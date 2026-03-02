# Nova

A personal AI assistant powered by Claude Code.

You message it. Claude responds. Text, photos, documents, voice. It remembers across sessions, checks in proactively, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
You ──▶ Telegram ──▶ Nova ──▶ Claude Code CLI ──▶ Response
                                  │
                            SQLite (memory)
```

## What You Get

- **AI Assistant**: Send messages on Telegram, get Claude responses back
- **Memory**: Semantic search over conversation history, persistent facts and goals via local SQLite
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals and schedule
- **Voice**: Transcribe voice messages (Groq cloud or local Whisper — your choice)
- **Always On**: Runs in the background, starts on boot, restarts on crash
- **Guided Setup**: Claude Code reads CLAUDE.md and walks you through everything

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

Claude Code reads `CLAUDE.md` and walks you through setup conversationally:

1. Create a Telegram bot via BotFather
2. Set up local SQLite database for persistent memory
3. Personalize your profile
4. Test the bot
5. Configure always-on services
6. Set up proactive check-ins and briefings
7. Add voice transcription (optional)

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
# bun run setup:launchd -- --service all    (core + checkin + briefing)
```

## Project Structure

```
CLAUDE.md                    # Guided setup (Claude Code reads this)
src/
  relay.ts                   # Core message handler
  transcribe.ts              # Voice transcription (Groq / whisper.cpp)
  memory.ts                  # Persistent memory (facts, goals, semantic search)
services/
  smart-checkin.ts           # Proactive check-ins
  morning-briefing.ts        # Daily briefing
  memory.ts                  # Memory persistence patterns
config/
  profile.example.md         # Personalization template
  schedule.example.json      # Scheduled tasks template
data/
  nova.db                    # Local SQLite database (auto-created)
setup/
  install.ts                 # Prerequisites checker
  test-telegram.ts           # Telegram connectivity test
  test-sqlite.ts             # SQLite connectivity test
  test-voice.ts              # Voice transcription test
  configure-launchd.ts       # macOS service setup
  configure-services.ts      # Windows/Linux service setup
  verify.ts                  # Full health check
daemon/
  launchagent.plist          # macOS daemon template
  nova.service               # Linux systemd template
  README-WINDOWS.md          # Windows options
```

## How It Works

Nova does three things:
1. **Listen** for Telegram messages (via grammY)
2. **Spawn** Claude Code CLI with context (your profile, memory, time)
3. **Send** the response back on Telegram

Claude Code gives you full power: tools, MCP servers, web search, file access. Not just a model — an AI with hands.

Nova remembers between sessions via a local SQLite database. Every message gets an embedding (generated locally using all-MiniLM-L6-v2) so the bot can semantically search past conversations for relevant context. It also tracks facts and goals — Claude detects when you mention something worth remembering and stores it automatically.

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

## What's Next

Nova is step one. It works standalone, forever. But it's also the foundation for something much bigger.

200+ builders are running the full version right now — their AI calls them when something is urgent, runs board meetings with six specialized agents, sends emails with approval buttons, and never goes offline.

The key: it's not just about features. It's about **mastering Claude Code** — CLAUDE.md files, MCP servers, hooks, skills. That's what turns a chatbot into real AI infrastructure. The community and course teach you that.

**[Read the full story → WHATS-NEXT.md](WHATS-NEXT.md)**

**Free course (6 lessons):** [autonomee.ai/telegram-bot-course](https://autonomee.ai/telegram-bot-course)
**Subscribe on YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Join the community:** [skool.com/autonomee](https://skool.com/autonomee)

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
