/**
 * Predictive Task Scheduler
 *
 * Polls Google Calendar every 30 minutes, matches upcoming events to
 * calendar_rules, and queues prep tasks ahead of meetings.
 *
 * Example: "client call" rule triggers 2 hours before any meeting with
 * "client" in the title — auto-queuing a Athena briefing prep task.
 *
 * Uses the Google Calendar MCP tool via gws CLI, same as other agents.
 */

import { join, dirname } from "path";
import { getDb, type Database } from "../src/db.ts";
import { emit } from "../src/events.ts";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const LOOKAHEAD_HOURS = 48; // look 48 hours ahead

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = getDb();
  return _db;
}

let _callAI: ((prompt: string, tier?: string, hint?: string) => Promise<string>) | null = null;
let _dispatchTask: ((userId: string, agentSlug: string, taskDescription: string, createdBy?: string) => Promise<string | null>) | null = null;

export function initPredictiveScheduler(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  dispatchTask: (userId: string, agentSlug: string, taskDescription: string, createdBy?: string) => Promise<string | null>;
}): void {
  _callAI = deps.callAI;
  _dispatchTask = deps.dispatchTask;
}

interface CalendarEvent {
  id: string;
  title: string;
  start_at: string;
  end_at?: string;
  attendees?: string[];
  description?: string;
  location?: string;
}

/**
 * Render a Handlebars-style template with event fields.
 */
function renderTemplate(template: string, event: CalendarEvent): string {
  const data: Record<string, string> = {
    title: event.title,
    start: event.start_at,
    attendees: (event.attendees || []).join(", "),
    description: event.description || "",
    location: event.location || "",
  };
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, key) => data[key] || match);
}

/**
 * Fetch upcoming calendar events for a user via LLM (using gws CLI or MCP).
 */
async function fetchCalendarEvents(userId: string, hoursAhead: number): Promise<CalendarEvent[]> {
  if (!_callAI) return [];

  const now = new Date();
  const until = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  const prompt = `Using the Google Calendar tool, list all events from now (${now.toISOString()}) until ${until.toISOString()}.

For each event, output a JSON array with this format:
[{"id":"eventId","title":"event title","start_at":"ISO datetime","attendees":["name1"],"description":"optional desc"}]

Only output the JSON array. If there are no events or you can't access the calendar, output: []`;

  try {
    const result = await _callAI(prompt, "fast", "calendar events");
    const match = result.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
  } catch {
    return [];
  }
}

/**
 * Check if an event title matches any of the rule's keywords.
 */
function eventMatchesRule(eventTitle: string, keywords: string[]): boolean {
  const titleLower = eventTitle.toLowerCase();
  return keywords.some(kw => titleLower.includes(kw.toLowerCase()));
}

/**
 * Process calendar events for a single user.
 */
async function processUserCalendar(user: any): Promise<void> {
  if (!_dispatchTask) return;

  // Skip if calendar rules aren't enabled
  const userDb = db();
  const rules = userDb.getCalendarRules(user.id);
  if (rules.length === 0) return;

  const events = await fetchCalendarEvents(user.id, LOOKAHEAD_HOURS);
  if (events.length === 0) return;

  const now = Date.now();

  for (const event of events) {
    const eventStart = new Date(event.start_at).getTime();
    if (isNaN(eventStart) || eventStart < now) continue; // skip past events

    for (const rule of rules) {
      const keywords: string[] = JSON.parse(rule.event_keywords || "[]");
      if (!eventMatchesRule(event.title, keywords)) continue;

      const triggerMs = rule.trigger_hours_before * 60 * 60 * 1000;
      const timeUntil = eventStart - now;

      // Only queue if we're within the trigger window (with 10% buffer to avoid repeated queueing)
      if (timeUntil > triggerMs * 1.1) continue;

      // Try to insert (unique constraint prevents duplicates)
      const isNew = userDb.upsertQueuedPrepTask({
        user_id: user.id,
        calendar_event_id: event.id,
        event_title: event.title,
        event_start_at: event.start_at,
        rule_id: rule.id,
        status: "pending",
      });

      if (!isNew) continue; // already queued

      // Parse pipeline config
      let agentSlug = "athena";
      let taskTemplate = rule.pipeline_template;
      try {
        const pipeline = JSON.parse(rule.pipeline_template);
        agentSlug = pipeline.agentSlug || "athena";
        taskTemplate = pipeline.taskTemplate || rule.pipeline_template;
      } catch {
        // plain string template
      }

      const taskDescription = renderTemplate(taskTemplate, event);

      const taskId = await _dispatchTask(user.id, agentSlug, taskDescription, "nova").catch(() => null);

      if (taskId) {
        // Update the queued prep task with the task_id
        try {
          userDb.upsertQueuedPrepTask({
            user_id: user.id,
            calendar_event_id: event.id,
            event_title: event.title,
            event_start_at: event.start_at,
            rule_id: rule.id,
            task_id: taskId,
            status: "running",
          });
        } catch {}

        emit({
          type: "task.created",
          level: "info",
          userId: user.id,
          agentSlug,
          data: {
            message: `Predictive prep: "${event.title}" in ${Math.round(timeUntil / 60000)}m → ${agentSlug}`,
            eventTitle: event.title,
            agentSlug,
            taskId,
            module: "predictive-scheduler",
          },
        });
      }
    }
  }
}

/**
 * Run one tick of the predictive scheduler for all users.
 */
async function tick(): Promise<void> {
  const userDb = db();

  let users: any[] = [];
  try {
    const admins = userDb.getUsersByRole?.("admin") || [];
    const members = userDb.getUsersByRole?.("member") || [];
    users = [...admins, ...members].filter((u: any) => u.active !== 0);
  } catch {
    return;
  }

  for (const user of users) {
    try {
      await processUserCalendar(user);
    } catch (err) {
      emit({ type: "error", level: "warn", data: { message: `Predictive scheduler failed for user ${user.id}: ${err}`, module: "predictive-scheduler" } });
    }
  }
}

/**
 * Start the predictive scheduler loop.
 */
export async function start(): Promise<void> {
  emit({ type: "system.health", level: "info", data: { message: "Predictive scheduler started (30-min cycle)", module: "predictive-scheduler" } });

  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: `Predictive scheduler tick failed: ${err}`, module: "predictive-scheduler" } });
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };

  // First run after 10 minutes (let system settle)
  setTimeout(loop, 10 * 60 * 1000);
}
