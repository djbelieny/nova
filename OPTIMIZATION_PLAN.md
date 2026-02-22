# Plan: Implement Remaining Optimization Items (#4, #10, #11, #15, #16, #17)

## Context

After the initial 17-item optimization pass, 6 items were deferred. Here's why each was skipped, and the plan to implement them now.

### Why Each Was Skipped

| # | Item | Reason Skipped |
|---|------|----------------|
| 4 | Skills in 5 places | Structural refactor — needed careful analysis of all locations before touching |
| 10 | Dynamic MCP loading | Already partially done (`getFilteredMcpConfigPath` exists with keyword routing). Needed analysis of what "more aggressive" means |
| 11 | Pattern cache hit rate | `src/patterns.ts` already has keyword overlap + 0.7 threshold matching. Needed usage data to know if it's actually underperforming |
| 15 | Conversation summarization | Architectural question — summarize on write vs. on read, how to trigger, where to store summaries |
| 16 | Daily digest skill | Feature, not optimization — requires designing what data to pull and from where |
| 17 | Square revenue tracking | Feature, not optimization — requires designing report format, schedule, multi-location logic |

---

## Item #4: Consolidate Skills to Single Source of Truth

**Problem:** Skill names are hardcoded in 4+ locations:
1. `src/relay.ts:1261-1268` — SKILLS block in T3 prompt
2. `src/relay.ts:1333-1334` — Agent creation instructions (subset of skills)
3. `src/agent-router.ts` — Per-agent SKILLS blocks (24 agents, each with curated list)
4. `.claude/skills/*/SKILL.md` — Actual skill definitions on disk

**Plan:**
1. Create `src/skills.ts` with:
   - `loadSkillCatalog()` — reads `.claude/skills/*/SKILL.md`, extracts name + one-liner description from each
   - `ALL_SKILLS: string[]` — cached full list of skill slugs
   - `getSkillsForAgent(slug: string): string[]` — maps agent → relevant skill subset (move from agent-router hardcoded strings)
   - `formatSkillList(skills: string[]): string` — formats for prompt injection
2. In `src/relay.ts` `buildPrompt()` T3 block: replace hardcoded skill list with `formatSkillList(ALL_SKILLS)`
3. In `src/relay.ts` agent creation instructions: replace hardcoded subset with `formatSkillList(ALL_SKILLS)`
4. In `src/agent-router.ts`: replace per-agent hardcoded SKILLS blocks with `formatSkillList(getSkillsForAgent(slug))`

**Files:** `src/skills.ts` (new), `src/relay.ts`, `src/agent-router.ts`

---

## Item #10: More Aggressive MCP Filtering

**Current state:** `src/integrations.ts` already has `MCP_ROUTING_MAP` (keyword→server) and `AGENT_SERVER_MAP` (agent→servers). `getFilteredMcpConfigPath()` writes a filtered `mcp-active.json` per call.

**Problem:** When no keywords match, ALL servers load (fallback). This is the common case for conversational messages that happen to be T3 (e.g., "create a document about X" triggers T3 but doesn't match any MCP keyword).

**Plan:**
1. Add a "default minimal" set — when no keywords match AND the message isn't clearly about integrations, include only `playwright` (general browsing). Currently returns full config.
2. Add negative filtering: if the message is clearly about ONE domain (e.g., only "email" keywords), don't also load Square/GHL/Cloudflare.
3. Log MCP server counts to help monitor: `[integrations] Loaded N/M servers` (already partially done).
4. In `src/relay.ts` where `getFilteredMcpConfigPath` is called: pass the full message text as hint (verify this is already happening).

**Files:** `src/integrations.ts`

---

## Item #11: Pattern Cache Hit Rate

**Current state:** `src/patterns.ts` uses `normalizeSignature()` (strip stop words) and keyword overlap scoring with 0.7 threshold + minimum 3 matching words.

**Problem:** Exact signature matching is brittle — "write blog post about AI" and "draft a blog article on artificial intelligence" produce different signatures and won't match.

**Plan:**
1. Add semantic similarity via embeddings: when keyword overlap doesn't find a match (score < 0.7), fall back to embedding-based search using Supabase's `search` edge function
2. Store embeddings alongside patterns: add `embedding` column to `execution_patterns` table (reuse existing embed webhook or generate on insert)
3. Add hit/miss logging: `[patterns] HIT: "signature" (score: 0.85)` vs `[patterns] MISS: "signature" (best: 0.45)`
4. Add a `findPatternSemantic()` function that calls the search edge function with the task text against patterns
5. Lower the keyword threshold from 0.7 to 0.6 as a quick win (more lenient matching)

**Files:** `src/patterns.ts`, DB migration for embedding column

---

## Item #15: Conversation Summarization

**Current state:** `getRecentHistory()` fetches last 12 messages, caps at 8,000 chars. No summarization — raw messages are injected into every prompt.

**Problem:** After 10-12 back-and-forth messages, the history section bloats to 8K chars of raw conversation. A summary would compress this ~4x.

**Plan:**
1. Add `summarizeConversation()` to `src/memory.ts`:
   - Triggers when message count for user in current "session" exceeds 10
   - A "session" = messages within 2 hours of each other (gap > 2h = new session)
   - Calls Claude haiku with: "Summarize this conversation in 3-5 bullet points. Preserve: decisions made, action items, current topic."
   - Stores summary in `messages` table with `role = 'summary'`, `metadata.type = 'session_summary'`
2. Modify `getRecentHistory()`:
   - Check if a summary exists for the current session
   - If yes: return summary + messages AFTER the summary (only recent ones)
   - If no: return raw messages as before
3. Trigger: call `summarizeConversation()` after saving each user message, but only when count > 10 since last summary
4. Cost: ~500 input tokens to haiku per summarization. At 1 summary per ~10 messages, negligible.

**Files:** `src/memory.ts`, `src/relay.ts` (trigger after message save)

---

## Item #16: Proactive Daily Digest

**Current state:** `services/morning-briefing.ts` exists as external cron process. The new heartbeat system (`src/heartbeat.ts`) runs in-process every 30 min.

**Problem:** The morning briefing spawns a full Claude CLI session externally. It should be a heartbeat checklist item that runs in-process.

**Plan:**
1. Add a `dailyDigest` heartbeat item to `config/heartbeat.md`:
   ```
   - [ ] At briefing hour, send daily digest (calendar, tasks, goals, revenue)
   ```
2. Add `buildDailyDigest()` to `src/heartbeat.ts`:
   - Only fires once per day per user (check `messages` for today's digest)
   - Gathers data in parallel:
     - Active goals from Supabase (`get_active_goals`)
     - Scheduled tasks due today (`get_scheduled_tasks`)
     - Recent facts/memories added yesterday
   - Does NOT call Google Calendar/Gmail/Square directly (no MCP in heartbeat) — instead includes a hint: "Check calendar and email if user has those integrations"
   - Calls Claude haiku with gathered context + checklist
   - If response != HEARTBEAT_OK, sends digest via user's preferred channel
3. The heartbeat's `isWithinActiveHours()` + briefing hour check handles timing
4. Remove dependency on `services/morning-briefing.ts` launchd service (keep file as reference)

**Files:** `config/heartbeat.md`, `src/heartbeat.ts`

---

## Item #17: Square Revenue Tracking

**Current state:** Square MCP is configured as a global server. Two locations exist: Open Source Mind (LA50ZWAK48MD8) and Zaarvy AI (LNCSX2ST6EKCY). No automated reporting.

**Problem:** DJ wants weekly auto-reports across both Square locations.

**Plan:**
1. Add a heartbeat checklist item:
   ```
   - [ ] On Monday mornings, generate weekly Square revenue report
   ```
2. Add `buildRevenueReport()` to `src/heartbeat.ts`:
   - Fires on Mondays only (day-of-week check in pre-filter)
   - Since heartbeat can't use MCP tools, this item should set a flag/scheduled task that triggers a full Claude call with Square MCP access
   - Alternative: create a dedicated `src/revenue-report.ts` that the heartbeat invokes via `spawn()` (lighter than full CLI, but has Square MCP access)
3. Better approach — make this a **scheduled task** that the heartbeat checks for:
   - On first run, auto-create a recurring scheduled task: "Weekly Square revenue report" every Monday 9am
   - The scheduler (`src/scheduler.ts`) handles execution with full MCP access
   - Heartbeat just checks if the scheduled task ran this week; if not, triggers it
4. Report format: both locations + combined total, week-over-week comparison, top items

**Files:** `src/heartbeat.ts`, `config/heartbeat.md`, possibly `src/scheduler.ts`

---

## Implementation Order

1. **#4 (Skills consolidation)** — foundational, unblocks cleaner prompt building
2. **#10 (MCP filtering)** — quick win, reduces server spawn overhead
3. **#11 (Pattern matching)** — improves orchestrator intelligence
4. **#15 (Summarization)** — reduces token usage for long conversations
5. **#16 (Daily digest)** — extends heartbeat with first real feature
6. **#17 (Revenue tracking)** — extends heartbeat + scheduler integration

---

## Verification

1. **#4:** Add a new skill to `.claude/skills/`, verify it auto-appears in T3 prompt and agent creation instructions without code changes
2. **#10:** Send a conversational message, check logs show reduced server count vs. current behavior
3. **#11:** Add logging, send tasks similar-but-not-identical to past patterns, verify hits
4. **#15:** Have a 12+ message conversation, verify summary gets created and subsequent prompts use it
5. **#16:** Set `HEARTBEAT_INTERVAL_MIN=1`, verify daily digest fires at briefing hour
6. **#17:** Trigger Monday check manually, verify report covers both Square locations
