# Nova Full Audit Report

**Date:** 2026-02-18
**Scope:** Full codebase at `/Users/djbelieny/Projects/nova`

---

### FIX THIS
- **Hardcoded GHL token in `.mcp.json:79-80`** — Bearer token `pit-be65de0c...` is in plaintext in a staged file. **Rotate immediately.**
- **Self-modification via Telegram** — Admin users can instruct Claude to edit core source files. The 5-change-per-day limit is prompt-only, not enforced in code. `/reload` applies changes instantly.
- **CORS `Access-Control-Allow-Origin: *`** on both miniapp.ts and dashboard.ts — any website can call these APIs
- **SQL wildcard injection in memory.ts** — `ilike` patterns with unescaped `%` and `_` (lines 71, 104, 123, 140, 162). `[DONE: %]` would match ALL goals.
- **TOCTOU race in lock file** — `relay.ts:50-71` has race between check and write
- **User cache has no TTL** — `relay.ts:133` caches user permissions indefinitely until restart
- **Predictable uploaded file names** — `relay.ts:722-749` uses `image_{timestamp}.jpg`
- **initData has no expiration check** — `miniapp.ts:69-127` validates HMAC but never checks `auth_date`
- **No per-user rate limiting** — `relay.ts:620` has no message throttling
- **Admin commands lack confirmation** — PINs stored in plaintext, destructive commands have no confirmation step
- **Auto-approve false positives** — `orchestrator.ts:199-211` can trigger on embedded text like "just do it"
- **PII in log output** — `twilio.ts` logs phone numbers in plaintext
- **File paths exposed via dashboard** — `/api/resources` leaks full filesystem paths
- **No CSP headers** on miniapp or dashboard HTML responses
- **Lockfile not committed** — `bun.lockb` is in `.gitignore`, dependency versions can drift
- **`user_preferences` table overlaps `users.preferences` JSONB** — `settings.ts` writes to `users.preferences` via RPC, while `migration-miniapp.sql` creates a separate `user_preferences` table. Two competing storage locations.
- **`cost-tracker.ts` creates its own Supabase client** — Instead of receiving one from the caller, it initializes its own connection
- **In-memory state for critical data** — `pendingApprovals` Map, user cache, active tasks, usage stats are all in memory. Process restart loses all pending approvals.
- **No durable job queue** — Claude calls are queued in-process with a simple array. Restart = lost tasks.
- **Concurrency ceiling** — `MAX_CONCURRENT_CLAUDE = 2` with no priority, timeout, or dead letter handling
- **No graceful shutdown** — Signal handlers call `process.exit()` without draining in-flight requests
- **Memory bloat** — Facts accumulate indefinitely with no deduplication, archival, or cap on injection into prompts
- **Conversation threading** — All messages in one flat stream. No way to resume or reference a prior thread.
- **Proactive intelligence** — Smart check-in and morning briefing exist only as example scripts, never wired up
- **Structured entity extraction** — Memory is free-text only. No contacts, projects, or deals as typed entities.
- **Conversation search** — Semantic search exists in backend but isn't exposed as a `/search` command
- **Progress updates for complex tasks** — Users see only a typing indicator for 30+ seconds during multi-agent tasks
- **Calendar-aware scheduling** — Google Calendar MCP is configured but no native scheduling logic
- **Webhook/event ingestion** — All interaction is pull-based. No way to react to external events from GHL, Square, etc.
- **Multi-modal output** — No inline charts, visualizations, or image responses in Telegram
- **Shared workspaces** — Multi-user exists but users interact in isolation
- **Supabase MCP missing from `.mcp.json`** — Referenced in CLAUDE.md and agent tool mappings but not configured. Database-aware agents (Architect, Cipher, Rift, Joule) can't query the DB.
- **Skills directory** — System prompt references 13 skills but `.claude/skills/` may not have matching `skill.md` files for all of them, I think we're loading them from the ~/.claude/skills directory, should probably copy those files into the skills directory in the repo for consistency and version control.
- **No startup config validation** — Missing `SUPABASE_URL` silently disables memory, patterns, tasks, cost tracking without warning. Bot appears to work but loses all persistence.
- **Approval UX is fragile** — Approvals use latest-per-user heuristic. Two pending approvals = button press acts on wrong one. No approval ID in callback data.
- **No conversation state indicator** — Users get no progress updates during 30-60+ second multi-agent tasks
- **Message splitting is naive** — Long messages split at `\n\n` boundaries, can break tables/code blocks/lists mid-element
- **No message editing** — Can't edit last message and re-process
- **No message deletion** — Can't delete messages with errors or sensitive info