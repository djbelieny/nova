# Nova runs the operation now: playbooks, automations & connectors

> Nova's biggest release turns it event-driven and process-durable: playbooks (reusable SOPs), event automations with semantic triggers, durable multi-day processes, document extraction, business connectors (Stripe/Shopify/Zendesk/HubSpot), compliance policies, and ROI reporting — every consequential step still gated.

*Source: https://mynova.space/blog/business-automation/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

A chatbot answers. A business needs work to happen — on a schedule, in response to events, across days, with a paper trail. Nova's biggest release turns it from an assistant you ask into a system that runs the repeatable work in the background — and still asks before anything ships, spends, or sends.

Jake Belieny · 21 July 2026 · 9 min read

For a while, Nova has been very good at the thing you ask it to do *right now*: decompose a request, route it to specialists, prepare the work, and wait for your approval before anything goes live. That's the assistant. But a business doesn't run on requests — it runs on **repeatable work** that happens on a schedule, reacts to events, spans days, and leaves a paper trail.

This release closes that gap. Nova is now **event-driven and process-durable** — a whole layer for building, running, and watching automated operations. And it lands on the same principle everything else does: the safe half runs freely; the consequential half still asks.

**The one-line version** Author a process once and run it many times; fire workflows off real-world events; keep multi-day processes moving; pull structured data out of documents; read and write your business tools; put guardrails on spend and compliance; and see the value it all delivers — self-hosted, on your keys.

## What shipped

#### Playbooks

Reusable SOPs — author a process once, run it many times with variables.

#### Automations

Event → condition → workflow, with dedupe, rate limits, and semantic triggers.

#### Durable processes

Multi-day flows that wait for a timer or an event, then resume — surviving restarts.

#### Document extraction

Invoices, receipts, and forms → structured, validated data.

#### Connectors

Stripe, Shopify, Zendesk, HubSpot — read and write, two-way.

#### Policies

Spend caps, approval matrices, and content checks — restrictive-only guardrails.

#### ROI reporting

Tasks automated, hours saved, and value vs. cost — by department and agent.

#### Operate & observe

A unified activity feed, dry-run previews, and a dead-letter queue for failures.

## Playbooks: your processes, written down and runnable

Every business has a set of "how we do X" processes — onboard a client, handle a refund, ship a launch. A **playbook** is that process, made runnable: a few ordered steps, each assigned to a specialist, with variables you fill in at run time. Author it once; run it whenever, with different inputs.

Playbooks are personal or team-wide, and they're versioned — editing bumps a version, so an automation can pin the one it was built against. Nova ships a starter library you can clone and edit.

## Automations: when something happens, do the work

The biggest shift is that Nova now **reacts**. An automation has a source (an inbound webhook, a metric crossing a threshold, or a business event like a new Stripe payment), optional conditions, and an action — run an agent, or run a playbook. A new lead arrives, a payment fails, a form comes in — Nova picks it up and does the next thing, through the same approval gate.

- **Conditions** filter on fields (`amount > 1000`, VIP senders, and so on), with per-hour dedupe and rate limits so a noisy source can't spam you.

- **Semantic triggers** go further: fire on *meaning*, not exact matches. "When an email reads like a complaint" or "sounds like a cancellation" — matched with the same local embeddings that power the knowledge base.

## Processes: for work that spans days

Some things don't finish in one run: *send the contract → wait for a signature → invoice → wait for payment → fulfill.* A **durable process** is a sequence of action and wait steps that survives restarts and resumes on a due timer or a named event. Nova holds the state, waits patiently, and picks up exactly where it left off — no cron spaghetti, no dropped threads.

## Extraction: turn documents into data

The knowledge base was about *retrieval* — ask, and Nova answers from your material. Extraction is the mirror image: **capture**. Define the fields you care about and Nova pulls clean, type-checked JSON out of a PDF, a DOCX, or a scanned form — invoice number, total, due date, line items — validated and ready to push into a sheet or your CRM. Drop a document in chat with "extract as invoice," or wire it to an automation so every incoming invoice files itself.

## Connectors: Nova, meet your stack

Automation has to live where your business already runs. Nova now speaks to external systems through a thin, uniform **connector** layer, with four built in and bidirectional: **Stripe** (charges, customers, refunds), **Shopify** (orders), **Zendesk** (tickets), and **HubSpot** (contacts). Each brings read and write actions plus a trigger that feeds automations — so `stripe.payment` or `shopify.order` can start a workflow. Adding your own is a single file.

## Policies: guardrails that only tighten

Handing work to an autonomous system is only comfortable if you can bound it. Policies sit on top of Nova's earned-autonomy ladder and are **restrictive-only** — they can require approval, block, or warn, but never grant more freedom than the ladder already allows. Set a monthly spend cap per department, route certain actions to a named approver with an escalation timeout, or scan outgoing content for PII before it ships. With no policies set, nothing changes.

## ROI: prove it's working

An automation you can't measure is an automation you'll eventually switch off. When an agent finishes something quantifiable, it tags the outcome; Nova rolls those up against its own cost ledger into the numbers that matter — **tasks automated, hours saved, and dollars influenced versus what the AI cost**, broken down by department and agent. A weekly digest lands in your chat, and the dashboard shows the trend.

## Built to be left running

Reacting to the world unattended raises the bar on operability, so this release ships the boring, essential parts too:

- **Dry-run.** Preview exactly what an automation would do against a sample event before you enable it. It executes nothing — you just see the decision.

- **A unified activity feed.** Every automation fire, process transition, and playbook run in one timeline — in chat, the CLI, or the dashboard.

- **Retries + a dead-letter queue.** A failed dispatch retries with backoff; if it still fails it lands in a queue you can inspect and retry, instead of vanishing.

And the agents themselves can now use these capabilities while they work — searching your knowledge base, extracting a document, running a configured connector — using read actions freely and **proposing anything consequential for your approval** rather than doing it on their own.

## Still the same promise

None of this loosens the trust model — it extends it. Every consequential step an automation, process, or playbook takes still flows through prepare → approve → execute. The difference is that now the *trigger* can be an event, a schedule, or a signature instead of only a message you typed. Nova grew from something you talk to into something that runs your operation — and it still asks first.
