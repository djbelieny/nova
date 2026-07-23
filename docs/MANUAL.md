# Nova — Complete Admin & User Manual

> **Version:** Production (April 2026)  
> **Runtime:** Bun · TypeScript · SQLite  
> **Channels:** Telegram · WhatsApp · Slack · Voice · Web Widget

---

## Table of Contents

### Part I — Admin Manual
1. [Architecture Overview](#1-architecture-overview)
2. [System Requirements](#2-system-requirements)
3. [Installation](#3-installation)
4. [Environment Configuration](#4-environment-configuration)
5. [Starting & Managing Services](#5-starting--managing-services)
6. [Executive Board Setup](#6-executive-board-setup)
7. [CS/SDR Mode Setup](#7-cssdr-mode-setup)
8. [The Web Dashboard](#8-the-web-dashboard)
9. [Database & Backups](#9-database--backups)
10. [Health Monitoring & Alerts](#10-health-monitoring--alerts)
11. [Deploying Updates](#11-deploying-updates)
12. [Troubleshooting](#12-troubleshooting)

### Part II — User Manual
13. [Getting Started](#13-getting-started)
14. [Talking to Nova](#14-talking-to-nova)
15. [Memory & Context](#15-memory--context)
16. [Goals](#16-goals)
17. [Task Management](#17-task-management)
18. [Scheduling](#18-scheduling)
19. [The 24 Specialist Agents](#19-the-24-specialist-agents)
20. [Approval Gates](#20-approval-gates)
21. [Developer Mode](#21-developer-mode)
22. [Voice Calls](#22-voice-calls)
23. [File & Media Handling](#23-file--media-handling)
24. [Usage & Cost Tracking](#24-usage--cost-tracking)
25. [Executive Board](#25-executive-board)
26. [Command Reference](#26-command-reference)
27. [Workboards](#27-workboards)

---

# Part I — Admin Manual

---

## 1. Architecture Overview

Nova is a **multi-agent AI orchestration platform** built on Bun. A single `relay.ts` process handles all incoming messages, classifies them into one of three tiers, and routes them to the appropriate execution path.

```
User Message (any channel)
         │
         ▼
     relay.ts                 ← Entry point. Manages channels, rate limiting,
         │                      command handling, and message routing.
         ▼
  orchestrator.ts             ← 3-tier classification:
    ├── Simple → callClaude()   Simple conversational replies
    ├── Routed → agent-router   Specialist agent (Helios, Pixel, Echo, etc.)
    └── Complex → planner.ts   Decomposed multi-agent parallel execution
         │
         ▼
  Two-Phase Execution
    Prepare (safe: research, generate, draft)
         │
    Approval Gate (Telegram inline buttons)
         │
    Execute (consequential: publish, send, spend)
```

**Key processes running in production:**

| Process | File | Purpose |
|---------|------|---------|
| `nova-relay` | `src/relay.ts` | Main bot process — all user interactions |
| `nova-dashboard` | `src/dashboard.ts` | Admin REST API (port 3033) |
| `nova-voice` | `src/voice-server.ts` | Twilio voice call handler |
| `nova-memwright` | memwright service | Vector memory store |
| `nova-exec-*` | `src/executive-node.ts` | 7 executive board nodes (CEO, CFO, CMO, CTO, COO, Research, Critic) |

**Data storage:**

```
data/
  shared.db        — Users, logs, cost tracking, CS tables, shared memory
  users/{id}.db    — Per-user messages, memory, tasks, approvals, patterns
  memwright/       — Vector memory store (managed by nova-memwright)
~/.nova/
  workspace/       — Agent working directory (files, images, projects)
  skills/learned/  — Auto-generated skills from repeated patterns
  backups/         — Daily backup archives
```

---

## 2. System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Ubuntu 22.04 / macOS 13 | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| Disk | 10 GB | 40 GB |
| CPU | 2 cores | 4 cores |
| Bun | 1.3+ | Latest |
| Node.js | 20+ (for some tools) | 22 LTS |
| Claude CLI | Latest | Latest |
| Gemini CLI | Latest (optional) | Latest |

**Required external accounts:**
- Anthropic (Claude API + CLI authentication)
- Telegram Bot (via [@BotFather](https://t.me/BotFather))

**Optional external accounts:**
- Google Gemini API
- Groq (voice transcription)
- GoHighLevel CRM (CS escalation)
- Meta Business (WhatsApp / Instagram / Facebook CS channels)
- Twilio (voice calls)
- ElevenLabs (text-to-speech)

---

## 3. Installation

### Fresh Install

```bash
# 1. Clone the repository
git clone https://github.com/your-username/nova /opt/nova
cd /opt/nova

# 2. Run the bootstrap installer (interactive)
bash bootstrap.sh
```

The bootstrap script handles: dependency installation, Claude CLI authentication, database initialization, systemd/launchd service registration, and first-run verification.

### Manual Steps (if bootstrap fails)

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
nano .env   # Fill in required values

# Initialize database
bun run src/db.ts

# Start services
systemctl start nova-relay nova-dashboard
```

### Verifying Installation

```bash
# Check all services are running
systemctl status nova-relay nova-dashboard nova-memwright

# Check logs
journalctl -u nova-relay -f

# Send /start to your Telegram bot to confirm it responds
```

---

## 4. Environment Configuration

The `.env` file at `/opt/nova/.env` controls all Nova behavior. Settings are grouped below by priority.

### Required

```bash
# Telegram — primary user channel
TELEGRAM_BOT_TOKEN=         # From @BotFather — /newbot
TELEGRAM_USER_ID=           # Your Telegram user ID (get from @userinfobot)

# Security — database encryption key
NOVA_ENCRYPTION_KEY=        # Generate: openssl rand -hex 32
                            # Nova will NOT start without this
```

### Strongly Recommended

```bash
# Your identity
USER_NAME=                  # Your first name (Nova uses this in messages)
USER_TIMEZONE=              # IANA timezone, e.g. America/New_York

# Dashboard access (enables admin UI)
DASHBOARD_USER=admin
DASHBOARD_PASS=             # Any secure password
DASHBOARD_PUBLIC_URL=       # Public HTTPS URL for remote access (e.g. https://yourdomain.com)
```

### AI Providers

```bash
# Gemini (enables provider routing and fallback)
GEMINI_API_KEY=

# Groq (enables free voice transcription)
GROQ_API_KEY=

# ElevenLabs (enables voice responses)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=        # Default: George
```

### Voice Calls (Twilio)

```bash
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=        # Your Twilio number in E.164 format
USER_PIN=                   # 4-6 digit PIN for call authentication
USER_PHONE=                 # Your personal phone number
VOICE_SERVER_PORT=80
VOICE_SERVER_URL=           # Public URL (must be reachable by Twilio)
```

### WhatsApp & Slack

```bash
# WhatsApp — configured via Meta Business
# Slack — for team/workspace access
SLACK_BOT_TOKEN=            # xoxb-...
SLACK_APP_TOKEN=            # xapp-... (Socket Mode)
```

### OAuth Integrations

```bash
# Google (Gmail, Calendar, Drive, Docs, Sheets, YouTube)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Notion
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=

# Zoom
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=

# TikTok
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

### CS/SDR Mode

```bash
# Web chat widget (port 3001 by default)
CS_WIDGET_PORT=3001

# Public Telegram CS bot (separate from private bot)
CS_TELEGRAM_BOT_TOKEN=     # Create a second bot via @BotFather

# Meta (covers WhatsApp Business, Instagram DMs, Facebook Messenger)
META_VERIFY_TOKEN=          # Any secret string you choose
META_APP_SECRET=            # From your Meta App dashboard
META_PAGE_ACCESS_TOKEN=     # From Meta App → Messenger/Instagram settings
META_WHATSAPP_PHONE_NUMBER_ID=
META_INSTAGRAM_PAGE_ID=

# GoHighLevel (for escalation ticket creation)
GHL_API_KEY=
GHL_LOCATION_ID=
```

### Executive Board (Multi-VPS)

```bash
# Each executive node needs these on its own VPS:
EXEC_ROLE=ceo               # ceo | cfo | cmo | cto | coo | research | critic
EXEC_NODE_ID=               # Unique identifier for this node

# Shared Supabase database (connects all nodes)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=      # Service role key (required — board tables use RLS)
```

---

## 5. Starting & Managing Services

### Linux (systemd)

```bash
# Start all Nova services
systemctl start nova-relay nova-dashboard nova-memwright nova-voice

# Stop all services
systemctl stop nova-relay nova-dashboard

# Restart a specific service (e.g. after config change)
systemctl restart nova-relay

# View live logs
journalctl -u nova-relay -f
journalctl -u nova-dashboard -f

# Enable auto-start on server reboot
systemctl enable nova-relay nova-dashboard nova-memwright
```

### macOS (launchd)

```bash
# Load all services
launchctl load ~/Library/LaunchAgents/com.nova.relay.plist
launchctl load ~/Library/LaunchAgents/com.nova.dashboard.plist

# Unload a service
launchctl unload ~/Library/LaunchAgents/com.nova.relay.plist

# View logs
tail -f ~/.nova/logs/relay.log
```

### Manual (development)

```bash
# Start relay (main process)
bun run start

# Start dashboard
bun run dashboard

# Run an executive node
bun run exec:ceo
bun run exec:cfo
# etc.
```

---

## 6. Executive Board Setup

The Executive Board is a distributed system of 7 AI nodes, each with a distinct executive persona. They communicate via a shared Supabase database, hold board meetings when strategic questions arise, and autonomously delegate work to Nova's 24 agents.

### Board Members

| Role | Persona Model | Primary Agents |
|------|--------------|----------------|
| CEO | Jeff Bezos (Day-1, flywheel thinking) | Athena, Oracle, Tesseract |
| CFO | Patrick Campbell (unit economics) | Digit, Flux |
| CMO | Seth Godin (Purple Cow, tribes) | Pixel, Kai, Aura, Nexus |
| CTO | Werner Vogels (everything fails) | Architect, Cipher, Rift, Joule |
| COO | Process-focused (execution tracking) | Zen + monitors all |
| Research | Ben Thompson (aggregation theory) | Oracle, Magnus, Cyra |
| Critic | Charlie Munger (inversion, pre-mortem) | Analysis only — never delegates |

### Deploying Executive Nodes

Each node runs on its own VPS. Minimum setup per node:

```bash
# On each executive VPS:
git clone https://github.com/your-username/nova /opt/nova-exec
cd /opt/nova-exec
bun install

# .env for the CEO node:
EXEC_ROLE=ceo
TELEGRAM_BOT_TOKEN=         # Same as main Nova (or dedicated bot)
TELEGRAM_USER_ID=           # Owner's Telegram ID
SUPABASE_URL=               # Shared Supabase project URL
SUPABASE_SERVICE_ROLE_KEY=  # Shared Supabase service role key (required — board tables use RLS)

# Start
systemctl start nova-exec-ceo
```

### Running a Board Meeting

Send `/board <strategic question>` to your private Nova bot:

```
/board Should we launch a paid tier at $99/mo or $299/mo?
```

**What happens:**
1. All 7 executives contribute independent analysis (Round 1)
2. The Critic runs a pre-mortem — what could go wrong? GO/NO-GO (Round 2)
3. Nova synthesizes 3–5 options with confidence scores (Round 3)
4. You choose an option
5. Decision is recorded → project created → COO delegates execution to agents

**Intent tags for executives** (usable in messages to exec nodes):
```
[DELEGATE: agent | task]              — Have COO delegate to a specialist agent
[BRIEF: cto | summary]                — Send a briefing to a specific executive
[BRIEF: all | summary]                — Broadcast to all executives
[DECISION: question | chosen | rationale | CONFIDENCE: 0.9]
```

---

## 7. CS/SDR Mode Setup

CS/SDR mode creates a public-facing customer service layer across 5 channels. Customers interact with a configurable AI persona (default: "Maya") grounded in your knowledge base documents. Nova never exposes private data or commands to CS users.

### Enabling CS Mode

CS mode activates automatically when any of these env vars are set in `.env`:

```bash
CS_WIDGET_PORT=3001          # Enables web chat widget
CS_TELEGRAM_BOT_TOKEN=       # Enables public Telegram CS bot
META_VERIFY_TOKEN=           # Enables Meta webhook (WhatsApp/Instagram/Facebook)
```

Restart `nova-relay` after adding these.

### Channel Setup

#### Web Chat Widget

Embed on any website with a single script tag:

```html
<script 
  src="https://your-server.com:3001/cs-widget.js"
  data-name="Support"
  data-color="#0066FF"
  data-position="bottom-right">
</script>
```

| Attribute | Default | Options |
|-----------|---------|---------|
| `data-name` | "Support" | Any text |
| `data-color` | `#0066FF` | Any hex color |
| `data-position` | `bottom-right` | `bottom-right`, `bottom-left` |

The widget connects via WebSocket. Sessions persist in `localStorage` across page refreshes.

#### Public Telegram CS Bot

1. Create a new bot via [@BotFather](https://t.me/BotFather): `/newbot`
2. Copy the token to `CS_TELEGRAM_BOT_TOKEN` in `.env`
3. Share the bot link with customers: `t.me/yourbotusername`

This bot is **completely separate** from your private Nova bot.

#### Meta (WhatsApp + Instagram + Facebook Messenger)

1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com)
2. Add Messenger, Instagram, and WhatsApp products to the app
3. Set webhook URL: `https://your-server.com:3001/cs/meta/webhook`
4. Set verify token: match `META_VERIFY_TOKEN` in `.env`
5. Subscribe to `messages` events for all three products
6. Copy `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_INSTAGRAM_PAGE_ID` to `.env`

### Building the Knowledge Base

All CS responses are grounded in documents you upload. Nova will only answer from this content — it won't hallucinate.

1. Open the **Dashboard** → **Knowledge Base** section
2. Upload documents: PDF, DOCX, TXT, or Markdown
3. Wait for status to show **Ready** (processing takes 10–60 seconds per document)
4. Test: send a question to your CS channel and verify the answer comes from the document

**What to upload:**
- Product catalog or price list
- FAQ document
- Shipping/returns policy
- Service descriptions
- Onboarding guides

**Confidence threshold:** Nova requires ≥ 65% cosine similarity to answer from the knowledge base. Below this, it escalates to your team rather than guessing.

### Configuring the CS Persona

Open **Dashboard** → **CS Settings**:

| Field | Description |
|-------|-------------|
| Business Name | Shown in greetings and system prompt |
| Agent Name | The persona name customers see (e.g. "Maya", "Alex") |
| Greeting | Opening message sent at conversation start |
| Tone | `friendly` (default), `formal`, or `casual` |
| Response Length | `concise`, `balanced` (default), or `detailed` |
| Escalation SLA | Text shown when escalating (e.g. "within 4 hours") |
| Fallback Message | Shown when no KB answer is found before escalating |
| Business Hours | Optional — mentioned in escalation messages |
| Widget Color | Hex color for the web widget bubble |

### Escalation Waterfall

When Nova can't answer (2 consecutive KB misses) or detects frustration:

1. **Nova asks for contact info:** "Could I get your name and email address?"
2. **Customer provides email →** GoHighLevel contact + support ticket created
3. **You receive a Telegram DM:**
   ```
   🆘 CS Escalation — John Smith via whatsapp
   📧 john@example.com
   💬 "My order hasn't arrived..."
   🆔 Session: abc123
   ```
4. **Reply to the Telegram notification** → your message is forwarded to the customer on their original channel (live handoff)

**Frustration triggers automatic escalation:** "speak to a human", "this is useless", "supervisor", "real person", "I give up", and similar phrases.

---

## 8. The Web Dashboard

The dashboard provides a visual admin interface for managing Nova's agents, tasks, and integrations.

**URL:** `http://your-server:3033` (local) or set `DASHBOARD_PUBLIC_URL` for remote access  
**Authentication:** Set `DASHBOARD_USER` + `DASHBOARD_PASS` in `.env`

### Sections

| Section | Features |
|---------|----------|
| **Kanban** | All agent tasks by status (pending → in_progress → completed) |
| **Agents** | Agent registry, tool access per agent |
| **History** | Full message history with search |
| **CS Sessions** | Active CS conversations, transcripts, escalation log |
| **Alerts** | Configure cost/error rate/downtime alert rules |
| **Health** | Live service health status (`GET /health`) |
| **Memory** | View and search stored facts and context |
| **Schedule** | View and manage scheduled tasks |
| **Integrations** | Manage OAuth connections (Google, Notion, Zoom, TikTok) |

---

## 9. Database & Backups

### Database Structure

Nova uses split SQLite with vector extension:

```
data/shared.db       — Users, logs, cost tracking, all CS tables
data/users/{id}.db   — Per-user: messages, memory, tasks, approvals, patterns
```

### Manual Backup

```bash
bun run scripts/backup.ts
```

Creates: `~/.nova/backups/nova-YYYY-MM-DDTHH-MM-SS.tar.gz`  
Contains: `data/`, `config/`, `.env`  
Retention: last 7 backups

### Automatic Backup

Backups run daily at 2:00 AM (configured by `setup/configure-launchd.ts` on macOS and `setup/configure-systemd.ts` on Linux). Verify the cron job is registered:

```bash
# Linux
systemctl status nova-backup.timer

# macOS  
launchctl list | grep nova-backup
```

### Restoring from Backup

```bash
# Stop Nova
systemctl stop nova-relay nova-dashboard

# Extract backup
tar -xzf ~/.nova/backups/nova-2026-04-24T02-00-00.tar.gz -C /tmp/nova-restore

# Restore files
cp -r /tmp/nova-restore/data/* /opt/nova/data/
cp /tmp/nova-restore/.env /opt/nova/.env

# Restart
systemctl start nova-relay nova-dashboard
```

---

## 10. Health Monitoring & Alerts

### Health Endpoint

```
GET /health   (port 3033)
```

Returns `200 OK` if:
- Database is accessible
- Last message was processed within 5 minutes
- Claude CLI is responsive

Returns `503 Service Unavailable` if any check fails.

### Automatic Health Monitor

`services/health-monitor.ts` polls `/health` every 2 minutes. After 3 consecutive failures, it sends you a Telegram DM:

```
⚠️ Nova health check failed 3 times in a row.
Last checked: 14:32:01
Error: Database not responding
```

It also sends a recovery notification when Nova comes back online.

### Alert Rules

Configure in **Admin Dashboard → Alerts**:

| Rule Type | Example |
|-----------|---------|
| Cost threshold | Alert when daily spend exceeds $5 |
| Error rate | Alert when error rate exceeds 10% |
| Service down | Alert when health check fails |

Alert rules are checked every 5 minutes. Notifications go to your owner Telegram DM.

### Log Rotation

**Linux:** `setup/logrotate.conf` is installed to `/etc/logrotate.d/nova` — rotates daily, keeps 7 days, compressed.

**macOS:** Configured via `StandardOutPath`/`StandardErrorPath` in launchd plists.

---

## 11. Deploying Updates

```bash
# On your local machine:
git push origin main

# Merge to production branch
git checkout production
git merge main --no-ff
git push origin production

# Trigger deployment on server
ssh root@your-server.com "bash /opt/nova/scripts/deploy.sh"
```

The deploy script:
1. Pulls the latest `production` branch
2. Runs `bun install` (installs any new dependencies)
3. Reloads cron schedules
4. Restarts all Nova services

**Zero-downtime note:** `nova-relay` restart takes ~2 seconds. Messages received during restart are queued by Telegram and delivered when the bot reconnects.

---

## 12. Troubleshooting

### Nova doesn't respond to messages

```bash
# 1. Check relay is running
systemctl status nova-relay

# 2. Check for startup errors
journalctl -u nova-relay -n 50

# 3. Common cause: missing NOVA_ENCRYPTION_KEY
echo $NOVA_ENCRYPTION_KEY   # Should not be empty

# 4. Check Claude CLI is authenticated
claude --version
claude "hello"   # Should produce a response
```

### "NOVA_ENCRYPTION_KEY not set" error

```bash
# Generate a key
openssl rand -hex 32

# Add to .env
echo "NOVA_ENCRYPTION_KEY=<generated_key>" >> /opt/nova/.env

# Restart
systemctl restart nova-relay
```

### Database errors on startup

```bash
# Check database file exists and is readable
ls -la /opt/nova/data/shared.db

# Check sqlite-vec extension is available
bun run -e "const db = require('better-sqlite3')('./data/shared.db'); db.loadExtension('./node_modules/sqlite-vec/index.node');"

# Re-initialize schema (non-destructive — CREATE TABLE IF NOT EXISTS)
bun run src/db.ts
```

### CS widget not loading

```bash
# Check CS server is running (port 3001)
ss -tlnp | grep 3001

# Test the widget endpoint
curl http://localhost:3001/cs-widget.js | head -5

# Check CS_WIDGET_PORT is set in .env
grep CS_WIDGET_PORT /opt/nova/.env
```

### Meta webhook not receiving events

1. Verify `META_VERIFY_TOKEN` matches what's set in the Meta App dashboard
2. Test verification: `curl "https://your-server.com:3001/cs/meta/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=test"`  — should return `test`
3. Ensure port 3001 is open in your firewall and accessible from the internet
4. Check the Meta App webhook subscriptions include `messages`

### High memory usage

```bash
# Check which process is using most memory
ps aux --sort=-%mem | head -10

# nova-relay handles all embeddings — normal is 200-500 MB
# If > 1 GB, restart and check for memory leaks
systemctl restart nova-relay
```

### Gemini CLI not authenticated

```bash
gemini auth login
# Follow the OAuth flow
# Test: gemini "hello"
```

---

# Part II — User Manual

---

## 13. Getting Started

### First Message

Send `/start` to your Nova bot on Telegram. Nova will:
1. Welcome you by name (from `USER_NAME` in config)
2. Show you what it can do
3. Offer a quick tour

From that point, just **talk to Nova naturally**. No need to memorize commands for most things — Nova understands plain English.

### How Nova Decides What to Do

Every message is classified into one of three paths:

| Tier | Examples | What happens |
|------|----------|-------------|
| **Simple** | "What time is it in Tokyo?" "Summarize this article" | Nova answers directly using Claude |
| **Routed** | "Help me write Instagram captions" "Analyze my ad performance" | Specialist agent handles it (Helios, Pixel, Kai, etc.) |
| **Complex** | "Build me a lead generation campaign" "Research competitors and write a report" | Task decomposed into parallel steps, agents collaborate |

Complex tasks use a **two-phase execution** model — Nova prepares everything first, shows you what it plans to do, and only executes (publish, send, spend) after you approve.

---

## 14. Talking to Nova

### Plain Conversation

Just type naturally:

```
What should I focus on today?
Summarize the email from John I just got
Help me respond to this customer complaint: [paste text]
What are the best practices for cold email subject lines?
```

### Directing to a Specific Agent

Prefix your message with the agent's name or role:

```
Pixel, create a week of Instagram content for my coffee shop
Helios, audit my Facebook ad campaigns
Echo, help me write a response to an angry customer review
Lex, review this contractor agreement
```

Or use the `/agents` command to browse and select from the full list.

### Forcing a Specific AI Provider

```
/claude What is the capital of France?
/gemini Translate this to Japanese: [text]
```

### Multi-Turn Conversations

Nova maintains context within a session. You can refer back to previous messages:

```
You: Write me a blog post about remote work productivity
Nova: [writes post]
You: Make it shorter and add a section on async communication
Nova: [updates post]
You: Change the tone to be more casual
Nova: [adjusts tone]
```

---

## 15. Memory & Context

Nova remembers things across sessions. You can explicitly tell it what to remember, or it infers important facts automatically.

### Saving Facts

```
Remember that my main client is TechCorp and they're on a $5,000/month retainer
Remember I prefer bullet-point summaries over paragraphs
Remember my preferred posting time is 9am EST
```

Nova uses the intent tag `[REMEMBER: fact]` internally when it identifies information worth storing.

### Viewing Your Memory

```
/memory
```

Shows your stored facts with delete buttons. The Dashboard Memory section provides a searchable view.

### Sharing Facts with All Users

If you're using Nova with a team:
```
Share: Our company's brand colors are #FF6B35 (orange) and #1A1A2E (navy)
```

This fact becomes visible to all users in your Nova instance.

### What Nova Automatically Remembers

- Your name, timezone, and preferences
- Information you mention repeatedly
- Your goals and their progress
- Recurring patterns in how you work

---

## 16. Goals

Goals are objectives Nova tracks and works toward over time.

### Setting a Goal

```
Goal: Launch the new product landing page by May 1st
Goal: Grow Instagram following to 10,000 by end of quarter
Set a goal to close 5 new clients this month | Deadline: April 30
```

### Viewing Goals

```
/goals
```

Shows active goals with deadlines and progress. Goals with deadlines close to expiry are surfaced in Nova's morning briefings.

### Marking a Goal Complete

```
Done: Launch the new product landing page
```

Or tap the checkmark button next to a goal in `/goals`.

### Goal-Driven Proactive Messages

When Nova notices something relevant to your active goals (a news article, a tool, a suggested action), it may send you a proactive message. These are throttled to avoid noise — max 3 per day.

---

## 17. Task Management

Tasks are discrete work items assigned to specific agents. Nova creates them automatically when it decomposes a complex request, or you can create them manually.

### Creating a Task

```
Task: Helios — Audit the Q1 ad campaigns and create a performance report
Task: Kai — Write 10 email subject line variations for the spring sale
```

### Viewing Tasks

```
/tasks
```

Shows pending, in-progress, and recently completed tasks. Tap a task to see its full details and output.

### Intent Tags for Tasks

When using agents, Nova uses these tags internally:

| Tag | Meaning |
|-----|---------|
| `[TASK: agent \| description]` | Create a task |
| `[TASK_START: description]` | Mark in progress |
| `[TASK_DONE: description \| result]` | Mark complete |
| `[TASK_BLOCKED: description \| reason]` | Flag a blocker |
| `[TASK_CANCEL: description]` | Cancel a task |

---

## 18. Scheduling

Nova can schedule tasks to run at specific times or on a recurring basis.

### One-Time Schedule

```
Schedule a morning briefing for tomorrow at 8am
Remind me to follow up with TechCorp on Friday at 2pm EST
```

### Recurring Schedule

```
Every Monday at 9am, pull my weekly metrics from Google Sheets and send me a summary
Daily at 7am, check my calendar and brief me on the day
Every weekday at 5pm, ask me what I accomplished today
```

### Conditional Schedule

```
Every day at 10am, if I have any unread Slack messages from the team, summarize them
```

### Viewing & Managing Schedules

```
/schedule
/schedule list
```

Shows all active schedules with cancel buttons. The Dashboard **Schedule section** provides a full list with a create form and human-readable recurrence picker.

### Schedule Recurrence DSL (for advanced use)

```
daily:HH:MM              e.g.  daily:08:00
weekly:DAY:HH:MM         e.g.  weekly:Monday:09:00
weekdays:HH:MM           e.g.  weekdays:17:00
interval:SECONDS         e.g.  interval:3600  (every hour)
```

### Cancelling a Schedule

```
/schedule list
```
Then tap the **Cancel** button next to the schedule. Or:
```
Cancel the schedule for the weekly metrics report
```

---

## 19. The 24 Specialist Agents

Nova has 24 specialist agents, each with deep expertise in their domain. Nova routes to the right agent automatically, or you can invoke them directly.

### Marketing & Content

| Agent | Trigger | Specialties |
|-------|---------|-------------|
| **Helios** | "my ads", "campaigns", "ROAS" | Google Ads, Facebook Ads, LinkedIn Ads, budget optimization |
| **Pixel** | "Instagram", "social media", "TikTok" | Content strategy, captions, community management, trends |
| **Kai** | "write", "blog", "copy", "content" | Brand storytelling, SEO content, ghostwriting, tone |
| **Orion** | "email", "newsletter", "sequence" | Email campaigns, automation sequences, segmentation |
| **Morpheus** | "video", "script", "YouTube" | Video strategy, scriptwriting, storyboards, thumbnails |
| **Aura** | "brand voice", "tone of voice", "identity" | Brand personality, messaging frameworks |
| **Magnus** | "SEO", "keywords", "search ranking" | On-page SEO, link building, technical SEO, content strategy |

### Business Strategy

| Agent | Trigger | Specialties |
|-------|---------|-------------|
| **Athena** | "strategy", "business plan", "SWOT" | Market analysis, competitive intelligence, frameworks |
| **Oracle** | "trends", "future", "forecast" | Trend forecasting, scenario planning, innovation |
| **Tesseract** | "systems", "complex problems", "root cause" | Systems thinking, causal loops, leverage points |
| **CFO** | "finances", "unit economics", "pricing" | Budget, ROI analysis, pricing strategy |
| **Flux** | "funnel", "conversion", "landing page" | CRO, offer sequencing, A/B test design |

### Operations & Tech

| Agent | Trigger | Specialties |
|-------|---------|-------------|
| **Architect** | "build", "code", "website", "app" | Full-stack development, technical architecture, debugging |
| **Cipher** | "data", "analysis", "ML", "statistics" | Data science, predictive modeling, Python analysis |
| **Rift** | "security", "vulnerability", "audit" | Cybersecurity audits, incident response |
| **Joule** | "automate", "workflow", "Zapier", "integrate" | Workflow automation, API integrations |
| **Digit** | "dashboard", "KPIs", "metrics", "analytics" | Business intelligence, reporting, data storytelling |
| **Zen** | "productivity", "focus", "habits", "schedule" | Time management, workflow optimization |

### Customer & Community

| Agent | Trigger | Specialties |
|-------|---------|-------------|
| **Echo** | "customer service", "support", "complaint" | Support responses, de-escalation, FAQ development |
| **Nexus** | "community", "Discord", "engagement" | Community building, moderation, platform selection |
| **Bridge** | "partnerships", "collaborations", "deals" | Partner identification, outreach, deal structuring |
| **Helia** | "PR", "press release", "media", "crisis" | Public relations, media outreach, crisis communications |
| **Quill** | "grant", "proposal", "funding" | Grant writing, business proposals, funding research |
| **Lex** | "legal", "contract", "compliance", "GDPR" | Contract review, data privacy, IP, risk assessment |
| **Cyra** | "website audit", "UX", "SEO", "conversions" | Site optimization, UX feedback, CRO |

### Browsing All Agents

```
/agents
```

Shows all 24 agents with descriptions and a **Use [Agent Name]** button that routes your next message directly to that agent.

---

## 20. Approval Gates

For consequential actions (publishing, sending emails, running ads, spending money), Nova uses a two-phase system:

**Phase 1 — Prepare:** Nova researches, drafts content, generates images, and prepares everything. No external action is taken.

**Phase 2 — Approve:** Nova presents what it's about to do with three buttons:
- ✅ **Approve** — Execute the action
- ✏️ **Revise** — Provide feedback; Nova revises and re-presents
- ❌ **Cancel** — Abandon the task

### Skipping the Approval Gate

Prefix your message with any of these to execute immediately without review:

```
Just do it: [your request]
Go ahead and [your request]
Ship it: [your request]
```

Use this only for low-stakes tasks where you trust Nova's judgment.

### Revision Flow

When you tap **Revise**:
1. Your next message is treated as feedback
2. Nova re-runs the preparation phase with your feedback incorporated
3. The updated proposal is presented again for approval

You can revise as many times as needed before approving.

### Approval Expiry

Pending approvals expire after **24 hours**. Expired approvals are automatically cancelled and you are notified.

---

## 21. Developer Mode

Nova can work as a background developer — accepting coding tasks, working in an isolated git workspace, and delivering completed diffs to you via Telegram.

### Registering a Codebase

```
/codebase add myapp /path/to/local/repo
/codebase add myapp https://github.com/user/myapp
/codebase list
/codebase remove myapp
```

### Queueing a Dev Task

```
/devtask fix the null pointer error in the user authentication flow
/devtask add input validation to the contact form
/devtask refactor the database connection pooling
```

If you have multiple codebases registered, Nova shows a picker so you can choose which project to work on.

### Natural Language Dev Detection

If you have codebases registered, Nova automatically detects when your message sounds like a coding request and asks:

```
🤔 That sounds like a dev task. Queue it for background work?
[✅ Yes, queue it]  [❌ No, answer normally]
```

### How It Works

1. Task is queued immediately — you get a confirmation
2. Nova starts within 30 seconds, sends: "🔧 Starting dev task: *your description*"
3. Every 3 minutes while working: "⏳ Still working on: *your description*..."
4. On completion:
   ```
   ✅ Dev task complete: fix null pointer in auth flow
   
   📁 Branch: `nova/task-a1b2c3d4`
   📊 Changes:
   src/auth.ts | 12 +-
   
   🧪 Tests: 47 passed, 0 failed
   
   Review with: `git diff main...nova/task-a1b2c3d4`
   ```

Nova works on a separate git branch (`nova/task-{id}`). Your main branch is never touched.

### Concurrent Tasks

Nova processes one dev task per codebase at a time. If you queue a second task on the same codebase while one is in progress, it waits in the queue automatically.

### Using the [DEVTASK:] Tag

In any conversation, Claude can queue dev tasks using the intent tag:

```
[DEVTASK: myapp | implement the password reset endpoint]
```

This is useful when a conversation leads to a coding decision — Nova can immediately queue the implementation without switching to the /devtask command.

---

## 22. Voice Calls

With Twilio configured, you can call your Nova phone number and have a spoken conversation.

### Making a Call

1. Call your Twilio number
2. Enter your PIN when prompted
3. Speak your request after the tone
4. Nova transcribes, processes, and speaks the response

### Voice Transcription

Voice messages sent to Nova via Telegram are also transcribed and processed:
- Send a voice memo → Nova transcribes → responds in text (and optionally voice)

### Text-to-Speech

If `ELEVENLABS_API_KEY` is set, Nova can speak responses back. The default voice is "George" — configurable via `ELEVENLABS_VOICE_ID`.

---

## 23. File & Media Handling

### Sending Files to Nova

Send any file directly in the Telegram chat. Nova handles:

| File Type | What Nova does |
|-----------|----------------|
| PDF | Extracts and reads the text content |
| Word (.docx) | Reads and can edit the document |
| Excel (.xlsx) | Reads data, can generate analysis |
| Images | Describes content (Claude Vision), can use in workflows |
| Voice messages | Transcribes and processes as text |
| CSV | Reads and analyzes data |

### Nova Sending Files to You

When agents produce documents, spreadsheets, or presentations, they are sent directly to your Telegram chat as downloadable files.

### Working Directory

Agents work in `~/.nova/workspace/` organized by type:

```
~/.nova/workspace/
  projects/     — Dev projects
  documents/    — Generated docs
  images/       — Generated images
  media/        — Video and audio files
```

---

## 24. Usage & Cost Tracking

### Viewing Usage

```
/usage
```

Shows:
- Today's total AI spend
- Monthly total
- Top agents by cost
- Provider breakdown (Claude vs Gemini)

### Cost in Approval Gates

Before you approve a consequential action, Nova shows an estimated cost for the execution phase.

### Cost Alerts

Configure in **Admin Dashboard → Alerts**: set a daily spend threshold and receive a Telegram DM when it's exceeded.

### Provider Routing for Cost Control

Nova intelligently routes to cheaper providers for appropriate tasks:
- Fast responses → Claude Haiku or Gemini Flash
- Standard tasks → Claude Sonnet or Gemini Pro
- Complex reasoning → Claude Opus or Gemini Ultra

You can override: `/gemini [your request]` forces Gemini, `/claude [your request]` forces Claude.

---

## 25. Executive Board

The Executive Board provides strategic oversight and autonomous project execution.

### Triggering a Board Meeting

```
/board Should we double down on Instagram or pivot to LinkedIn?
/board What's the right pricing model for our SaaS product?
/board How do we respond to [competitor] launching a free tier?
```

### The Meeting Process

| Round | What happens |
|-------|-------------|
| Round 1 | Each of 7 executives independently analyzes the question from their lens |
| Round 2 | The Critic runs a pre-mortem — identifies failure modes, GO/NO-GO |
| Round 3 | Nova synthesizes 3–5 options with confidence scores and trade-offs |
| Decision | You choose an option |
| Execution | Decision recorded → project created → COO delegates to specialist agents |

### DM'ing an Executive Directly

Each executive node is available via direct message (if deployed separately):

```
@YourCEOBot What's your take on the competitive landscape right now?
@YourCFOBot Model the unit economics for a $199/mo plan with 30% churn
```

Executives respond in character and log their contributions to the shared board database.

---

## 26. Command Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `/start` | First-time onboarding or show welcome message |
| `/help` | Show all available commands |
| `/agents` | Browse 24 specialist agents with use buttons |

### Memory & Goals

| Command | Description |
|---------|-------------|
| `/memory` | View stored facts with delete buttons |
| `/goals` | View active goals with complete buttons |
| `/tasks` | View pending and in-progress agent tasks |

### Scheduling

| Command | Description |
|---------|-------------|
| `/schedule` | View active schedules |
| `/schedule list` | Same as above, explicit list format |

### Developer Mode

| Command | Description |
|---------|-------------|
| `/codebase add <name> <url-or-path>` | Register a codebase |
| `/codebase list` | List registered codebases |
| `/codebase remove <name>` | Unregister a codebase |
| `/devtask <description>` | Queue a background dev task |

### Intelligence & Board

| Command | Description |
|---------|-------------|
| `/board <question>` | Convene full executive board meeting |

### Usage & Feedback

| Command | Description |
|---------|-------------|
| `/usage` | Today's AI spend, monthly total, provider breakdown |
| `/feedback good` | Rate Nova's last response positively |
| `/feedback bad` | Rate Nova's last response negatively |

### Admin Commands

> These are only visible to users with `role = admin`.

| Command | Description |
|---------|-------------|
| `/adduser` | Open Dashboard to add a new user |
| `/schedules` | Open Dashboard schedules manager |
| `/agents` (admin) | Open Dashboard agents registry |

### Provider Override Prefixes

| Prefix | Effect |
|--------|--------|
| `/claude [message]` | Force Claude for this message |
| `/gemini [message]` | Force Gemini for this message |

### Execution Override Prefixes

| Prefix | Effect |
|--------|--------|
| `Just do it: [task]` | Skip approval gate, execute immediately |
| `Go ahead and [task]` | Same as above |
| `Ship it: [task]` | Same as above |

### Memory Intent Tags (for power users)

These can be included in messages and Nova will parse and act on them:

| Tag | Effect |
|-----|--------|
| `[REMEMBER: fact]` | Save a fact to your memory |
| `[SHARE: fact]` | Save a fact visible to all users |
| `[GOAL: text \| DEADLINE: date]` | Create a goal |
| `[DONE: search text]` | Mark a matching goal complete |
| `[TASK: agent \| description]` | Create an agent task |
| `[TASK_DONE: description \| result]` | Mark task complete |
| `[SCHEDULE: title \| datetime \| instructions]` | Create a one-time schedule |
| `[SCHEDULE: title \| datetime \| instructions \| RECUR: rule]` | Recurring schedule |
| `[SCHEDULE_CANCEL: search text]` | Cancel a schedule |
| `[DEVTASK: projectName \| description]` | Queue a background dev task |

---

## 27. Workboards

A workboard is a board of structured cards that Nova and its agents can create, fill, and move
through **stages** — columns you define, not a fixed workflow. Ask for one in chat ("make me a
purchasing board tracking POs", "generate leads and put them on a board") and Nova proposes a
field schema and a set of stages; once you confirm, the board exists and agents can add or update
cards on it through the CLI. Open it in the web dashboard to see it as a drag-and-drop board.

Every board declares its own fields — two boards can look completely different. A stage is inert
by default; a board can optionally be made **reactive**, and a reactive stage can carry an action
that runs automatically when a card enters it.

Reading a board through the dashboard API needs only a signed-in session. Creating a board,
writing or moving a card, and editing a schema need the `workboard.manage` capability — the same
shape of gate playbooks and automations use, because an armed stage can dispatch an agent. Admins
have it implicitly; grant it to a member with `nova access grant <@user> workboard.manage`.

### Field Types

| Type | Notes |
|------|-------|
| `text` | Single-line string |
| `longtext` | Multi-line string |
| `number` | Coerced from numeric-looking input |
| `money` | Same coercion as `number`, strips `$` and `,` |
| `date` | Stored as given |
| `email` | Stored as given |
| `url` | Stored as given |
| `select` | Must declare `options`; value must be one of them |
| `checkbox` | Coerced from booleans or `true/false/yes/no/1/0` |
| `agent` | An agent slug |
| `link` | Stored as given |

A field definition is `{ key, label, type, required?, options?, primary? }`. The `primary` field
(or the first field, if none is marked) supplies a card's title when one isn't given explicitly.

### The `nova workboard` CLI

Agents drive workboards through this CLI mid-task via the shell — see `.claude/agents/shared/skills.md`
and `src/agent-tools.ts` for what agents are told. Card writes (add, move, update) are local and
reversible, so they're prepare-phase safe and don't need the approval gate; running a stage's
action or syncing a connector does.

| Command | Flags | Description |
|---------|-------|--------------|
| `nova workboard list` | — | List boards visible to the admin user with stage/card counts |
| `nova workboard describe <board>` | — | Show a board's fields and stages |
| `nova workboard create <name>` | `--purpose '<text>'` `--fields '<json array>'` `--stages '<json array>'` `--reactive` | Create a board. `--fields` and `--stages` are JSON arrays of field/stage definitions; `--reactive` (no value) opts the board into stage actions. Boards created this way are always personal-scope — there's no `--scope` flag |
| `nova workboard card add <board>` | `--stage <key>` `--fields '{…}'` `--title <text>` | Add one card. `--stage` defaults to the board's first stage if omitted. Fails on a system board — those read cards from another table |
| `nova workboard card add-many <board>` | `--stage <key>` `--file <path>` | Add many cards from a JSON file (an array of `{ title?, fields }`). `--file` is required |
| `nova workboard card move <card-id>` | `--to <stage>` | Move a card to another stage. `--to` is required. If the move enters an armed stage, the action is queued for the relay to dispatch — the CLI has no dispatcher of its own |
| `nova workboard card update <card-id>` | `--fields '{…}'` `--title <text>` | Patch a card's fields and/or title |
| `nova workboard query <board>` | `--stage <key>` | Print the board's cards as JSON, optionally filtered to one stage |
| `nova workboard run <board>` | `--stage <key>` `--playbook <name>` `[key=value ...]` | Queue every card currently in `--stage` to run the named playbook. This queues the run for the relay to dispatch shortly — it does not run inline |
| `nova workboard sync <board>` | — | Pull records from the board's bound connector and upsert them onto cards. Fails if the board has no connector binding |

### Reactive Stages

A stage's `onEnter` action is either `{ playbook, vars? }` or `{ agent, task }`. It only fires if
the board is reactive **and** the move isn't itself the result of another `onEnter` firing (so a
board can't loop on itself). Before it can become an agent instruction, the card content behind it
is scanned for prompt injection; a match is skipped, not fired.

Firing is exactly-once within a short claim window, so a rapid double-move or a mid-run restart
can't double-fire the same card into the same stage. A dispatch that can't get a task started is
retried a few times, then dead-lettered rather than silently dropped. Dragging many cards into an
armed stage at once (more than `WORKBOARD_BULK_CONFIRM`, default 10) asks for one confirmation
covering the whole batch instead of firing per card.

The dashboard is a separate process from the relay and has no dispatcher of its own, so a stage
action triggered from the dashboard is written to a durable queue; the relay drains that queue on
an interval (`NOVA_WORKBOARD_QUEUE_MS`), not instantly. `nova workboard run` queues the same way.

### Live Updates on an Open Board

An open board page refreshes itself two ways. Changes made from the dashboard itself arrive over
the activity SSE stream immediately. Changes made by another process — a card an agent writes with
`nova workboard card add`, a stage the relay's queue drainer fires — cannot: the event bus behind
SSE is in-process. Those are picked up by a poll of a cheap per-board change marker
(`GET /api/workboards/:id/rev`) every 10 seconds, so they appear within about that long rather
than instantly. A change you made yourself is never reloaded on top of you: a successful drag
adopts the marker its own write produced, and the card is additionally exempt from a reload for
two poll intervals, so a drag never costs you your scroll position, a toast, or a second drag
already in flight.

### Connector-Bound Boards

A board can be bound to a configured connector: `sync` pulls records from the connector's read
action and upserts them onto cards, matched by external id. Pull never deletes — a record the
remote stops returning is left on the board rather than removed, so a bad or partial pull can't
wipe a board. On a bound board, moving a card to a stage that maps to a remote value **describes**
the write back to that system (connector, action, and input) rather than performing it. Nothing
performs it for you: the description is recorded in the board's event history (a `sync` event
carrying `pendingPush`) and returned to the page, and you run it yourself — `nova connector run
<id> <action> --input '{…}'` — when you want it applied. There is no queue behind it and no
approval prompt in chat.

### Editing a Board's Schema

Adding a field to an existing board backfills every existing card with a `null` value for it.
Removing or retyping a field is destructive to existing card data and needs an explicit
confirmation; when confirmed, the card values as they stood before the edit are preserved in the
board's event history rather than discarded.

### System Boards

`/kanban` (agent tasks) and `/tickets` (support tickets) are workboards rendered by the same
engine, backed by their existing tables rather than the generic card store. Their schema and
stages are locked — you can drag their cards between stages, but you cannot edit their fields or
stage layout, and `nova workboard card add`/`add-many` refuse to write to them directly.

A system board shows the 200 most recently updated rows of its table, but its stage counts come
from a `COUNT(*)` over the whole table — so a stage showing fewer rows than it holds says so.
`nova workboard query` cannot show the rest of one: it reads the generic card store, which a
system board has no rows in.

### Environment Variables

| Variable | Default | Controls |
|----------|---------|----------|
| `WORKBOARD_BULK_CONFIRM` | `10` | Cards moved into an armed reactive stage at once above this count trigger one bulk confirmation instead of firing individually |
| `NOVA_WORKBOARD_QUEUE_MS` | `45000` (floored at `30000`) | How often the relay drains the durable stage-action queue the dashboard writes to, in milliseconds |

---

## Quick Reference Card

```
DAILY WORKFLOW
──────────────────────────────────────────────────────────────
Morning    →  Nova sends a briefing automatically (if scheduled)
Requests   →  Just type naturally — no commands needed
Agents     →  "Pixel, draft 5 captions" or /agents to browse
Approval   →  Tap Approve / Revise / Cancel on proposed actions
Memory     →  "Remember that..." or /memory to view
Schedule   →  "Every Monday at 9am, send me..." or /schedule list
Dev work   →  /codebase add myapp <url>, then /devtask <what to do>
Strategy   →  /board <strategic question> for full executive analysis
Help       →  /help for commands, just ask for anything else
```

---

*Nova — Built on Bun · Powered by Claude & Gemini*
