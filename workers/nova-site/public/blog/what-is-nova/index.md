# What is Nova? Your open-source AI team, explained

> Nova is a self-hosted, open-source AI team you run from Telegram: 24 specialist agents, an executive board, human approval before anything ships or spends, sandboxed execution, and earned autonomy. Here's what it does and how people use it.

*Source: https://mynova.space/blog/what-is-nova/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Nova is a self-hosted, open-source platform that turns a group of specialist AI agents into something closer to a company than a chatbot — and it asks before it does anything that ships, spends, or sends.

Jake Belieny · 15 July 2026 · 8 min read

Most "AI assistants" are one model behind a text box. You ask, it answers, and every consequential step is still on you. Nova takes a different shape. It's an **org chart**: two dozen specialists, an executive board that reasons about strategy, and a coordination layer that decomposes a request into tasks, runs them in parallel, and pauses for your approval before it touches the real world.

And it runs where you already are. You message Nova in Telegram (or WhatsApp or Slack) the same way you'd message a coworker — and it runs on **your** machine, on **your** API keys or subscriptions, with your data staying in local storage. It's MIT licensed, so you can read every line, change anything, and owe nobody a per-seat fee.

**The one-line version** Nova is self-hosted AI staff: a team of agents that plan, draft, and analyze on their own — but get your sign-off before anything leaves the building.

## How a message becomes work

When you send Nova a message, it first **classifies** what you're asking for. A quick question gets a direct answer. A focused task gets routed to the right specialist. Something big — "plan and launch our spring campaign" — gets **decomposed** into a dependency-aware plan and executed across several agents at once.

Then comes the part that makes Nova trustworthy. Work happens in **two phases**:

- **Prepare** — the safe half. Research, write the copy, generate the image, crunch the numbers. Nothing has left the building yet.

- **Approve** — Nova shows you exactly what it's about to do, with inline buttons: *Approve*, *Revise*, or *Cancel*.

- **Execute** — only after you approve does it do the consequential thing: publish the post, send the emails, launch the campaign, spend the money.

## The team you're actually hiring

Under the hood, Nova is **24 specialist agents**, each with its own domain, tools, and system prompt. You don't have to know their names — Nova routes to the right one — but it helps to see the shape of the roster:

#### Growth & marketing

Helios (paid ads), Pixel (social), Kai (content), Orion (email), Magnus (SEO), Morpheus (video), Flux (funnels).

#### Strategy & ops

Athena (business strategy), Oracle (trend forecasting), Tesseract (systems thinking), Zen (productivity), Bridge (partnerships).

#### Data & engineering

Digit (analytics), Cipher (data science), Architect (web dev), Joule (automation), Rift (security).

#### Voice & support

Aura (brand voice), Echo (customer support), Helia (PR), Nexus (community), Quill (grants), Lex (legal), Cyra (site optimization).

Above the specialists sits an **Executive Board** — CEO, CFO, CMO, CTO, COO, Head of Research, and a Critic — each modeled on a distinct way of thinking. Ask a hard strategic question with `/board` and they convene: independent analysis, a pre-mortem from the Critic, then a synthesis of options with confidence scores for you to choose from.

## Built so you can actually trust it with the keys

An AI team that can send emails and spend ad budget is only useful if it's also *safe*. Nova's most recent release is all about that — turning "it probably won't do anything dumb" into real guarantees.

### Sandboxed execution

Agent tasks can run inside a hardened container — read-only system, no access to your host files beyond a per-task workspace, no path to your credentials — so a webpage that tries to hijack an agent through a cleverly-worded paragraph can't reach anything that matters. And it stays on your **subscription**: Nova shares your Claude, OpenAI, or Gemini plan into the sandbox instead of quietly switching you to pay-per-token billing.

### Earned autonomy, not a blank check

Every kind of action starts at **always ask**. As an agent builds a clean track record on a given task — say, "send the weekly newsletter" — it graduates: first to *notify you after*, then to *fully autonomous within a spending cap*. One failure or one rejection and it drops straight back to asking. You decide how much rope each agent gets, and you can see and change it from a dashboard.

### An audit trail for everything

Every consequential action is written to a ledger — what ran, which agent, what it cost, whether it worked. After each task an agent even **verifies its own work** ("did the email actually send? does the page render?") before reporting done. Business-grade mostly means *answerable after the fact*, and Nova is.

## What people use it for

Because Nova is a team rather than a single tool, the useful requests tend to be the ones you'd hand to a capable employee. A few real shapes:

### Run the marketing that runs on a schedule

Newsletters, social calendars, ad reports. "Post three times this week about the launch," "summarize how last month's ad spend performed," "turn this blog post into a LinkedIn thread and a carousel." Nova drafts, you approve, it publishes — and once you trust a recurring task, you let it run on its own.

### Turn a standing goal into ongoing work

Tell Nova a goal — "grow the newsletter to 5,000 subscribers" — and it doesn't just nod. It breaks the goal into concrete tasks, schedules them, executes over days and weeks, and reports progress. It's the difference between a tool you operate and staff that pursue an outcome.

### Make the big calls with a board behind you

For the decisions that deserve more than one opinion, the executive board is a genuine thinking partner. "Should we expand into the EU?" convenes seven perspectives, surfaces the failure modes you didn't think of, and hands you scored options — not a single confident guess.

#### Solo founders

A whole marketing, data, and ops team you can afford — on your own accounts, asking before it spends.

#### Small teams

Offload the recurring grind (reports, drafts, scheduling) with a paper trail and approval gates the whole team can see.

#### Builders & tinkerers

MIT licensed and self-hosted. Read it, fork it, add your own agents, wire in your own tools.

#### Privacy-minded

Your data lives in local storage on your machine. Your keys, your subscription, your rules.

## Getting started

Nova is designed to get you from clone to first message with almost no friction. One command — `bash bootstrap.sh` — installs anything missing ([Bun](https://bun.sh), the Claude Code CLI) and launches a guided wizard that asks for a Telegram bot token and one AI provider, sets up a few starter agents, and verifies the connection. It even detects your Telegram user ID automatically, and it's resumable if you step away. The rest (the executive board, extra integrations) you can turn on when you want them.

- Clone the repo and run `bash bootstrap.sh`.

- Message your bot in Telegram — Nova greets you with tappable starter ideas, and `/team` introduces your specialists in plain language.

- Turn on sandboxing, autonomy, and the self-hosted board as you grow into them — all opt-in, nothing forced.
