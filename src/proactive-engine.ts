/**
 * Proactive Engine — Background intelligence for executive nodes
 *
 * Each executive continuously analyzes data, creates deliverables,
 * and surfaces insights without being asked. Extends the
 * existing proactive services pattern (services/smart-checkin.ts).
 */

import type { ExecComms, Delegation, NodeStatus, Project } from "./exec-comms.ts";
import { searchTavily } from "./service-integrations.ts";
import { getDb } from "./db.ts";

// ============================================================
// Types
// ============================================================

export interface ProactiveConfig {
  role: string;
  intervalMs: number; // default 30 min (1800000)
  behaviors: ProactiveBehavior[];
}

export interface ProactiveBehavior {
  name: string;
  source: string; // 'zoom', 'trends', 'leads', 'delegations', 'decisions', 'briefs'
  description: string;
  check: () => Promise<boolean>; // should we run this?
  execute: () => Promise<void>; // do the work
}

// ============================================================
// Module state
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _sendMessage: (chatId: string | number, text: string) => Promise<void>;
let _role: string;

export function initProactiveEngine(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  sendMessage: (chatId: string | number, text: string) => Promise<void>;
  role: string;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _sendMessage = deps.sendMessage;
  _role = deps.role;
}

// ============================================================
// Dedup tracking via Supabase proactive_runs table
// ============================================================

async function hasRunToday(behaviorName: string): Promise<boolean> {
  return _comms.hasProactiveRun(_role, behaviorName, todayKey());
}

async function recordRun(
  behaviorName: string,
  source: string,
  outputType?: string,
  outputRef?: string,
): Promise<void> {
  await _comms.recordProactiveRun(_role, source, todayKey(), outputType, outputRef, behaviorName);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ============================================================
// Role-specific behavior catalog
// ============================================================

function getProactiveBehaviors(role: string): ProactiveBehavior[] {
  // --- common behaviors shared by all execs ---
  const common: ProactiveBehavior[] = [
    {
      name: "check-briefs",
      source: "briefs",
      description: "Check for unread briefs from other executives",
      check: async () => {
        const messages = await _comms.pollMessages(new Date(Date.now() - 30 * 60 * 1000));
        return messages.length > 0;
      },
      execute: async () => {
        const messages = await _comms.pollMessages(new Date(Date.now() - 30 * 60 * 1000));
        for (const msg of messages) {
          const prompt = `You are the ${_role.toUpperCase()}. You received a ${msg.type} from ${msg.from_role.toUpperCase()}:
Subject: ${msg.subject ?? "(none)"}
Content: ${msg.content}

Decide what action to take, if any. Respond with:
ACTION: none | brief | alert | delegation
TARGET: <role or "all">
CONTENT: <your response>`;
          const response = await _callAI(prompt, "fast");

          const actionMatch = response.match(/ACTION:\s*(\w+)/i);
          const action = actionMatch?.[1]?.toLowerCase() ?? "none";

          if (action === "brief" || action === "alert") {
            const targetMatch = response.match(/TARGET:\s*(\w+)/i);
            const contentMatch = response.match(/CONTENT:\s*([\s\S]+)/i);
            const target = targetMatch?.[1] ?? null;
            const content = contentMatch?.[1]?.trim() ?? "";
            if (content) {
              if (action === "brief") {
                await _comms.sendBrief(target === "all" ? null : target, `Re: ${msg.subject ?? "brief"}`, content);
              } else {
                await _comms.sendAlert(target === "all" ? null : target, `Re: ${msg.subject ?? "alert"}`, content);
              }
            }
          }

          await _comms.markRead(msg.id);
        }
      },
    },
    {
      name: "review-delegations",
      source: "delegations",
      description: "Check completed delegations and act on results",
      check: async () => true,
      execute: async () => {
        const delegations = await _comms.pollDelegations();
        const mine = delegations.filter((d: Delegation) => d.requesting_role === _role && d.status === "completed");
        for (const d of mine) {
          if (!d.result) continue;

          // Parse [ARTIFACT: type | value] tags from result
          const artifacts: Array<{ type: string; value: string }> = [];
          const artifactRegex = /\[ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
          let m: RegExpExecArray | null;
          while ((m = artifactRegex.exec(d.result)) !== null) {
            artifacts.push({ type: m[1].trim(), value: m[2].trim() });
          }

          // Forward completion brief back to requesting role (this exec)
          const summary = artifacts.length > 0
            ? `Delegation complete: "${d.task_description.slice(0, 80)}"\n\nArtifacts:\n${artifacts.map(a => `- [${a.type}]: ${a.value}`).join("\n")}`
            : `Delegation complete: "${d.task_description.slice(0, 80)}"\n\nResult: ${d.result.slice(0, 500)}`;

          await _comms.sendBrief(_role, "Delegation Complete", summary);
        }
      },
    },
  ];

  // --- role-specific behaviors ---
  switch (role) {
    case "ceo":
      return [
        ...common,
        {
          name: "strategic-review",
          source: "decisions",
          description: "Review active projects and suggest pivots when metrics diverge from expectations",
          check: async () => true,
          execute: async () => {
            const projects = await _comms.getActiveProjects();
            if (projects.length === 0) return;

            const summary = projects
              .map((p: Project) => `- ${p.title} (${p.progress_pct}%): ${p.description ?? "no description"}`)
              .join("\n");

            const prompt = `As CEO, review these active projects and identify any that need strategic pivots.
For each project, assess whether progress is on track and whether the direction still makes sense.

Active projects:
${summary}

If any project needs attention, generate a brief addressed to the relevant executive.
Format each brief as:
[BRIEF: <target_role> | <subject> | <content>]

If everything looks fine, respond with: ALL_CLEAR`;

            const analysis = await _callAI(prompt, "standard");

            if (!analysis.includes("ALL_CLEAR")) {
              const briefPattern = /\[BRIEF:\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]/g;
              let match: RegExpExecArray | null;
              while ((match = briefPattern.exec(analysis)) !== null) {
                const target = match[1].trim();
                const subject = match[2].trim();
                const content = match[3].trim();
                await _comms.sendBrief(target, subject, content);
              }
            }
          },
        },
      ];

    case "cfo":
      return [
        ...common,
        {
          name: "cost-monitoring",
          source: "decisions",
          description: "Monitor AI spend and budget across all nodes",
          check: async () => true,
          execute: async () => {
            const statuses = await _comms.getNodeStatuses();
            const activeNodes = statuses.filter((s: NodeStatus) => s.status === "online");

            let costSummary = "";
            try {
              const db = getDb();
              const rows = db.getCostSummary24h();
              if (rows?.length) {
                costSummary = "AI spend last 24h:\n" + rows
                  .map(r => `  ${r.provider}/${r.model}: $${r.total_cost.toFixed(4)} (${r.call_count} calls)`)
                  .join("\n");
              }
            } catch { /* DB may not be accessible from exec node */ }

            const prompt = `As CFO, review operational status and AI spend.

Active nodes (${activeNodes.length}):
${activeNodes.map((s: NodeStatus) => `- ${s.role}: ${s.active_tasks} active tasks`).join("\n") || "None"}

${costSummary || "No spend data available for last 24h."}

Identify any cost concerns:
- Models or providers with unexpectedly high spend
- Nodes with unusually high task counts
- Inefficiencies in provider usage (e.g. premium model used for simple tasks)

If there are concerns, generate a brief to the CEO.
Format: [BRIEF: ceo | <subject> | <content>]
Otherwise respond: ALL_CLEAR`;

            const analysis = await _callAI(prompt, "fast");
            if (!analysis.includes("ALL_CLEAR")) {
              const briefPattern = /\[BRIEF:\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]/g;
              let match: RegExpExecArray | null;
              while ((match = briefPattern.exec(analysis)) !== null) {
                await _comms.sendBrief(match[1].trim(), match[2].trim(), match[3].trim());
              }
            }
          },
        },
      ];

    case "cmo":
      return [
        ...common,
        {
          name: "content-opportunities",
          source: "trends",
          description: "Identify content opportunities from trends and research briefs",
          check: async () => true,
          execute: async () => {
            const messages = await _comms.pollMessages(new Date(Date.now() - 60 * 60 * 1000));
            const researchBriefs = messages.filter((m) => m.from_role === "research" && m.type === "brief");
            if (researchBriefs.length === 0) return;

            const briefSummary = researchBriefs
              .map((b) => `- ${b.subject}: ${b.content.slice(0, 200)}`)
              .join("\n");

            const prompt = `As CMO, review these research briefs and identify content opportunities:

${briefSummary}

For each opportunity, suggest a specific content piece and target channel.
Format: [BRIEF: pixel | <subject> | <content direction>]
Or if nothing actionable: ALL_CLEAR`;

            const analysis = await _callAI(prompt, "standard");
            if (!analysis.includes("ALL_CLEAR")) {
              const briefPattern = /\[BRIEF:\s*([^|]+)\|\s*([^|]+)\|\s*([^\]]+)\]/g;
              let match: RegExpExecArray | null;
              while ((match = briefPattern.exec(analysis)) !== null) {
                await _comms.sendBrief(match[1].trim(), match[2].trim(), match[3].trim());
              }
            }

            for (const b of researchBriefs) await _comms.markRead(b.id);
          },
        },
      ];

    case "cto":
      return [
        ...common,
        {
          name: "system-health",
          source: "delegations",
          description: "Monitor system health and flag offline nodes or stale heartbeats",
          check: async () => true,
          execute: async () => {
            const statuses = await _comms.getNodeStatuses();
            const staleThreshold = Date.now() - 15 * 60 * 1000; // 15 min

            const staleNodes = statuses.filter(
              (s: NodeStatus) => new Date(s.last_seen).getTime() < staleThreshold,
            );

            if (staleNodes.length > 0) {
              const names = staleNodes.map((s: NodeStatus) => s.role).join(", ");
              await _comms.sendAlert(
                "coo",
                "Stale nodes detected",
                `The following nodes have not sent a heartbeat in 15+ minutes: ${names}. Recommend checking node health.`,
              );
              console.log(`[proactive:cto] Alerted COO about stale nodes: ${names}`);
            }
          },
        },
      ];

    case "coo":
      return [
        ...common,
        {
          name: "daily-digest",
          source: "delegations",
          description: "Generate daily execution summary across all delegations and projects",
          check: async () => !await hasRunToday("daily-digest"),
          execute: async () => {
            const projects = await _comms.getActiveProjects();
            const statuses = await _comms.getNodeStatuses();

            const prompt = `As COO, compile a concise daily execution digest.

Active projects (${projects.length}):
${projects.map((p: Project) => `- ${p.title}: ${p.progress_pct}% complete`).join("\n") || "None"}

Node statuses:
${statuses.map((s: NodeStatus) => `- ${s.role}: ${s.status} (${s.active_tasks} tasks)`).join("\n") || "None"}

Provide a brief summary (max 5 bullet points) of operational status.
Highlight any blockers or items needing human attention.`;

            const digest = await _callAI(prompt, "standard");
            await _comms.sendBrief("ceo", "Daily Execution Digest", digest);
            console.log(`[proactive:coo] Daily digest sent to CEO`);
          },
        },
        {
          name: "goal-pursuit",
          source: "goals",
          description: "Check active goals not touched in 24h and dispatch next-action delegations",
          check: async () => true,
          execute: async () => {
            try {
              const sharedDb = getDb();
              const users = sharedDb.getAllActiveUsers();
              for (const user of users) {
                const goals = sharedDb.getActiveGoals(user.id);
                if (!goals?.length) continue;

                // Filter goals not progressed in 24h
                const stale = goals.filter(g => {
                  const lastTouched = new Date(g.updated_at || g.created_at).getTime();
                  return Date.now() - lastTouched > 24 * 60 * 60 * 1000;
                });

                for (const goal of stale.slice(0, 2)) { // max 2 per cycle to avoid overload
                  const prompt = `As COO, identify the single most actionable next step to advance this goal.
Goal: ${goal.content}
${goal.deadline ? `Deadline: ${goal.deadline}` : ""}
Current date: ${new Date().toISOString().slice(0, 10)}

Respond with ONE specific, executable task in 1-2 sentences. Be concrete and actionable.`;

                  const nextAction = await _callAI(prompt, "fast");
                  if (nextAction && nextAction.length > 10) {
                    await _comms.requestDelegation(
                      `[Goal: ${goal.content.slice(0, 60)}] ${nextAction}`,
                      user.id,
                    );
                  }
                }
              }
            } catch (err) {
              console.error(`[proactive:coo] Goal pursuit error:`, err);
            }
          },
        },
        {
          name: "stalled-detection",
          source: "delegations",
          description: "Detect stalled delegations (in_progress > 1 hour) and escalate",
          check: async () => true,
          execute: async () => {
            const delegations = await _comms.pollDelegations();
            const staleThreshold = Date.now() - 60 * 60 * 1000; // 1 hour

            const stalled = delegations.filter(
              (d: Delegation) =>
                d.status === "in_progress" &&
                new Date(d.updated_at).getTime() < staleThreshold,
            );

            for (const d of stalled) {
              console.log(`[proactive:coo] Stalled delegation: ${d.task_description.slice(0, 60)}`);
              await _comms.sendAlert(
                d.requesting_role,
                "Stalled delegation",
                `Delegation "${d.task_description.slice(0, 100)}" has been in_progress for over 1 hour. Please review or reassign.`,
              );
            }
          },
        },
      ];

    case "research":
      return [
        ...common,
        {
          name: "trend-scan",
          source: "trends",
          description: "Scan for industry trends and generate strategic briefs",
          check: async () => !await hasRunToday("trend-scan"),
          execute: async () => {
            const [aiTrends, industryNews] = await Promise.all([
              searchTavily("AI automation digital agency trends 2026", { maxResults: 5, topic: "news" }),
              searchTavily("AI tools business digital transformation market signals", { maxResults: 5, topic: "news" }),
            ]).catch(() => [[], []]);
            const searchContext = [...aiTrends, ...industryNews]
              .slice(0, 8)
              .map(a => `- ${a.title}: ${a.content?.slice(0, 200)}`)
              .join("\n");

            const prompt = `As the Research executive, identify 3-5 current trends in AI, digital marketing, and business automation that are relevant for a digital agency.

${searchContext ? `Current market signals:\n${searchContext}\n\n` : ""}For each trend, provide:
1. Trend name
2. Why it matters (1-2 sentences)
3. Suggested action

Format the output as a structured brief suitable for the CEO and CMO.`;

            const analysis = await _callAI(prompt, "standard", "research");

            await _comms.sendBrief("ceo", "Daily Trend Scan", analysis);
            await _comms.sendBrief("cmo", "Content Opportunities from Trends", analysis);
            console.log(`[proactive:research] Trend scan briefs sent to CEO and CMO`);
          },
        },
        {
          name: "lead-scan",
          source: "leads",
          description: "Identify potential leads from market signals and brief the CMO",
          check: async () => !await hasRunToday("lead-scan"),
          execute: async () => {
            const [marketData, adoptionSignals] = await Promise.all([
              searchTavily("businesses adopting AI automation 2026 hiring", { maxResults: 5, topic: "news" }),
              searchTavily("companies undergoing digital transformation seeking AI help", { maxResults: 5, topic: "news" }),
            ]).catch(() => [[], []]);
            const searchContext = [...marketData, ...adoptionSignals]
              .slice(0, 8)
              .map(a => `- ${a.title}: ${a.content?.slice(0, 200)}`)
              .join("\n");

            const prompt = `As the Research executive, analyze current market signals to identify potential lead opportunities for a digital agency.

${searchContext ? `Current market signals:\n${searchContext}\n\n` : ""}Consider:
- Industries undergoing digital transformation
- Companies likely needing AI integration
- Seasonal business needs

Provide 3-5 lead categories with targeting suggestions.`;

            const analysis = await _callAI(prompt, "standard", "research");
            await _comms.sendBrief("cmo", "Lead Opportunities", analysis);
            console.log(`[proactive:research] Lead scan brief sent to CMO`);
          },
        },
      ];

    case "critic":
      return [
        ...common,
        {
          name: "retrospective",
          source: "decisions",
          description: "Review decisions older than 7 days and assess their outcomes",
          check: async () => !await hasRunToday("retrospective"),
          execute: async () => {
            // Get recent decisions across all users (critic reviews all)
            const decisions = await _comms.getRecentDecisions("", 20);
            const pendingReview = decisions.filter(
              (d) =>
                d.outcome === "pending" &&
                d.id &&
                Date.now() - new Date((d as any).created_at).getTime() > 7 * 24 * 60 * 60 * 1000,
            );

            if (pendingReview.length === 0) return;

            for (const d of pendingReview) {
              const prompt = `As the Critic, evaluate this decision made 7+ days ago:

Question: ${d.question}
Chosen option: ${d.chosen_option}
Rationale: ${d.rationale ?? "none provided"}

Based on general business principles, assess the likely outcome.
Respond with:
OUTCOME: success | partial | failure | inconclusive
NOTES: <brief assessment>`;

              const review = await _callAI(prompt, "fast");
              const outcomeMatch = review.match(/OUTCOME:\s*(\w+)/i);
              const notesMatch = review.match(/NOTES:\s*([\s\S]+)/i);

              const outcome = outcomeMatch?.[1]?.toLowerCase() ?? "inconclusive";
              const notes = notesMatch?.[1]?.trim() ?? "";

              if (d.id) {
                await _comms.updateOutcome(d.id, outcome, notes);
                console.log(`[proactive:critic] Reviewed decision ${d.id}: ${outcome}`);
              }
            }
          },
        },
      ];

    default:
      return common;
  }
}

// ============================================================
// Main loop
// ============================================================

export function startProactiveLoop(intervalMs: number = 30 * 60 * 1000): void {
  const behaviors = getProactiveBehaviors(_role);

  console.log(
    `[proactive] Starting loop for ${_role} with ${behaviors.length} behaviors (interval: ${intervalMs / 60000}min)`,
  );

  // Run immediately on startup, then on interval
  runProactiveCycle(behaviors);

  setInterval(() => {
    runProactiveCycle(behaviors);
  }, intervalMs);
}

async function runProactiveCycle(behaviors: ProactiveBehavior[]): Promise<void> {
  console.log(`[proactive:${_role}] Cycle starting (${behaviors.length} behaviors)`);

  for (const behavior of behaviors) {
    try {
      const shouldRun = await behavior.check();
      if (!shouldRun) {
        continue;
      }

      console.log(`[proactive:${_role}] Running: ${behavior.name}`);
      await behavior.execute();
      await recordRun(behavior.name, behavior.source);
    } catch (err) {
      console.error(`[proactive:${_role}] Error in ${behavior.name}:`, err);
    }
  }

  console.log(`[proactive:${_role}] Cycle complete`);
}
