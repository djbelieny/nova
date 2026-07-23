# Nova

> Nova is a self-hosted, open-source AI platform: 24 specialist agents, a knowledge base you feed, event-driven automations, playbooks, durable processes, business connectors, and human approval before anything ships, spends, or sends — from Telegram to your terminal.

*Source: https://mynova.space/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova is 24 specialist agents plus an automation layer that reacts to events — webhooks, metrics, connector events — and runs the repeatable work in the background: playbooks, durable processes, a knowledge base you feed. Reach it from Telegram, Slack, Discord, or your terminal; run it on your own model subscriptions and your own machine. It prepares freely, then asks before anything ships, spends, or sends.

## Every request runs the same honest pipeline.

No magic router, no black box. Whether it starts as a message you send or an event that fires an automation, a request is classified, decomposed if it's big, and executed in two phases — with the consequential half gated behind you.

01 · classify

### Three tiers, cheapest first

Short messages skip straight to the model. Repeat requests hit a pattern cache of plans that worked before. Only genuinely new, complex asks pay for LLM classification.

02 · decompose

### Subtasks with dependencies

Complex requests become a plan: subtasks, dependency order, and a specialist agent for each. Independent branches run in parallel.

03 · prepare → approve → execute

### Safe work first, then the gate

Research, drafts, and images happen freely. Publishing, sending, and spending wait for the approval card — Approve, Revise, or Cancel, from your chat.

## Built like it handles your credentials — because it does.

Nova connects to your email, calendar, CRM, and ad accounts. The security posture treats that seriously.

- approval →**Two-phase execution.** Consequential actions are separated from safe ones and gated behind explicit approval, per category, per user.

- local →**Your data stays home.** Messages, memory, and tasks live in local SQLite with per-user isolation. Embeddings are computed on your machine.

- encrypted →**Credentials at rest.** OAuth tokens are AES-256-GCM encrypted; webhook signatures verified; dashboard sessions authenticated.

- yours →**Your keys, your models.** Routes across Claude, Gemini, and Codex CLIs under your own accounts, with rate-limit fallback.

- governed →**Guardrails for a business.** Spend caps, approval matrices, and PII checks; role-based permissions; encrypted secrets; and an audit ledger of every consequential action.

## Now it runs the operation, not just the chat.

Nova is event-driven and process-durable: feed it your knowledge, wire it to your tools, and let it run the repeatable work in the background — every consequential step still passing the same approval gate.

Second brainFeed it PDFs, docs & URLs — retrieved with citations, embedded on your machine
 PlaybooksAuthor an SOP once, run it many times with variables
 AutomationsEvent → condition → workflow, including semantic triggers
 Durable processesMulti-day flows that wait for a timer or a signature, then resume
 Document extractionInvoices & forms → structured, validated data
 ConnectorsStripe, Shopify, Zendesk, HubSpot — read & write, two-way
 PoliciesSpend caps, approval matrices, PII checks — guardrails that only add friction
 ROI reportingTasks automated, hours saved, value vs. cost — by department

## 24 specialists. One chat.

Each agent has its own system prompt, tools, skills, and MCP access — a working team weighted toward marketing and operations, and fully yours to edit. Adding an agent is writing a markdown file.

HeliosPaid advertising
 PixelSocial media
 KaiContent writing
 OrionEmail marketing
 MorpheusVideo content
 ArchitectWeb development
 AthenaBusiness strategy
 DigitData analytics
 EchoCustomer support
 FluxFunnel engineering
 QuillGrant writing
 LexLegal & compliance
 HeliaPublic relations
 BridgePartnerships
 OracleTrend forecasting
 CipherData science
 RiftCybersecurity
 JouleWorkflow automation
 NexusCommunity building
 AuraBrand voice
 ZenProductivity
 TesseractSystems thinking
 MagnusSEO
 CyraWebsite optimization

## Convene a board meeting when the question is big enough.

An optional distributed layer: seven executive nodes, each with its own reasoning persona, deliberating over a shared database. Independent analysis, an adversarial pre-mortem, then synthesized options with confidence scores — you pick, it executes.

/board should we switch to usage-based pricing?

CEODay-1 thinking, flywheels, customer obsessionlong-term vision
 CFOUnit economics and pricing disciplinecapital efficiency
 CMORemarkable over incremental; tribes over funnelsaudience & brand
 CTOEverything fails; design for itarchitecture & reliability
 COOExecution tracking, bottleneck huntingturns decisions into work
 ResearchAggregation theory, platform economicsmarket intelligence
 CriticInversion and pre-mortem; analysis onlykeeps everyone honest

## Batteries included, nothing locked in.

### Any model, no lock-in

Run on your Claude, Gemini, or Codex subscriptions via their CLIs, or add any OpenAI-compatible model — OpenRouter, OpenAI, local Ollama or vLLM — with one command. Subscription-first, your keys.

### A real nova CLI

One `nova` command runs everything, and `nova connect` drops you into your running Nova from any terminal — local or VPS — with live agent activity and inline approvals.

### Knowledge base (RAG)

Feed it PDFs, docs, and URLs — chunked and embedded on your machine, retrieved across every agent with source citations. Personal, team, or per-agent.

### Persistent memory

Facts, goals, and tasks with local vector search — Nova remembers across conversations and injects the right context.

### Learning & pattern cache

Successful plans are cached and reused; proven wins are promoted into learned skills over time.

### Scheduler & proactive services

Morning briefings, smart check-ins, recurring and conditional tasks — it works while you don't.

### Integrations & connectors

MCP servers (Notion, Google Workspace, Playwright, Cloudflare, GoHighLevel) plus two-way business connectors — Stripe, Shopify, Zendesk, HubSpot — on per-user credentials.

### mcp2cli — tools without the context tax

Agents discover tools on demand from the shell instead of loading every schema into the prompt, so the toolset grows without bloating context. Nova's own capabilities work the same way.

### Connected data

Query the systems your numbers live in — an HTTP endpoint, a read-only SQLite file, or a connector — for reports and for agents mid-task.

### Governance & audit

Earned-autonomy ladder, spend caps and approval matrices, role-based permissions, encrypted secrets, and a full action ledger with ROI reporting.

### 45 skills

Image generation, DOCX/XLSX/PPTX/PDF creation, research writing, ad extraction — invoked by agents as needed.

### Voice

Inbound and outbound calls via Twilio; voice messages transcribed with Groq or local Whisper.

## Running in one line.

$ curl -fsSL https://mynova.space/install | bash

One line clones Nova, sets up [Bun](https://bun.sh) and the [Claude Code](https://claude.ai/claude-code) CLI for you, then a guided wizard connects Telegram and your AI provider — no file editing, and it detects your Telegram user ID automatically. All you need first is a bot token from @BotFather. Prefer to clone yourself? `git clone https://github.com/djbelieny/nova && cd nova && bash bootstrap.sh`. Everything else is optional and documented in the repo.

## Want Nova — without the setup?

Not everyone has the time — or a spare engineer — to stand up their own AI team. If you want Nova running for your business but don't want to build it yourself, work with me directly: **done-for-you setup**, **consulting & advisory**, and **custom agents & integrations** built around how you actually work. Paid engagements, scoped to what you need.

Booked directly with me, Jake Belieny.
