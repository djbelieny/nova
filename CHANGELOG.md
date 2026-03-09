# Nova Changelog — self-maintained by Nova
# Nova — Changelog

All modifications to Nova's source code are logged here, whether triggered by user request, auto-correction, or self-learning.

Each entry includes: when, what triggered it, which files changed, what happened, and the risk level.

---

## [2026-03-08] Documentation rewrite — describe Nova as it actually operates
**Trigger:** user-request
**Files:** CLAUDE.md, README.md, SETUP.md (new), docs/ARCHITECTURE.md (new), WHATS-NEXT.md (deleted), CHANGELOG.md
**Summary:** Rewrote CLAUDE.md from a setup guide into an architecture reference (message flow, agent system, memory tags, two-phase execution, DB schema, MCP integrations, AI routing). Moved setup guide to SETUP.md. Created docs/ARCHITECTURE.md for deep technical reference. Updated README.md to reflect actual multi-agent platform. Deleted WHATS-NEXT.md (marketed features that already exist).
**Risk:** low (documentation only)

---

## [2026-03-06] Add message chunking for long Telegram messages
**Trigger:** user-request
**Files:** src/channels/telegram.ts
**Summary:** Long responses that exceed Telegram's 4096-character limit are now automatically split into multiple messages with smart boundary detection (paragraph breaks, sentence endings).
**Risk:** low

---

## [2026-03-06] Fix Telegram Markdown fallback for proactive services
**Trigger:** bug-fix
**Files:** src/channels/telegram.ts
**Summary:** Proactive service messages (check-ins, briefings) were failing to send when containing Markdown that Telegram couldn't parse. Added fallback to plain text on parse error.
**Risk:** low

---

## [2026-03-06] Add proactive services: AI news, social posts, lead suggestions
**Trigger:** user-request
**Files:** services/ai-news-monitor.ts (new), services/social-post-suggester.ts (new), services/lead-suggester.ts (new)
**Summary:** Three new proactive services: AI news monitor curates relevant AI/tech news, social post suggester generates content ideas, lead suggester identifies business leads. All follow the common service pattern (state tracking, Groq preference, timezone-aware scheduling).
**Risk:** low

---

## [2026-03-04] Revert meta-social from miniapp, keep IG/FB via GHL
**Trigger:** user-request
**Files:** src/miniapp.ts, services/meta-social-mcp.ts
**Summary:** Removed direct Meta API social posting from the miniapp interface. Instagram and Facebook posting now goes exclusively through GoHighLevel MCP integration, which is more reliable and handles auth centrally.
**Risk:** low

---

## [2026-02-26 11:38] Fix concurrent message flow tracking and approval recovery
**Trigger:** user-request
**Files:** src/orchestrator.ts, db/migration-concurrent-revisions.sql (new)
**Summary:** Fixed three bugs that broke multi-message concurrent task flows:
1. `recoverPendingApprovals()` was missing `workspace_dir`, `workflow_type`, and `request_id` columns — recovered approvals lost context and defaulted to "generic" workflow type
2. Both `recoverSingleApproval()` and `recoverPendingApprovals()` created minimal `{ id: userId }` user objects — execute phase would fail accessing `user.name`/`user.timezone`. Now loads full user data from Supabase.
3. Revision sessions had a `UNIQUE(user_id)` constraint — concurrent revision flows for the same user would overwrite each other. Now keyed by unique `sessionId` with most-recent-first lookup.
**Risk:** medium

---

## [2026-02-26 11:38] Fix message flow tracking and approval persistence
**Trigger:** user-request
**Files:** src/orchestrator.ts, src/relay.ts, db/migration-message-flow.sql (new)
**Summary:** Fixed four issues with multi-message task tracking:
1. `handleApproval()` now auto-recovers approvals from Supabase when not in memory (was showing false "expired" error)
2. Removed 10-minute expiration on revision sessions — they now persist indefinitely
3. Revision sessions are persisted to Supabase (new `revision_sessions` table) so they survive restarts and hour-long delays
4. Added `request_id` flow tracking: each user message generates a unique ID that follows through task creation → approval → execution, enabling full message-to-task traceability
5. `pending_approvals` table now stores `workspace_dir`, `workflow_type`, and `request_id` for complete recovery
**Risk:** medium

---

## [2026-02-18 20:22] Add scheduled Meta Ads daily report
**Trigger:** user-request
**Files:** services/meta-ads-report.ts (new)
**Summary:** Created daily Meta Ads performance report that pulls yesterday's metrics + last 7 days overview + per-campaign breakdown from Meta Graph API and sends a formatted summary to Telegram. Scheduled via launchd at 8:30 AM ET daily.
**Risk:** low

---

## [2026-02-18 12:00] Initial changelog setup
**Trigger:** user-request
**Files:** CHANGELOG.md (new), src/relay.ts, src/orchestrator.ts, src/planner.ts, src/patterns.ts, src/agent-router.ts
**Summary:** Added human-in-the-loop approval gates with two-phase execution (prepare → approve → execute), artifact passing between phases, auto-approve detection, self-modification capabilities, CHANGELOG tracking, auto-correction, and self-learning instructions. Audited all 24 agents and updated their tool+skill mappings to be comprehensive. Added /reload, /revert, and /agents admin commands.
**Risk:** medium

---
