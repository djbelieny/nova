---
name: platform-maker
description: Autonomous SaaS platform generator that creates complete, production-ready platforms from a YAML configuration. Creates database schemas, tRPC routers, React frontends, i18n files, payment integration, referral systems, and deployment configs. Use when you need to generate a digital product platform, sales page, dashboard, admin panel, or launchpad.
---

# Platform Maker Skill

## Overview

This skill **autonomously** generates complete SaaS platforms from a YAML configuration. It runs with minimal user interruption, spawning parallel subagents that communicate via shared memory to build faster.

## Invocation

```bash
/platform-maker
/platform-maker /path/to/project
/platform-maker /path/to/project/platform.config.yaml
```

---

## AUTONOMOUS OPERATION PRINCIPLES

### Minimal Interruption Policy

**ONLY interrupt the user for:**
1. Initial project folder (if not provided)
2. Missing critical config information that cannot be inferred
3. **Destructive command confirmation** (see safeguards)
4. Unrecoverable errors after 3 retry attempts

**DO NOT interrupt for:**
- Validation errors you can fix automatically
- Missing optional fields (use sensible defaults)
- Build errors (fix and retry)
- Type errors (fix and retry)
- Minor decisions (make the best choice and document it)

### Decision Logging (Enhanced)

Log ALL significant events to `.platform-maker/decisions.log`:

**Log Format:**
```
[YYYY-MM-DD HH:MM:SS] TYPE: Message
```

**Event Types:**
| Type | When to Use |
|------|-------------|
| `INIT` | Generation started |
| `CONFIG` | Config parsed/validated |
| `AUTO-DECISION` | Autonomous choice made |
| `USER-PROMPT` | Question shown to user |
| `USER-RESPONSE` | User's answer received |
| `AGENT-START` | Agent began work |
| `AGENT-FILE` | Agent created/modified file |
| `AGENT-COMPLETE` | Agent finished successfully |
| `AGENT-ERROR` | Agent encountered error |
| `VALIDATION` | Validation check result |
| `AUTO-FIX` | Automatic error fix applied |
| `DB-PUSH` | Database schema pushed |
| `COMPLETE` | Generation finished |
| `FAILED` | Generation failed |

**Example Complete Log:**
```
[2026-02-05 12:48:00] INIT: Platform generation started for BookVault
[2026-02-05 12:48:00] CONFIG: Parsed platform.config.yaml successfully
[2026-02-05 12:48:00] CONFIG: Languages: en, pt-BR, es
[2026-02-05 12:48:00] CONFIG: Payment provider: Square
[2026-02-05 12:48:05] AUTO-DECISION: Using SQLite for development database
[2026-02-05 12:48:10] AGENT-START: Database agent started
[2026-02-05 12:50:00] AGENT-FILE: Created drizzle/schema.ts
[2026-02-05 12:50:30] AGENT-FILE: Created drizzle/seed.ts
[2026-02-05 12:51:00] DB-PUSH: Pushing schema to database
[2026-02-05 12:51:05] DB-PUSH: Schema push successful
[2026-02-05 12:51:10] DB-PUSH: Seed data inserted
[2026-02-05 12:52:00] AGENT-COMPLETE: Database agent finished (4 files)
[2026-02-05 12:52:30] AGENT-START: Backend agent started
...
[2026-02-05 12:59:00] VALIDATION: TypeScript check passed
[2026-02-05 12:59:05] VALIDATION: Build succeeded
[2026-02-05 12:59:10] VALIDATION: Server health check passed
[2026-02-05 13:00:00] COMPLETE: Platform generation finished (16 files, 4 agents)
```

---

## DESTRUCTIVE COMMAND SAFEGUARDS

### Level 1: Blocked Commands (NEVER execute)
These commands are **NEVER** allowed, even with user confirmation:
```bash
rm -rf /
rm -rf ~
rm -rf /*
sudo rm -rf
:(){ :|:& };:  # fork bomb
> /dev/sda
mkfs.*
dd if=/dev/zero of=/dev/*
```

### Level 2: Triple Confirmation Required
These commands require **3 separate confirmations** from the user:
```bash
rm -rf <any-path>
rm -r <any-path>
git reset --hard
git clean -fd
git push --force
DROP DATABASE
DROP TABLE
TRUNCATE TABLE
```

**Triple Confirmation Flow:**
```
⚠️  DESTRUCTIVE COMMAND DETECTED
Command: rm -rf ./old-project

This will permanently delete files. This action cannot be undone.

Confirmation 1/3: Type "DELETE" to continue: [user types DELETE]
Confirmation 2/3: Type the folder name "old-project" to confirm: [user types old-project]
Confirmation 3/3: Are you absolutely sure? Type "YES I AM SURE": [user types YES I AM SURE]

Executing command...
```

### Level 3: Single Confirmation
These commands require **1 confirmation**:
```bash
rm <file>              # Single file deletion
git checkout -- .      # Discard changes
pnpm remove <pkg>      # Remove dependency
```

### Safe Alternatives
Always prefer safe alternatives:
- Instead of `rm -rf`, use `mv` to a `.trash/` folder
- Instead of `git reset --hard`, create a backup branch first
- Instead of `DROP TABLE`, rename to `_old_tablename`

---

## MULTI-AGENT ARCHITECTURE

### Agent Team Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (Main Agent)                 │
│  - Parses config, validates, coordinates agents              │
│  - Manages shared memory                                     │
│  - Handles user communication                                │
│  - Resolves conflicts between agents                         │
└─────────────────────────────────────────────────────────────┘
            │
            ├──────────────────┬──────────────────┬──────────────────┐
            ▼                  ▼                  ▼                  ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│   DATABASE AGENT  │ │   BACKEND AGENT   │ │  FRONTEND AGENT   │ │    I18N AGENT     │
│                   │ │                   │ │                   │ │                   │
│ - Schema design   │ │ - tRPC routers    │ │ - React pages     │ │ - Locale files    │
│ - Migrations      │ │ - Auth logic      │ │ - Components      │ │ - Translations    │
│ - Seed data       │ │ - Payment flow    │ │ - Contexts/hooks  │ │ - RTL support     │
│ - Relations       │ │ - API endpoints   │ │ - Styling         │ │                   │
└───────────────────┘ └───────────────────┘ └───────────────────┘ └───────────────────┘
```

### Shared Memory System

Create `.platform-maker/` directory for inter-agent communication:

```
.platform-maker/
├── memory.json              # Shared state (read/write by all agents)
├── decisions.log            # Autonomous decision log
├── errors.log               # Error tracking
├── agents/
│   ├── database.status      # Agent status files
│   ├── backend.status
│   ├── frontend.status
│   └── i18n.status
├── contracts/
│   ├── schema.types.ts      # Database types (DB → Backend/Frontend)
│   ├── api.types.ts         # API types (Backend → Frontend)
│   └── i18n.keys.ts         # Translation keys (I18n → Frontend)
└── artifacts/
    ├── db-ready.flag        # Signals DB schema is ready
    ├── api-ready.flag       # Signals API types are ready
    └── build-ready.flag     # Signals all code is ready
```

### memory.json Structure

```json
{
  "project": {
    "name": "My Platform",
    "path": "/Users/me/Projects/my-platform",
    "config": "platform.config.yaml",
    "startedAt": "2024-01-15T10:30:00Z"
  },
  "config": {
    "parsed": true,
    "validated": true,
    "hash": "abc123..."
  },
  "agents": {
    "database": {
      "status": "completed",
      "progress": 100,
      "startedAt": "2024-01-15T10:30:00Z",
      "completedAt": "2024-01-15T10:32:00Z",
      "currentTask": null,
      "files": ["drizzle/schema.ts", "drizzle/seed.ts"],
      "exports": ["tierEnum", "users", "products", "agents"],
      "databasePushed": true,
      "seeded": true,
      "errors": []
    },
    "backend": {
      "status": "in_progress",
      "progress": 65,
      "startedAt": "2024-01-15T10:32:00Z",
      "currentTask": "Generating auth router",
      "waitingFor": [],
      "files": ["server/routers.ts", "server/routers/auth.ts"],
      "errors": []
    },
    "frontend": {
      "status": "pending",
      "progress": 0,
      "waitingFor": ["backend.api-types"],
      "files": [],
      "errors": []
    },
    "i18n": {
      "status": "completed",
      "progress": 100,
      "startedAt": "2024-01-15T10:30:30Z",
      "completedAt": "2024-01-15T10:31:30Z",
      "files": ["client/src/locales/en/*.json"],
      "keys": ["common", "home", "checkout", "auth"],
      "errors": []
    }
  },
  "contracts": {
    "dbTypes": {
      "ready": true,
      "path": ".platform-maker/contracts/schema.types.ts",
      "exports": ["User", "Product", "Agent", "Tier"]
    },
    "apiTypes": {
      "ready": false,
      "path": ".platform-maker/contracts/api.types.ts"
    }
  },
  "validation": {
    "typeCheck": { "passed": null, "timestamp": null, "errors": [] },
    "build": { "passed": null, "timestamp": null, "errors": [] },
    "serverStartup": { "passed": null, "timestamp": null, "healthResponse": null },
    "database": { "pushed": false, "seeded": false }
  },
  "build": {
    "attempts": 0,
    "lastError": null,
    "ready": false
  }
}
```

### Agent Lifecycle Tracking

Agents MUST update memory.json at each stage:

**Status Values:**
- `pending` - Not yet started
- `in_progress` - Currently running
- `completed` - Successfully finished
- `failed` - Encountered unrecoverable error

**On Agent Start:**
```json
{
  "agents": {
    "database": {
      "status": "in_progress",
      "startedAt": "2026-02-05T12:48:00Z",
      "progress": 0,
      "currentTask": "Parsing config"
    }
  }
}
```

**During Progress (every 25%):**
```json
{
  "agents": {
    "database": {
      "progress": 50,
      "currentTask": "Generating schema tables",
      "filesGenerated": 2
    }
  }
}
```

**On Completion:**
```json
{
  "agents": {
    "database": {
      "status": "completed",
      "completedAt": "2026-02-05T12:52:00Z",
      "progress": 100,
      "files": [
        "drizzle/schema.ts",
        "drizzle/schema.sqlite.ts",
        "drizzle/schema.postgres.ts",
        "drizzle/seed.ts"
      ],
      "exports": ["users", "sessions", "ebooks", "subscriptions"],
      "databasePushed": true,
      "seeded": true
    }
  }
}
```

**On Failure:**
```json
{
  "agents": {
    "database": {
      "status": "failed",
      "failedAt": "2026-02-05T12:52:00Z",
      "error": "Schema validation failed: duplicate column 'id'",
      "lastFile": "drizzle/schema.sqlite.ts",
      "recoverable": true
    }
  }
}
```

### Agent Communication Protocol

**1. Status Updates:**
Each agent writes to its status file and memory.json:
```typescript
// Agent writes to memory
updateMemory({
  agents: {
    database: {
      status: "completed",
      progress: 100,
      exports: ["tierEnum", "users", "products"]
    }
  }
});
```

**2. Dependency Signals:**
Agents create flag files when their outputs are ready:
```bash
# Database agent creates when schema is ready
touch .platform-maker/artifacts/db-ready.flag

# Backend agent waits for this before generating API
while [ ! -f .platform-maker/artifacts/db-ready.flag ]; do sleep 1; done
```

**3. Contract Files:**
Agents share type definitions through contract files:
```typescript
// .platform-maker/contracts/schema.types.ts (written by Database Agent)
export type Tier = 'none' | 'core' | 'growth' | 'quantum';
export interface User {
  id: number;
  email: string;
  tier: Tier;
  // ...
}

// Backend Agent imports these
import { User, Tier } from '../.platform-maker/contracts/schema.types';
```

**4. Error Broadcasting:**
When an agent encounters a blocking error:
```json
// Written to memory.json
{
  "agents": {
    "backend": {
      "status": "blocked",
      "blockingError": {
        "type": "missing_dependency",
        "message": "Cannot find tierEnum export from database schema",
        "needsFrom": "database",
        "timestamp": "2024-01-15T10:35:00Z"
      }
    }
  }
}
```

---

## PHASE 0: PROJECT SETUP (Autonomous)

### Step 0.1: Get Project Location

**If path provided:** Use it directly, create if needed.

**If no path provided:** Ask user ONCE:
```
Where should I create your platform? (full path)
```

Then proceed autonomously.

### Step 0.2: Create Project Structure (No interruption)

Silently create:
```
{project}/
├── .platform-maker/          # Agent communication
│   ├── memory.json
│   ├── decisions.log
│   └── agents/
├── CLAUDE.md
├── platform.config.yaml      # Create or use existing
├── assets/
│   ├── README.md
│   ├── brand/
│   ├── screenshots/
│   ├── colors/
│   └── content/
└── ... (generated code)
```

### Step 0.3: Configuration Handling

**If config EXISTS:** Parse it, validate it, proceed. Fix minor issues automatically.

**If config DOES NOT EXIST:**
1. Check assets/ for any reference materials
2. If assets found, infer what you can
3. Ask user ONCE for critical missing info (name, domain, basic pricing)
4. Generate complete config with sensible defaults
5. Proceed without asking for confirmation

**Auto-inference from assets:**
- `assets/brand/logo.svg` → Extract colors for brand.colors
- `assets/screenshots/*.png` → Analyze for layout/style preferences
- `assets/content/products.txt` → Parse for tier/product info
- `assets/colors/palette.png` → Extract hex colors

---

## PHASE 1-9: PARALLEL AGENT EXECUTION

### Launch Sequence

```
ORCHESTRATOR initializes shared memory
    │
    ├─► Spawn DATABASE AGENT (background)
    │   └─► Generates schema, types, seeds
    │       └─► Writes db-ready.flag when done
    │
    ├─► Spawn I18N AGENT (background)
    │   └─► Generates all locale files
    │       └─► Writes i18n-ready.flag when done
    │
    └─► Wait for db-ready.flag
        │
        ├─► Spawn BACKEND AGENT (background)
        │   └─► Reads DB types, generates routers
        │       └─► Writes api-ready.flag when done
        │
        └─► Wait for api-ready.flag
            │
            └─► Spawn FRONTEND AGENT (background)
                └─► Reads API types, generates components
                    └─► Writes frontend-ready.flag when done

ORCHESTRATOR monitors all agents via memory.json
    │
    └─► When all flags present:
        └─► Run integration (package.json, build, test)
```

### Agent Prompts

**DATABASE AGENT:**
```markdown
You are the Database Agent for platform-maker.

SHARED MEMORY: Read/write .platform-maker/memory.json
YOUR STATUS FILE: .platform-maker/agents/database.status

TASKS:
1. Read platform.config.yaml
2. Generate drizzle/schema.postgres.ts with all tables
3. Generate drizzle/schema.sqlite.ts (dev version)
4. Generate drizzle/schema.ts (environment switcher)
5. Generate drizzle/relations.ts
6. Generate drizzle/seed.ts
7. Generate drizzle/seed-pricing.ts (if pricing tiers defined)
8. Write contract types to .platform-maker/contracts/schema.types.ts
9. Push schema to database: `pnpm db:push`
   - Wait for success before proceeding
   - If it fails: check for syntax errors, auto-fix, retry up to 3 times
10. Run seeds: `pnpm seed && pnpm seed:pricing 2>/dev/null || true`
11. Update memory.json with your exports AND set databasePushed: true, seeded: true
12. Create .platform-maker/artifacts/db-ready.flag ONLY after db:push succeeds

CRITICAL: Do NOT create db-ready.flag until database schema is pushed successfully.

AUTONOMY: Fix all errors yourself. Only report to memory.json.
Do not ask the user anything.
```

**BACKEND AGENT:**
```markdown
You are the Backend Agent for platform-maker.

SHARED MEMORY: Read/write .platform-maker/memory.json
YOUR STATUS FILE: .platform-maker/agents/backend.status
WAIT FOR: .platform-maker/artifacts/db-ready.flag

TASKS:
1. Wait for db-ready.flag
2. Read schema types from .platform-maker/contracts/schema.types.ts
3. Generate server/trpc.ts (tRPC setup)
4. Generate server/routers.ts (main router)
5. Generate all routers: auth, products, agents, checkout, payment, referral, pricing, admin
6. Generate server/db/*.ts (database queries)
7. Generate REQUIRED security files (see SECURITY FEATURES section below)
8. Write API types to .platform-maker/contracts/api.types.ts
9. Update memory.json with your exports
10. Create .platform-maker/artifacts/api-ready.flag

AUTONOMY: Fix all errors yourself. Only report to memory.json.
Do not ask the user anything.
```

### SECURITY FEATURES (Required for Backend Agent)

All generated platforms MUST include these security features:

**5.1 Helmet Security Headers**
Generate in `server/index.ts`:
```typescript
import helmet from 'helmet';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", /* payment SDK URLs */],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", /* payment API URLs */],
      frameSrc: ["'self'", /* payment iframe URLs */],
      fontSrc: ["'self'", "data:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
```

**5.2 CSRF Protection**
Generate `server/lib/csrf.ts`:
```typescript
import { Request, Response, NextFunction } from 'express';

const ALLOWED_ORIGINS = [
  process.env.APP_URL || 'http://localhost:3000',
];

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip for webhooks and safe methods
  if (req.path.startsWith('/webhooks/') || req.method === 'GET') {
    return next();
  }

  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next();

  const isAllowed = ALLOWED_ORIGINS.some(allowed =>
    origin.startsWith(allowed)
  );

  if (!isAllowed) {
    return res.status(403).json({ error: 'Invalid origin' });
  }

  next();
}
```

**5.3 Rate Limiting**
Generate `server/lib/rateLimit.ts`:
```typescript
const authAttempts = new Map<string, { count: number; resetAt: number }>();

export const AUTH_RATE_LIMIT = { maxAttempts: 5, windowMs: 15 * 60 * 1000 };
export const GENERAL_RATE_LIMIT = { maxAttempts: 100, windowMs: 60 * 1000 };

export function checkRateLimit(key: string, limit: typeof AUTH_RATE_LIMIT) {
  const now = Date.now();
  const record = authAttempts.get(key);

  if (!record || now > record.resetAt) {
    authAttempts.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true };
  }

  if (record.count >= limit.maxAttempts) {
    return { allowed: false, retryAfter: record.resetAt - now };
  }

  record.count++;
  return { allowed: true };
}
```

**5.4 Role-Based Admin Access**
Generate `server/lib/admin.ts`:
```typescript
export function isAdmin(user: User | null): boolean {
  if (!user) return false;
  // Primary: Role-based
  if (user.role === 'admin' || user.role === 'super_admin') {
    return true;
  }
  // Fallback: Email whitelist (development only)
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').filter(Boolean);
  return adminEmails.includes(user.email);
}
```

**FRONTEND AGENT:**
```markdown
You are the Frontend Agent for platform-maker.

SHARED MEMORY: Read/write .platform-maker/memory.json
YOUR STATUS FILE: .platform-maker/agents/frontend.status
WAIT FOR: .platform-maker/artifacts/api-ready.flag, .platform-maker/artifacts/i18n-ready.flag

TASKS:
1. Wait for api-ready.flag and i18n-ready.flag
2. Read API types from .platform-maker/contracts/api.types.ts
3. Read i18n keys from .platform-maker/contracts/i18n.keys.ts
4. Generate client/src/pages/*.tsx (all pages)
5. Generate client/src/components/*.tsx (all components)
6. Generate client/src/lib/*.ts (contexts, hooks, utils)
7. Generate client/src/App.tsx and routes
8. Update memory.json with your files
9. Create .platform-maker/artifacts/frontend-ready.flag

AUTONOMY: Fix all errors yourself. Only report to memory.json.
Do not ask the user anything.
```

**I18N AGENT:**
```markdown
You are the I18N Agent for platform-maker.

SHARED MEMORY: Read/write .platform-maker/memory.json
YOUR STATUS FILE: .platform-maker/agents/i18n.status

TASKS:
1. Read platform.config.yaml for languages and content
2. Generate client/src/locales/{lang}/*.json for each language
3. Generate client/src/lib/i18n/config.ts
4. Write translation keys to .platform-maker/contracts/i18n.keys.ts
5. Update memory.json with your keys
6. Create .platform-maker/artifacts/i18n-ready.flag

AUTONOMY: Fix all errors yourself. Only report to memory.json.
Do not ask the user anything.
```

### Conflict Resolution

If agents have conflicting outputs:
1. Orchestrator detects via memory.json
2. Uses config as source of truth
3. Regenerates affected files
4. Logs resolution to decisions.log

---

## NO PLACEHOLDER POLICY

Agents MUST NOT generate placeholder or stub implementations.

### Prohibited Patterns
```typescript
// BAD - Placeholder
getPaymentMethods: protectedProcedure.query(async () => {
  // TODO: Implement
  return [];
});

// BAD - Mock that looks real
processPayment: protectedProcedure.mutation(async () => {
  // In production, this would call Square API
  return { success: true };
});
```

### Required Pattern
If a feature cannot be fully implemented, either:
1. Implement it completely with real API calls
2. Add clear conditional logic for dev/prod:

```typescript
processPayment: protectedProcedure.mutation(async ({ input }) => {
  if (!isSquareConfigured()) {
    // Development mode - simulate payment
    console.log('[DEV] Mock payment:', input);
    return {
      success: true,
      paymentId: `mock_${Date.now()}`,
      _mock: true
    };
  }

  // Production - real Square API call
  const client = getSquareClient()!;
  const result = await client.payments.create({...});
  return { success: true, paymentId: result.payment?.id };
});
```

### Critical Features That Must Be Complete
- Password reset flow (request, email, reset)
- Email verification flow
- Payment processing
- Webhook handlers
- Reader components (EPUB/PDF for ebook platforms)
- File upload/download

---

## PHASE 10: INTEGRATION & VERIFICATION (Autonomous)

After all agents complete:

```bash
# 1. Generate project files
# - package.json
# - tsconfig.json
# - vite.config.ts
# - tailwind.config.js
# - .env.example
# - Dockerfile, docker-compose.yml, nginx.conf

# 2. Install dependencies (auto-retry on failure)
pnpm install || pnpm install || pnpm install

# 3. Push database schema
pnpm drizzle-kit push --config=drizzle.config.sqlite.ts

# 4. Seed database
pnpm seed

# 5. Type check (fix errors automatically)
pnpm check || fix_errors_and_retry

# 6. Build test
pnpm build || fix_errors_and_retry
```

### Auto-Fix Loop

```
attempt = 0
max_attempts = 5

while (build_fails && attempt < max_attempts) {
  error = parse_build_error()
  fix = determine_fix(error)
  apply_fix(fix)
  log_to_decisions(fix)
  attempt++
}

if (attempt >= max_attempts) {
  notify_user_with_full_context()
}
```

---

## PHASE 11: VALIDATION (Critical)

After all agents complete and before declaring success, run validation:

### 11.1 TypeScript Type Check
```bash
pnpm check || {
  # Parse errors, auto-fix common issues
  fix_typescript_errors
  pnpm check # Retry
}
```

Common auto-fixes:
- Remove unused imports
- Add missing null checks
- Export missing types

### 11.2 Build Verification
```bash
pnpm build || {
  # Parse build errors, attempt fix
  fix_build_errors
  pnpm build # Retry
}
```

### 11.3 Server Startup Test
```bash
# Start server in background
pnpm dev:server &
SERVER_PID=$!
sleep 5

# Test health endpoint
curl -s http://localhost:3001/api/health | grep -q '"status":"ok"'
HEALTH_OK=$?

kill $SERVER_PID 2>/dev/null

if [ $HEALTH_OK -ne 0 ]; then
  echo "Server health check failed"
  exit 1
fi
```

### 11.4 Database Sync Verification
```bash
# Push schema (run after schema generation)
pnpm db:push

# Run seeds if configured
pnpm seed 2>/dev/null || true
```

### 11.5 Update memory.json
```json
{
  "validation": {
    "typeCheck": { "passed": true, "timestamp": "..." },
    "build": { "passed": true, "timestamp": "..." },
    "serverStartup": { "passed": true, "healthResponse": "ok" },
    "database": { "pushed": true, "seeded": true }
  }
}
```

**CRITICAL**: Do NOT declare success until all validation passes.

---

## PHASE 12: START & REPORT (Minimal Output)

```bash
pnpm dev
```

**Final Output to User:**
```
════════════════════════════════════════════════════════════
  ✓ Platform Generated Successfully
════════════════════════════════════════════════════════════
  Project:    {{config.brand.name}}
  Location:   {{projectPath}}
  URL:        http://localhost:3000
  Admin:      http://localhost:3000/admin
────────────────────────────────────────────────────────────
  Files:      {{fileCount}} files generated
  Agents:     {{agentCount}} agents configured
  Languages:  {{languageCount}} languages
  Time:       {{duration}}
────────────────────────────────────────────────────────────
  Validation: TypeScript ✓ | Build ✓ | Server ✓ | Database ✓
  Decisions:  {{decisionCount}} auto-decisions made
              See .platform-maker/decisions.log
════════════════════════════════════════════════════════════
```

---

## ERROR HANDLING

### Retry Strategy

| Error Type | Max Retries | Action |
|------------|-------------|--------|
| Network error | 5 | Wait 2s, retry |
| Build error | 5 | Auto-fix, retry |
| Type error | 5 | Auto-fix, retry |
| Dependency error | 3 | Clear cache, retry |
| Config error | 0 | Ask user |
| Destructive cmd | 0 | Triple confirm |

### Unrecoverable Errors

Only notify user when:
1. 5 retry attempts exhausted
2. Config is fundamentally invalid
3. Required external service unavailable
4. File system permissions blocked

Notification format:
```
⚠️  I need your help with an issue I couldn't resolve automatically.

Error: [clear description]
Attempted fixes: [list of what was tried]
Suggestion: [what user can do]

See full details in .platform-maker/errors.log
```

---

## TECHNOLOGY STACK

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript 5, Vite 6, TailwindCSS 4, Shadcn/UI |
| Backend | Express 4, tRPC 11, Drizzle ORM 0.38 |
| Database | SQLite (dev), PostgreSQL 16 (prod) |
| Payments | Square SDK 41 |
| Email | Resend 4 |
| i18n | i18next 24 |
| Routing | Wouter 3 |
| Deployment | Docker, Nginx, Let's Encrypt |

---

## SDK VERSION HANDLING

SDKs change APIs between major versions. Before generating code, detect versions.

### Detection Commands
```bash
# Square SDK version
SQUARE_VER=$(node -p "require('./package.json').dependencies.square?.replace('^','') || '41'")

# Resend SDK version
RESEND_VER=$(node -p "require('./package.json').dependencies.resend?.replace('^','') || '4'")
```

### Version-Specific Patterns

| SDK | Version | Pattern |
|-----|---------|---------|
| Square | <41 | `import { Client, Environment } from 'square'` |
| Square | >=41 | `import { SquareClient, SquareEnvironment } from 'square'` |

### Template Selection
Store version-aware templates and select based on detected version.

### Square SDK v42+ Pattern
```typescript
import { SquareClient, SquareEnvironment } from 'square';

let squareClient: SquareClient | null = null;

function getSquareClient(): SquareClient | null {
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return null;
  }
  if (!squareClient) {
    squareClient = new SquareClient({
      token: process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.NODE_ENV === 'production'
        ? SquareEnvironment.Production
        : SquareEnvironment.Sandbox,
    });
  }
  return squareClient;
}

export function isSquareConfigured(): boolean {
  return !!process.env.SQUARE_ACCESS_TOKEN;
}
```

---

## REFERENCE FILES

- `SCHEMA.md` - Complete configuration schema
- `ARCHITECTURE.md` - System architecture patterns (includes defensive service initialization)
- `DEPLOYMENT.md` - Production deployment guide
- `templates/example.yaml` - Full example configuration
- `templates/verify.template.ts` - Platform verification script (copy to generated project)
