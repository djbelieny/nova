# Nova, production-hardened: governance, exactly-once & connected data

> The hardening release: hard-block compliance policies, role-based permissions, out-of-office delegation, durable exactly-once idempotency, advisory locks, encrypted connector secrets, connectors agents can discover like MCP tools, and a connected-data layer — everything you need to run Nova unattended, for a team.

*Source: https://mynova.space/blog/governance-hardening/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Building automations is one thing; leaving them running — for a team, on real money — is another. This release is about that second thing: hard limits that hold even when you approve, permissions and delegation, exactly-once guarantees, encrypted secrets, and a way for Nova to read the data your business actually runs on.

Jake Belieny · 22 July 2026 · 8 min read

The last few releases gave Nova reach: a knowledge base, event-driven automations, playbooks, durable processes, connectors, ROI. This one gives it **restraint and rigor** — the unglamorous guarantees that turn "impressive demo" into "you can leave it running for your team." Every piece is additive: with nothing configured, Nova behaves exactly as it did before.

**The one-line version** Hard limits that hold even when you approve, role-based permissions, out-of-office delegation, exactly-once idempotency, no-double-fire locking, encrypted secrets, connectors agents discover like MCP tools, and a read-only data layer for the systems your business runs on.

## Hard limits that hold — even when you approve

Nova's approval gate has always been the trust anchor: consequential work waits for your yes. But some rules shouldn't be a person's to waive. If policy says customer PII never leaves the building, an approver clicking "approve" too fast shouldn't override it.

So compliance policies now have a real **hard block**. A content check set to *block* is enforced at the execute boundary against the actual prepared output — after approval, on the autopilot path, everywhere. If it trips, nothing ships, and Nova tells you why. *Warn* still just flags; *block* genuinely stops.

## Who can do what — and who covers you when you're out

A one-person Nova and a team Nova need different controls. Two arrive here:

#### Role-based permissions

Admins can do everything. Members get scoped capabilities — manage automations, policies, connectors, playbooks — so you decide who can change what. Granted with `nova access grant @teammate automation.manage` or `/access`.

#### Out-of-office delegation

Going away? `/ooo @teammate` and your assignments and approvals route to them until you're back — a cycle-guarded chain, cleared with `/ooo off`.

## The boring guarantees that matter

Automation that reacts to the world unattended lives or dies on three unglamorous properties:

- **Exactly-once.** Webhooks get retried; a payment event can arrive twice. An automation can opt into durable idempotency (`--idempotent`) so it fires once and only once — not again an hour later when the sender retries.

- **No double-fire.** Advisory locks now wrap the automation poller and the task dispatcher, so two overlapping ticks — or two instances on two machines — never process the same work twice.

- **Encrypted secrets.** Connector credentials are stored AES-256-GCM encrypted at rest and set with `nova connector set stripe STRIPE_API_KEY=…`, with a rotation audit — no more live API keys sitting in a plaintext `.env`.

## Connectors agents can actually use — without the bloat

Nova drives its integrations through **mcp2cli**, a deliberate choice: instead of stuffing every tool's full schema into an agent's prompt (which balloons context and cost), agents *discover* tools at runtime — list them, ask for a tool's parameters, then call it. It keeps the prompt lean no matter how many tools exist.

Connectors now follow that exact idiom. An agent runs `nova connector describe stripe` to learn its actions and parameters on demand, then `nova connector run …` to call one — reading freely, and proposing any write (a refund, a new record) for your approval rather than doing it alone. Adding a connector doesn't grow the prompt; discovery does the work. It's the difference between handing someone a 200-page manual and telling them where the manual is.

## Reading the data your business runs on

Analysis is only as good as the data it can reach. The new **connected-data layer** lets you register the sources your numbers actually live in and query them — read-only, by design:

#### HTTP

Any JSON or CSV endpoint — a report URL, an internal API.

#### SQLite

A read-only `SELECT` against a database file — analytics, exports, a local warehouse.

#### Connector

A connector read action — pull orders, charges, or tickets straight through.

Register once with `nova data add`, then query from the terminal, from chat (`/data query sales`), from an agent mid-task, or on a schedule for a recurring report. No new dependencies, no warehouse required.

## Still the same promise, just sturdier

None of this changes what Nova is — it makes it something you can trust with more. The approval gate still stands; now there are limits even it can't cross, permissions around who sets them, guarantees that the work runs once and cleanly, and reach into the data and systems your business depends on. The demo grew up into something you can actually leave running.
