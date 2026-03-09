# Nova

A multi-agent AI orchestration platform. 24 specialist agents, task decomposition, human-in-the-loop approval, persistent memory, and multi-channel messaging — all coordinated through Telegram, WhatsApp, or Slack.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
User ──▶ Channel ──▶ relay.ts ──▶ orchestrator.ts ──▶ planner.ts
         (Telegram/                  │ classify          │ decompose
          WhatsApp/                  │ (heuristic →      │ (subtasks +
          Slack)                     │  pattern cache →   │  dependencies)
                                     │  LLM)             │
                                     ▼                   ▼
                              agent-router.ts ◀── 24 specialist agents
                                     │
                              Two-Phase Execution
                             prepare ──▶ approve ──▶ execute
                                     │
                                Response ──▶ User
```

## What You Get

- **24 Specialist Agents**: Advertising, content, email, SEO, data science, legal, PR, strategy, and more — each with dedicated tools and MCP integrations
- **Task Decomposition**: Complex requests auto-decomposed into subtasks with dependency resolution and parallel execution
- **Human-in-the-Loop**: Two-phase execution — safe work first, then approval via Telegram buttons before consequential actions
- **Pattern Learning**: Successful task plans cached and reused — skips classification on repeat requests
- **Multi-Channel**: Telegram, WhatsApp, Slack via channel adapters
- **Persistent Memory**: Local SQLite with vector search (all-MiniLM-L6-v2), semantic recall, facts, goals, scheduled tasks
- **Smart AI Routing**: Claude, Gemini, Codex — auto-selects by task type, cost tier, and rate limits
- **12 MCP Integrations**: Notion, Google Workspace, Playwright, Cloudflare, Square, GoHighLevel, and more
- **21 Skills**: Image generation, document creation (DOCX/XLSX/PPTX/PDF), canvas design, web research, and more
- **Proactive Services**: Smart check-ins, morning briefings, AI news, social post suggestions, lead generation
- **Voice**: Transcribe voice messages via Groq or local Whisper
- **Always On**: Background process with auto-restart (launchd/PM2)

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Telegram** account

### Option A: Guided Setup (Recommended)

```bash
git clone https://github.com/djbelieny/nova.git
cd nova
claude
```

Claude Code reads `CLAUDE.md` and can guide you through setup. See **[SETUP.md](SETUP.md)** for the full walkthrough.

### Option B: Manual Setup

```bash
git clone https://github.com/djbelieny/nova.git
cd nova
bun run setup          # Install deps, create .env
# Edit .env with your API keys
bun run test:telegram  # Verify bot token
bun run test:sqlite    # Verify database
bun run start          # Start the bot
```

## Commands

```bash
# Run
bun run start              # Start the bot
bun run dev                # Start with auto-reload

# Setup & Testing
bun run setup              # Install dependencies, create .env
bun run test:telegram      # Test Telegram connection
bun run test:sqlite        # Test SQLite database
bun run setup:verify       # Full health check

# Always-On Services
bun run setup:launchd      # Configure launchd (macOS)
bun run setup:services     # Configure PM2 (Windows/Linux)

# Use --service flag for specific services:
# bun run setup:launchd -- --service core
# bun run setup:launchd -- --service all
```

## Project Structure

```
src/
  relay.ts                   # Entry point — channel setup, message coordination
  orchestrator.ts            # 3-tier classification, approval gates, revision sessions
  planner.ts                 # Task decomposition, parallel execution, artifact aggregation
  agent-router.ts            # Agent catalog, tool/skill mapping, prompt construction
  memory.ts                  # Intent tags, context injection (facts, goals, tasks, history)
  db.ts                      # Split SQLite (shared.db + per-user DBs), vector search
  ai-provider.ts             # Provider interface & registry
  ai-router.ts               # Smart routing (force → preference → hint → fallback)
  patterns.ts                # Pattern caching & reuse
  channels/                  # Platform adapters (telegram, whatsapp, slack)
  providers/                 # AI CLI wrappers (claude, gemini, codex, groq)
  integrations.ts            # Per-user MCP config, credentials
  scheduler.ts               # Scheduled task execution
  embeddings.ts              # Local vector embeddings (all-MiniLM-L6-v2)
services/
  smart-checkin.ts           # Context-aware proactive check-ins
  morning-briefing.ts        # Daily summary
  ai-news-monitor.ts         # AI/tech news curation
  social-post-suggester.ts   # Social media content ideas
  lead-suggester.ts          # Business lead identification
  meta-ads-report.ts         # Daily ad performance report
  task-dispatcher.ts         # Scheduled task runner
  health-monitor.ts          # System health checks
.claude/
  agents/                    # 24 specialist agent definitions (.md)
  agents/shared/skills.md    # Shared skill registry
  skills/                    # 21 skill definitions
config/
  profile.md                 # User personalization (loaded every message)
  schedule.example.json      # Scheduled tasks template
data/
  shared.db                  # Shared database (users, logs, costs)
  users/{id}.db              # Per-user database (messages, memory, tasks)
```

## How It Works

Nova classifies every incoming message through a 3-tier system:

1. **Heuristic** — short messages (<15 words without action verbs + conjunctions) go straight to Claude
2. **Pattern Cache** — previously successful decomposition plans reused via keyword matching
3. **LLM Classification** — Sonnet classifies as simple/routed/complex

Complex tasks get decomposed into subtasks with dependencies. Independent subtasks run in parallel. Each subtask is routed to a specialist agent with its own tools and MCP access.

Consequential actions (publish, send, spend) require explicit approval via Telegram inline buttons before execution. Artifacts (images, copy, files) flow from the prepare phase to the execute phase.

## Environment Variables

See `.env.example` for all options. The essentials:

```bash
# Required
TELEGRAM_BOT_TOKEN=     # From @BotFather
TELEGRAM_USER_ID=       # From @userinfobot

# Recommended
USER_NAME=              # Your first name
USER_TIMEZONE=          # e.g., America/New_York

# Optional — Voice
VOICE_PROVIDER=         # "groq" or "local"
GROQ_API_KEY=           # For Groq (free at console.groq.com)
```

## Documentation

- **[SETUP.md](SETUP.md)** — Guided setup walkthrough (8 phases)
- **[CLAUDE.md](CLAUDE.md)** — Architecture & conventions (Claude Code reads this)
- **[DEPLOY.md](DEPLOY.md)** — Production deployment
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Deep technical reference
- **[CHANGELOG.md](CHANGELOG.md)** — Change history

## Community & Resources

- **YouTube**: [youtube.com/@GodaGo](https://youtube.com/@GodaGo) — free tutorials
- **Free Course**: [autonomee.ai/telegram-bot-course](https://autonomee.ai/telegram-bot-course)
- **Community**: [skool.com/autonomee](https://skool.com/autonomee) — full course, direct support

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
