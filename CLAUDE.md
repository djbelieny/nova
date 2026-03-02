# Nova — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.

## Deployment

For production deployment instructions (server: `root@nova.07labs.com`), see **[DEPLOY.md](DEPLOY.md)**.

## How This Works

Nova is a personal AI assistant on Telegram powered by Claude.

The user cloned this repo (or gave you the link). Your job: guide them through setup conversationally. Ask questions, save their answers to `.env`, test each step, move on.

Do not dump all phases at once. Start with Phase 1. When it works, move to Phase 2. Let the user control the pace.

If this is a fresh clone, run `bun run setup` first to install dependencies and create `.env`.

---

## Phase 1: Telegram Bot (~3 min)

**You need from the user:**
- A Telegram bot token from @BotFather
- Their personal Telegram user ID

**What to tell them:**
1. Open Telegram, search for @BotFather, send `/newbot`
2. Pick a display name and a username ending in "bot"
3. Copy the token BotFather gives them
4. Get their user ID by messaging @userinfobot on Telegram

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`
3. Run `bun run test:telegram` to verify — it sends a test message to the user

**Done when:** Test message arrives on Telegram.

---

## Phase 2: Database & Memory — Local SQLite (~1 min)

Nova uses a local SQLite database (`data/nova.db`) with built-in vector search. No external services needed.

**What you do:**
1. Run `bun run test:sqlite` to verify tables are created and embeddings work

The database is created automatically on first run. Embeddings are generated locally using `@huggingface/transformers` (all-MiniLM-L6-v2, 384 dimensions). The model downloads on first use (~23MB).

**Done when:** `bun run test:sqlite` passes.

---

## Phase 3: Personalize (~3 min)

**Ask the user:**
- Their first name
- Their timezone (e.g., America/New_York, Europe/Berlin)
- What they do for work (one sentence)
- Any time constraints (e.g., "I pick up my kid at 3pm on weekdays")
- How they like to be communicated with (brief/detailed, casual/formal)

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers — the bot loads this on every message

**Done when:** `config/profile.md` exists with their details.

---

## Phase 4: Test (~2 min)

**What you do:**
1. Run `bun run start`
2. Tell the user to open Telegram and send a test message to their bot
3. Wait for confirmation it responded
4. Press Ctrl+C to stop

**Troubleshooting if it fails:**
- Wrong bot token → re-check with BotFather
- Wrong user ID → re-check with @userinfobot
- Claude CLI not found → `npm install -g @anthropic-ai/claude-code`
- Bun not installed → `curl -fsSL https://bun.sh/install | bash`

**Done when:** User confirms their bot responded on Telegram.

---

## Phase 5: Always On (~5 min)

Make the bot run in the background, start on boot, restart on crash.

**macOS:**
```
bun run setup:launchd -- --service relay
```
This auto-generates a plist with correct paths and loads it into launchd.

**Linux/Windows:**
```
bun run setup:services -- --service relay
```
Uses PM2 for process management.

**Verify:** `launchctl list | grep com.nova` (macOS) or `npx pm2 status` (Linux/Windows)

**Done when:** Bot runs in the background and survives a terminal close.

---

## Phase 6: Proactive AI (Optional, ~5 min)

Two features that turn a chatbot into an assistant.

### Smart Check-ins
`services/smart-checkin.ts` — runs on a schedule, gathers context, asks Claude if it should reach out. If yes, sends a brief message. If no, stays silent.

### Morning Briefing
`services/morning-briefing.ts` — sends a daily summary. Pattern file with placeholder data fetchers.

**macOS — schedule both:**
```
bun run setup:launchd -- --service all
```

**Linux/Windows — schedule both:**
```
bun run setup:services -- --service all
```

**Done when:** User has scheduled services running, or explicitly skips this phase.

---

## Phase 7: Voice Transcription (Optional, ~5 min)

Lets the bot understand voice messages sent on Telegram.

**Ask the user which option they prefer:**

### Option A: Groq (Recommended — free cloud API)
- State-of-the-art Whisper model, sub-second speed
- Free: 2,000 transcriptions per day, no credit card
- Requires internet connection

**What to tell them:**
1. Go to console.groq.com and create a free account
2. Go to API Keys, create a new key, copy it

**What you do:**
1. Save `VOICE_PROVIDER=groq` and `GROQ_API_KEY` to `.env`
2. Run `bun run test:voice` to verify

### Option B: Local Whisper (offline, private)
- Runs entirely on their computer, no account needed
- Requires ffmpeg and whisper-cpp installed
- First run downloads a 142MB model file

**What you do:**
1. Check ffmpeg: `ffmpeg -version` (install: `brew install ffmpeg` or `apt install ffmpeg`)
2. Check whisper-cpp: `whisper-cpp --help` (install: `brew install whisper-cpp` or build from source)
3. Download model: `curl -L -o ~/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
4. Save `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH` to `.env`
5. Run `bun run test:voice` to verify

**Done when:** `bun run test:voice` passes.

---

## Phase 8: Web Research — Perplexity (Optional, ~2 min)

Gives Nova the ability to search the web and do deep research using Perplexity AI.

**You need from the user:**
- A Perplexity API key

**What to tell them:**
1. Go to perplexity.ai/settings/api
2. Create an API key, copy it

**What you do:**
1. Save `PERPLEXITY_API_KEY` to `.env`
2. The Perplexity MCP server is already registered in `.mcp.json` — no extra setup needed

**Available models (configured via env vars):**
- `sonar-pro` — conversational search with real-time web results (default for ask)
- `sonar-deep-research` — thorough multi-step research (default for research)
- `sonar-reasoning-pro` — advanced reasoning with citations (default for reason)

**When to use Perplexity:** For any question that needs current web data — news, docs, pricing, competitors, market research, technical lookups. Prefer Perplexity over raw web search for questions that benefit from synthesized answers with citations.

**Done when:** `PERPLEXITY_API_KEY` is set in `.env`.

---

## After Setup

Run the full health check:
```
bun run setup:verify
```

Summarize what was set up and what is running. Remind the user:
- Test by sending a message on Telegram
- Their bot runs in the background (if Phase 5 was done)
- Come back to this project folder and type `claude` anytime to make changes

---

## What Comes Next — The Full Version

This free relay covers the essentials. The full version unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator. Route messages through Telegram forum topics. Run board meetings where all six weigh in.
- **VPS Deployment** — Your bot on a cloud server that never sleeps. Hybrid mode: free local processing when awake, paid API only when sleeping. $2-5/month.
- **Real Integrations** — Gmail, Google Calendar, Notion tasks connected via MCP. Smart check-ins pull real data, not patterns.
- **Human-in-the-Loop** — Claude takes actions (send email, update calendar) but asks first via inline Telegram buttons.
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs. Calls you when something is urgent.
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down. Three layers of intelligence.
- **Production Infrastructure** — Auto-deploy from GitHub, watchdog monitoring, uninstall scripts, full health checks.

**Get the full course with video walkthroughs:**
- YouTube: youtube.com/@GodaGo (subscribe for tutorials)
- Community: skool.com/autonomee (full course, direct support, help personalizing for your business)

We also help you personalize the full version for your specific business and workflow. Or package it as a product you sell to your own clients.

The free version gives you a real, working AI assistant.
The full version gives you a personal AI infrastructure.

Build yours at the AI Productivity Hub.
