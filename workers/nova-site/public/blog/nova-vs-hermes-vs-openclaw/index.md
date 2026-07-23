# Nova vs. Hermes vs. OpenClaw: the good, the bad, and the ugly

> An honest, sourced comparison of three self-hosted, open-source AI agents — OpenClaw, Hermes, and Nova — with a feature table, charts, and the good, the bad, and the ugly of each.

*Source: https://mynova.space/blog/nova-vs-hermes-vs-openclaw/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Three open-source, self-hosted AI agents you run yourself and talk to from your chat apps — and three very different bets on how much to trust an AI with the keys. An honest, side-by-side look.

Jake Belieny · 20 July 2026 · 12 min read

**Full disclosure** I build Nova. I've worked to keep this fair — the numbers are sourced, and Nova gets its own *bad* and *ugly* like everyone else. If anything reads as unfair to Hermes or OpenClaw, tell me and I'll correct it.

Self-hosted AI agents had a breakout year. You run them on your own hardware, point them at your files and your chat apps, and they don't just answer — they *do things*: send messages, run commands, browse the web, automate your busywork. Three get talked about the most: **OpenClaw**, the viral juggernaut; **Hermes**, the research-grade agent from Nous Research; and **Nova** — the one I build.

They share a shape but disagree, deeply, on one question: **how much should an AI be allowed to do on its own?** That single disagreement explains almost everything else about them — so keep it in mind as we go.

## The landscape

Two of these are giants. OpenClaw went from launch (as "Clawdbot") in November 2025 to a quarter-million GitHub stars within months; Hermes, backed by a well-funded AI research lab, isn't far behind. Nova is the newcomer — just open-sourced, essentially zero stars. I'm not pretending Nova wins a popularity contest. It doesn't.

GitHub stars, July 2026 (live). Reach, not fit — everything below is about fit.

## Meet the three

**OpenClaw** — a personal AI assistant that lives in your chat apps. Built in TypeScript/Node with a Swift companion, it connects any model — Claude, GPT, Gemini, DeepSeek, or fully local — to 20+ messaging channels, 100+ community "skills," voice, a live canvas, and mobile apps. Its signature move is a *heartbeat*: every 30 minutes it wakes, reads a `HEARTBEAT.md`, and acts on its own. MIT-licensed; now stewarded by the OpenClaw Foundation after its creator, Peter Steinberger, joined OpenAI in February 2026.

**Hermes** — Nous Research's self-improving agent, in Python. Model-agnostic to a fault: any OpenAI-compatible endpoint, and it can even reuse your vendor CLI's subscription tokens. It creates and refines its own skills from experience, models you with a dialectic memory system (Honcho), runs a "code mode" that calls tools over RPC, and can hibernate on serverless backends. It ships a terminal TUI, editor (ACP) integration, ~28 channels, and even tooling to generate training data. MIT.

**Nova** — an AI *team*, not a chatbot: 24 named specialists and an executive board, coordinated by task decomposition, in Bun/TypeScript. The defining choice is **two-phase execution** — it prepares safe work, then asks for your approval before anything ships, sends, or spends. It drives your Claude/Gemini/Codex *subscriptions* within their terms (and now any OpenAI-compatible model too). Telegram, WhatsApp, Slack, Discord, and your terminal. MIT.

## Side by side

|  | OpenClaw | Hermes | Nova |
| --- | --- | --- | --- |
| Runtime | TypeScript / Node | Python | Bun / TypeScript |
| License | MIT | MIT | MIT |
| GitHub stars (Jul 2026) | ~384k | ~218k | new |
| Primary interface | Chat apps | Terminal + chat | Chat apps + terminal |
| Messaging channels | 20+ | ~28 | 5 (TG / WA / Slack / Discord / CLI) |
| Models | Any, incl. local | Any, incl. subscription-token reuse | Subscription CLIs + any OpenAI-compatible |
| Multi-agent | Session routing | Subagents + code-mode | 24 specialists + executive board |
| Human approval before acting | ✗ off by default | ✗ off by default | ✓ on by default |
| Proactive / autonomous | Heartbeat, every 30 min | Background review + cron | Scheduler + services (scheduled runs unattended) |
| Self-improving skills | ✗ static | ✓ auto-created | ✓ promotes proven wins |
| Default execution surface | host (sandbox opt-in) | sandbox backends | Approval gate; host by default, Docker opt-in |
| Backing | Foundation (creator → OpenAI) | Nous Research lab | Solo (Jake) |
| Maturity | Battle-tested, huge | Research-grade, active | New (2026) |

## Where each one sits

Strip away the feature lists and they line up on two axes: **how much it acts without you**, and **how much it's a single assistant versus a whole team**.

The one chart that matters: Nova sits alone on the "asks first" side — on purpose.

## The good, the bad, and the ugly

### OpenClaw

The ecosystem is unmatched — 20+ channels, 100+ skills, mobile apps, voice, a slick control UI. If you want an always-on assistant in WhatsApp that just works and actually does things, nothing else is this polished or this widely used. And it runs on truly any model.

By default, tools run **on your host, autonomously** — the main session executes without an approval step. Convenient, but it's a lot of trust to hand a probabilistic system with reach into your shell, email, and messages. Sandboxing exists, but it's opt-in for non-main sessions.

That trust has bitten people. Cisco researchers documented third-party skills performing **data exfiltration and prompt injection without the user's awareness**, against a largely unvetted skill registry. In March 2026, Chinese authorities restricted state enterprises, agencies, and banks from running it over data-deletion and leak concerns. And in the widely-reported "MoltMatch" episode, an agent created a dating profile — reportedly using a real person's photos without consent. Power without a gate cuts both ways.

### Hermes

The most *interesting* of the three. It genuinely learns — forking a background copy of itself to write and refine skills after hard tasks — builds a model of you over time, and will run on literally any endpoint, including a serverless box that costs almost nothing when idle. For researchers and serious tinkerers, it's a playground with real depth (down to generating training data for tool-calling models).

It's heavy. Core files run into the hundreds of kilobytes; there's a large surface area to understand and operate, and the self-improving loop can sprawl if you don't watch it. And it's Python — great if that's your stack, friction if it isn't.

To get subscription pricing on Claude or Codex, Hermes **reuses the vendor CLI's OAuth tokens** to call the subscription backends directly from its own process. It's clever and it saves money — but it plausibly runs against those subscriptions' terms, and it breaks whenever a vendor rotates auth. Like OpenClaw, its default posture is broad autonomy, not approval.

### Nova

The whole thing is built around **not** trusting the AI blindly. Two-phase execution means nothing ships, sends, or spends until you approve it — with a readable preview of what's about to happen. It reads like an org chart (24 specialists plus an executive board), drives your subscription CLIs *within their terms* (no token games), and it's a coherent Bun/TypeScript codebase you can actually sit down and read. And it quietly **learns**: repeat a task enough and Nova promotes the winning plan into a reusable skill, reassigns and self-heals failed steps mid-run, and tracks which specialists perform.

It's brand-new and tiny. Essentially zero stars, a community of roughly one, thinner docs, fewer integrations, and none of the free battle-testing a 200k-star project gets. Fewer channels than OpenClaw. If you want a huge skill marketplace *today*, it isn't here yet.

Its learning is earned, not instant — Nova promotes a skill only after a handful of *successful* runs, so it improves through repetition rather than the on-the-fly reflection Hermes does. The org-chart model has a learning curve, and while simple asks take a fast path (not the full board), the default posture is hands-on: the approval gate keeps you in the loop, and you loosen it with autopilot and earned autonomy as trust grows. If you want a fully hands-off agent from minute one, that deliberate caution will feel like friction.

## So which should you pick?

- **OpenClaw** — if you want the biggest ecosystem and a polished, hands-off assistant in your chat apps today, and you're willing to sandbox it and vet skills yourself.

- **Hermes** — if you're a researcher or serious tinkerer who wants a model-agnostic, self-improving agent, and you don't mind Python heft or the token-reuse caveat.

- **Nova** — if you want an AI *team* that asks before it acts, stays inside your subscription terms, and keeps you in the loop by design — and you can live with a young project.

There's no universal winner here — only a winner for *your* risk tolerance. OpenClaw and Hermes bet that autonomy is worth the exposure. Nova bets the opposite: that the thing standing between a helpful agent and an expensive mistake is a human tapping *approve*. Pick the bet you're comfortable making with your shell, your keys, and your customers.

Sources & notes: star counts from the GitHub API (July 2026); OpenClaw history, naming, and documented security/regulatory issues from [Wikipedia](https://en.wikipedia.org/wiki/OpenClaw) and public reporting; Hermes and Nova details from their public repositories. Numbers move — treat them as a July-2026 snapshot.
