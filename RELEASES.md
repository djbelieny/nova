# Release Notes

Public changelog for Nova. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning aims to follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-15 · Trust & Autonomy

Real execution isolation, an auditable action ledger, earned autonomy with spend caps, self-verifying agents, one-command onboarding, and the ability for Nova to deploy its own Executive Board backend — removing the last third-party dependency.

**Every change is opt-in and backward compatible.** Existing deployments keep their current behavior unless the new features are explicitly enabled.

### Added

- **Sandboxed agent execution** — a pluggable backend at the provider dispatch seam. `local` (default, unchanged) or `docker`: a hardened container with read-only root, dropped capabilities, `no-new-privileges`, resource caps, per-user workspace-only mounts, and credential-root bind blocking. Enable with `NOVA_SANDBOX_BACKEND=docker`; build/test the image with `bun run sandbox:verify`.
- **Subscription-first sandbox auth** — in docker mode Nova shares the host's OAuth credentials read-only into the container so agents use your Claude / OpenAI / Gemini **subscription** rather than per-token API billing (`NOVA_SANDBOX_SHARE_AUTH`, default on).
- **Action ledger** — every consequential action recorded per-user (agent, action type, outcome, cost, sandbox backend, verification, artifacts); surfaced at `GET /api/ledger`.
- **Autonomy ladder** — earned, graduated autonomy per (agent, action-type): L0 always-ask → L1 notify-after → L2 autonomous. Any failure, rejection, or spend-cap breach demotes instantly. Per-action and per-day USD spend caps at L2.
- **Outcome verification** — after execute, a fast-tier model checks the result against the goal and records a verdict (`verified` / `failed` / `unverifiable`) before reporting done.
- **Goal pursuit loop** — standing goals decompose into scheduled tasks and execute over time, with per-cycle safety caps (`NOVA_GOAL_PURSUER_ENABLED`).
- **`nova init` onboarding wizard** (`bun run init`) — Telegram token + one provider key + starter agents, minimal `.env`/`.mcp.json`, non-destructive.
- **Dashboard governance control plane** — a `/governance` view plus `GET`/`POST /api/autonomy`, `GET /api/budgets`, `GET /api/goals` for approvals, ledger, autonomy levels, spend-vs-budget, and goal progress.
- **Self-hosted Executive Board backend** — `deploy/board/` ships a Postgres + PostgREST stack (with an nginx compatibility proxy) that Nova deploys itself via `bash deploy/board/setup.sh`. Config generalized to `BOARD_DB_URL` / `BOARD_DB_KEY`; cloud→self-hosted migration via `bun run migrate:board`.

### Changed

- Board configuration reads `BOARD_DB_URL` / `BOARD_DB_KEY`, falling back to the legacy `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` names — existing deployments continue to work unchanged.

### Fixed

- `decision_log` inserts wrote columns that did not exist and failed silently — the decision audit trail is now actually recorded.
- The unread-message poll filter used invalid PostgREST syntax; corrected for reliable executive message delivery.
- Board migration now creates the `array_append_read_by()` RPC and `updated_at` triggers that fresh installs were missing.
- Added the missing `proactive_runs.behavior_name` column — an insert that was silently failing on every fresh install.
- `mcp2cli` is installed from PyPI, not npm (the npm package does not exist and 404'd on fresh installs) — in both the sandbox image and the deploy script.

## [0.1.0] — Initial public release

- Multi-agent orchestration platform with 24 specialist agents.
- Three-tier message classification (simple / routed / complex) with dependency-aware task decomposition and parallel execution.
- Two-phase execution with human-in-the-loop approval gates.
- Multi-channel messaging (Telegram, WhatsApp, Slack) and MCP integrations.
- Distributed Executive Board (CEO/CFO/CMO/CTO/COO/Research/Critic) with board meetings and autonomous project execution.
- Pattern caching, local embeddings, split-SQLite per-user storage.
- Landing page and documentation site.

[0.2.0]: https://github.com/djbelieny/nova
[0.1.0]: https://github.com/djbelieny/nova
