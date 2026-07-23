# How Nova works: the architecture under the hood

> A technical deep dive into Nova's architecture: 3-tier message classification, task decomposition with dependency resolution, parallel execution, two-phase approval gates, split SQLite with vector search, and intelligent AI routing across Claude, Gemini, and Codex.

*Source: https://mynova.space/blog/architecture/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova's power comes from how it thinks, not just what it can do. Here's a technical walkthrough of the pipeline that turns a Telegram message into coordinated work across 24 specialist agents, how it learns from patterns, and why it asks before it acts.

Jake Belieny · 15 July 2026 · 13 min read

A traditional chatbot takes your message and runs it straight to an LLM. Nova takes a longer, smarter route. Every message gets **classified** into one of three buckets, each handled differently. Simple things stay fast. Focused work routes to a specialist. Big decomposable problems get broken into subtasks and run in parallel. And nothing consequential happens until you say so.

It's a pipeline, not a black box. At every stage — classification, decomposition, execution — the system makes a deliberate decision. You can read the code. You can change it.

## How Nova decides what to do with your message

When you send a message, Nova doesn't immediately ask Claude to reason about it. Instead it uses a **3-tier classification system** designed to keep as many requests as possible out of the LLM entirely.

### Tier 1: The heuristic (instant, zero cost)

Messages under 15 words with no action verbs get a direct answer from Claude. "What time is it?" stays instant. This catches quick lookups, status checks, and casual questions — the kind where routing overhead would be silly.

### Tier 2: Pattern matching and single-agent routing

Nova remembers successful task decompositions. If you asked "draft a newsletter" last week and got a plan that worked, and you ask something similar today, Nova reuses that same plan without re-running the LLM. For new requests, Nova pattern-matches against known task templates — things like "social media post", "email campaign", "blog article", "ad creative" — and routes them straight to the right specialist agent.

### Tier 3: LLM classification (only when necessary)

Everything else goes to Claude Sonnet, which classifies it as simple (direct answer), routed (single agent), or complex (decompose and parallelize). This happens once per unique type of request, then gets cached.

**The result** Simple messages get answered without an LLM call at all. Repeated tasks reuse a cached plan. Only genuinely new requests pay for a classification call — and each one becomes a pattern that makes the next similar request faster.

## Breaking complex work into independent pieces

When you ask Nova something big — "plan and launch our Q3 campaign" — the planner takes over. It breaks the request into subtasks, figures out dependencies, and runs everything that can happen in parallel.

Some of Nova's most complex workflows are **deterministic pipelines**, not LLM-generated each time. A social media campaign always follows the same shape: research → content → image → preview → publish. A blog post is always research → write → hero image → preview → publish. This means you get a predictable, reproducible process for work you do repeatedly.

For truly novel requests, the LLM decomposes the task. It returns JSON: an array of subtasks, each with a description, which agent should handle it, and which other tasks it depends on. Dependencies are resolved, then independent subtasks run at the same time.

## Two phases: prepare first, ask permission, then execute

The moment a task touches the real world — publish a post, send an email, spend money — it needs approval. Nova implements this as two distinct phases.

**Prepare** is the safe half. Research, write the copy, generate images, run analytics. Artifacts flow from subtask to subtask. Everything is reversible or at least refundable. This phase produces a summary and artifacts, sent to you in Telegram with three buttons: Approve, Revise, or Cancel.

**Execute** only runs after you tap Approve. It publishes, sends, creates, spends — all the irreversible stuff. But it runs with full context from prepare: the copy is already written, the image is already generated, the timing is already planned.

Users who run the same task weekly can eventually **earn autonomy**. After a few clean executions of "send the newsletter", the system can graduate it: first to "send it and notify you after", then to "send it autonomously up to a $50 budget". One rejection and it drops back to asking. You're always in control of how much rope each task gets.

## How Nova stores what it knows

Nova uses a **split SQLite architecture**: one shared database for Nova's own state, and one per-user database for everything private to that user.

#### Shared database

User accounts, cost tracking, logs, global facts, service state. One instance per Nova deployment.

#### Per-user database

Messages, personal memory, agent tasks, approvals, scheduled work, execution patterns. Stays on your machine.

Both use `sqlite-vec` for vector search. Every fact, every memory, every message gets embedded with `all-MiniLM-L6-v2` (384 dimensions). When the planner needs context — "what do we know about pricing strategy?" — it does a semantic search instead of keyword matching. This means Nova can find relevant context even when you don't use the exact same words.

Embeddings are cheap to compute locally, and the search results are cached. Your data never leaves your machine. Your keys, your subscription, your database.

## Choosing the right AI for the job

Nova can route work to Claude, Gemini, Codex, or Groq. The decision happens automatically using **smart routing**: force override (you prefix with `/claude` or `/gemini`) beats your default. Your default beats hint-based routing. Hint-based beats rate-limit fallback.

The routing logic considers the task type. MCP-heavy work (managing Notion docs, Calendar events, Gmail) routes to Claude because of its native MCP support. Research and web synthesis go to Gemini because of its free tier and strong synthesis. Fast classification goes to whichever provider has the cheapest fast model.

Each provider has three tiers: `fast` (classification, cheap), `standard` (task execution, balanced), and `premium` (critical reasoning, best quality). The router picks the tier based on the task criticality.

## The building blocks: patterns, memory, and integrations

### Pattern learning

Every successful task execution gets recorded as a pattern. The next time you ask something similar, Nova scores your request against those patterns by keyword overlap. When a request closely matches a previous plan that already has two or more clean executions, Nova reuses it. This turns repeated tasks into one-step actions — and a pattern that keeps succeeding is eventually promoted into a reusable skill.

### Persistent memory

Nova embeds everything you tell it to remember. Use `[REMEMBER: fact]` in a response and it saves the fact, deduplicates against existing memory, and makes it available for semantic search on every future request. You can also set `[GOAL: text | DEADLINE: date]` to track objectives, and Nova will remind you of progress and blockers.

### 12 MCP integrations

Nova ships pre-configured with Notion, Google Workspace (Gmail, Calendar, Drive, Docs, Sheets), Playwright, Cloudflare Workers, Zoom, Square, ClickUp, GoHighLevel, Firecrawl, Tavily, Exa, and Browserbase. Each agent can access the ones relevant to its domain. You provide the credentials once during setup, and they stay on your machine.

### Scheduled and proactive work

Nova can run tasks on a schedule: daily briefings, weekly reports, monthly audits. It learns your patterns — when you're most likely to want news, which reports matter most, which team members to loop in — and proactively reaches out. A morning briefing isn't just "here's your calendar", it's "here's your calendar plus the three most important emails plus your top priority for today based on your goals".

## The executive board: strategy at scale

For the biggest decisions, Nova runs a **board meeting**. Seven executives — CEO, CFO, CMO, CTO, COO, Head of Research, and Critic — each with a distinct persona and priority agents, convene on your strategic question.

The meeting follows a structured flow: each executive independently analyzes the question, the Critic identifies failure modes and gives a GO/NO-GO, then Nova synthesizes 3–5 options ranked by confidence. You pick one, the decision gets recorded to the ledger, and the executive team delegates autonomous work based on the decision through the main Nova orchestrator.

The executives use different AI providers (Claude for strategy, Gemini for analytics, Codex for technical depth) and coordinate through a shared database. Each executive node runs independently on its own VPS, making it possible to scale across unlimited work without a central bottleneck.

## Why this architecture?

Nova's design makes five things possible:

- **Speed** — many messages never touch an LLM at all. Heuristics and cached patterns keep the fast path fast.

- **Cost efficiency** — Every route chooses the cheapest model adequate for the task. Fast tiers for classification, standard for execution, premium only when reasoning matters.

- **Parallelism** — Independent subtasks run concurrently. A 10-step campaign doesn't take 10× the time; many steps collapse into 2–3 batches.

- **Auditability** — Every decision is logged. You can see why Nova routed to an agent, what the dependencies were, whether it used a cached pattern or called the LLM.

- **Control** — Two-phase execution means consequential work stops for approval. Patterns and autonomy escalation mean you gradually trust more work to run unsupervised as the system proves itself.
