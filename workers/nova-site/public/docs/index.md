# Nova Documentation

> Complete Nova documentation: installation, every environment variable, channels, agents, memory tags, scheduling, MCP integrations, dashboard, voice, the executive board, and troubleshooting.

*Source: https://mynova.space/docs/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Everything you need to install, configure, and run your self-hosted AI team — from the first Telegram message to a seven-node executive board.

## What Nova is

Nova is an open-source, self-hosted AI platform. It's a team of **24 specialist agents** plus an **automation layer** that runs the repeatable work in the background — and it runs on your own model subscriptions and your own machine. Four pillars:

| Pillar | What it means |
| --- | --- |
| **Multi-agent** | A request is classified cheaply, then answered, routed to one specialist, or decomposed into a dependency-ordered plan run across several (an optional 7-role executive board deliberates on strategy). |
| **Event-driven** | It doesn't only wait for a message. A webhook, a metric, a connector event, or a semantic match can fire an automation or playbook; durable processes span days. |
| **Your models, your machine** | It drives the vendor CLIs (Claude, Gemini, Codex) as subprocesses so it runs on subscriptions you already pay for — plus any OpenAI-compatible API. Storage is local SQLite; embeddings and the knowledge base are local. Your keys, your data. |
| **Trust & governance** | Two-phase prepare → approve → execute gates interactive requests; policies, spending caps, and role-based permissions govern the autonomous ones. |

Everything runs on your machine: **Bun + TypeScript**, local SQLite with vector search, your own AI accounts, and credentials AES-256-GCM encrypted at rest. MIT licensed — [source on GitHub](https://github.com/djbelieny/nova).

## Installation

### Prerequisites

- A **Telegram account** (to create your bot)

- macOS 13+ or Ubuntu 22.04+ (Windows via WSL2); 2 GB RAM minimum (4 GB recommended)

That's it to start — the installer takes care of the rest. It automatically installs **[Bun](https://bun.sh)** and the **[Claude Code](https://claude.ai/claude-code) CLI** if they're missing, so you don't have to set them up by hand. Optional accounts unlock more: Gemini, Groq (free voice transcription), Twilio (phone calls), Perplexity (web research), Meta, Notion, Google Workspace, and more — all covered in Configuration.

### Option A — one line (recommended)

A single line clones Nova to `~/nova`, installs any missing prerequisites, then launches a friendly **setup wizard**. The wizard walks you through connecting Telegram and an AI provider — no file editing — and can even **detect your Telegram user ID automatically** (it just asks you to message your bot). It's **resumable**: close it and re-run to pick up where you left off.

```
$ curl -fsSL https://mynova.space/install | bash
```

Prefer to clone it yourself? That's the same as running:

```
$ git clone https://github.com/djbelieny/nova && cd nova
$ bash bootstrap.sh      # installs prerequisites, then runs the setup wizard
```

Just want to check what's already installed? `bash bootstrap.sh --check` reports your system and changes nothing.

### Option B — manual setup

```
$ git clone https://github.com/djbelieny/nova && cd nova
$ bun run setup           # install deps, create .env
$ vim .env                # bot token, user ID, encryption key
$ cp .mcp.example.json .mcp.json
$ cp config/profile.example.md config/profile.md
$ bun run test:telegram   # verify the bot connects
$ bun run test:sqlite     # verify the database
$ bun run start
```

The local embedding model (all-MiniLM-L6-v2, ~23 MB) downloads on first use. When Nova starts, it sends you a welcome message on Telegram with tappable starter ideas — so your first interaction works without typing anything. Run `nova doctor` anytime for a health check, or `nova update` to pull the latest and reinstall.

### Command reference

The installer puts a `nova` command on your PATH — that's the front door for everyday use (`nova start`, `nova doctor`, `nova connect`, and the rest). The underlying `bun run <script>` scripts still work if you prefer them, and advanced scripts (`test:*`, `setup:*`, `exec:*`) are only exposed through `bun run`.

| Command | What it does |
| --- | --- |
| `bash bootstrap.sh` | Install prerequisites and launch the setup wizard (`--check` for a dry run) |
| `nova init` | Run the setup wizard on its own (resumable) |
| `nova doctor` | Health check + copyable diagnostics |
| `nova update` | Pull the latest and reinstall dependencies |
| `nova start` | Start the relay (main bot process) |
| `nova dev` | Start with auto-reload on file changes |
| `nova chat` | Talk to Nova right in your terminal |
| `nova connect` | Connect to a running Nova (local or remote) with a live view and inline approvals |
| `nova dashboard` | Start the web dashboard on port 3033 |
| `nova providers add` / `list` / `test` / `default` | Add and manage AI models (see AI providers) |
| `nova invite [member|admin]` | Generate an invite code to add a teammate |
| `nova kb add` / `list` / `search` / `remove` / `reindex` | Feed and manage the knowledge base (see Knowledge base) |
| `nova voice` | Start the Twilio voice-call server |
| `nova setup` | Install dependencies, create `.env` from the example |
| `nova backup` | Archive `data/`, `config/`, and `.env` to `~/.nova/backups/` |
| `bun run test:telegram` / `test:sqlite` / `test:voice` | Verify Telegram token, database, and voice transcription |
| `bun run setup:verify` | Full installation health check |
| `bun run setup:launchd` / `setup:systemd` / `setup:services` | Configure always-on services (macOS / Linux / PM2) |
| `bun run typecheck` / `bun run test` | TypeScript check; run the test suite against an isolated DB |
| `bun run exec:ceo` … `exec:critic` | Start an executive board node |

## Configuration

All secrets live in `.env` (copied from `.env.example`). Personal context lives in `config/profile.md`, loaded into every prompt. MCP servers are declared in `.mcp.json` (copied from `.mcp.example.json`).

**`NOVA_ENCRYPTION_KEY`** — Nova will not start without it. Generate with `openssl rand -hex 32`. It encrypts OAuth tokens and stored credentials with AES-256-GCM.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** From @BotFather |
| `TELEGRAM_USER_ID` | — | **Required.** Your numeric ID, from @userinfobot |
| `NOVA_ENCRYPTION_KEY` | — | **Required.** 64-char hex; credential encryption at rest |
| `BOT_NAME` | `Nova` | The name your assistant calls itself |
| `USER_NAME` | — | Your first name (recommended) |
| `USER_TIMEZONE` | `UTC` | IANA timezone, e.g. `America/New_York` |
| `CLAUDE_PATH` | `claude` | Claude CLI path (auto-detected if in PATH) |
| `RELAY_DIR` | `~/.nova` | Relay data directory (workspace, uploads, logs) |
| `PROJECT_DIR` | repo dir | Working directory handed to Claude |

### Channels

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_WEBHOOK_URL` | Public URL Kapso posts WhatsApp webhooks to (per-user Kapso key + phone-number ID are added in the dashboard) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-…`), Socket Mode |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-…`) |
| `DISCORD_BOT_TOKEN` | Discord bot token — enables the Discord channel |

### AI providers & research

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Enables the Gemini provider |
| `CODEX_PATH` | Path to the Codex CLI (auto-detected if in PATH) |
| `GROQ_API_KEY` | Voice transcription (free tier at console.groq.com) |
| `PERPLEXITY_API_KEY` | Web research: sonar-pro (ask), sonar-deep-research, sonar-reasoning-pro |

### Voice & phone

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICE_PROVIDER` | `groq` | `groq` or `local` (whisper.cpp) |
| `WHISPER_BINARY` / `WHISPER_MODEL_PATH` | `whisper-cpp` | Local transcription binary and model file |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | — | Phone calls & SMS |
| `USER_PHONE` / `USER_PIN` | — | Your number and a private PIN for call authentication |
| `VOICE_SERVER_PORT` | `80` | Voice server port (production deployments typically use 8080 behind a proxy) |
| `VOICE_SERVER_URL` / `WEBHOOK_BASE_URL` | — | Public URLs Twilio calls back to |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | George | Text-to-speech for voice replies |

### Dashboard, integrations & services

| Variable | Purpose |
| --- | --- |
| `DASHBOARD_USER` / `DASHBOARD_PASS` | Dashboard login — **the dashboard stays disabled until `DASHBOARD_PASS` is set** |
| `DASHBOARD_PUBLIC_URL` | Public dashboard URL; used as the OAuth redirect base |
| `GOOGLE_CLIENT_ID/SECRET`, `NOTION_CLIENT_ID/SECRET`, `ZOOM_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET` | OAuth apps you create; users connect accounts from the dashboard |
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_APP_ID`, `META_APP_SECRET` | Meta Ads API (`act_XXXXX` account format) |
| `SQUARE_LOCATIONS` | Comma-separated `Name (LOCATION_ID)` pairs the voice assistant may mention |
| `HEYGEN_API_KEY` / `FAL_API_KEY` | AI avatar video / text-to-video |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID`, `TELEGRAM_ADMIN_ID`, `TICKET_DEPLOY_DRYRUN` | Support-ticket pipeline (see Support tickets) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Executive board shared database (see Executive board) |
| `MEMWRIGHT_URL` / `MEMWRIGHT_DATA_DIR` | Optional long-term memory service (defaults `http://localhost:8765`, `./data/memwright`); Nova degrades gracefully without it |
| `HEARTBEAT_*` | Proactive check-in controls (see Scheduling) |

### Your profile

`config/profile.md` is freeform markdown about you — role, businesses, preferences, constraints — injected into every conversation. Start from `config/profile.example.md`. It's gitignored; it never leaves your machine.

## Connecting channels

### Telegram (required)

1. Message **@BotFather** → `/newbot` → pick a display name, then a username ending in `bot`.

2. Copy the token (looks like `7123…:AAH…`) into `TELEGRAM_BOT_TOKEN`.

3. Your numeric user ID is **detected automatically** by the setup wizard — it just asks you to message your bot. (You can still set `TELEGRAM_USER_ID` by hand from **@userinfobot** if you prefer.)

4. Verify: `bun run test:telegram`.

### WhatsApp

WhatsApp runs through [Kapso](https://kapso.ai) (Meta Cloud API). Set `WHATSAPP_WEBHOOK_URL` to a public URL that reaches the relay's `POST /webhook/kapso` endpoint, then add each user's Kapso API key and phone-number ID from the dashboard's WhatsApp page.

### Slack

1. Create an app at api.slack.com/apps → *From scratch*.

2. Enable **Socket Mode**; create an app-level token (`xapp-…`) → `SLACK_APP_TOKEN`.

3. Add bot scopes `channels:history`, `chat:write`, `im:history`, `im:write`; install to your workspace.

4. Copy the bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`.

### Terminal

Talk to Nova straight from your shell with `nova chat` — the same pipeline, classification, and approval gates as every other channel, no bot token required. To reach a Nova that's already running (locally or on your VPS), use `nova connect` (see Talking to Nova).

### Discord

Run Nova as a Discord bot: create an application at [discord.com/developers](https://discord.com/developers/applications), add a bot, and set `DISCORD_BOT_TOKEN`. Discord uses the same adapter pattern as Telegram — messages flow through the identical two-phase, approval-gated pipeline.

## Talking to Nova

Just write naturally. Every message runs through three classification tiers — a fast heuristic for short messages, a pattern cache of plans that worked before, and LLM classification only for genuinely new complex requests. You can also steer explicitly:

- **Address an agent directly** by name: `Pixel, create a week of Instagram content`.

- **Force a provider**: prefix with `/claude`, `/gemini`, or `/codex`.

- **Voice messages** are transcribed automatically (Groq or local Whisper).

### From any terminal — nova connect

Because Nova runs always-on, you can drop into a running instance from any terminal — local or your VPS — with `nova connect --url https://your-nova`. You get a live view of what your agents are doing and can **approve, change, or cancel** inline, right from the shell. For a plain conversation without connecting to a remote instance, `nova chat` talks to your local Nova.

### Commands

| Command | What it does |
| --- | --- |
| `/start` / `/help` | Friendly welcome with tappable starter ideas, and plain-language help |
| `/team` | Meet your 24 specialists, grouped by what you want to get done |
| `/examples` | Starter ideas you can tap to run right now |
| `/agents` | Browse all 24 agents with one-tap "Use" buttons |
| `/memory` / `/goals` / `/tasks` | Show stored facts, goals, and agent tasks |
| `/knowledge` / `/kb` | List the documents in your knowledge base, grouped by scope |
| `/schedule`, `/schedule list` | Manage scheduled tasks |
| `/usage` | Cost and usage summary |
| `/board <question>` | Convene the executive board (if configured) |
| `/voice` | Voice settings |
| `/feedback good|bad` (or 👍/👎) | Rate the last response — feeds pattern learning |
| `/settings autopilot <category> [limit_usd]` | Auto-approve a category, optionally capped: `social_post`, `email`, `ad_spend`, `code_deploy`, `seo`, `research`, `general`, `*` |
| `/settings access @user <level>` | Per-user visibility: `none`, `tasks-only`, `tasks+goals`, `full-summary` |
| `/settings role <job_role>` | Tell Nova your role for better context |
| `/codebase add <name> <git-url>` / `list` / `remove` | Register repos for dev tasks |
| `/devtask <description>` | Queue a background coding task on a registered repo |

### Admin commands

Users with the `admin` role also get `/adduser`, `/removeuser`, `/listusers`, `/share <fact>` (shared memory), `/status`, `/reload`, `/revert`, `/schedules`, `/budget`, `/project`, `/webhook`, `/zoom`, and `/reputation`.

### Adding teammates — invite codes

You no longer need to look up a numeric user ID to add someone. Run `nova invite` (`nova invite member` or `nova invite admin` to set the role) to generate an invite code, hand it to the person, and they redeem it on **Telegram or Discord** — you approve the pairing with a tap. Invites can also be managed from the dashboard.

## The 24 agents

Each agent is a markdown file in `.claude/agents/` — YAML frontmatter (name, description) plus a system prompt. The router picks agents during decomposition, or you address one by name.

**Helios** · paid ads**Pixel** · social media**Kai** · content**Orion** · email**Morpheus** · video**Architect** · web dev**Athena** · strategy**Digit** · analytics**Echo** · support**Flux** · funnels**Quill** · grants**Lex** · legal**Helia** · PR**Bridge** · partnerships**Oracle** · trends**Cipher** · data science**Rift** · security**Joule** · automation**Nexus** · community**Aura** · brand voice**Zen** · productivity**Tesseract** · systems**Magnus** · SEO**Cyra** · site optimization

### Adding your own

Create `.claude/agents/yourname.md` with frontmatter and a system prompt, map its tools and skills in `src/agent-router.ts`, and it joins the roster. Agent knowledge-base PDFs can be dropped in `agent-team/knowledge_bases/` (optional).

## Skills

45 reusable skills live in `.claude/skills/` — agents invoke them as needed. Highlights: document creation (`docx`, `xlsx`, `pptx`, `pdf`), `image-gen`, `canvas-design`, `ai-video-creator`, `content-research-writer`, `ghostwriter` (full book pipeline), `social-media-manager`, `email-marketing`, `meta-ads-manager`, `competitive-ads-extractor`, `lead-research-assistant`, `customer-support`, `reviews-testimonials`, `platform-maker` (SaaS generator), `ui-ux-pro-max`, `file-organizer`, `telegram-file-sender`, `notebooklm`, `skill-creator`, plus suites for Google Workspace (`gws-*`: Gmail, Calendar, Drive, Docs, Sheets), GoHighLevel (`ghl-*`: contacts, marketing, billing, content, admin), and Cloudflare (`cloudflare-dns`, `cloudflare-workers`).

To add one, use the `skill-creator` skill or write a `SKILL.md` by hand in a new directory — keep it generic, with credentials referenced from `.env`.

## Memory & intent tags

Nova remembers facts, goals, and tasks in local SQLite with vector search — recalled semantically and injected into context (up to 50 facts/goals, 12 recent messages, 5 semantic matches, 20 tasks). The model manages memory through intent tags in its responses; Nova parses them, acts, and strips them before you see the reply. You can trigger them naturally ("remember that…", "set a goal to…").

```
[REMEMBER: fact]                      save a fact (with embedding)
[SHARE: fact]                         fact visible to all users
[GOAL: text | DEADLINE: date]         save a goal
[DONE: search text]                   complete a matching goal
[TASK: agent | description]           create an agent task
[TASK_START|TASK_DONE|TASK_BLOCKED|TASK_CANCEL: …]
[SCHEDULE: title | datetime | instructions]
[SCHEDULE: … | RECUR: rule]           recurring
[SCHEDULE: … | RECUR: rule | IF: condition]
[SCHEDULE_CANCEL: search text]
[DEVTASK: project | description]      queue a background dev task
```

### Recurrence DSL

`daily:HH:MM` · `weekly:DAY:HH:MM` (0=Sunday) · `weekdays:HH:MM` · `interval:SECONDS`

## Knowledge base

Where memory holds what Nova *learns*, the knowledge base holds what you already *have*. Feed it a document, file, or URL and Nova ingests it — extracting text (PDF, DOCX, Markdown, plain text, or a web page), splitting it into overlapping passages, and turning each into a vector with a model that runs **on your own machine** (all-MiniLM, the same local embedder used for memory). Nothing is sent to a third-party embedding API. When you ask a question, Nova pulls the closest passages into the answer and **cites the source document**.

### Three scopes

| Scope | Who sees it | Good for |
| --- | --- | --- |
| `personal` | Only you (stored in your own per-user database) | Your notes, drafts, private research |
| `team` | Everyone on your Nova (shared database) | Handbook, brand guide, pricing — shared truth |
| `agent` | One specialist's pack, plus that user's personal + team docs | Contracts for Lex, brand voice for Aura, API docs for Architect |

An agent retrieves from your *personal* docs, the *team* base, *and* its own pack — never another agent's pack. Personal + team passages are also auto-injected into ordinary conversations, so recall is effortless.

### Four ways to feed it

- **Drop a file in Telegram** — send a document with a caption like `add to knowledge`, `add to team knowledge`, or `for Lex's pack`, and it's ingested with that scope on the spot.

- **Dashboard** — the web dashboard has a **Knowledge** panel: drag files in, set each one's scope, search, and delete.

- **The `nova kb` command** — manage the whole lifecycle from a terminal (below).

- **A watched folder** — anything dropped into `~/.nova/knowledge/` is ingested automatically; subfolders set the scope (`team/`, `agents/<slug>/`). Delete a file and its passages leave the base. Disable with `NOVA_KB_WATCH=false`.

### The nova kb command

```
nova kb add report.pdf --scope team          add a file to the team base
nova kb add https://example.com/spec --agent architect
nova kb add notes.md                          defaults to personal scope
nova kb list                                  list docs, grouped by scope
nova kb search "refund window"                search across visible scopes
nova kb remove <id> --scope team
nova kb reindex --all                         re-embed after edits
```

In chat, `/knowledge` (or `/kb`) lists everything Nova currently knows, grouped by scope.

Retrieved passages are **injection-scanned** before they reach a prompt — a document that tries to smuggle in instructions is dropped. Your files are treated as data, never as commands. Re-ingesting an edited file replaces the old version in place (no duplicates), and embeddings never leave your machine.

## Playbooks

A playbook is a reusable **SOP** — a business process you author once and run many times with different inputs. Each has variables and ordered steps (which agent does what, in which phase); running one renders those steps into a plan and executes it through the normal two-phase gate. Distinct from Nova's auto-learned patterns: playbooks are intentional, editable, and shareable.

Scopes: `personal` (yours) or `team` (shared). Load a starter library — client onboarding, refund handling, content launch, weekly report, lead follow-up — with one command.

```
/playbook seed                         load the starter SOPs
/playbook run client-onboarding client=Acme email=a@b.com
nova playbook list | show <name> | remove <name>
```

Author and edit playbooks in the dashboard **Playbooks** panel; run them from chat, or wire one to an automation (below). Variables are injection-scanned; edits bump a version.

## Automations — event → condition → workflow

Automations make Nova **event-driven**: when something happens, run a workflow. Each has a source (an inbound webhook, a metric probe, or a connector event like `stripe.payment`), optional conditions, and an action — an agent task or a playbook. Every fire still passes the approval gate unless you've granted autopilot.

| Piece | What it does |
| --- | --- |
| Conditions | `field:op:value` — ops `eq/neq/gt/lt/gte/lte/contains/exists`; all must pass. Plus **semantic** (below). |
| Dedupe | Skip repeats within an hour by a templated key (e.g. `{{contact.email}}`). |
| Rate limit | Cap fires per hour. |
| Action | `--agent <slug> --template "…{{event.field}}…"` or `--playbook <name> --var k={{…}}`. |

```
nova automation add new-lead --playbook lead-follow-up --var lead={{contact.name}} \
    --when amount:gt:1000 --dedupe {{contact.email}} --rate 10
nova automation url new-lead      the signed POST endpoint to give your source
/automations                      list them in chat
```

Inbound events arrive at `POST /automation/:userId/:id` (HMAC-verified). Rendered event text is injection-scanned. Design and dry-run automations in the dashboard **Automations** panel.

### Semantic triggers

Beyond exact matches, a condition can fire on *meaning*: `body:semantic:a customer complaint:0.55` fires when the event field is semantically similar to the phrase (local embeddings, threshold optional). Great for "when an email reads like a complaint / a cancellation / an upsell opportunity."

## Durable processes

Some work spans days and external events: *send contract → wait for signature → invoice → wait for payment → fulfill.* A durable process is a sequence of **action** and **wait** steps that survives restarts (state in SQLite) and resumes on a due timer or a named event. Action steps run as normal tasks (consequential ones pass the gate).

```
nova process start onboarding --from-playbook client-onboarding
nova process list | show <id> | cancel <id>
/process signal signature.done         resume processes waiting on that event
```

Timers resume automatically via the task dispatcher; events resume via a signal (a chat command or an automation). Author step sequences (with `wait|until|+2d` or `wait|event|<name>`) in the dashboard **Processes** timeline.

## Document extraction

The capture counterpart to the knowledge base: define a field schema and pull **structured, type-coerced JSON** out of PDFs, DOCX, or text — invoices, receipts, forms, contracts. Values are coerced (number/date/boolean/array), required fields validated, and rows exportable to CSV.

```
nova extract schema add invoice --field invoice_number:string:required \
    --field total:number:required --field due_date:date
nova extract statement.pdf --schema invoice
nova extract list --schema invoice | nova extract export invoice
```

In chat, drop a document with a caption like *"extract as invoice"*. Manage schemas, run extractions, and export from the dashboard **Extraction** panel. Extraction runs locally against your text; destinations (Sheets/CRM) route through the connectors.

## Policies & compliance

Business governance on top of the earned-autonomy ladder. Policies are **restrictive-only**: they add friction (require approval, block, or warn) but never grant more autonomy than the ladder already allows. With none defined, behavior is exactly as before.

| Kind | Effect |
| --- | --- |
| `spend_cap` | A day/month budget checked against the action ledger — over it, force approval. |
| `approval_matrix` | Route certain actions to named approvers, with an escalation timeout. |
| `content_check` | Scan prepared output for PII / profanity. `warn` flags it; `block` is a true **hard block** — it prevents execution at the execute boundary even after a human approves (checked against the prepared content), so nothing ships. |

```
nova policy add spend-cap --cap 500 --period month --department marketing
nova policy add approval --action email.send --approver <userId> --escalate 30
nova policy add content-check --checks pii,profanity --on-fail block
/policies
```

Manage everything in the dashboard **Policies** editor. Policies are evaluated at the gate, just before Approve/Revise/Cancel.

## ROI & reporting

Makes the automation's value legible. Agents quantify outcomes with a `[VALUE: $X | SAVED: Ymin | DEPT: z]` tag; Nova records it and rolls it up against the action ledger into **tasks automated, hours saved, and $ influenced vs. cost** — by department and agent.

```
/roi                 last 7 days, in chat
nova roi --period 30 | nova roi --by-agent | nova roi --by-department
```

The dashboard **ROI** view shows hero tiles + charts; a weekly digest DMs each user the value delivered. Value ranking by agent/department can inform where to lean in.

## Connectors

A thin, uniform layer over external business systems. Built-ins ship bidirectional: **Stripe** (charges/customers/refunds), **Shopify** (orders), **Zendesk** (tickets), **HubSpot** (contacts). Each has read + write actions and a poll trigger that feeds automations (e.g. `stripe.payment`). Credentials come from env vars or the shared credential store; write actions are consequential.

```
nova connector list                    built-ins + configured status
nova connector describe stripe         its actions + parameters (discovery)
nova connector run stripe list_charges --input '{"limit":5}'
nova connector set stripe STRIPE_API_KEY=sk_live_…   stored encrypted at rest
```

Configure and run actions from the dashboard **Connectors** panel. Adding a connector is one file implementing the `Connector` interface. Agents call connectors themselves the same way they use MCP tools under **mcp2cli** — discover on demand (`describe`) then call — so the agent prompt stays lean no matter how many connectors exist (see Operate & observe).

## Operate & observe

Everything the automation layer does is observable and recoverable.

- **Activity feed** — a unified timeline of every automation fire, process transition, and playbook run. `nova activity`, `/activity`, or the dashboard **Activity** page.

- **Dry-run** — preview exactly what an automation would do against a sample event before enabling it (`nova automation simulate <name> --event '{…}'`, or the "Test / dry-run" control in the dashboard). Executes nothing.

- **Retries & dead-letter** — a failed dispatch retries with backoff; if it still fails it lands in a dead-letter queue instead of vanishing. `nova dlq list | retry <id> | drop <id>`, or the dashboard **Dead letters** page.

### Agents can use your tools

Specialist agents call Nova's capabilities themselves while working — searching the knowledge base, extracting a document, querying a data source, running a configured connector, or running a playbook — via the `nova` CLI in their execution environment. Following the **mcp2cli** pattern, they *discover* tools on demand (e.g. `nova connector describe <id>`) rather than carrying every schema in the prompt, use read actions freely, and **propose write/consequential actions for approval** rather than executing them directly.

## Connected data

Register the sources where your business data actually lives and query them — for reports, for automations, or for an agent mid-task. Read-only by design.

| Kind | Reads from |
| --- | --- |
| `http` | A JSON or CSV endpoint (point `rowsPath` at the array in a JSON body). |
| `sqlite` | A read-only `SELECT` against a SQLite file — analytics, exports, a local warehouse. |
| `connector` | A connector *read* action (Stripe, Shopify, …) — write actions are refused. |

```
nova data add sales --kind http --url https://api/report.json --rows-path data
nova data add wh --kind sqlite --path /data/warehouse.db --query "SELECT day, revenue FROM metrics"
nova data query sales        columns + rows
/data query sales            or from chat
```

Manage sources and run queries in the dashboard **Data** panel. Pair a source with the scheduler or a playbook for recurring reports. Zero extra dependencies.

## Governance & hardening

Production-grade controls for running Nova unattended and for a team. All additive — with nothing configured, behavior is exactly as before.

### Roles & permissions

Admins can do everything. Members get scoped **capabilities** — `automation.manage`, `policy.manage`, `connector.manage`, `playbook.manage`, `process.manage`, `access.manage` — that gate who can create or change each governed area (enforced on the dashboard write actions).

```
nova access grant @teammate automation.manage
nova access list @teammate
/access @teammate grant policy.manage
```

### Out-of-office delegation

Going away? Delegate your work so assignments and approvals route to a teammate (a cycle-guarded chain) until you're back.

```
nova ooo set @teammate "on vacation" --until 2026-08-01
/ooo @teammate   ·   /ooo off
```

### Idempotency, locking & secrets

- **Exactly-once.** An automation can opt into durable idempotency (`--idempotent`) so a re-delivered webhook fires once — not again an hour later.

- **No double-fire.** Advisory locks wrap the automation poller and the task dispatcher, so overlapping ticks or multiple instances never process the same work twice.

- **Encrypted secrets.** Connector credentials are stored AES-256-GCM encrypted at rest (set `NOVA_ENCRYPTION_KEY`) via `nova connector set`, with a rotation audit — no plaintext keys in `.env`.

Manage capabilities, delegation, and connector secrets in the dashboard **Governance Admin** panel.

## Scheduling & proactive services

Beyond one-off schedules, Nova ships background services that work while you don't (times below are the cron defaults, UTC):

| Service | Schedule | What it does |
| --- | --- | --- |
| Task dispatcher | every 60s | Runs due scheduled tasks |
| Morning briefing | daily | Day summary: calendar, goals, tasks, news |
| Smart check-in | several/day | Context-aware nudges, capped by heartbeat limits |
| AI news monitor | 3×/day | Curated AI/tech news |
| Social post suggester | daily | Post ideas from your context |
| Lead suggester | daily | Business lead ideas |
| Meta ads report | daily | Ad performance summary |
| Memory review | daily | Dedupes and curates memory |
| Health monitor | every 30 min | Polls `/health`; DMs you after 3 consecutive failures |
| Log monitor / Dream mode | periodic | Error triage / idle-time reflection |

### Heartbeat controls

`HEARTBEAT_ENABLED=true` · `HEARTBEAT_INTERVAL_MIN=30` · `HEARTBEAT_MAX_DAILY=3` (proactive messages per user per day) · `HEARTBEAT_ACTIVE_HOURS=8-22` (your timezone). Emptying `config/heartbeat.md` disables proactive check-ins entirely.

## AI providers & routing

Nova drives AI through CLIs you've already authenticated — no raw API keys needed for Claude. Routing precedence: **force prefix → user preference → task hint → MCP dependency → rate-limit fallback**.

| Provider | Via | Tiers |
| --- | --- | --- |
| Claude | `claude` CLI | fast=Haiku · standard=Sonnet · premium=Opus |
| Gemini | `gemini` CLI | fast=Flash · standard=Pro · premium=Ultra |
| Codex | `codex` CLI | standard |
| Groq | API | Whisper voice transcription |

### Adding any OpenAI-compatible model

Beyond the subscription CLIs, you can add **any OpenAI-compatible model** — an OpenRouter route, an OpenAI model, or a local `Ollama` / `vLLM` endpoint. Add one with `nova providers add` (or the dashboard's **Models** panel); manage the rest with `nova providers list`, `nova providers test`, and `nova providers default`. Definitions live in `config/providers.json`, and each model uses its own API key. The subscription CLIs remain the default — added models slot in alongside them and drive the same MCP tools and connectors.

## MCP integrations

Copy `.mcp.example.json` to `.mcp.json`. Each server runs on demand via `npx`; credentials come from `.env` or per-user storage (encrypted, managed in the dashboard — `src/integrations.ts` generates each user's MCP config).

| Server | Purpose | Credentials |
| --- | --- | --- |
| `notion` | Docs, databases, pages | OAuth via dashboard (or `NOTION_MCP_HEADERS`) |
| `google-workspace` | Gmail, Calendar, Drive, Docs, Sheets | OAuth via dashboard (`GOOGLE_CLIENT_*`) |
| `playwright` | Browser automation, scraping, screenshots | none |
| `cloudflare` | Workers, DNS, edge | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| `zoom` | Meetings | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_*` |
| `square` | POS, sales data | `SQUARE_ACCESS_TOKEN` |
| `clickup` | Task management | `CLICKUP_API_TOKEN` |
| `gohighlevel` | CRM, campaigns, publishing | `GHL_BEARER_TOKEN` |
| `firecrawl` | Web scraping | `FIRECRAWL_API_KEY` |
| `tavily` / `exa` | Web search / semantic search | `TAVILY_API_KEY` / `EXA_API_KEY` |
| `browserbase` | Cloud browser sessions | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` |

Service-based MCPs in `services/` add YouTube, TikTok, Zoom, and Meta social publishing. The optional `memwright` server provides long-term vector memory (port 8765).

### mcp2cli — tools without the context tax

Loading every MCP tool's JSON schema into an agent's prompt is expensive — hundreds of tool definitions can dominate the context window. Nova instead exposes MCP servers through **mcp2cli**: agents get a short instruction to *discover* tools on demand from the shell — `mcp2cli … --list` to see a server's tools, then `--tool <name> --param k=v` to call one — so only the tools actually used cost any context. The same discovery-first idiom applies to Nova's own capabilities (`nova connector describe <id>`, `nova kb search`, …), so an agent's toolset can grow without bloating its prompt.

## Web dashboard

A full admin and per-user surface on **port 3033**: set `DASHBOARD_PASS` (and optionally `DASHBOARD_USER`, default `admin`), then `bun run dashboard` and open `http://localhost:3033`. Sessions are cookie-based with rate limiting; non-admin users only ever see their own data.

- **Dashboard & Kanban** — live activity, task board, agent status

- **Approvals** — resolve pending approval gates from the browser

- **Integrations** — connect Google, Notion, Zoom, TikTok via OAuth (callback: `http://localhost:3033/auth/<provider>/callback`, or your `DASHBOARD_PUBLIC_URL`)

- **Memory, History, Schedules, Skills** — inspect and edit what Nova knows and runs

- **Tickets, WhatsApp, Shared credentials, Health, Costs** — operations pages

## Voice

### Voice messages (transcription)

**Groq** (recommended, free tier ~2000/day): `VOICE_PROVIDER=groq` + `GROQ_API_KEY`. **Local**: install ffmpeg + whisper.cpp, download `ggml-base.en.bin` (~142 MB) to `~/whisper-models/`, set `VOICE_PROVIDER=local`. Verify with `bun run test:voice`.

### Phone calls (Twilio)

Run `bun run voice` to start the call server (default port 80; production typically 8080 behind a reverse proxy). Configure the Twilio env vars plus `USER_PIN` — callers authenticate by PIN, talk to Nova, and actionable requests are extracted from the transcript and executed after the call. Replies use ElevenLabs TTS when configured. Webhooks are HMAC-verified; endpoints: `/voice/*`, `/sms/*`, `/audio/*`, `/health`.

## Support tickets

An email-driven pipeline: inbound support email (via [Resend](https://resend.com) webhooks, signature-verified) becomes a ticket → triage → an agent drafts a fix in the matched client repo → you approve from Telegram → deploy. Configure `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TICKET_SUPPORT_FROM`, `TICKET_OPERATOR_USER_ID`, and `TELEGRAM_ADMIN_ID`; the worker (`bun run ticket-worker`) polls every 60 seconds. `TICKET_DEPLOY_DRYRUN=true` (the default) keeps deploys simulated until you flip it.

## Executive board

An optional multi-node layer: seven executive roles — CEO, CFO, CMO, CTO, COO, Research, Critic — each a process with a distinct reasoning persona and its own AI provider, coordinating through a shared Postgres database over PostgREST. Ask `/board should we switch to usage-based pricing?` and you get independent analyses, an adversarial pre-mortem from the Critic, and 3–5 synthesized options with confidence scores. Pick one; the decision is recorded and the COO dispatches execution.

### Setup

1. Stand up the shared DB — **self-hosted Postgres + PostgREST** (`bun run migrate:board`, see `deploy/board/`), or a Supabase project if you prefer a hosted one.

2. Set `BOARD_DB_URL` and `BOARD_DB_KEY` in `.env` (the `SUPABASE_*` names still work as aliases). The board tables use row-level security with no anonymous access — the key must only live on trusted servers.

3. Create `.env.<role>` per node (`EXEC_ROLE`, `EXEC_NODE_ID`, a bot token, optional `EXEC_AI_PROVIDER`).

4. Start the roles: `bun run exec:ceo`, `exec:cfo`, … `exec:critic`. They're just processes — run all seven on one host, or spread them across machines (systemd units `nova-exec-<role>`). Separate hosts with separate AI keys is a recommendation for rate limits, not a requirement.

Executives use their own intent tags: `[DELEGATE: agent | task]` (optionally `| PROVIDER: claude`), `[BRIEF: role|all | summary]`, and `[DECISION: question | chosen | rationale | CONFIDENCE: 0.8]`.

## Running always-on

### macOS — launchd

```
$ bun run setup:launchd -- --service core   # just the relay
$ bun run setup:launchd -- --service all    # relay + dashboard + proactive services
$ launchctl list | grep com.nova            # verify
$ bun run setup:logrotate                   # daily log rotation
```

Services install as `~/Library/LaunchAgents/com.nova.*.plist`; individual services: `core`, `dashboard`, `memwright`, `checkin`, `briefing`, `memory-review`, `dispatcher`, `health-monitor`, `voice`.

### Linux — systemd

```
$ sudo bun run setup:systemd --service all
$ systemctl enable --now nova-relay nova-dashboard
$ journalctl -u nova-relay -f               # logs
```

### Windows / anywhere — PM2

```
$ bun run setup:services -- --service all
$ npx pm2 status
```

For public exposure (webhooks, dashboard, voice), put Caddy or another reverse proxy in front — see `DEPLOY.md` in the repo for a production walkthrough.

## Database & backups

Split SQLite with `sqlite-vec` for vector search. Embeddings are computed locally (all-MiniLM-L6-v2, 384 dimensions) — nothing leaves your machine.

```
data/shared.db       # users, status, logs, cost tracking, shared memory
data/users/{id}.db   # per-user: messages, memory, tasks, approvals, schedules, patterns
data/memwright/      # optional long-term memory service store
```

**Backups:** `bun run backup` archives `data/`, `config/`, and `.env` to `~/.nova/backups/` (last 7 kept; scheduled daily when services are installed). To restore: stop services, extract the archive, copy the three paths back, restart.

## Security model

- **Approval gates** separate consequential actions from safe ones, per category and per user — **the default safety boundary** (see the caveat below).

- **Sandboxing is opt-in.** By default agent tools run **unsandboxed on your host**. A hardened Docker sandbox exists (`NOVA_SANDBOX_BACKEND=docker`: read-only FS, dropped caps, no network, workspace-only mount) but is off by default and **falls back to unsandboxed if Docker isn't installed**. Run Nova as a dedicated user / on its own VPS, and enable the Docker sandbox if isolation matters to you.

- **Autonomous paths.** The approval gate covers *interactive* requests. Scheduled tasks, automations, and durable-process steps are **pre-authorized when you create them** and run headless; the controls there are the autonomy ladder's **spending caps** and **hard-block** content policies (which stop execution even on those paths).

- **Credentials at rest** — OAuth tokens and connector secrets are AES-256-GCM encrypted with `NOVA_ENCRYPTION_KEY`.

- **Webhooks verified** — Twilio HMAC with timing-safe comparison; Resend svix signatures; automation webhooks HMAC-signed.

- **Dashboard** — authenticated sessions, per-user data isolation, capability-gated management routes, rate limiting. Always set `DASHBOARD_PASS` and serve over HTTPS if exposed.

- **Executive board** — RLS on all shared tables (self-hosted Postgres + PostgREST or Supabase); the DB key on trusted servers only.

- **SQL** — fully parameterized queries; AI CLIs invoked with argv arrays (no shell interpolation of your messages).

### Security posture

Nova has access to private data, receives untrusted input (messages, web content, tool output), and has outbound paths (chat replies, API calls). That's the "lethal trifecta" — the hardening below cuts each leg for the untrusted/leaking case. Run `nova doctor --security` to grade your deployment against it.

- **Least-privilege agent env** (`NOVA_AGENT_ENV_STRICT`, on by default) — agent subprocesses get only the vars they need, not the full host environment.

- **Egress leak firewall** (`NOVA_LEAK_FIREWALL`, on by default) — redacts secrets from chat replies and logs, hard-blocks secrets leaving at the execute boundary.

- **Untrusted-input firewall** (`NOVA_UNTRUSTED_FIREWALL`, on by default) — neutralizes tool/web/email content before it enters an agent prompt.

- **Dashboard** binds loopback-only unless `DASHBOARD_PASS` is set.

Found a vulnerability? Report privately via [GitHub Security Advisories](https://github.com/djbelieny/nova/security) — see `SECURITY.md`.

## Open source

Nova is MIT licensed and built on a lot of other people's work. Each project below is used under its own license (full texts ship in `node_modules`) — thank you to their maintainers.

| Area | Projects |
| --- | --- |
| Runtime & AI | [Bun](https://bun.sh), [TypeScript](https://www.typescriptlang.org), [sqlite-vec](https://github.com/asg017/sqlite-vec) (vector search), [Transformers.js](https://www.npmjs.com/package/@huggingface/transformers) running [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), the [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| **mcp2cli** | the MCP-to-CLI bridge Nova drives so agents call MCP tools from the shell (see MCP integrations) |
| **[RTK](https://github.com/rtk-ai/rtk)** (Apache-2.0) | Rust Token Killer — installed by `bootstrap.sh` and on by default; compresses command output (git, build, test, grep…) by 60–90% before it re-enters an agent's context. Safe by design — unknown commands pass through unchanged. Disable with `NOVA_RTK=off`. |
| Channels & UI | [grammY](https://grammy.dev) (Telegram), [Bolt](https://www.npmjs.com/package/@slack/bolt) (Slack), [discord.js](https://discord.js.org), [Ink](https://www.npmjs.com/package/ink) + [React](https://react.dev) |
| Documents & media | [pdf-parse](https://www.npmjs.com/package/pdf-parse), [mammoth](https://www.npmjs.com/package/mammoth), [docx](https://www.npmjs.com/package/docx), [PptxGenJS](https://www.npmjs.com/package/pptxgenjs), [sharp](https://sharp.pixelplumbing.com), [Playwright](https://playwright.dev) |
| Other | [groq-sdk](https://www.npmjs.com/package/groq-sdk) (transcription), [Resend](https://resend.com) (email), [dotenv](https://www.npmjs.com/package/dotenv) |

Nova **runs on** the official vendor CLIs — [Claude Code](https://claude.ai/claude-code), the Gemini CLI, and Codex — driven as subprocesses under your own subscriptions; those are proprietary tools, not bundled. Nova also grew out of Goda's minimal [Claude Code Telegram Relay](https://github.com/godagoo) pattern, since almost entirely rewritten.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nova won't start | `NOVA_ENCRYPTION_KEY` set? Generate with `openssl rand -hex 32` and restart. Then `claude "hello"` to confirm the CLI is authenticated. |
| Bot doesn't reply | Token has no stray spaces; `TELEGRAM_USER_ID` matches @userinfobot; `bun run test:telegram`; check relay logs. |
| Dashboard unreachable | `DASHBOARD_PASS` must be set or login is disabled; `curl http://localhost:3033`; is the dashboard process running? |
| Database errors | `bun run test:sqlite`; confirm `data/` exists and sqlite-vec loaded. |
| Claude CLI not found | `npm install -g @anthropic-ai/claude-code`, or set `CLAUDE_PATH`. |
| Voice transcription fails | `bun run test:voice`; Groq key valid, or whisper binary + model path correct. |
| High memory use | 200–500 MB is normal for the relay; restart the service if it exceeds ~1 GB. |
| Gemini errors | `gemini auth login` to refresh CLI credentials. |

Still stuck? [Open an issue](https://github.com/djbelieny/nova/issues) — include your OS, Bun version, and relay logs (secrets redacted).
