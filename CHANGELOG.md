# Nova — Changelog

All modifications to Nova's source code are logged here, whether triggered by user request, auto-correction, or self-learning.

Each entry includes: when, what triggered it, which files changed, what happened, and the risk level.

---

## [2026-02-18 12:00] Initial changelog setup
**Trigger:** user-request
**Files:** CHANGELOG.md (new), src/relay.ts, src/orchestrator.ts, src/planner.ts, src/patterns.ts, src/agent-router.ts
**Summary:** Added human-in-the-loop approval gates with two-phase execution (prepare → approve → execute), artifact passing between phases, auto-approve detection, self-modification capabilities, CHANGELOG tracking, auto-correction, and self-learning instructions. Audited all 24 agents and updated their tool+skill mappings to be comprehensive. Added /reload, /revert, and /agents admin commands.
**Risk:** medium

---
