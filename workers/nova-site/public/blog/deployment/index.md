# Deploying Nova: A practical guide to self-hosting

> Self-host Nova in under 5 minutes. From the init wizard to production on a VPS, here's everything you need to know to run your own AI team on your machine, your keys, your approval gates.

*Source: https://mynova.space/blog/deployment/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

From a fresh clone to running on your machine or VPS. Learn how to initialize Nova, configure it for your AI provider and integrations, enable sandboxing, and set up the executive board — with approval gates that keep you in control.

Jake Belieny · 15 July 2026 · 10 min read

Nova is designed to be self-hosted. Your machine, your API keys, your data, your approval gates. This guide walks through every step: from the first `bash bootstrap.sh` to a production instance running on a VPS, with optional features like sandboxed execution and a distributed executive board.

Most of this takes under five minutes. The optional bits — sandboxing, multi-VPS board coordination, advanced governance — you turn on when you're ready.

## What you'll need

Before you start, gather these pieces:

#### A computer or server

macOS, Linux, or Windows via WSL2. The installer sets up everything else — the Bun runtime and the Claude Code CLI are installed for you automatically.

#### A Telegram account

Nova communicates via Telegram by default (WhatsApp and Slack also work). You'll get a bot token from @BotFather.

#### One AI provider key

Claude (recommended), Gemini, Codex, or Groq. Start with what you already use; Nova switches providers based on task type.

#### MCP credentials (optional)

Google Workspace, Notion, Cloudflare, etc. Each one adds a tool to your agents. You can skip these for now and add them later.

## The fast path: `bash bootstrap.sh`

Nova ships with a one-command installer and a guided setup wizard that asks exactly what it needs and no more. Clone the repo, run one command, and you're done in about 3 minutes:

**Quick start** 
 `git clone https://github.com/djbelieny/nova.git`

 `cd nova`

 `bash bootstrap.sh`

`bootstrap.sh` installs any missing prerequisites (Bun, the Claude Code CLI), then launches the wizard. It's resumable — close it and re-run to continue — and `bash bootstrap.sh --check` reports your system without changing anything. The wizard will ask you for:

- A Telegram bot token from @BotFather (follow the prompts)

- That's all you type for Telegram — your user ID is **detected automatically** when you message your bot (no @userinfobot step)

- Which AI provider you want to start with (Claude/Gemini/etc.)

- Your API key for that provider

- Your name and timezone (for personalization)

It writes a minimal `.env` file, creates `.mcp.json` from the example, and verifies the Telegram connection. When Nova starts, it greets you on Telegram with tappable starter ideas — so your very first interaction works without typing. Run `bun run doctor` anytime for a health check.

**That's it** You now have a working Nova instance that understands classified requests, routes to the right agent, and asks for approval before anything consequential happens.

## Configuration: Know your three files

Nova's configuration lives in three places. You rarely need to edit them directly — `bun run init` handles the basics — but understanding them helps when you want to add a feature or debug.

### .env — Secrets and API keys

Never commit this file. It holds your Telegram bot token, AI provider keys, and any third-party credentials. Start with the example:

**Essential variables** 
 TELEGRAM_BOT_TOKEN=your_token_here

 TELEGRAM_USER_ID=your_id

 ANTHROPIC_API_KEY=sk-ant-...

 USER_NAME=Jake

 USER_TIMEZONE=America/New_York

Optional variables enable features as you add them: `GROQ_API_KEY` for voice transcription, `GOOGLE_WORKSPACE_CREDS` for Gmail/Drive, `CLOUDFLARE_API_TOKEN` for workers, and so on.

### config/profile.md — Who you are

A markdown file describing your context. It gets loaded on every message so Nova understands your goals, constraints, and communication style. Fill it in once:

**Example profile.md** 
 # Your Profile

 

 Your name: Jake

 What you do: Run a SaaS company

 Your goals: 10x content output, grow to 5k newsletter subscribers

 Constraints: I have 4 hours a week free

 Timezone: America/New_York

### .mcp.json — Integrations and tools

Specifies which MCP servers Nova can connect to: Notion, Google Workspace, Playwright, Cloudflare, Square, GoHighLevel, and 12 others. The init wizard copies `.mcp.example.json` and sets up placeholders. As you add integrations, uncomment the ones you use and add credentials.

## Running Nova: Start it, keep it running

Once configured, start the bot:

**Development** 
 `bun run start`

It listens for Telegram messages. Ctrl+C to stop. Test it: send your bot a message on Telegram and wait for it to reply.

For production — so Nova runs in the background and restarts on crash — use your OS's process manager:

### macOS: launchd

**Set up and enable** 
 `bun run setup:launchd -- --service core`

This auto-generates a plist file with the right paths and loads it into launchd. Nova runs in the background, starts on boot, and restarts if it crashes. Check status with `launchctl list | grep nova`.

### Linux/Windows: PM2

**Set up and enable** 
 `bun run setup:services -- --service core`

Uses PM2 for process management. Verify with `npx pm2 status`.

## Sandboxed execution (0.2.0)

When agents run tasks, they run in your machine's memory by default. Sandboxing is optional but powerful: it runs each task in a hardened Docker container — read-only filesystem except for a per-task workspace, no access to your credentials, limited system calls.

A malicious webpage that tries to trick an agent into exfiltrating data can't escape the sandbox. And Nova stays on your subscription: instead of switching to pay-per-token billing, it shares your Claude/Gemini plan into the sandbox.

To enable sandboxing:

**Optional: Enable sandboxing** 
 `NOVA_SANDBOX_BACKEND=docker`

 Build the image: `bun run sandbox:verify`

 Set subscription mode: `NOVA_SANDBOX_SHARE_AUTH=true`

That's it. Agents now run inside a container. You can see the container logs and tune isolation as needed.

## The executive board (0.2.0)

For hard strategic questions, Nova has an optional executive board: CEO, CFO, CMO, CTO, COO, Head of Research, and a Critic. Each models a different way of thinking. They convene, give independent analysis, the Critic does a pre-mortem to surface failure modes, and Nova synthesizes options with confidence scores.

The board can run on a single VPS or distributed across 7 separate machines. All 7 executives coordinate through a shared Postgres database.

### Single-VPS board setup

Run Postgres locally and register it:

**Board database** 
 `bash deploy/board/setup.sh`

 Set in .env: `BOARD_DB_URL=postgres://...your-local-db...`

Then start the executive services:

**Enable executives** 
 `bun run setup:launchd -- --service all`

Seven new launchd services start: `nova-exec-ceo`, `nova-exec-cfo`, and so on. Each one can receive DMs on Telegram (or run autonomously with rate limiting).

### Multi-VPS board (advanced)

Deploy a PostgREST API on one VPS and point each executive node to it. Each executive runs in a separate container with its own AI provider key. They coordinate entirely through the shared database. This is optional and only worth doing if you need the executives to run independently and scale.

## Governance: Approval gates and earned autonomy

Out of the box, Nova always asks before it publishes, sends, or spends. You tap Approve/Revise/Cancel on Telegram inline buttons.

As an agent builds a clean track record, it graduates: first to *notify you after*, then to *fully autonomous within a spending cap*. One failure and it drops back to asking. You manage autonomy levels from a dashboard:

**Governance dashboard** 
 `GET /governance`

 View and adjust autonomy levels per agent

 Set spending budgets

 Review the audit ledger

Every action is logged: who ran what, at what cost, whether it succeeded. You can reverse any decision, adjust trust levels, and see a full history.

## Security checklist

Before you trust Nova with real work:

**Before production** 
 Never commit .env or .mcp.json with real credentials

 Set TELEGRAM_USER_ID so only you can message the bot

 Use a strong Telegram bot token (if exposed, regenerate from @BotFather)

 If using sandboxing, verify the Docker image builds and runs

 Test the approval flow on a low-stakes task first

 Review the audit ledger for the first week of use

 Enable spending caps on agents that touch billing APIs

Nova's approval gates, sandboxing, and audit trails are designed to make consequences reversible. But the starting position is always "ask first, then execute" — you stay in control.

## Next: Run it, build on it

You now have everything you need to run Nova on your machine or on a VPS. Send it a message and watch it work. Turn on sandboxing and the executive board when you're ready. Adjust autonomy levels as you trust it more. Add MCP integrations as you need them.

Nova is MIT licensed. Read the code, fork it, customize agents, add your own tools. It's your team now.
