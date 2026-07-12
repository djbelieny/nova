# Security Policy

Nova handles sensitive material by design: bot tokens, OAuth credentials, API keys, and the contents of your conversations. We take vulnerability reports seriously.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](../../security/advisories/new) ("Report a vulnerability" on the repo's Security tab). You'll get an acknowledgment within a few days.

Please include: affected component/file, reproduction steps, and impact.

## Scope

Especially interested in:

- Authentication/authorization bypasses in the dashboard (`src/dashboard.ts`), voice server (`src/voice-server.ts`), or webhook endpoints
- Cross-user data access (per-user database isolation, credential resolution)
- Command or SQL injection anywhere user input is processed
- Leakage of stored credentials (OAuth tokens are AES-256-GCM encrypted at rest — anything that defeats this)
- Approval-gate bypasses (the two-phase execution model exists so consequential actions require human sign-off)

## Hardening Notes for Operators

- Set a strong `NOVA_ENCRYPTION_KEY` (`openssl rand -hex 32`) — required for encrypted credential storage
- Always set `DASHBOARD_PASS`; run the dashboard behind HTTPS (reverse proxy)
- The auto-approve phrases ("just do it", "go ahead", "ship it") skip the approval gate by design — be aware of this when forwarding content from untrusted sources into your chat
- Supabase executive-board tables use RLS with no anon policies; exec nodes require the service role key, which must only live on trusted servers
