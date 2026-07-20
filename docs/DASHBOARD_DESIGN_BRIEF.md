# Nova Dashboard — Design Brief

**Audience:** UI/UX Designer  
**Purpose:** Design a new web dashboard for Nova — a personal AI operating system  
**Deliverable:** High-fidelity designs (desktop-first), component library, interactive prototype

---

## 1. What is Nova?

Nova is not a chatbot. It is a **personal AI operating system** that runs 24/7 on a private server, managing tasks, automating workflows, and operating a team of AI agents on the owner's behalf.

The owner talks to Nova through Telegram, WhatsApp, Slack, or voice calls. Nova listens, thinks, delegates work to specialist agents, and executes — or asks for approval before doing anything consequential.

The dashboard is **mission control**: the one place where the operator can see everything Nova is doing, has done, and is waiting on.

Think air traffic control, not a settings page.

---

## 2. The User

**One person. The operator.** This is the person who owns and runs their Nova instance — technically capable, extremely busy, and already accustomed to delegating large amounts of work to an AI. They open the dashboard to:

- See what's happening across all 24 agents at a glance
- Approve or reject consequential actions before they execute
- Review costs and resource usage
- Browse memory, goals, and task context
- Chat directly with Nova
- Monitor service health

They are **not** a casual user. They want information density, speed, and clarity — not simplicity. They are comfortable with a Bloomberg terminal or Raycast-level interface. Every second they spend hunting for information is a failure of the design.

---

## 3. System Architecture (what the designer needs to understand)

Nova has three conceptual layers. The dashboard surfaces all three.

### Layer 1 — Executive Board
Seven AI executives, each running on its own server, each embodying a distinct executive persona:

| Role | Persona model | Focus |
|------|--------------|-------|
| CEO | Jeff Bezos (Day-1 thinking) | Long-term vision, strategic direction |
| CFO | Patrick Campbell (unit economics) | Costs, pricing, ROI |
| CMO | Seth Godin (Purple Cow) | Brand, content, tribe building |
| CTO | Werner Vogels (everything fails) | Infrastructure, technical strategy |
| COO | Process-driven | Execution, cross-functional coordination |
| Research | Ben Thompson (aggregation theory) | Market intelligence, trend analysis |
| Critic | Charlie Munger (inversion) | Pre-mortem, failure modes — never delegates |

The executives hold **board meetings**: convened around a strategic question, they each contribute independently, the Critic challenges assumptions, then Nova synthesizes 3–5 options with confidence scores. The operator picks one, and autonomous execution begins.

### Layer 2 — Agent Team
Twenty-four specialist agents, each an expert in a specific domain:

| Slug | Specialty |
|------|-----------|
| helios | Paid advertising (Google, Meta, LinkedIn) |
| pixel | Social media strategy & content |
| kai | Content writing & brand storytelling |
| orion | Email marketing & automation |
| morpheus | Video content & scriptwriting |
| architect | Web development & technical implementation |
| athena | Business strategy & market analysis |
| digit | Data analytics & dashboards |
| echo | Customer support |
| flux | Funnel engineering & conversion |
| quill | Grant writing & proposals |
| lex | Legal & compliance |
| helia | Public relations & media |
| bridge | Partnerships & business development |
| oracle | Trend forecasting & scenario planning |
| cipher | Data science & ML |
| rift | Cybersecurity |
| joule | Workflow automation & integrations |
| nexus | Community building |
| aura | Brand voice & identity |
| zen | Productivity coaching |
| tesseract | Systems thinking |
| magnus | SEO |
| cyra | Website optimization & CRO |

Agents are routed tasks automatically based on the nature of the request. They produce **artifacts** (content, plans, images, code, reports) that pass through an approval gate before execution.

### Layer 3 — Execution Engine
Nova uses a **two-phase execution model** for any action with real-world consequences:

1. **Prepare** (safe): research, write, generate, analyze → produces artifacts
2. **Approval gate**: the operator sees the artifact and decides: Approve / Revise / Cancel
3. **Execute** (consequential): publish, send, spend, create → uses artifacts from step 1

The approval gate is the most critical interaction in the entire system. Publishing a campaign, sending emails to a list, spending ad budget — nothing consequential happens without explicit operator sign-off.

---

## 4. Data Available (all live APIs)

Every data point below is served by the existing backend. The new dashboard only replaces the frontend.

### System Status
- Health of each service process (nova-relay, nova-dashboard, nova-voice, exec nodes)
- Uptime, active AI provider slots (concurrent call limit), queue depth
- Which agents are currently mid-task
- Real-time event stream (Server-Sent Events) — every action Nova takes fires an event

### Work in Flight
- **Kanban board** — tasks across `pending / in_progress / done / blocked / cancelled`
- **Agent tasks** — which of the 24 agents is running what, assigned to whom
- **Pending approvals** — the highest-urgency view; tasks waiting for human go/no-go
- **Scheduled tasks** — upcoming queue with trigger times
- **Active delegations** — executive-to-agent assignments currently open

### Intelligence & Memory
- **Memory store** — facts, goals, shared context Nova has learned about the user
- **Conversation history** — per-user message threads across all channels (Telegram, WhatsApp, Slack)
- **LLM traces** — full prompt/response pairs for debugging
- **Board sessions** — recent strategic decisions, reasoning chains, and outcomes

### Financials
- Daily AI cost vs. threshold
- Cost breakdown by model, by agent, by period (day/week/month)
- Usage by user (for multi-user deployments)

### Infrastructure
- Logs per service (last N lines)
- System resources (CPU, memory, disk)
- Connected MCP integrations (Notion, Google Workspace, Playwright, Cloudflare, Zoom, Square, ClickUp, GoHighLevel, Firecrawl, Tavily, Exa, Browserbase)

### Agent & Skill Catalog
- All 24 agents with descriptions and current status
- 21 skills available (e.g., image-gen, email-marketing, pdf, social-media-manager)
- Agent performance history

### CS / SDR Mode
- Live customer service sessions across up to 5 channels simultaneously
- Knowledge base documents (RAG source material for AI answers)
- Escalation queue (customers waiting for human follow-up)
- CS configuration (persona, business hours, escalation rules)

---

## 5. Key Flows to Design

### Flow 1: Morning Briefing (most common)
The operator opens the dashboard after sleeping. In under 10 seconds they need to know:
- Did anything go wrong overnight?
- Are there approvals waiting?
- What did the agents accomplish?
- What's the cost so far today?
- What's scheduled to run next?

This is a **narrative moment**, not a metrics grid. The design should tell a story about what happened, not just show numbers. Consider a "while you were away" summary section at the top of the home view.

### Flow 2: The Approval Gate (most critical)
An agent completes a `prepare` phase — say, drafting a full email campaign or creating an ad set — and stops. The operator is notified (via Telegram and a badge in the dashboard).

The operator opens the approval view and sees:
- What was requested
- What the agent produced (the artifact: copy, targeting, budget, etc.)
- Which agent produced it
- Cost of the preparation step
- Three actions: **Approve**, **Revise**, **Cancel**

If they tap **Revise**, a text field opens and they can give feedback in natural language. The agent re-runs the prepare phase incorporating the feedback. This can go back and forth multiple times before the operator is satisfied.

If they tap **Approve**, the execute phase runs.

This flow must be **impossible to do accidentally**. Approving a $500 ad spend or sending an email to 10,000 people needs friction — but not annoying friction. Clarity, not confirmation dialogs.

### Flow 3: Board Meeting
The operator types a strategic question — "Should we expand into the European market?" or "What's the best approach to our Q3 pricing strategy?" — and convenes the board.

Each executive contributes independently. The Critic challenges the other contributions. Nova synthesizes 3–5 options with confidence scores and tradeoff notes. The operator selects one.

The UI should feel like a **war room**: each executive's contribution legible, the dissent visible, the synthesis clear. This is not a chat thread — it's structured strategic deliberation with a decision output.

### Flow 4: Agent Deep-Dive
From the Kanban or agent list, the operator clicks into a specific task or agent to see:
- Full execution trace (what prompt was sent, what the response was)
- Artifacts produced
- Cost breakdown
- What happened downstream (next steps, dependencies)

This is the debugging view — used when something goes wrong or the operator wants to understand what Nova actually did.

### Flow 5: Live Activity
For power users who want to watch Nova work in real-time: a live feed of events as they fire. Every tool call, every agent invocation, every message processed. Should feel like watching a system work — not like watching a log file.

---

## 6. Technical Context for the Designer

- **Backend is already built.** The API runs at `localhost:3033`. The new dashboard is frontend-only.
- **Self-hosted.** This runs on the operator's own VPS, accessed via private URL (not a public SaaS). No onboarding, no marketing pages, no pricing pages.
- **Desktop-first.** This is a power tool used at a desk. Mobile is a stretch goal, not a requirement.
- **Real-time.** The event stream (SSE) fires constantly while Nova is active. The UI should feel alive — not require a manual refresh.
- **Single-user primary.** Most installs serve one person, but a user switcher exists for teams.
- **No build step required** for the current dashboard (server-rendered HTML). The new one can use any modern framework (React, SvelteKit, Next.js) — the API contract is the same.
- **Auth is session-based** (cookie, password-protected login page). No OAuth flows needed.

### Available API endpoints (sample)
```
GET  /api/status              — service health, uptime
GET  /api/agents/active       — currently running agents
GET  /api/agents/catalog      — all 24 agents with metadata
GET  /api/kanban              — tasks by status column
GET  /api/approvals           — pending approval queue
GET  /api/activity            — recent event log
GET  /api/activity/stream     — SSE real-time event stream
GET  /api/executives          — 7 exec board members + status
GET  /api/board/recent        — recent board sessions
GET  /api/delegations/active  — open exec-to-agent assignments
GET  /api/memory              — user memory store
GET  /api/messages            — conversation history
GET  /api/traces              — LLM prompt/response traces
GET  /api/costs               — cost breakdown
GET  /api/costs/breakdown     — grouped by model/agent/period
GET  /api/logs                — per-service log tail
GET  /api/resources           — CPU/memory/disk
GET  /api/skills              — skills catalog
GET  /api/users               — user list
GET  /api/cs/sessions         — customer service sessions
GET  /api/cs/config           — CS mode configuration

POST /api/chat                — send message to Nova
POST /api/approvals/resolve   — approve/reject/revise
POST /api/memory/delete       — delete a memory entry
POST /api/alerts/rules        — update alert thresholds
```

---

## 7. Design Direction

### Tone
Nova has a name and a persona. She's not a utility — she's an intelligent system with presence. The dashboard should feel like it belongs to something alive, not like a generic admin panel.

Suggested directions (pick one, don't blend):

**Option A — Dark precision**
High information density on a near-black background. Think Linear, Vercel dashboard, or Raycast. Clean mono or geometric typeface. Muted color palette with a single vibrant accent for status indicators. Feels like a cockpit.

**Option B — Ambient intelligence**
The dashboard "breathes" with Nova's activity. Subtle animations show the system thinking. Soft gradients, not flat blocks. More organic than grid-based. Feels like a living system, not a control panel.

**Option C — Command center**
Military / ops aesthetic. High contrast, grid-based layout, monospace accents, status lights. Pulls from Bloomberg terminal and NASA mission control. Dense but structured. Feels like serious infrastructure.

### What it must feel like to open
- You know immediately whether something needs your attention
- You understand what Nova accomplished while you were away
- It rewards returning — each visit shows you something meaningful happened
- It does not feel like a SaaS product you pay for monthly

### What to avoid
- Generic dashboard component libraries dropped in without thought
- Tables for everything — most data has a better form
- Empty states that feel broken — Nova is always doing something
- Excessive color — use it to communicate state, not decorate
- Modals for confirmations that should be inline
- Mobile-first breakpoints that waste the desktop viewport

---

## 8. Views / Navigation Structure (suggestion)

```
Nova Dashboard
│
├── Home           — narrative summary: approvals, activity, costs, agent status
├── Approvals      — pending gate decisions (badge with count)
├── Work           — Kanban + agent tasks + scheduled queue
├── Board          — executive board sessions and decisions
├── Memory         — facts, goals, conversation history
├── Analytics      — costs, usage, performance over time
├── Infrastructure — service health, logs, resources
├── Chat           — direct Nova conversation
└── Settings       — alert rules, CS mode, user management
```

Consider: should these be top-level tabs, or should Home be the "command center" that surfaces urgent items from all sections inline?

---

## 9. Questions to Resolve in the Design

1. **Approval interrupt pattern** — how does an urgent pending approval surface when the operator is looking at a different view? Badge? Banner? Notification overlay?

2. **Zero state** — what does the dashboard show when Nova is idle, all tasks complete, nothing pending? Should it feel calm or prompt the operator to give Nova something to do?

3. **Agent roster** — 24 agents is a lot to display. Do you show all of them always, or surface only active/recently-used ones? How do you communicate which agents exist without overwhelming?

4. **Board meeting layout** — is this a conversation-style thread (chronological), or structured cards per executive with a synthesis pane? What does the decision artifact look like?

5. **Real-time vs. on-demand** — how much of the UI animates live vs. requires the operator to refresh/navigate? What's the right level of "aliveness"?

6. **Revision flow** — when the operator rejects and revises an approval, does the conversation stay in-place in the approval view, or does it shift to a chat-like revision interface?

7. **Multi-user** — if multiple users are connected (e.g., a small team), how does the operator switch context between them? Per-user memory and tasks are separate.

---

## 10. What Already Exists (baseline to exceed)

The current dashboard is a **single-file, server-rendered HTML page** with a retro CRT aesthetic. It works. It covers all the data. But it is a developer tool — every section is a table, there is no visual hierarchy, no narrative, no personality. The navigation is a flat tab bar with 14 items.

The new dashboard should make the operator *want* to open it — not just tolerate it as a necessary operational interface.

The backend API is stable and will not change to accommodate the design. The designer should work from the endpoint list above and request additions only if a specific view genuinely requires data that isn't there.

---

*Questions? Contact the engineering lead. The full architecture reference is in `docs/ARCHITECTURE.md`.*
