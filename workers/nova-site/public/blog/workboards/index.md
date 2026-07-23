# Boards your agents fill in

> Nova can now build you a board. Ask for one in chat, it proposes the fields and stages, agents fill the cards, and you drag them in the dashboard. Stages can run a playbook when a card lands. Enough to replace a light CRM.

*Source: https://mynova.space/blog/workboards/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Ask Nova for a board and it builds one — typed fields, ordered stages, and cards its agents fill for you. Open the dashboard and drag them. Arm a stage and the work runs when a card lands there. It is enough to stop paying for a light CRM.

Jake Belieny · 23 July 2026 · 7 min read

Nova generates records all day. It researches leads, drafts purchase orders, triages tickets, pulls the numbers for a report. Until this week all of that arrived as *messages* — a good answer in a chat thread, scrolled past by Thursday.

There was nowhere to *see* a set of those records. Nowhere to move one along. No way to say "run the follow-up on everything in that column." So you kept a CRM open next to Nova, mostly to hold state that Nova had already produced, and you retyped it by hand.

That is what **Workboards** fixes.

**The one-line version** Ask for a board in chat. Nova picks the fields and the stages, its agents fill the cards, you drag them in the dashboard — and a stage can run a playbook the moment a card arrives.

## Ask for a board, get a board

You describe it the way you'd describe it to a colleague. Nova works out what the board needs to hold, builds it, and hands you the link.

That second one is the part worth sitting with. The board and the research are one request. An agent goes and does the work, and the output lands as cards you can sort and move — not as a wall of text you have to reformat into something usable.

## Every board has its own shape

A purchasing board and a lead board have nothing in common, so Nova doesn't force them into one schema. Each board declares its own **typed fields** — text, money, date, email, a dropdown with your options, a link, a checkbox — and every card on that board carries that shape.

Typed fields are what make a board more than a wall of sticky notes. A money column totals itself per stage. A date column sorts. A dropdown can't drift into four spellings of the same status. And a playbook can reliably read *this card's* amount, because it's always there and always a number.

Schemas change, so editing one is handled carefully: **adding** a field is instant and backfills every existing card. **Removing or retyping** one asks you to confirm first, then keeps the old values in the board's history — so a field you drop in a hurry is recoverable, not gone.

## Stages that do the work

By default a stage is just a column — a label, somewhere to drag a card. That's the right default; most boards want to be a whiteboard.

But a board can be made **reactive**, and then a stage can carry an action: a playbook, or a task for a named agent. Drop a card into it and the work starts, with the card's own fields as the inputs. A lead dragged into *Nurture* gets the nurture sequence written for *that* company. A PO dragged into *Send* gets sent.

Handing a drag-and-drop gesture the power to start real work deserves guardrails, so it has them:

- **Card content is treated as data, never as instructions.** A card whose notes field says *"ignore your previous instructions and…"* is caught and the action is skipped — the same screening Nova already applies to anything untrusted that reaches an agent.

- **It fires once.** A double-drag, a duplicate request, a restart mid-run — the action runs a single time.

- **Bulk moves ask first.** Drag forty cards into an armed stage and Nova asks once for the batch instead of quietly starting forty jobs.

- **Failures are visible.** An action that can't complete goes to the dead-letter queue with its reason attached, rather than disappearing.

- **The gate still applies.** Anything consequential downstream — sending, publishing, spending — still stops for your approval exactly as it always has.

## Pull in what already lives elsewhere

A board can bind to a connector you've configured — HubSpot, Stripe, Shopify, Zendesk — and pull records onto cards. Sync is **upsert-only**: it adds and updates, and never deletes. A flaky API or an expired token can leave you with stale cards, but it can't empty a board.

Going the other way is deliberately slower. When you move a card on a bound board, Nova *describes* the write it would make to that system and records it — it doesn't reach out and change a record in your CRM because you dragged something. Writing to systems you depend on is a decision, not a side effect.

## The boards you already had moved in

Nova has shown agent tasks and support tickets on fixed, read-only boards for a while. Both now run on this engine: same look, same interactions, and draggable for the first time. Their columns are locked — a ticket board should mean what everyone thinks it means — but moving a card genuinely updates the ticket or the task underneath.

One board UI instead of three, and every improvement lands on all of them at once.

## What it isn't

It isn't Salesforce. There's no lead scoring engine, no email sequencer bolted on, no reporting suite. If you need enterprise CRM, buy enterprise CRM.

What it is: the place your agents' output goes so it stops being a chat message. For a lot of small teams the CRM was only ever a schema, a few columns, and a follow-up reminder — and Nova can hold all three now, on your own machine, next to the agents already doing the work.
