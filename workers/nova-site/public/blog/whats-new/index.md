# Nova speaks every model now

> A batch of upgrades: run any OpenAI-compatible model alongside your subscription CLIs, a real nova command with nova connect, terminal + Discord channels, and self-serve team invites — without touching the self-hosted, approval-gated trust model.

*Source: https://mynova.space/blog/whats-new/*  
*Nova — open-source, self-hosted multi-agent AI orchestration. MIT licensed. https://github.com/djbelieny/nova*

---

A batch of upgrades makes Nova more flexible and easier to live with — any model, a real CLI, more places to talk to it, and self-serve team access — without changing what it is.

Jake Belieny · 20 July 2026 · 6 min read

Nova has always been a self-hosted, approval-gated AI team you run on your own machine. This release doesn't touch any of that. What it does is widen the doors: more models can drive your agents, there's finally a real command to run them, you can talk to Nova from more places, and adding a teammate no longer means editing config files.

Four themes: **any model**, **a real CLI**, **more places to talk to it**, and **easier setup and team access**. None of it changes the trust model — Nova still asks before anything ships or spends.

## Use any model — without losing the subscription advantage

Nova already runs on your Claude, Gemini, and Codex **subscriptions** by driving their CLIs directly. That's the whole trick behind its economics: a flat monthly cost instead of a metered API bill, and full agentic tool use — the same plan you already pay for, put to work by a team of agents.

Now you can add **any OpenAI-compatible model** alongside them — an [OpenRouter](https://openrouter.ai) route, an OpenAI model, or a local `Ollama` or `vLLM` box on your own network. Add one with a single entry in `config/providers.json`, with `nova providers add`, or with a click in the dashboard's Models panel. The subscription CLIs stay the default and stay first; new models slot in beside them.

And API models aren't second-class citizens. They can use your tools too — driving the very same sandbox and MCP bridge the CLIs use — so an agent on a local model can still browse, write files, and call integrations under the same approval gates.

**A principled line** Nova keeps **driving the official CLIs** rather than harvesting subscription tokens to hit private endpoints. That's what keeps your subscription squarely within terms — and any new model you add uses its own proper API key, not a borrowed one.

## A real `nova` command

No more remembering `bun run this, bun run that`. There's now one `nova` CLI, installed on your PATH, that fronts everything:

- `nova start` — bring your Nova up.

- `nova doctor` — health check and copyable diagnostics.

- `nova update` — pull the latest and reinstall.

- `nova providers add` — wire in a new model.

- `nova invite` — generate a code to add a teammate.

The standout is **`nova connect`** — a terminal client that connects to your *running* Nova, whether it's on this laptop or on your VPS. You get a live view of what your agents are doing right now, and you can **approve, change, or cancel** inline without leaving the terminal. Because Nova runs always-on, you can drop into it from any terminal, anywhere, and pick up exactly where things are.

## New places to talk to Nova

Nova was already multi-channel — Telegram, WhatsApp, and Slack all feed the same pipeline. This release adds two more:

- Your **terminal** — `nova chat` gives you a full conversation with Nova right in the shell.

- **Discord** — run Nova as a Discord bot for you or your community.

Both are just new adapters on the existing pattern: same message pipeline, same classification, same two-phase execution, same approval gates. A request you make in Discord is handled exactly like one you'd send in Telegram — nothing about how Nova decides or acts changes with the surface.

## Easier setup, and adding your team

You can now manage models, channels, and invites from the **dashboard** or the **CLI** — no hand-editing config to turn something on. Flip a channel, add a model, issue an invite, all from a screen or a single command.

Adding a teammate used to mean tracking down a numeric user ID and pasting it into a file. Now you generate an **invite code** with `nova invite`, hand it to the person, and they redeem it on Telegram or Discord — you approve with a tap. Roles come along for the ride: `nova invite member` or `nova invite admin`.

**Secrets stay put** Nothing about this moves your credentials off your server. The management screens show only which keys are *set* — never their values. Your keys never leave the machine you run Nova on.

## Still the same Nova

Everything that made Nova worth trusting is untouched. It's still self-hosted and MIT licensed. It still runs on your keys and your machine. And it still asks for your approval before anything ships, sends, or spends.

These upgrades add reach and polish — more models, a real command, more channels, self-serve invites — without touching the trust model underneath. Same team, more doors.
