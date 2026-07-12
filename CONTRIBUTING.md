# Contributing to Nova

Thanks for your interest in improving Nova.

## Getting Set Up

1. Install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
2. Fork and clone the repo, then:

```bash
bun install
cp .env.example .env        # fill in at least TELEGRAM_BOT_TOKEN + TELEGRAM_USER_ID
cp .mcp.example.json .mcp.json
bun run typecheck           # should pass
bun run test                # should pass — uses an isolated DB in data/test-run
```

See [SETUP.md](SETUP.md) for the full walkthrough and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the system fits together.

## Development

- **Runtime**: Bun only — no Node-specific APIs unless Bun supports them.
- **Style**: TypeScript, 2-space indentation, `const` over `let`, async/await over raw promises, early returns over deep nesting.
- **Typecheck**: `bun run typecheck` must pass. Don't add `@ts-ignore` or `any` where a real type is practical.
- **Tests**: `bun run test` must pass. Tests run against an isolated database (`NOVA_DB_DIR`) — never point tests at real data. New logic in core modules (orchestrator, planner, memory, patterns, ai-router) should come with tests; these are the least-covered and most valuable areas to test.
- **Commits**: conventional messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).

## Pull Requests

- Keep PRs focused — one change per PR.
- Describe what changed and why; include repro steps for bug fixes.
- Run `bun run typecheck` and `bun run test` before submitting — both must pass.

## Adding an Agent

Agents live in `.claude/agents/*.md` — YAML frontmatter (name, description) plus a markdown system prompt. Register tool/skill mappings in `src/agent-router.ts` and add the agent to the roster table in `CLAUDE.md`.

## Adding a Skill

Skills live in `.claude/skills/<name>/SKILL.md`. Keep skill docs generic — no personal account IDs, tokens, or business names.

## Reporting Security Issues

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
