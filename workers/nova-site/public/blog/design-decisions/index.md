# Why Nova is built the way it is

> The philosophy behind Nova's architecture: why an org chart instead of a chatbot, why trust is engineered, why autonomy must be earned, and why sandboxing and auditability are non-negotiable.

*Source: https://mynova.space/blog/design-decisions/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

Eight design decisions that make Nova trustworthy, autonomous, and truly yours. The philosophy behind every choice, from architecture to autonomy to auditability.

Jake Belieny · 15 July 2026 · 12 min read

Building a system that can act on your behalf is not the same as building a system that works well. Nova's shape comes from seven years of thinking about the difference. This essay describes why each piece is there and what problem it solves — and where I chose one good design over another better one, because "better" would have made the platform unusable.

## An org chart, not a chatbot

The first decision: Nova isn't one model playing the role of every job. It's 24 specialists, each with a domain, a playbook, and dedicated tools. Some people see that and ask: isn't that just routing? Don't you still need the general reasoning engine underneath?

No. Each specialist is. Helios knows paid advertising because all of their context, training, and tool access is structured around it. Cipher knows how to reason about data because that's the entire shape of their system prompt. Lex isn't a general assistant reading legalese; they're a lawyer.

The alternative — one model routing to different tool sets — feels simpler. It saves you from managing 24 prompts. But it loses something crucial: depth. A general model reasoning about your Meta campaigns for the first time makes different tradeoffs than a specialist who has reasoned about 10,000 campaigns. They prioritize differently. They ask questions you didn't think to ask. They spot risks because that's all they watch for.

The tradeoff is routing complexity. You have to classify every incoming request (heuristic → pattern cache → LLM) and pick the right agent. That's three tiers of classification to avoid calling the expensive one every time. Worth it, because the specialist's answer is better.

Above the specialists sits an **Executive Board** — seven roles, each modeled on a distinct way of thinking. The CEO reasons in terms of flywheel loops and Day-1 questions. The CFO thinks about unit economics. The Critic does pre-mortems. When you ask something hard — "should we expand into a new market?" — they don't just debate; they reason from their different first principles, and you get seven perspectives plus a synthesis. Not consensus, but decision-support.

**Design choice** Specialists beat generalists on depth. A single reasoning engine loses the rigor that comes from expertise.

## Trust is the product

You don't trust a system because it's confident. You trust it because it asks before it does anything that matters. Two-phase execution is where that lives.

Phase one: prepare. Research, write, generate images, run the analysis. Everything that's safe and reversible. Nothing has left the building. You get to see exactly what's about to happen.

Phase two: execute. Publish the post. Send the email. Spend the money. Create the campaign. Only after you tap *Approve* on Telegram.

That's it. That's the core of the trust mechanism. Not "Nova is smart enough that it won't do anything dumb" — that's not true, and it's not the point. Instead: "Nova does the safe work, shows you the plan, and stops until you say yes." Nothing consequential happens without a human in the loop. Nothing.

The alternative is autonomy by trust level — some actions run without asking if Nova has a clean track record. Nova has that (earned autonomy, described below), but it's a power-up. The floor is always: ask before you execute.

What makes this actually work is that the approval gate lives in your messaging app (Telegram, Slack, WhatsApp). You don't have to navigate to a dashboard or remember a password. You get a notification. You read it. You tap a button. Frictionless approval makes it worthwhile: you actually do it instead of waving away warnings.

## Earned autonomy, not a blank check

The moment a system never asks is the moment you can't trust it. And the moment it asks for everything is the moment it becomes a nuisance and you stop paying attention.

Earned autonomy lives in between. Every action type (send newsletters, publish social posts, create ad campaigns) starts at *always ask*. If an agent builds a clean track record — say, three successful newsletter sends in a row with zero rejections — it graduates: first to *notify you after it happens*, then to *fully autonomous within a spending cap*. One failure or one rejection and it drops back to asking immediately.

You set the rules. You decide how much rope each agent gets, per action type. You can see and change it on the dashboard. The system learns and defers to your history, but never silently. If an agent fails enough times, they've earned their demotion.

This solves the real problem, which isn't "should the AI be autonomous?" It's "on what basis does it get to be autonomous?" The basis is earned trust — a track record on that specific action type. Not global confidence. Not a toggle. Not a prayer.

## Self-hosted and local-first

Nova runs on your machine. It reads your Telegram messages from your bot. It stores your data in local SQLite databases on your disk. Your API keys stay in your `.env` file. You never send your data to a cloud unless you explicitly ask a Nova agent to, and even then only what's needed for that task.

This was not the easier choice. A hosted service is simpler to build, simpler to scale, and much simpler to charge for. Hosting it means I become the data controller — I collect the information, I'm responsible for the security, I get sued when something breaks. Self-hosting pushes that responsibility onto you. If Nova leaks your data, it's because you didn't secure your VPS properly, not because I had a security incident at my data center.

But that's exactly the point. Your data should be your responsibility. Your Telegram messages shouldn't transit through a server I control. Your Ad spend shouldn't require giving me API keys. You should be able to read every line of code, fork the whole thing, and owe me nothing.

Self-hosting also makes Nova radically cheaper. You're not paying me per-message or per-month-per-seat. You're paying for your Claude subscription (or Gemini, or OpenAI). That's it. Nova just uses what you already have. This only works because Nova is open source and MIT licensed — you can take it, change it, run it forever.

## Subscription-first routing

When Nova classifies a request or decomposes a complex task, it has to call an AI model. Three choices: use your existing Claude/Gemini/OpenAI subscription, or switch you to per-token billing, or negotiate a wholesale rate with the provider.

Nova picks your subscription. Always. If you have a Claude Pro plan, Nova prefers it. If you have a Gemini business plan, it prefers that. Only if you've explicitly configured a different preference — or your subscription hits its rate limit — does Nova fall back to a different provider.

This is a small decision with large consequences. It means the cost of running Nova doesn't surprise you. It doesn't appear on a separate bill. It doesn't require you to set up OAuth and trust a third party with your API credentials. You just use what you're already paying for.

The tradeoff is that Nova can't optimize purely on cost or latency. If you're on Gemini but Claude would be faster, Nova still prefers Gemini because that's your subscription. That's a deliberate loss of optimization in exchange for transparency and predictability.

## Sandboxing is the ticket to real autonomy

An agent that can send emails or spend ad budget is only acceptable if it can't somehow read your SSH keys, exfiltrate your database, or pivot to other systems. Sandboxing is how that works.

When a Nova agent executes a task that involves untrusted input — scraping a webpage, analyzing a file a customer uploaded, running code somebody handed you — that execution happens inside a hardened container. Read-only system, no filesystem access beyond a task-specific staging directory, no path to your credentials. A malicious webpage can't hijack the agent and use it as a stepping stone to your machine.

Without sandboxing, you can't safely delegate consequential work to an agent. An attacker who found a jailbreak in the AI's reasoning could potentially compromise your whole system. Sandboxing doesn't prevent the jailbreak, but it limits the blast radius: the agent runs in a cage.

This is non-negotiable for any system you're trusting with real work. And it's expensive — containerization has overhead, network latency, resource costs. But the alternative is: don't trust the agent with consequential work. I chose the expensive path.

## An executive board with distinct personas

Single-source-of-truth thinking is what gets companies killed. You make a decision based on one perspective, miss the risk, and the company absorbs the hit. The executive board is Nova's way of preventing that.

Instead of one confident answer, you get seven. The CEO thinks in terms of leverage and flywheel effects. The CFO thinks in unit economics. The CMO thinks in tribes and permission. The CTO thinks about systems failing. The Critic thinks about what could go wrong. They reason from different first principles. They spot different risks. None of them is smarter than the others; they're just thinking in different directions.

When you ask the board a hard question, you get back three to five scored options, each with a confidence level and a rationale. You pick one. The decision gets logged. That matters.

The tradeoff is latency and cost — you're running seven reasoning sessions instead of one. And you have to pick an option yourself instead of getting a recommendation. But that second part is the whole point. For decisions that matter, you should see the reasoning, weigh the options, and choose. The board gives you the raw material to think with.

## An audit trail for everything

After a Nova agent runs a task, you have a log of what happened: which agent, what they did, how long it took, how much it cost, whether it worked. After the task completes, the agent even verifies its own work — "did the email actually send?" "does the page render?" — before reporting done. If verification fails, the task stays open until you decide what to do.

This isn't security theater. It's the foundation of business-grade AI. You can't be responsible for something you can't explain. You can't debug something you didn't measure. You can't defend something you can't describe.

The cost is that every decision, every action, gets written to a ledger. More storage, more I/O, more data to manage. More importantly, it means you have to face what the system actually did, not what you hoped it did. That's uncomfortable sometimes. It's also the only way to run this responsibly.

**Design choice** "Business grade" mostly means answerable after the fact. Auditability is not a feature; it's the requirement.

## The tradeoffs are real

Each of these decisions costs something. Specialists beat generalists but add routing complexity. Approval gates build trust but add friction. Earned autonomy prevents blank checks but requires tracking state. Sandboxing blocks attacks but adds latency. Self-hosting is cheap but puts operational burden on you. An executive board prevents groupthink but slows down decisions. Auditability builds responsibility but requires logging everything.

I chose each tradeoff because the alternative — a confident, autonomous, high-velocity AI system that nobody really trusts with anything important — seemed worse.

Nova is slower than it could be. It's more complex than it could be. It costs more to run (on your infrastructure, not mine). It asks more questions than a optimized system would ask. All of this is deliberate. The goal isn't to build an AI that moves fast. The goal is to build an AI team that actually works, that you can hand a real problem to, that you'd trust to run something important, and that you can explain and defend when something goes wrong.

That's harder. It takes longer. But it's the only kind of autonomous system worth building.
