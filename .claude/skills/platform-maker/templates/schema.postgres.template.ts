/**
 * PostgreSQL Schema Template
 *
 * This template defines the database schema for the generated platform.
 * Replace {{PLACEHOLDERS}} with values from platform.config.yaml
 *
 * Tables:
 * - users: User accounts and authentication
 * - products: Tier/product definitions
 * - agents: AI agent definitions
 * - promptTemplates: Multi-language prompt templates
 * - pendingCheckouts: Payment sessions
 * - referralCodes: User referral codes
 * - referrals: Referral tracking
 * - referralRewards: Milestone rewards
 * - currencies: Currency formatting rules
 * - countryPricing: Country-specific pricing
 * - passwordResetTokens: Password reset tokens
 */

import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  pgEnum,
  boolean,
  integer,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";

// =============================================================================
// ENUMS - Generated from config.tiers.hierarchy
// =============================================================================

/**
 * User roles
 */
export const roleEnum = pgEnum("role", ["user", "admin"]);

/**
 * Tier levels - Generated from: {{config.tiers.hierarchy}}
 * Example: ["none", "core", "growth", "quantum", "secret"]
 */
export const tierEnum = pgEnum("tier", [
  {{#each config.tiers.hierarchy}}
  "{{this}}",
  {{/each}}
]);

/**
 * Checkout status
 */
export const checkoutStatusEnum = pgEnum("checkout_status", [
  "pending",
  "completed",
  "cancelled",
  "expired",
]);

/**
 * Referral status
 */
export const referralStatusEnum = pgEnum("referral_status", [
  "clicked",
  "purchased",
  "credited",
  "revoked",
]);

/**
 * Reward status
 */
export const rewardStatusEnum = pgEnum("reward_status", [
  "earned",
  "applied",
  "revoked",
]);

/**
 * Currency symbol position
 */
export const symbolPositionEnum = pgEnum("symbol_position", ["before", "after"]);

// =============================================================================
// TABLES
// =============================================================================

/**
 * Users table - User accounts with authentication and tier information
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  password: text("password"),
  role: roleEnum("role").default("user").notNull(),
  tier: tierEnum("tier").default("none").notNull(),
  referredBy: integer("referredBy"), // User ID who referred this user
  referralCodeUsed: varchar("referralCodeUsed", { length: 10 }), // Referral code used at signup
  hasSecretAccess: boolean("hasSecretAccess").default(false).notNull(), // Unlocked secret tier
  isAdmin: boolean("isAdmin").default(false).notNull(), // Admin access
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Products table - Tier/product definitions with pricing and order bump config
 *
 * Generated from: {{config.tiers.products}}
 */
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  tierKey: varchar("tierKey", { length: 20 }).notNull().unique(), // 'core', 'growth', 'quantum'
  name: varchar("name", { length: 100 }).notNull(), // 'Core Crew'
  description: text("description"), // '6 AI Agents + 60+ Templates'
  priceCents: integer("priceCents").notNull(), // 999
  agentCount: integer("agentCount").notNull(), // 6
  templateCount: integer("templateCount").notNull(), // 60
  features: jsonb("features").notNull().$type<string[]>(), // ['Feature 1', 'Feature 2']
  squareProductId: varchar("squareProductId", { length: 50 }), // 'ZAACC7A'
  squarePaymentLink: varchar("squarePaymentLink", { length: 255 }), // 'https://square.link/...'

  // Order bump configuration (references another tier)
  bumpToTierKey: varchar("bumpToTierKey", { length: 20 }), // 'growth' (references products.tierKey)
  bumpPriceCents: integer("bumpPriceCents"), // 1200 (discounted upgrade price)
  bumpRegularCents: integer("bumpRegularCents"), // 1500 (regular difference)
  bumpSavingsCents: integer("bumpSavingsCents"), // 300

  displayOrder: integer("displayOrder").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

/**
 * Agents table - AI agent definitions with tier assignment
 *
 * Generated from: {{config.agents}}
 */
export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  agentKey: varchar("agentKey", { length: 50 }).notNull().unique(), // 'pixel', 'orion'
  name: varchar("name", { length: 100 }).notNull(), // 'Pixel'
  role: varchar("role", { length: 200 }).notNull(), // 'Social Media Strategist'
  tierKey: varchar("tierKey", { length: 20 }).notNull(), // 'core' (minimum tier to access)

  chatgptUrl: varchar("chatgptUrl", { length: 500 }),
  avatarUrl: varchar("avatarUrl", { length: 500 }),
  personality: text("personality"),
  communicationStyle: text("communicationStyle"),
  signatureQuote: text("signatureQuote"),
  idealFor: jsonb("idealFor").$type<string[]>(), // ['Use case 1', 'Use case 2']
  realWorldUse: text("realWorldUse"),
  valueProposition: text("valueProposition"),

  displayOrder: integer("displayOrder").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

/**
 * Prompt templates - Multi-language prompt templates for agents
 *
 * Language fields generated from: {{config.i18n.supportedLanguages}}
 */
export const promptTemplates = pgTable("prompt_templates", {
  id: serial("id").primaryKey(),
  agentId: varchar("agentId", { length: 50 }).notNull(),
  displayOrder: integer("displayOrder").default(0).notNull(),

  // Multi-language fields - Add more as needed based on config.i18n.supportedLanguages
  titleEn: text("titleEn").notNull(),
  titlePt: text("titlePt"),
  titleEs: text("titleEs"),
  descriptionEn: text("descriptionEn").notNull(),
  descriptionPt: text("descriptionPt"),
  descriptionEs: text("descriptionEs"),
  promptEn: text("promptEn").notNull(),
  promptPt: text("promptPt"),
  promptEs: text("promptEs"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type InsertPromptTemplate = typeof promptTemplates.$inferInsert;

/**
 * Pending checkouts - Payment sessions awaiting completion
 */
export const pendingCheckouts = pgTable("pending_checkouts", {
  id: serial("id").primaryKey(),
  sessionId: varchar("sessionId", { length: 64 }).unique(), // Client-side session ID for safe concurrent checkout lookup
  squareOrderId: varchar("squareOrderId", { length: 64 }).unique(),
  squarePaymentLinkId: varchar("squarePaymentLinkId", { length: 64 }),
  userId: integer("userId").references(() => users.id),
  email: varchar("email", { length: 320 }).notNull(),
  baseTier: tierEnum("baseTier").notNull(),
  finalTier: tierEnum("finalTier").notNull(),
  orderBumpAccepted: boolean("orderBumpAccepted").default(false).notNull(),
  amountCents: integer("amountCents").notNull(),
  status: checkoutStatusEnum("status").default("pending").notNull(),
  idempotencyKey: varchar("idempotencyKey", { length: 64 }).notNull().unique(),
  referralCode: varchar("referralCode", { length: 10 }), // Referral code used for this purchase
  // Currency context for location-based pricing
  countryCode: varchar("countryCode", { length: 2 }), // 'BR', 'US'
  currencyCode: varchar("currencyCode", { length: 3 }).default("USD"), // 'BRL', 'USD'
  displayedPriceCents: integer("displayedPriceCents"), // Price shown to user in their local currency
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type PendingCheckout = typeof pendingCheckouts.$inferSelect;
export type InsertPendingCheckout = typeof pendingCheckouts.$inferInsert;

/**
 * Password reset tokens
 */
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("userId")
    .references(() => users.id)
    .notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// =============================================================================
// REFERRAL SYSTEM TABLES
// =============================================================================

/**
 * Referral codes - One per user
 *
 * Generated from: {{config.referral}}
 */
export const referralCodes = pgTable("referral_codes", {
  id: serial("id").primaryKey(),
  userId: integer("userId")
    .references(() => users.id)
    .notNull()
    .unique(),
  code: varchar("code", { length: 10 }).notNull().unique(), // e.g., "PIXEL7K"
  successfulReferrals: integer("successfulReferrals").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ReferralCode = typeof referralCodes.$inferSelect;
export type InsertReferralCode = typeof referralCodes.$inferInsert;

/**
 * Referrals - Track each referral
 */
export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerUserId: integer("referrerUserId")
    .references(() => users.id)
    .notNull(),
  referredUserId: integer("referredUserId").references(() => users.id),
  referredEmail: varchar("referredEmail", { length: 320 }),
  referralCode: varchar("referralCode", { length: 10 }).notNull(),
  status: referralStatusEnum("status").default("clicked").notNull(), // 'clicked', 'purchased', 'credited', 'revoked'
  purchaseTier: varchar("purchaseTier", { length: 20 }),
  purchaseAmountCents: integer("purchaseAmountCents"),
  clickedAt: timestamp("clickedAt").defaultNow().notNull(),
  purchasedAt: timestamp("purchasedAt"),
  creditedAt: timestamp("creditedAt"),
});

export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = typeof referrals.$inferInsert;

/**
 * Referral rewards - Track milestone achievements
 *
 * Generated from: {{config.referral.milestones}}
 */
export const referralRewards = pgTable("referral_rewards", {
  id: serial("id").primaryKey(),
  userId: integer("userId")
    .references(() => users.id)
    .notNull(),
  milestone: integer("milestone").notNull(), // 5
  fromTier: varchar("fromTier", { length: 20 }).notNull(),
  toTier: varchar("toTier", { length: 20 }).notNull(), // 'growth', 'quantum', 'secret'
  status: rewardStatusEnum("status").default("earned").notNull(), // 'earned', 'applied', 'revoked'
  earnedAt: timestamp("earnedAt").defaultNow().notNull(),
  appliedAt: timestamp("appliedAt"),
});

export type ReferralReward = typeof referralRewards.$inferSelect;
export type InsertReferralReward = typeof referralRewards.$inferInsert;

// =============================================================================
// MULTI-CURRENCY TABLES
// =============================================================================

/**
 * Currencies - Currency metadata for formatting
 *
 * Generated from: {{config.currencies.supported}}
 */
export const currencies = pgTable("currencies", {
  code: varchar("code", { length: 3 }).primaryKey(), // 'USD', 'BRL'
  name: varchar("name", { length: 50 }).notNull(), // 'Brazilian Real'
  symbol: varchar("symbol", { length: 5 }).notNull(), // 'R$'
  symbolPosition: symbolPositionEnum("symbolPosition").default("before"),
  decimalPlaces: integer("decimalPlaces").default(2),
  thousandSeparator: varchar("thousandSeparator", { length: 1 }).default(","),
  decimalSeparator: varchar("decimalSeparator", { length: 1 }).default("."),
  isActive: boolean("isActive").default(true).notNull(),
  isDefault: boolean("isDefault").default(false).notNull(), // Only one currency should be default
});

export type Currency = typeof currencies.$inferSelect;
export type InsertCurrency = typeof currencies.$inferInsert;

/**
 * Country pricing - Country-specific price overrides
 *
 * Generated from: {{config.countryPricing}}
 */
export const countryPricing = pgTable(
  "country_pricing",
  {
    id: serial("id").primaryKey(),
    productId: integer("productId")
      .references(() => products.id)
      .notNull(),
    countryCode: varchar("countryCode", { length: 2 }).notNull(), // 'BR'
    currencyCode: varchar("currencyCode", { length: 3 }).notNull(), // 'BRL'
    priceCents: integer("priceCents").notNull(), // 4990 = R$49.90
    // Order bump pricing for this country
    bumpPriceCents: integer("bumpPriceCents"),
    bumpRegularCents: integer("bumpRegularCents"),
    bumpSavingsCents: integer("bumpSavingsCents"),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    uniqueProductCountry: unique().on(table.productId, table.countryCode),
  })
);

export type CountryPricing = typeof countryPricing.$inferSelect;
export type InsertCountryPricing = typeof countryPricing.$inferInsert;
