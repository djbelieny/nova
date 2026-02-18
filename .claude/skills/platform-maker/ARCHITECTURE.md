# Architecture Overview

This document describes the system architecture of the Zaarvy AI platform, serving as a reference for both understanding the existing codebase and generating new platforms.

---

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [Directory Structure](#directory-structure)
3. [Database Schema](#database-schema)
4. [Server Architecture](#server-architecture)
5. [Frontend Architecture](#frontend-architecture)
6. [State Management](#state-management)
7. [Authentication Flow](#authentication-flow)
8. [Payment Flow](#payment-flow)
9. [Internationalization](#internationalization)
10. [Data Flow Diagrams](#data-flow-diagrams)

---

## Technology Stack

### Frontend
| Technology | Purpose | Version |
|------------|---------|---------|
| React | UI framework | 19.x |
| Vite | Build tool & dev server | 6.x |
| TypeScript | Type safety | 5.x |
| Wouter | Lightweight routing | 3.x |
| TailwindCSS | Utility-first styling | 4.x |
| Shadcn/UI | Component library | Latest |
| React Query | Server state management | 5.x |
| tRPC React | Type-safe API client | 11.x |
| i18next | Internationalization | 24.x |
| Framer Motion | Animations | 11.x |
| Recharts | Data visualization | 2.x |

### Backend
| Technology | Purpose | Version |
|------------|---------|---------|
| Express.js | HTTP server | 4.x |
| tRPC | Type-safe RPC framework | 11.x |
| Drizzle ORM | Database ORM | 0.38.x |
| Square SDK | Payment processing | 41.x |
| Resend | Transactional email | 4.x |
| AWS S3 SDK | File storage | 3.x |

### Database
| Environment | Database | Notes |
|-------------|----------|-------|
| Development | SQLite | File-based, no setup |
| Production | PostgreSQL | Full ACID, scalable |

### DevOps
| Tool | Purpose |
|------|---------|
| Docker | Containerization |
| nginx | Reverse proxy |
| Let's Encrypt | SSL certificates |
| GitHub Actions | CI/CD |

---

## Service Initialization Patterns

Services depending on environment variables MUST use lazy initialization to prevent startup crashes.

### Pattern: Lazy Initialization
```typescript
// BAD - Crashes if RESEND_API_KEY missing
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY); // Throws!

// GOOD - Lazy initialization with fallback
import { Resend } from 'resend';

let resend: Resend | null = null;

function getResendClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null; // Return null, don't crash
  }
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

export async function sendEmail(options: EmailOptions) {
  const client = getResendClient();
  if (!client) {
    // Development fallback - log instead of send
    console.log('[EMAIL-DEV] Would send:', options);
    return { success: true, mock: true };
  }
  return client.emails.send(options);
}
```

### Services Requiring This Pattern
- Email (Resend, SendGrid)
- Payments (Square, Stripe)
- Storage (S3, Cloudflare R2)
- Analytics (optional services)

### Verification
Each service should export an `isConfigured()` function:
```typescript
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export function isSquareConfigured(): boolean {
  return !!process.env.SQUARE_ACCESS_TOKEN;
}

export function isStorageConfigured(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
```

### Square SDK Pattern (v42+)
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
```

---

## Directory Structure

```
/
├── client/                      # Frontend React application
│   ├── src/
│   │   ├── main.tsx            # Entry point
│   │   ├── App.tsx             # Root component with routing
│   │   ├── components/
│   │   │   ├── ui/             # Shadcn UI components (50+ files)
│   │   │   ├── referral/       # Referral-specific components
│   │   │   ├── DashboardLayout.tsx
│   │   │   ├── UpgradeModal.tsx
│   │   │   ├── OrderBump.tsx
│   │   │   └── ...
│   │   ├── pages/
│   │   │   ├── Home.tsx        # Landing page
│   │   │   ├── Launchpad.tsx   # User dashboard
│   │   │   ├── Checkout.tsx    # Payment page
│   │   │   ├── Confirmation.tsx
│   │   │   ├── Login.tsx
│   │   │   ├── Dossier.tsx     # Agent detail page
│   │   │   └── admin/          # Admin pages
│   │   │       ├── index.tsx
│   │   │       ├── users/
│   │   │       ├── products/
│   │   │       ├── referrals/
│   │   │       └── currencies/
│   │   ├── lib/
│   │   │   ├── trpc.ts         # tRPC client setup
│   │   │   ├── i18n/
│   │   │   │   ├── config.ts   # i18next configuration
│   │   │   │   └── LanguageContext.tsx
│   │   │   └── pricing/
│   │   │       └── PricingContext.tsx
│   │   ├── contexts/
│   │   │   └── ThemeContext.tsx
│   │   ├── hooks/
│   │   │   ├── useMobile.tsx
│   │   │   └── _core/
│   │   │       └── useAuth.tsx
│   │   └── locales/            # Translation files
│   │       ├── en/
│   │       ├── pt/
│   │       └── es/
│   ├── index.html
│   └── vite.config.ts
│
├── server/                      # Backend Express + tRPC
│   ├── index.ts                # Server entry point
│   ├── routers.ts              # Main router composition
│   ├── db.ts                   # Database connection
│   ├── storage.ts              # S3 file storage
│   ├── _core/
│   │   ├── trpc.ts             # tRPC instance & procedures
│   │   ├── context.ts          # Request context
│   │   ├── systemRouter.ts     # System routes
│   │   ├── oauth.ts            # OAuth handlers
│   │   ├── llm.ts              # LLM integration
│   │   └── env.ts              # Environment config
│   ├── routers/
│   │   ├── admin.ts            # Admin dashboard
│   │   ├── referral.ts         # Referral system
│   │   └── pricing.ts          # Pricing queries
│   ├── db/
│   │   ├── products.ts         # Product queries
│   │   ├── agents.ts           # Agent queries
│   │   ├── currencies.ts       # Currency formatting
│   │   ├── pricing.ts          # Localized pricing
│   │   └── referrals.ts        # Referral helpers
│   ├── payment/
│   │   └── squarePayment.ts    # Square payment logic
│   ├── square/
│   │   ├── checkout.ts         # Checkout router
│   │   ├── payment.ts          # Payment processing
│   │   ├── webhook.ts          # Square webhooks
│   │   └── products.ts         # Product sync
│   ├── geo/
│   │   ├── location.ts         # IP geolocation
│   │   ├── countryMap.ts       # Country→currency map
│   │   └── exchangeRates.ts    # Exchange rate API
│   └── email/
│       └── index.ts            # Email service
│
├── drizzle/                     # Database schemas
│   ├── schema.ts               # Environment-aware export
│   ├── schema.sqlite.ts        # SQLite tables
│   ├── schema.postgres.ts      # PostgreSQL tables
│   ├── relations.ts            # Table relationships
│   └── seed.ts                 # Seed data
│
├── shared/                      # Shared utilities
│   └── constants.ts            # Tier hierarchy, etc.
│
├── scripts/                     # Utility scripts
│   └── ...
│
├── dist/                        # Production build output
│   └── public/                 # Static frontend assets
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── drizzle.config.sqlite.ts
├── drizzle.config.postgres.ts
└── docker-compose.yml
```

---

## Database Schema

### Entity Relationship Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     users       │     │    products     │     │     agents      │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │     │ id (PK)         │
│ openId          │     │ tierKey (unique)│     │ agentKey (unique│
│ email           │     │ name            │     │ name            │
│ password        │     │ priceCents      │     │ role            │
│ name            │     │ agentCount      │     │ tierKey ────────┼──┐
│ loginMethod     │     │ features (json) │     │ personality     │  │
│ role            │     │ bumpToTierKey   │     │ avatarUrl       │  │
│ tier ───────────┼──┐  │ bumpPriceCents  │     │ displayOrder    │  │
│ referredBy (FK)─┼──┘  │ displayOrder    │     │ isActive        │  │
│ hasSecretAccess │     │ isActive        │     └─────────────────┘  │
│ isAdmin         │     └─────────────────┘                          │
│ timestamps      │              │                                   │
└─────────────────┘              │ (1:n)                             │
        │                        ▼                                   │
        │ (1:n)         ┌─────────────────┐                          │
        │               │ countryPricing  │                          │
        │               ├─────────────────┤                          │
        │               │ id (PK)         │                          │
        │               │ productId (FK)──┼──────────────────────────┘
        │               │ countryCode     │
        │               │ currencyCode    │
        │               │ priceCents      │
        │               │ bumpPriceCents  │
        │               └─────────────────┘
        │
        │ (1:1)
        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ referralCodes   │     │    referrals    │     │ referralRewards │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │     │ id (PK)         │
│ userId (FK)     │◄────┤ referrerUserId  │     │ userId (FK)     │
│ code (unique)   │     │ referredUserId  │     │ milestone       │
│ successfulCount │     │ referralCode    │     │ fromTier        │
└─────────────────┘     │ status          │     │ toTier          │
                        │ purchaseTier    │     │ status          │
                        │ timestamps      │     │ timestamps      │
                        └─────────────────┘     └─────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│pendingCheckouts │     │ promptTemplates │     │   currencies    │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ id (PK)         │     │ id (PK)         │     │ code (PK)       │
│ sessionId       │     │ agentId (FK)    │     │ name            │
│ squareOrderId   │     │ titleEn/Pt/Es   │     │ symbol          │
│ userId (FK)     │     │ descEn/Pt/Es    │     │ symbolPosition  │
│ email           │     │ promptEn/Pt/Es  │     │ decimalPlaces   │
│ baseTier        │     │ displayOrder    │     │ isActive        │
│ finalTier       │     └─────────────────┘     │ isDefault       │
│ orderBumpAccept │                             └─────────────────┘
│ amountCents     │
│ status          │
│ countryCode     │
│ currencyCode    │
│ timestamps      │
└─────────────────┘
```

### Table Definitions

#### users
Primary user table with authentication and tier information.

```typescript
users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  openId: text("open_id").unique(),
  email: text("email"),
  password: text("password"),
  name: text("name"),
  loginMethod: text("login_method").$type<"email" | "oauth">(),
  role: text("role").$type<"user" | "admin">().default("user"),
  tier: text("tier").$type<TierKey>().default("none"),
  referredBy: integer("referred_by").references(() => users.id),
  hasSecretAccess: integer("has_secret_access", { mode: "boolean" }).default(false),
  isAdmin: integer("is_admin", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
  lastSignedIn: text("last_signed_in"),
});
```

#### products
Product/tier definitions with pricing and order bump configuration.

```typescript
products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tierKey: text("tier_key").unique().notNull(),
  name: text("name").notNull(),
  description: text("description"),
  priceCents: integer("price_cents").notNull(),
  agentCount: integer("agent_count").default(0),
  templateCount: integer("template_count").default(0),
  features: text("features", { mode: "json" }).$type<string[]>(),

  // Square integration
  squareProductId: text("square_product_id"),
  squarePaymentLink: text("square_payment_link"),

  // Order bump (upgrade offer)
  bumpToTierKey: text("bump_to_tier_key"),
  bumpPriceCents: integer("bump_price_cents"),
  bumpRegularCents: integer("bump_regular_cents"),
  bumpSavingsCents: integer("bump_savings_cents"),

  displayOrder: integer("display_order").default(0),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
});
```

#### agents
AI agent definitions with personality and metadata.

```typescript
agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentKey: text("agent_key").unique().notNull(),
  name: text("name").notNull(),
  role: text("role"),
  tierKey: text("tier_key").notNull(),
  chatgptUrl: text("chatgpt_url"),
  avatarUrl: text("avatar_url"),
  personality: text("personality"),
  communicationStyle: text("communication_style"),
  signatureQuote: text("signature_quote"),
  idealFor: text("ideal_for", { mode: "json" }).$type<string[]>(),
  realWorldUse: text("real_world_use"),
  valueProposition: text("value_proposition"),
  displayOrder: integer("display_order").default(0),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
});
```

#### promptTemplates
Multi-language prompt templates linked to agents.

```typescript
promptTemplates = sqliteTable("prompt_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agentId: text("agent_id").notNull(),
  displayOrder: integer("display_order").default(0),

  // Multi-language fields
  titleEn: text("title_en"),
  titlePt: text("title_pt"),
  titleEs: text("title_es"),
  descriptionEn: text("description_en"),
  descriptionPt: text("description_pt"),
  descriptionEs: text("description_es"),
  promptEn: text("prompt_en"),
  promptPt: text("prompt_pt"),
  promptEs: text("prompt_es"),

  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
});
```

#### currencies
Currency formatting rules.

```typescript
currencies = sqliteTable("currencies", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  symbolPosition: text("symbol_position").$type<"before" | "after">().default("before"),
  decimalPlaces: integer("decimal_places").default(2),
  thousandSeparator: text("thousand_separator").default(","),
  decimalSeparator: text("decimal_separator").default("."),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
});
```

#### countryPricing
Country-specific pricing overrides.

```typescript
countryPricing = sqliteTable("country_pricing", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").references(() => products.id),
  countryCode: text("country_code").notNull(),
  currencyCode: text("currency_code").notNull(),
  priceCents: integer("price_cents").notNull(),
  bumpPriceCents: integer("bump_price_cents"),
  bumpRegularCents: integer("bump_regular_cents"),
  bumpSavingsCents: integer("bump_savings_cents"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
}, (table) => ({
  uniqueProductCountry: unique().on(table.productId, table.countryCode),
}));
```

#### pendingCheckouts
Checkout sessions awaiting payment completion.

```typescript
pendingCheckouts = sqliteTable("pending_checkouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").unique().notNull(),
  squareOrderId: text("square_order_id").unique(),
  squarePaymentLinkId: text("square_payment_link_id").unique(),
  userId: integer("user_id").references(() => users.id),
  email: text("email").notNull(),
  baseTier: text("base_tier").$type<TierKey>().notNull(),
  finalTier: text("final_tier").$type<TierKey>().notNull(),
  orderBumpAccepted: integer("order_bump_accepted", { mode: "boolean" }).default(false),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").$type<"pending" | "completed" | "cancelled" | "expired">().default("pending"),
  idempotencyKey: text("idempotency_key").unique(),
  referralCode: text("referral_code"),
  countryCode: text("country_code"),
  currencyCode: text("currency_code"),
  displayedPriceCents: integer("displayed_price_cents"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").$onUpdate(() => new Date().toISOString()),
});
```

#### referralCodes, referrals, referralRewards
Referral system tables.

```typescript
referralCodes = sqliteTable("referral_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id).unique(),
  code: text("code").unique().notNull(),
  successfulReferrals: integer("successful_referrals").default(0),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

referrals = sqliteTable("referrals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  referrerUserId: integer("referrer_user_id").references(() => users.id),
  referredUserId: integer("referred_user_id"),
  referredEmail: text("referred_email"),
  referralCode: text("referral_code").notNull(),
  status: text("status").$type<"clicked" | "purchased" | "credited" | "revoked">().default("clicked"),
  purchaseTier: text("purchase_tier"),
  purchaseAmountCents: integer("purchase_amount_cents"),
  clickedAt: text("clicked_at").default(sql`(datetime('now'))`),
  purchasedAt: text("purchased_at"),
  creditedAt: text("credited_at"),
});

referralRewards = sqliteTable("referral_rewards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id),
  milestone: integer("milestone").notNull(),
  fromTier: text("from_tier").notNull(),
  toTier: text("to_tier").notNull(),
  status: text("status").$type<"earned" | "applied" | "revoked">().default("earned"),
  earnedAt: text("earned_at").default(sql`(datetime('now'))`),
  appliedAt: text("applied_at"),
});
```

---

## Server Architecture

### Router Hierarchy

```
appRouter
├── system          # Health checks, version info
├── auth            # Authentication
│   ├── me              # Get current user
│   ├── login           # Email/password login
│   ├── logout          # Clear session
│   ├── createAccountFromPurchase
│   ├── forgotPassword
│   └── resetPassword
├── products        # Product catalog
│   ├── getAll          # List all products
│   └── getByTier       # Get single product
├── agents          # Agent catalog
│   ├── getAll          # List all agents
│   ├── getByKey        # Get single agent
│   ├── getForUserTier  # Agents for user's tier
│   └── checkAccess     # Check if user can access agent
├── prompts         # Prompt templates
│   └── getByAgent      # Get prompts for agent
├── tier            # Tier management
│   ├── getUserTier     # Get user's current tier
│   ├── completePurchase
│   ├── updateTier
│   └── checkAgentAccess
├── checkout        # Checkout flow
│   ├── getOrderBumpOffer
│   ├── createCheckout
│   └── verifySession
├── payment         # Square payment
│   ├── webhook         # Square webhooks
│   └── ...
├── referral        # Referral system
│   ├── getCode         # Get/create referral code
│   ├── getStats        # Referral statistics
│   ├── validateCode    # Validate referral code
│   └── applyReward     # Apply milestone reward
├── pricing         # Pricing queries
│   ├── getLocalizedPrices
│   └── getExchangeRates
└── admin           # Admin dashboard
    ├── dashboardStats
    ├── users
    │   ├── list
    │   ├── get
    │   ├── update
    │   └── delete
    ├── products
    │   ├── list
    │   ├── get
    │   ├── update
    │   └── updateCountryPricing
    ├── currencies
    │   ├── list
    │   ├── update
    │   └── toggleActive
    └── referrals
        ├── list
        └── getRewards
```

### Procedure Types

```typescript
// Public - no authentication required
export const publicProcedure = t.procedure;

// Protected - requires authenticated user
export const protectedProcedure = t.procedure.use(requireUser);

// Admin - requires admin role
export const adminProcedure = t.procedure.use(adminMiddleware);
```

### Middleware Pattern

```typescript
const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const adminMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user?.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});
```

### Database Access Pattern

```typescript
// Environment-aware table selection
function getProductsTable() {
  return process.env.NODE_ENV === "production"
    ? schemaPostgres.products
    : schemaSqlite.products;
}

// Query helper
export async function getProduct(tierKey: TierKey) {
  const db = await getDb();
  const productsTable = getProductsTable();

  const [product] = await db
    .select()
    .from(productsTable)
    .where(and(
      eq(productsTable.tierKey, tierKey),
      eq(productsTable.isActive, true)
    ))
    .limit(1);

  return product;
}
```

---

## Frontend Architecture

### Component Tree

```
App
├── ThemeProvider
├── LanguageProvider
├── QueryClientProvider
├── trpc.Provider
└── Router
    ├── /:lang/                 # Language-prefixed routes
    │   ├── Home               # Landing page
    │   ├── Login              # Authentication
    │   ├── ForgotPassword
    │   ├── ResetPassword
    │   ├── Launchpad          # User dashboard (protected)
    │   │   └── DashboardLayout
    │   │       ├── Header
    │   │       ├── AgentGrid
    │   │       └── UpgradeModal
    │   ├── Checkout           # Payment flow
    │   │   └── PricingProvider
    │   │       ├── TierSelector
    │   │       ├── OrderBump
    │   │       └── PaymentButton
    │   ├── Confirmation       # Post-purchase
    │   ├── Dossier/:agentKey  # Agent detail
    │   ├── Privacy
    │   ├── Terms
    │   └── Contact
    └── /admin                  # Admin routes
        ├── AdminDashboard
        ├── UserManagement
        ├── ProductManagement
        ├── CurrencyManagement
        └── ReferralManagement
```

### Page Component Pattern

```tsx
export default function ExamplePage() {
  // Auth hook for user state
  const { user, loading: authLoading } = useAuth();

  // Router hook
  const [, setLocation] = useLocation();

  // tRPC query with conditional enable
  const { data, isLoading, error } = trpc.router.query.useQuery(
    { param: "value" },
    { enabled: !!user }
  );

  // Loading state
  if (authLoading || isLoading) {
    return <LoadingSpinner />;
  }

  // Error state
  if (error) {
    return <ErrorDisplay error={error} />;
  }

  // Auth redirect
  if (!user) {
    setLocation("/login");
    return null;
  }

  // Main render
  return (
    <DashboardLayout>
      {/* Page content */}
    </DashboardLayout>
  );
}
```

### UI Component Pattern (Shadcn)

```tsx
// Button with variants using class-variance-authority
const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground",
        outline: "border border-input bg-background hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
);
```

---

## State Management

### Server State (React Query + tRPC)

```tsx
// Query setup
const utils = trpc.useUtils();

// Query with caching
const { data: products } = trpc.products.getAll.useQuery(undefined, {
  staleTime: 5 * 60 * 1000,  // 5 minutes
  cacheTime: 30 * 60 * 1000, // 30 minutes
});

// Mutation with optimistic update
const updateTier = trpc.tier.updateTier.useMutation({
  onMutate: async (newTier) => {
    await utils.auth.me.cancel();
    const previousUser = utils.auth.me.getData();
    utils.auth.me.setData(undefined, (old) => ({
      ...old!,
      tier: newTier.tier,
    }));
    return { previousUser };
  },
  onError: (err, newTier, context) => {
    utils.auth.me.setData(undefined, context?.previousUser);
  },
  onSettled: () => {
    utils.auth.me.invalidate();
  },
});
```

### Context Providers

#### PricingContext
Provides localized pricing data throughout the app.

```tsx
interface PricingContextValue {
  pricing: Map<string, LocalizedProduct>;
  orderBumps: Map<string, LocalizedOrderBump>;
  isLoading: boolean;
  currency: string;
  countryCode: string;
  getLocalizedProduct: (tierKey: string) => LocalizedProduct | null;
  getOrderBump: (tierKey: string) => LocalizedOrderBump | null;
}

export function PricingProvider({ children }: { children: React.ReactNode }) {
  const { data: geoData } = trpc.pricing.getGeoLocation.useQuery();
  const { data: prices, isLoading } = trpc.pricing.getLocalizedPrices.useQuery(
    { countryCode: geoData?.countryCode },
    { enabled: !!geoData }
  );

  const value = useMemo(() => ({
    pricing: new Map(prices?.products.map(p => [p.tierKey, p])),
    orderBumps: new Map(prices?.orderBumps.map(b => [b.fromTier, b])),
    isLoading,
    currency: prices?.currency || "USD",
    countryCode: geoData?.countryCode || "US",
    getLocalizedProduct: (tierKey) => pricing.get(tierKey) || null,
    getOrderBump: (tierKey) => orderBumps.get(tierKey) || null,
  }), [prices, isLoading, geoData]);

  return (
    <PricingContext.Provider value={value}>
      {children}
    </PricingContext.Provider>
  );
}
```

#### LanguageContext
Manages language state synced with URL path.

```tsx
interface LanguageContextValue {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  getLocalizedHref: (path: string) => string;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();

  const language = useMemo(() => {
    return getLanguageFromPath(location) || "en";
  }, [location]);

  const setLanguage = useCallback((lang: SupportedLanguage) => {
    const newPath = getLocalizedPath(location, lang);
    setLocation(newPath);
    i18n.changeLanguage(lang);
  }, [location, setLocation]);

  const getLocalizedHref = useCallback((path: string) => {
    return `/${language}${path.startsWith("/") ? path : `/${path}`}`;
  }, [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, getLocalizedHref }}>
      {children}
    </LanguageContext.Provider>
  );
}
```

---

## Authentication Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │     │   Server    │     │  Database   │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │ POST /login       │                   │
       │ {email, password} │                   │
       │──────────────────►│                   │
       │                   │ SELECT user       │
       │                   │ WHERE email=?     │
       │                   │──────────────────►│
       │                   │◄──────────────────│
       │                   │                   │
       │                   │ bcrypt.compare    │
       │                   │                   │
       │                   │ Create JWT token  │
       │                   │                   │
       │ Set-Cookie: token │                   │
       │◄──────────────────│                   │
       │                   │                   │
       │ GET /api/auth/me  │                   │
       │ Cookie: token     │                   │
       │──────────────────►│                   │
       │                   │ Verify JWT        │
       │                   │                   │
       │                   │ SELECT user       │
       │                   │──────────────────►│
       │                   │◄──────────────────│
       │ { user }          │                   │
       │◄──────────────────│                   │
```

### JWT Token Structure

```typescript
interface JWTPayload {
  userId: number;
  email: string;
  tier: TierKey;
  isAdmin: boolean;
  iat: number;  // Issued at
  exp: number;  // Expiration
}
```

---

## Payment Flow

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Client    │  │   Server    │  │   Square    │  │  Database   │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
       │                │                │                │
       │ createCheckout │                │                │
       │ {tier, email}  │                │                │
       │───────────────►│                │                │
       │                │                │                │
       │                │ Get localized  │                │
       │                │ pricing        │                │
       │                │───────────────────────────────►│
       │                │◄───────────────────────────────│
       │                │                │                │
       │                │ Convert to USD │                │
       │                │                │                │
       │                │ Create order   │                │
       │                │───────────────►│                │
       │                │◄───────────────│                │
       │                │                │                │
       │                │ Create payment │                │
       │                │ link           │                │
       │                │───────────────►│                │
       │                │◄───────────────│                │
       │                │                │                │
       │                │ Store pending  │                │
       │                │ checkout       │                │
       │                │───────────────────────────────►│
       │                │                │                │
       │ {paymentLink,  │                │                │
       │  sessionId}    │                │                │
       │◄───────────────│                │                │
       │                │                │                │
       │ Redirect to    │                │                │
       │ Square         │                │                │
       │═══════════════════════════════►│                │
       │                │                │                │
       │ User completes │                │                │
       │ payment        │                │                │
       │◄═══════════════════════════════│                │
       │                │                │                │
       │                │ Webhook:       │                │
       │                │ payment.completed              │
       │                │◄───────────────│                │
       │                │                │                │
       │                │ Update checkout│                │
       │                │ status         │                │
       │                │───────────────────────────────►│
       │                │                │                │
       │                │ Create/update  │                │
       │                │ user           │                │
       │                │───────────────────────────────►│
       │                │                │                │
       │ Redirect to    │                │                │
       │ /confirmation  │                │                │
       │◄═══════════════════════════════│                │
       │                │                │                │
       │ verifySession  │                │                │
       │ {sessionId}    │                │                │
       │───────────────►│                │                │
       │                │ Check checkout │                │
       │                │ status         │                │
       │                │───────────────────────────────►│
       │                │◄───────────────────────────────│
       │ {success, user}│                │                │
       │◄───────────────│                │                │
```

---

## Internationalization

### Translation File Structure

```
/client/src/locales/
├── en/
│   ├── common.json       # Shared UI strings
│   ├── auth.json         # Authentication pages
│   ├── home.json         # Landing page
│   ├── launchpad.json    # Dashboard
│   ├── checkout.json     # Payment flow
│   ├── agents.json       # Agent metadata
│   ├── prompts.json      # Prompt templates
│   ├── legal.json        # Terms, privacy
│   └── confirmation.json # Post-purchase
├── pt/
│   └── ... (same structure)
└── es/
    └── ... (same structure)
```

### Translation Key Pattern

```json
{
  "namespace": {
    "section": {
      "key": "value",
      "keyWithVar": "Hello, {{name}}!",
      "pluralKey_zero": "No items",
      "pluralKey_one": "{{count}} item",
      "pluralKey_other": "{{count}} items"
    }
  }
}
```

### Usage Pattern

```tsx
import { useTranslation } from "react-i18next";

function Component() {
  const { t } = useTranslation();

  return (
    <div>
      <h1>{t("common:brand.name")}</h1>
      <p>{t("home:hero.description")}</p>
      <span>{t("common:labels.agentCount", { count: 7 })}</span>
    </div>
  );
}
```

### URL-Based Language Switching

```
https://zaarvy.com/en/checkout  → English
https://zaarvy.com/pt/checkout  → Portuguese
https://zaarvy.com/es/checkout  → Spanish
```

---

## Data Flow Diagrams

### Pricing Flow

```
┌─────────────┐
│ User visits │
│ checkout    │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Detect IP   │
│ location    │
└─────────────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐
│ Check for   │ No  │ Use USD     │
│ country     │────►│ base price  │
│ pricing     │     └─────────────┘
└─────────────┘
       │ Yes
       ▼
┌─────────────┐
│ Get local   │
│ currency    │
│ pricing     │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Format with │
│ currency    │
│ rules       │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Convert to  │
│ USD for     │
│ Square      │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Display     │
│ local price │
│ Charge USD  │
└─────────────┘
```

### Referral Flow

```
┌─────────────┐
│ User shares │
│ referral    │
│ link        │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Friend      │
│ clicks link │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Store code  │
│ in cookie   │
│ 30 days     │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Friend      │
│ completes   │
│ purchase    │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Apply 20%   │
│ discount    │
└─────────────┘
       │
       ▼
┌─────────────┐
│ Credit      │
│ referrer    │
└─────────────┘
       │
       ▼
┌─────────────┐     ┌─────────────┐
│ Check for   │ Yes │ Award tier  │
│ milestone   │────►│ upgrade     │
│ (5 refs)    │     └─────────────┘
└─────────────┘
```

---

## Next Steps

- See [PLATFORM_CONFIG_SCHEMA.md](./PLATFORM_CONFIG_SCHEMA.md) for configuration options
- See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment instructions
- See [SKILL_PROMPT.md](./SKILL_PROMPT.md) for generator skill usage
- See [templates/](./templates/) for code generation templates
