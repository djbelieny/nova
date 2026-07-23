# Every feature Nova has, and what they're built to do

> 24 specialist agents, an executive board, earned autonomy, two-phase approval, persistent memory with semantic recall, 12 MCP integrations, 45 skills, proactive services, and full audit trails. Here's everything Nova can do.

*Source: https://mynova.space/blog/features/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

24 specialist agents, an executive board that reasons strategically, two-phase approval before anything ships, earned autonomy built on trust, persistent memory with semantic recall, 12 MCP integrations, 45 pre-built skills, and complete audit trails. Here's everything Nova has and how it works together.

Jake Belieny · 15 July 2026 · 11 min read

## 24 Specialist Agents

Nova's roster spans almost every function a company needs. Each agent has its own system prompt, dedicated tools, and MCP integrations. Nova routes your request to the specialist without requiring you to know their names — but it helps to see the shape of the team you're hiring.

#### Growth & marketing

**Helios** runs paid ads across Google, Facebook, and LinkedIn. **Pixel** manages social media and community growth. **Kai** writes and develops brand narrative. **Orion** designs and executes email campaigns. **Magnus** handles SEO and organic search strategy.

#### Creative & content

**Morpheus** writes video scripts and storyboards. **Aura** discovers and maintains brand voice and tone guidelines. **Flux** engineers sales funnels and conversion flows. **Cyra** audits and optimizes websites for UX, CRO, and performance.

#### Strategy & operations

**Athena** owns business strategy and competitive analysis. **Oracle** forecasts trends and plans for the future. **Tesseract** applies systems thinking and identifies leverage points. **Zen** optimizes workflows and productivity. **Bridge** identifies and develops partnerships.

#### Data & engineering

**Digit** turns data into dashboards and actionable insights. **Cipher** runs machine learning and statistical analysis. **Architect** designs and builds web applications and infrastructure. **Joule** automates workflows and wires together APIs.

#### Risk & voice

**Rift** audits security and assesses vulnerabilities. **Lex** reviews contracts and handles legal compliance. **Helia** manages public relations and media outreach. **Nexus** builds and moderates online communities.

#### Support & operations

**Echo** drafts customer support responses and builds knowledge bases. **Quill** writes grant proposals and business funding documents. **Digit** analyzes business metrics and produces reports. Together they handle the work that keeps operations running.

Each agent also has access to a shared library of **45 pre-built skills**: image generation, document creation (DOCX, XLSX, PPTX, PDF), web research, Google Workspace integration, Notion databases, and more. If an agent needs a tool, it already has hands.

## The Executive Board

For decisions that deserve more than one opinion, Nova convenes an executive board of seven distinct thinkers. Each has its own AI provider, persona, and mental model:

- **CEO** (modeled after Jeff Bezos) focuses on Day-1 thinking and customer obsession. Owns long-term vision and flywheel effects.

- **CFO** (Patrick Campbell) reasons about unit economics, pricing, and capital efficiency. Ensures every dollar compounds.

- **CMO** (Seth Godin) builds remarkable brands and tribes. Focuses on permission marketing and Purple Cow ideas, not incremental campaigns.

- **CTO** (Werner Vogels) designs systems with "everything fails" as the starting point. Ensures technical choices serve business outcomes.

- **COO** tracks execution, finds bottlenecks, and turns strategy into results. The engine that makes things happen.

- **Head of Research** (Ben Thompson) synthesizes trends and platform dynamics. Provides the intellectual foundation for decisions.

- **Critic** (Charlie Munger) does pre-mortems, finds failure modes, and keeps everyone honest. Never executes—only analyzes.

Invoke the board with `/board your question`. The flow: each executive contributes independently, the Critic performs a pre-mortem, Nova synthesizes 3–5 options with confidence scores, and you choose the path. The decision gets recorded and fed to the execution engine.

## Two-Phase Execution: Approval Before Action

The moment that separates Nova from a blank check is the approval gate. Every consequential action — publish, send, spend, create — happens in two phases:

- **Prepare** — The safe half. Research, draft copy, generate images, analyze data, design pages. Nothing leaves the building yet.

- **Approve** — Nova shows you exactly what it's about to do: preview the email, the social post, the ad creative, the code. Telegram buttons: *Approve*, *Revise*, or *Cancel*.

- **Execute** — Only after your sign-off does it do the irreversible thing.

For routine tasks you trust completely, you can auto-approve: messages starting with "just do it", "go ahead", or "ship it" skip the gate. The gate stays closed until you train it otherwise.

If you tap *Revise*, the session is saved to the database. Your next message is treated as feedback, and Nova re-runs the prepare phase with your guidance.

## Earned Autonomy: Trust Built on Track Record

Autonomy isn't a blank check — it's earned. Every type of action starts at **always ask**. As an agent builds a clean track record on a specific task — say, "send the weekly newsletter" — it graduates in stages:

- **Level 0 (Ask)** — Nova prepares and waits for your approval every time.

- **Level 1 (Notify)** — Nova executes and notifies you after. You can still review what happened.

- **Level 2 (Autonomous)** — Nova runs fully on its own, within a spending cap you set per action type.

One failure or one rejection and it drops straight back to Level 0. You set the cap (daily spend, email list size, infrastructure cost), and you can change it anytime from the dashboard. It's trust that survives failure.

## Memory & Goals: Semantic Recall That Compounds

Every conversation feeds a persistent knowledge base. Nova uses a two-part system:

**Intent tags** let you save facts, set goals, create tasks, and schedule work — all via structured tags Nova parses from responses:

- `[REMEMBER: fact]` — Save a fact with vector embeddings for semantic search.

- `[GOAL: grow newsletter to 10k | DEADLINE: 2026-12-31]` — Set a goal with optional deadline. Nova checks progress.

- `[TASK: Kai | write 3 blog posts on AI trends]` — Delegate to a specialist.

- `[SCHEDULE: social post | 2026-07-20 at 9am | RECUR: weekly:monday:9am]` — One-time or recurring. Conditional rules supported.

Nova stores these in SQLite with vector embeddings (all-MiniLM-L6-v2 model, 384 dimensions) and injects relevant facts into every message. So when you ask a question three weeks later, Nova already knows your context — what you're building, what you've tried, what failed, and what's working.

## Proactive Services: Background Intelligence That Stays Current

Nova doesn't just wait for you to ask. Several proactive services run on schedules you configure:

#### Morning Briefing

Daily digest: key metrics, new leads, support tickets, schedule changes. Delivered to your Telegram before you start work.

#### Smart Check-in

Context-aware prompts when you're idle. Offers next actions based on your goals and unfinished tasks — not a dumb "how are you" bot.

#### AI News Monitor

Curated news about AI developments and industry trends, parsed so you get signal not noise.

#### Social Post Suggester

Ideas for social content based on what's trending in your niche and your brand voice.

#### Lead Suggester

Identifies warm leads from your network and explains why they're relevant to your current goals.

#### Meta Ads Report

Daily analysis of ad performance, cost per lead trends, and recommendations for pausing or scaling.

Each service is opt-in. Most default to daily or periodic schedules, but you can customize timing, disable, or add conditions (e.g., "only send if there's a crisis").

## Multi-Channel & Integrations

### Talk to Nova where you already are

Nova works via Telegram, WhatsApp, and Slack. The same agent team, the same approval gate, the same memory — you just pick where you want to chat. Messages sync across channels, so you can start a task in Slack and revise it in Telegram.

### 12 MCP integrations built in

Nova connects to the tools your business already uses:

- **Google Workspace** — Gmail, Calendar, Drive, Docs, Sheets. Draft emails, create schedules, pull data.

- **Notion** — Read and write databases, pages, and documentation. Keep institutional knowledge in sync.

- **Playwright** — Browser automation, screenshots, scraping. Agents can log into your apps and take actions.

- **Cloudflare** — Workers, DNS, edge functions. Deploy serverless code and manage infrastructure from Nova.

- **ClickUp** — Task management. Agents create tasks, update statuses, and track dependencies.

- **GoHighLevel** — CRM, campaigns, social publishing. Agents can create leads, launch campaigns, and publish posts.

- **Square** — POS and sales data. Agents can analyze revenue, refunds, and customer transactions.

- **Zoom** — Schedule meetings directly from Nova without leaving Telegram.

- **Firecrawl** — Web scraping at scale. Agents can gather competitor data or customer research.

- **Tavily** — Web search API. Agents research topics, find best practices, and analyze trends.

- **Exa** — Semantic web search. Find papers, articles, and resources by concept, not keywords.

- **Browserbase** — Headless browser sessions. Agents can interact with modern web apps that require JavaScript.

Each integration uses your own credentials or API keys — Nova doesn't mediate access. Your data, your rules.

## Built to Be Trusted: Audit, Sandboxing & Verification

### Sandboxed execution

Agent tasks can run inside a hardened container: read-only system, isolated filesystem, no access to your host except a per-task workspace, no path to your credentials. If an agent encounters a malicious webpage or prompt injection, it stays contained. And sandboxing doesn't force you to pay-per-token — Nova runs your subscription inside the sandbox instead of quietly switching billing.

### Autonomous verification

After each task, the agent automatically verifies its own work. Did the email send? Does the page render? Did the database update? If it fails, you see the error immediately. If it succeeds, you get a signed ledger entry.

### Complete action ledger

Every consequential action is logged: what ran, which agent, which user approved it, what it cost, when it finished, whether it succeeded. Query the ledger by date range, agent, action type, or cost. Business-grade mostly means *answerable after the fact*, and Nova is.

### Governance dashboard

See real-time spending, cost per agent, which tasks are running, which agents have highest error rates, and which operations need your attention. Spend caps are enforced — if an agent hits its budget, it stops and alerts you.

**Why this matters** An AI team that can send emails and spend money is only useful if it's also *safe*. Sandboxing, verification, and audit trails turn "it probably won't do anything dumb" into real guarantees you can defend.

## Smart AI Routing

Nova runs on Claude, Gemini, or other providers. Rather than forcing one model for everything, Nova routes based on task type, cost tier, and rate limits. A fast question might go to Haiku. A complex strategic analysis gets Opus. You can override anytime with a prefix: `/claude your question` forces Claude, `/gemini your question` forces Gemini.

This matters because some tasks are cheap to think through and others need the biggest model. Nova makes that choice automatically, but you're never locked in.

## Pattern Caching: The Same Request, Instantly

Every successful decomposition plan — the breakdown of a complex task into agent subtasks — gets cached with semantic indexing. The next time you ask a similar question, Nova recognizes the pattern and skips classification. This saves both tokens and latency. As you use Nova, it gets faster on your recurring work.
