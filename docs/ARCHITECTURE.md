# Nova — Architecture Deep Dive

## 3-Tier Message Classification

### Tier 1: Fast Heuristic (`isSimpleMessage()` in orchestrator.ts)
- Messages under 15 words → simple, unless they have BOTH an action verb AND a conjunction
- Action verbs: research, analyze, compare, create, build, write, draft, summarize, review, plan, design, evaluate, investigate, compile, prepare, develop, generate, organize, calculate
- Conjunctions: and, then, also, plus, after, before, while
- Catches ~80% of messages with zero AI cost

### Tier 2: Pattern Detection + Single-Agent Routing
- `detectSingleAgentRoute()` matches regex patterns to specific agents (16 keyword→agent mappings)
- `detectSocialMediaRequest()`, `detectEmailCampaign()`, `detectBlogPost()`, `detectPresentation()`, `detectAdCampaign()` — hard-coded pipeline triggers
- Pattern cache: `findPattern()` checks for previously successful decomposition plans (70% keyword overlap, 2+ successes required)

### Tier 3: LLM Classification
- Sonnet classifies as "simple", "routed", or "complex"
- Simple → direct callClaude with full memory context
- Routed → single agent with specialist prompt
- Complex → decomposition via planner

## Task Decomposition (planner.ts)

### Decompose Algorithm
1. Sonnet receives: user request + full agent catalog (names, descriptions, tool access)
2. Returns JSON: array of subtasks, each with description, agent slug, dependencies, phase
3. Dependencies are 0-indexed positional references
4. Agent slugs validated against loaded agents; unknown slugs → "general"

### Deterministic Plans
Five task types bypass LLM decomposition with hard-coded pipelines:
- **Social Media**: research → content → image-gen → telegram-preview → GHL-publish
- **Email Campaign**: research → copy → template → broadcast
- **Blog Post**: research → write → hero-image → preview → publish
- **Presentation**: research → outline → PPTX creation
- **Ad Campaign**: research → creative → image-gen → preview → campaign-create

### Parallel Execution
- Subtasks with no dependencies run concurrently via `Promise.all()`
- Each batch waits for dependencies before spawning
- Circular dependency detection logs error and breaks

## Two-Phase Execution

### Phase: Prepare (safe, reversible)
- Research, content creation, image generation, analysis
- Each subtask output scanned for `[ARTIFACT: type | value]` tags
- Artifacts validated: file-based ones checked with `stat()`, registered in `task_artifacts` table
- If expected artifacts missing, automatic retry with explicit instructions

### Phase: Execute (consequential, hard to reverse)
- API calls: create campaigns, send emails, publish posts, spend money
- Only runs after explicit user approval via Telegram inline buttons
- Receives all artifacts from prepare phase as context

### Approval Lifecycle
1. Prepare phase completes → summary + artifacts sent to user with Approve/Revise/Cancel buttons
2. Approval persisted to SQLite (`pending_approvals` table) — survives restarts
3. User taps Approve → execute phase runs
4. User taps Revise → revision session created, next message treated as feedback
5. User taps Cancel → cleanup, task cancelled
6. Auto-approve: messages starting with "just do it", "go ahead", "ship it", etc. skip the gate

### Revision Sessions
- Persisted to SQLite (`revision_sessions` table)
- No expiration — persist until user sends feedback or cancels
- Keyed by unique sessionId (supports multiple concurrent sessions per user)
- On feedback: re-run prepare phase with revision instructions injected

## Pattern Caching (patterns.ts)

### Signature Normalization
- Lowercase, strip punctuation, remove stop words (a, an, the, and, or, but, in, on, at, etc.)
- Preserve word order to differentiate semantically different requests

### Matching Algorithm
- Pull patterns with 2+ successes for the user
- Score each by keyword overlap: `matching_words / max(query_words, pattern_words)`
- Require 3+ matching words minimum
- Threshold: 70% overlap score

### Recording
- After each execution, record success/failure + duration
- Running average on duration for performance tracking

## AI Routing (ai-router.ts)

### Decision Tree
1. **Force override**: `/claude`, `/gemini`, `/codex` prefix → use that provider
2. **User preference**: Per-user default stored in DB (`ai_provider` column)
3. **Rate limit check**: If preferred provider rate-limited in last 60s, try alternatives
4. **Hint-based routing**:
   - MCP-heavy tasks (calendar, email, notion, crm) → Claude (native MCP support)
   - Research/search/web → Gemini (free tier, good synthesis)
   - Fast-tier classification → Gemini Flash (free)
5. **Default**: Use preferred provider
6. **Ultimate fallback**: First registered provider

### Model Tiers
- `fast`: Classification, decomposition — cheapest model (Gemini Flash or Haiku)
- `standard`: Task execution — balanced quality (Sonnet or Gemini Pro)
- `premium`: Critical reasoning — best available (Opus or Gemini Ultra)

### Providers
| Provider | File | CLI |
|----------|------|-----|
| Claude | providers/claude.ts | `claude` CLI |
| Gemini | providers/gemini.ts | `gemini` CLI |
| Codex | providers/codex.ts | `codex` CLI |
| Groq | providers/groq.ts | API (voice transcription) |

## Database Architecture (db.ts)

### Split Architecture
```
data/
  shared.db          — users, nova_status, logs, cost_tracking, shared memory, service_state
  users/{id}.db      — messages, private memory, tasks, approvals, scheduled_tasks, patterns
```

### Shared DB Tables
- `users` — id, telegram_id, name, timezone, phone, whatsapp_id, slack_id, role, preferences, ai_provider, ai_config
- `nova_status` — singleton row: uptime, call counts, rate limits, active slots, queue depth
- `logs` — level, event, message, metadata, session_id, duration_ms
- `cost_tracking` — provider, model, tokens, cost_usd, duration_ms, session_id
- `memory` (scope=shared) — shared facts across users
- `service_state` — key-value store for proactive services

### Per-User DB Tables
- `messages` — role, content, channel, metadata, embedding (BLOB)
- `memory` (scope=private) — facts, goals, completed_goals, preferences
- `agent_tasks` — agent, description, status, result, parent_task_id
- `pending_approvals` — plan, prepare_results, artifacts, workspace_dir, workflow_type
- `revision_sessions` — plan, results, artifacts, status
- `scheduled_tasks` — title, instructions, trigger_at, recurrence, timezone, condition
- `execution_patterns` — task_signature, plan, success/fail counts, avg_duration

### Vector Search
- sqlite-vec extension loaded on all DBs
- Embeddings: all-MiniLM-L6-v2 via @huggingface/transformers (384 dimensions)
- Stored as Float32Array BLOBs
- Used for semantic message search and memory deduplication

## Memory System (memory.ts)

### Intent Tags (parsed from AI responses)
| Tag | Action |
|-----|--------|
| `[REMEMBER: fact]` | Save fact with embedding, deduplicate against existing |
| `[SHARE: fact]` | Save fact with scope=shared (visible to all users) |
| `[GOAL: text \| DEADLINE: date]` | Save goal, optional deadline |
| `[DONE: search text]` | Find matching goal, mark completed |
| `[TASK: agent \| description]` | Create agent task |
| `[TASK_START: search text]` | Mark matching pending task as in_progress |
| `[TASK_DONE: search text \| result]` | Mark matching task as completed |
| `[TASK_BLOCKED: search text \| reason]` | Mark task as blocked |
| `[TASK_CANCEL: search text]` | Cancel task |
| `[SCHEDULE: title \| datetime \| instructions]` | Create scheduled task |
| `[SCHEDULE: title \| datetime \| instructions \| RECUR: rule]` | Create recurring task |
| `[SCHEDULE: title \| datetime \| instructions \| RECUR: rule \| IF: condition]` | Conditional recurring task |
| `[SCHEDULE_CANCEL: search text]` | Cancel scheduled task |

### Context Injection (injected into every prompt)
| Function | Content | Cap |
|----------|---------|-----|
| `getMemoryContext()` | Facts + active goals | 50 facts |
| `getRecentHistory()` | Last N messages chronological | 12 messages, 8000 chars |
| `getRelevantContext()` | Semantic search results | 5 matches, 500 chars each |
| `getTaskContext()` | Active agent tasks | 20 tasks |
| `getScheduleContext()` | Scheduled tasks | All active |

### Schedule Recurrence DSL
- `daily:HH:MM` — every day at time
- `weekly:DAY:HH:MM` — every week (0=Sun, 1=Mon, etc.)
- `weekdays:HH:MM` — Mon-Fri only
- `interval:SECONDS` — repeat every N seconds

## Agent System

### Loading (agent-router.ts)
- `.claude/agents/*.md` — 24 agent definition files
- YAML frontmatter: name, description
- Markdown body: full system prompt (personality, capabilities, playbook)
- Loaded at startup into memory Map

### Agent Prompt Construction
- For subtask execution: compact identity (title + first paragraph + description) instead of full personality
- Tool/skill instructions injected from `AGENT_TOOLS` map per agent
- Artifact tagging instructions added for prepare-phase tasks
- Workspace path injected for file operations

### Artifact System
Types: image, copy, audience, url, file, data
Format: `[ARTIFACT: type | value]`
Workspace structure:
```
~/.nova/workspace/
  projects/     — full codebases
  documents/    — reports, docs, spreadsheets
  images/       — generated visuals
  media/        — videos, audio
  .tasks/       — per-task staging directories
```

## Channel Adapters (src/channels/)

### Interface
- `index.ts` — ChannelRegistry, IncomingMessage, PlatformContext types
- Each adapter normalizes platform-specific messages to IncomingMessage
- Response formatting handled per-platform (Telegram HTML, WhatsApp markdown, etc.)

### Adapters
| File | Platform | Features |
|------|----------|----------|
| telegram.ts | Telegram | Inline keyboards, file sending, HTML formatting, message chunking |
| whatsapp.ts | WhatsApp | Via Kapso API, media handling |
| slack.ts | Slack | Thread-based conversations |

## Proactive Services (services/)

Common patterns across services:
- State tracking via `service_state` table (last run timestamps, etc.)
- Groq preference for fast AI calls
- Timezone-aware scheduling
- Rate limiting to prevent spam

| Service | File | Purpose |
|---------|------|---------|
| Smart Check-in | smart-checkin.ts | Context-aware check-ins, decides whether to reach out |
| Morning Briefing | morning-briefing.ts | Daily summary with tasks, calendar, weather |
| AI News Monitor | ai-news-monitor.ts | Curates AI/tech news relevant to user |
| Social Post Suggester | social-post-suggester.ts | Suggests social media content ideas |
| Lead Suggester | lead-suggester.ts | Identifies potential business leads |
| Health Monitor | health-monitor.ts | System health checks |
| Log Monitor | log-monitor.ts | Error detection in logs |
| Meta Ads Report | meta-ads-report.ts | Daily ad performance summary |
| Task Dispatcher | task-dispatcher.ts | Executes scheduled tasks |
| Memory Review | memory-review.ts | Memory cleanup and consolidation |

## MCP Integrations (.mcp.json)

12 MCP servers configured:
| Server | Purpose |
|--------|---------|
| notion | Notion workspace — docs, databases, pages |
| google-workspace | Gmail, Calendar, Drive, Docs, Sheets |
| playwright | Browser automation — scraping, testing, screenshots |
| cloudflare | Workers, DNS, edge functions |
| zoom | Meeting scheduling and management |
| square | POS, sales data, transactions |
| clickup | Task management |
| gohighlevel | CRM, campaigns, contacts, social publishing |
| firecrawl | Web scraping and crawling |
| tavily | Web search API |
| exa | Semantic web search |
| browserbase | Cloud browser sessions |

Plus platform-specific MCP services in services/:
- youtube-mcp.ts — YouTube API integration
- tiktok-mcp.ts — TikTok API integration
- zoom-mcp.ts — Zoom API integration
- meta-social-mcp.ts — Meta social publishing
