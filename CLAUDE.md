# Nova — Architecture & Conventions

> Claude Code reads this file on every conversation. It describes how Nova actually works
> so you can navigate the codebase, make changes, and debug without re-exploring each time.

Nova is a multi-agent AI orchestration platform. 24 specialist agents, task decomposition with
dependency resolution, human-in-the-loop approval gates, pattern caching, multi-channel
messaging (Telegram/WhatsApp/Slack), and 12 MCP integrations.

For setup instructions, see **[SETUP.md](SETUP.md)**.
For production deployment, see **[DEPLOY.md](DEPLOY.md)**.
For deep technical reference, see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Message Flow

```
User ──▶ Channel Adapter ──▶ relay.ts ──▶ orchestrator.ts
              (Telegram/                       │
               WhatsApp/               ┌───────┴────────┐
               Slack)                  │   Classify      │
                                       │  (3-tier)       │
                                       └───────┬────────┘
                               ┌───────────────┼───────────────┐
                           simple          routed          complex
                               │               │               │
                        callClaude()    agent-router.ts   planner.ts
                        (+ memory        (specialist      (decompose →
                         context)         prompt)          parallel exec)
                               │               │               │
                               └───────────────┼───────────────┘
                                               │
                                      Two-Phase Execution
                                     prepare ──▶ approval ──▶ execute
                                               │
                                          Response ──▶ User
```

## Key Modules

| File | Role |
|------|------|
| `src/relay.ts` | Entry point. Channel setup, AI provider registration, message coordination, workspace management |
| `src/orchestrator.ts` | 3-tier classification, approval gates, revision sessions, pattern cache lookup |
| `src/planner.ts` | Task decomposition (LLM + deterministic plans), parallel execution, artifact aggregation |
| `src/agent-router.ts` | Agent catalog loading, tool/skill mapping, prompt construction per specialist |
| `src/memory.ts` | Intent tag parsing, context injection (facts, goals, tasks, history, schedule) |
| `src/db.ts` | Split SQLite architecture (shared.db + per-user DBs), schema, migrations |
| `src/ai-provider.ts` | Provider interface & registry (Claude, Gemini, Codex, Groq) |
| `src/ai-router.ts` | Smart routing: force override → user pref → hint → MCP dep → rate limit fallback |
| `src/patterns.ts` | Pattern caching: signature normalization, keyword overlap matching, success tracking |
| `src/channels/` | Platform adapters: telegram.ts, whatsapp.ts, slack.ts, index.ts (registry + types) |
| `src/providers/` | AI CLI wrappers: claude.ts, gemini.ts, codex.ts, groq.ts |
| `src/integrations.ts` | Per-user MCP config generation, credential management |
| `src/embeddings.ts` | Local embeddings via all-MiniLM-L6-v2, semantic search |
| `src/scheduler.ts` | Scheduled task execution (recurring, one-time, conditional) |
| `services/` | Proactive services (smart-checkin, morning-briefing, ai-news, social-post, lead-suggester, etc.) |
| `src/miniapp.ts` | Telegram Mini App backend (approval UI, dashboard) |
| `src/dashboard.ts` | Admin dashboard API |
| `src/voice-server.ts` | Voice call handling |

## Agent System

24 agents in `.claude/agents/*.md`. Each has YAML frontmatter (name, description) and a markdown body (system prompt).

Shared skill registry: `.claude/agents/shared/skills.md`

21 skills in `.claude/skills/`: ai-video-creator, canvas-design, competitive-ads-extractor, content-research-writer, customer-support, docx, email-marketing, file-organizer, ghostwriter, image-gen, lead-research-assistant, meta-ads-manager, notebooklm, pdf, platform-maker, pptx, reviews-testimonials, skill-creator, social-media-manager, telegram-file-sender, xlsx

### Agent Roster

| Slug | Name | Domain |
|------|------|--------|
| helios | Helios | Paid advertising |
| pixel | Pixel | Social media |
| kai | Kai | Content writing |
| orion | Orion | Email marketing |
| morpheus | Morpheus | Video content |
| architect | Architect | Web development |
| athena | Athena | Business strategy |
| digit | Digit | Data analytics |
| echo | Echo | Customer support |
| flux | Flux | Funnel engineering |
| quill | Quill | Grant writing |
| lex | Lex | Legal & compliance |
| helia | Helia | Public relations |
| bridge | Bridge | Partnerships |
| oracle | Oracle | Trend forecasting |
| cipher | Cipher | Data science |
| rift | Rift | Cybersecurity |
| joule | Joule | Workflow automation |
| nexus | Nexus | Community building |
| aura | Aura | Brand voice |
| zen | Zen | Productivity |
| tesseract | Tesseract | Systems thinking |
| magnus | Magnus | SEO |
| cyra | Cyra | Website optimization |

## Memory Intent Tags

Claude uses these tags in responses. Nova parses them, saves to DB, and strips before sending to user.

```
[REMEMBER: fact to store]              — save fact with embedding
[SHARE: fact]                          — save fact visible to all users
[GOAL: text | DEADLINE: date]          — save goal (deadline optional)
[DONE: search text]                    — mark matching goal completed
[TASK: agent | description]            — create agent task
[TASK_START: search text]              — mark task in_progress
[TASK_DONE: search text | result]      — mark task completed
[TASK_BLOCKED: search text | reason]   — mark task blocked
[TASK_CANCEL: search text]             — cancel task
[SCHEDULE: title | datetime | instructions]                        — one-time
[SCHEDULE: title | datetime | instructions | RECUR: rule]          — recurring
[SCHEDULE: title | datetime | instructions | RECUR: rule | IF: condition]  — conditional
[SCHEDULE_CANCEL: search text]         — cancel scheduled task
```

Recurrence DSL: `daily:HH:MM`, `weekly:DAY:HH:MM`, `weekdays:HH:MM`, `interval:SECONDS`

## Two-Phase Execution

1. **Prepare** (safe): research, write content, generate images, analyze — produces `[ARTIFACT: type | value]` tags
2. **Approval gate**: Telegram inline buttons — Approve / Revise / Cancel
3. **Execute** (consequential): publish, send emails, create campaigns, spend money — receives artifacts from prepare

Auto-approve: messages starting with "just do it", "go ahead", "ship it" skip the gate.

Revision: user taps Revise → session persisted to DB → next message treated as feedback → re-run prepare.

## Database

Split SQLite with sqlite-vec for vector search:

```
data/shared.db         — users, nova_status, logs, cost_tracking, shared memory, service_state
data/users/{id}.db     — messages, memory, tasks, approvals, revisions, scheduled_tasks, patterns
```

Embeddings: all-MiniLM-L6-v2 (384 dims), stored as Float32Array BLOBs.

## MCP Integrations

12 servers in `.mcp.json`:

| Server | Purpose |
|--------|---------|
| notion | Docs, databases, pages |
| google-workspace | Gmail, Calendar, Drive, Docs, Sheets |
| playwright | Browser automation, scraping, screenshots |
| cloudflare | Workers, DNS, edge functions |
| zoom | Meeting scheduling |
| square | POS, sales data |
| clickup | Task management |
| gohighlevel | CRM, campaigns, social publishing |
| firecrawl | Web scraping |
| tavily | Web search |
| exa | Semantic web search |
| browserbase | Cloud browser sessions |

Plus service-based MCPs: YouTube, TikTok, Zoom, Meta Social (in `services/`)

## AI Providers

| Provider | CLI | Model Tiers |
|----------|-----|-------------|
| Claude | `claude` | fast=Haiku, standard=Sonnet, premium=Opus |
| Gemini | `gemini` | fast=Flash, standard=Pro, premium=Ultra |
| Codex | `codex` | standard tier |
| Groq | API | Voice transcription (Whisper) |

Routing: force prefix (`/claude`, `/gemini`) → user default → hint-based → rate limit fallback

## Proactive Services

| Service | File | Schedule |
|---------|------|----------|
| Smart Check-in | services/smart-checkin.ts | Periodic, context-aware |
| Morning Briefing | services/morning-briefing.ts | Daily |
| AI News | services/ai-news-monitor.ts | Periodic |
| Social Post | services/social-post-suggester.ts | Periodic |
| Lead Suggester | services/lead-suggester.ts | Periodic |
| Meta Ads Report | services/meta-ads-report.ts | Daily |
| Health Monitor | services/health-monitor.ts | Periodic |
| Task Dispatcher | services/task-dispatcher.ts | Continuous |

## Executive Board (Distributed Multi-VPS)

7 executive nodes + Nova orchestrator, each on its own VPS with independent AI API keys.
All communication via shared Supabase database.

| Role | AI Provider | Persona Model | Team Priority Agents |
|------|-------------|---------------|---------------------|
| CEO | Claude | Jeff Bezos (Day-1, flywheel) | Athena, Oracle, Tesseract |
| CFO | Gemini | Patrick Campbell (unit economics) | Digit, Flux |
| CMO | Gemini | Seth Godin (Purple Cow, tribes) | Pixel, Kai, Aura, Nexus |
| CTO | Codex | Werner Vogels (everything fails) | Architect, Cipher, Rift, Joule |
| COO | Claude | Process-based (execution tracking) | Zen + monitors all |
| Research | Gemini | Ben Thompson (aggregation theory) | Oracle, Magnus, Cyra |
| Critic | Claude | Charlie Munger (inversion, pre-mortem) | Analysis-only, no dispatch |

### Key Modules

| File | Role |
|------|------|
| `src/executive-node.ts` | Entry point for exec VPS (`bun run exec --role ceo`) |
| `src/executive-handler.ts` | DM handling, board contributions, intent tag parsing |
| `src/exec-comms.ts` | Supabase REST API wrapper for inter-node communication |
| `src/board.ts` | Board meeting coordinator (convene → contribute → critique → synthesize → decide) |
| `src/coo-pipeline.ts` | COO delegation polling, agent dispatch, self-healing |
| `src/execution-engine.ts` | Autonomous project execution after board decisions |
| `src/proactive-engine.ts` | Background intelligence loop per executive |
| `.claude/agents/executives/*.md` | 7 executive agent definitions with deep personas |
| `supabase/migrations/001_executive_board.sql` | Shared Supabase schema |

### Executive Intent Tags

```
[DELEGATE: agent | task]                    — delegate to agent via COO
[DELEGATE: agent | task | PROVIDER: claude] — with provider override
[BRIEF: role | summary]                     — brief another executive
[BRIEF: all | summary]                      — broadcast to all executives
[DECISION: question | chosen | rationale | CONFIDENCE: 0.8] — record decision
```

### Board Meeting Flow

```
/board <question>  →  Convene all executives
  → Round 1: Independent analysis (each exec contributes)
  → Round 2: Critic pre-mortem (failure modes + GO/NO-GO)
  → Round 3: Nova synthesizes 3-5 options with confidence scores
  → User picks option → Decision recorded → Project created → Autonomous execution
```

### Shared Supabase Tables

exec_nodes, exec_messages, board_sessions, board_contributions,
delegations, decisions, decision_log, exec_heartbeats, projects, proactive_runs

## Conventions

- **Runtime**: Bun (`bun run start`)
- **Entry point**: `src/relay.ts` (Nova node), `src/executive-node.ts` (exec nodes)
- **Config**: `.env` for secrets, `config/profile.md` for user context, `.mcp.json` for MCP servers
- **Workspace**: `~/.nova/workspace/` (projects/, documents/, images/, media/)
- **Logs**: Console + `data/shared.db` logs table
- **Process management**: launchd (macOS), PM2 (Linux/Windows)
- **Testing**: `bun run test:telegram`, `bun run test:sqlite`, `bun run test:voice`, `bun run setup:verify`
- **Exec nodes**: `bun run exec:ceo`, `bun run exec:cfo`, etc.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (90-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk vitest run          # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->