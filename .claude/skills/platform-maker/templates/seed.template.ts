/**
 * Database Seed Template
 *
 * This template seeds the database with initial data from platform.config.yaml
 * Replace {{PLACEHOLDERS}} with values from the config file.
 *
 * Run with: npx tsx drizzle/seed.ts
 */

import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import pg from "pg";
import Database from "better-sqlite3";
import * as schemaPostgres from "./schema.postgres.js";
import * as schemaSqlite from "./schema.sqlite.js";

// =============================================================================
// SEED DATA - Generated from platform.config.yaml
// =============================================================================

/**
 * Currency seed data
 * Generated from: {{config.currencies.supported}}
 */
const CURRENCIES_SEED = [
  {{#each config.currencies.supported}}
  {
    code: "{{code}}",
    name: "{{name}}",
    symbol: "{{symbol}}",
    symbolPosition: "{{symbolPosition}}" as const,
    decimalPlaces: {{decimalPlaces}},
    thousandSeparator: "{{thousandSeparator}}",
    decimalSeparator: "{{decimalSeparator}}",
    isActive: {{#if isActive}}true{{else}}false{{/if}},
    isDefault: {{#if isDefault}}true{{else}}false{{/if}},
  },
  {{/each}}
];

/**
 * Country pricing seed data
 * Generated from: {{config.countryPricing}}
 */
const COUNTRY_PRICING_SEED = [
  {{#each config.countryPricing}}
  {{#each prices}}
  {
    tierKey: "{{@key}}",
    countryCode: "{{../countryCode}}",
    currencyCode: "{{../currencyCode}}",
    priceCents: {{priceCents}},
    bumpPriceCents: {{#if bumpPriceCents}}{{bumpPriceCents}}{{else}}null{{/if}},
    bumpRegularCents: {{#if bumpRegularCents}}{{bumpRegularCents}}{{else}}null{{/if}},
    bumpSavingsCents: {{#if bumpSavingsCents}}{{bumpSavingsCents}}{{else}}null{{/if}},
  },
  {{/each}}
  {{/each}}
];

/**
 * Product seed data
 * Generated from: {{config.tiers.products}}
 */
const PRODUCTS_SEED = [
  {{#each config.tiers.products}}
  {
    tierKey: "{{tierKey}}",
    name: "{{name}}",
    description: "{{agentCount}} AI Agents + {{templateCount}}+ Advanced Prompt Templates",
    priceCents: {{priceCents}},
    agentCount: {{agentCount}},
    templateCount: {{templateCount}},
    features: [
      {{#each features}}
      "{{this}}",
      {{/each}}
    ],
    squareProductId: {{#if squareProductId}}"{{squareProductId}}"{{else}}null{{/if}},
    squarePaymentLink: {{#if squarePaymentLink}}"{{squarePaymentLink}}"{{else}}null{{/if}},
    {{#if orderBump.enabled}}
    bumpToTierKey: "{{orderBump.targetTier}}",
    bumpPriceCents: {{orderBump.discountCents}}, // Calculated: (targetTier.price - this.price) - discountCents
    bumpRegularCents: null, // Set by seed logic
    bumpSavingsCents: {{orderBump.discountCents}},
    {{else}}
    bumpToTierKey: null,
    bumpPriceCents: null,
    bumpRegularCents: null,
    bumpSavingsCents: null,
    {{/if}}
    displayOrder: {{displayOrder}},
    isActive: {{#if isActive}}true{{else}}false{{/if}},
  },
  {{/each}}
];

/**
 * Agent seed data
 * Generated from: {{config.agents}}
 */
const AGENTS_SEED = [
  {{#each config.agents}}
  {
    agentKey: "{{agentKey}}",
    name: "{{name}}",
    role: "{{role}}",
    tierKey: "{{tierKey}}",
    chatgptUrl: {{#if chatgptUrl}}"{{chatgptUrl}}"{{else}}null{{/if}},
    avatarUrl: {{#if avatarUrl}}"{{avatarUrl}}"{{else}}null{{/if}},
    personality: `{{personality}}`,
    communicationStyle: {{#if communicationStyle}}"{{communicationStyle}}"{{else}}null{{/if}},
    signatureQuote: {{#if signatureQuote}}"{{signatureQuote}}"{{else}}null{{/if}},
    idealFor: [
      {{#each idealFor}}
      "{{this}}",
      {{/each}}
    ],
    realWorldUse: {{#if realWorldUse}}"{{realWorldUse}}"{{else}}null{{/if}},
    valueProposition: {{#if valueProposition}}"{{valueProposition}}"{{else}}null{{/if}},
    displayOrder: {{displayOrder}},
    isActive: {{#if isActive}}true{{else}}false{{/if}},
  },
  {{/each}}
];

/**
 * Prompt template seed data
 * Generated from agent prompts in config.agents[].prompts
 */
const PROMPTS_SEED = [
  {{#each config.agents}}
  {{#each prompts}}
  {
    agentId: "{{../agentKey}}",
    displayOrder: {{displayOrder}},
    titleEn: "{{title.en}}",
    titlePt: {{#if title.pt}}"{{title.pt}}"{{else}}null{{/if}},
    titleEs: {{#if title.es}}"{{title.es}}"{{else}}null{{/if}},
    descriptionEn: "{{description.en}}",
    descriptionPt: {{#if description.pt}}"{{description.pt}}"{{else}}null{{/if}},
    descriptionEs: {{#if description.es}}"{{description.es}}"{{else}}null{{/if}},
    promptEn: `{{prompt.en}}`,
    promptPt: {{#if prompt.pt}}`{{prompt.pt}}`{{else}}null{{/if}},
    promptEs: {{#if prompt.es}}`{{prompt.es}}`{{else}}null{{/if}},
  },
  {{/each}}
  {{/each}}
];

// =============================================================================
// SEED FUNCTION
// =============================================================================

async function seed() {
  console.log("Starting database seed...");
  console.log("Platform: {{config.brand.name}}");

  let db: any;

  // Environment-aware database connection
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required in production");
      process.exit(1);
    }
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzlePg(pool, { schema: schemaPostgres });
  } else {
    const dbPath = process.env.DATABASE_URL || "local.db";
    const cleanPath = dbPath.replace(/^file:/, "");
    const sqlite = new Database(cleanPath);
    db = drizzleSqlite(sqlite, { schema: schemaSqlite });
  }

  // Get the correct tables based on environment
  const productsTable =
    process.env.NODE_ENV === "production"
      ? schemaPostgres.products
      : schemaSqlite.products;
  const agentsTable =
    process.env.NODE_ENV === "production"
      ? schemaPostgres.agents
      : schemaSqlite.agents;
  const currenciesTable =
    process.env.NODE_ENV === "production"
      ? schemaPostgres.currencies
      : schemaSqlite.currencies;
  const countryPricingTable =
    process.env.NODE_ENV === "production"
      ? schemaPostgres.countryPricing
      : schemaSqlite.countryPricing;
  const promptTemplatesTable =
    process.env.NODE_ENV === "production"
      ? schemaPostgres.promptTemplates
      : schemaSqlite.promptTemplates;

  try {
    // ==========================================================================
    // SEED PRODUCTS
    // ==========================================================================
    console.log("\nSeeding products...");
    for (const product of PRODUCTS_SEED) {
      await db
        .insert(productsTable)
        .values(product)
        .onConflictDoUpdate({
          target: productsTable.tierKey,
          set: {
            name: product.name,
            description: product.description,
            priceCents: product.priceCents,
            agentCount: product.agentCount,
            templateCount: product.templateCount,
            features: product.features,
            squareProductId: product.squareProductId,
            squarePaymentLink: product.squarePaymentLink,
            bumpToTierKey: product.bumpToTierKey,
            bumpPriceCents: product.bumpPriceCents,
            bumpRegularCents: product.bumpRegularCents,
            bumpSavingsCents: product.bumpSavingsCents,
            displayOrder: product.displayOrder,
          },
        });
      console.log(`  + ${product.name} (${product.tierKey})`);
    }

    // ==========================================================================
    // SEED AGENTS
    // ==========================================================================
    console.log("\nSeeding agents...");
    for (const agent of AGENTS_SEED) {
      await db
        .insert(agentsTable)
        .values(agent)
        .onConflictDoUpdate({
          target: agentsTable.agentKey,
          set: {
            name: agent.name,
            role: agent.role,
            tierKey: agent.tierKey,
            chatgptUrl: agent.chatgptUrl,
            personality: agent.personality,
            communicationStyle: agent.communicationStyle,
            signatureQuote: agent.signatureQuote,
            idealFor: agent.idealFor,
            realWorldUse: agent.realWorldUse,
            valueProposition: agent.valueProposition,
            displayOrder: agent.displayOrder,
          },
        });
      console.log(`  + ${agent.name} (${agent.tierKey})`);
    }

    // ==========================================================================
    // SEED CURRENCIES
    // ==========================================================================
    console.log("\nSeeding currencies...");
    for (const currency of CURRENCIES_SEED) {
      await db
        .insert(currenciesTable)
        .values(currency)
        .onConflictDoUpdate({
          target: currenciesTable.code,
          set: {
            name: currency.name,
            symbol: currency.symbol,
            symbolPosition: currency.symbolPosition,
            decimalPlaces: currency.decimalPlaces,
            thousandSeparator: currency.thousandSeparator,
            decimalSeparator: currency.decimalSeparator,
            isActive: currency.isActive,
            isDefault: currency.isDefault,
          },
        });
      console.log(`  + ${currency.name} (${currency.code})`);
    }

    // ==========================================================================
    // SEED COUNTRY PRICING
    // ==========================================================================
    console.log("\nSeeding country pricing...");
    for (const pricing of COUNTRY_PRICING_SEED) {
      // Find the product ID for this tier
      const products = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.tierKey, pricing.tierKey))
        .limit(1);

      const product = products[0];
      if (!product) {
        console.log(`  ! Product not found for tier: ${pricing.tierKey}`);
        continue;
      }

      await db
        .insert(countryPricingTable)
        .values({
          productId: product.id,
          countryCode: pricing.countryCode,
          currencyCode: pricing.currencyCode,
          priceCents: pricing.priceCents,
          bumpPriceCents: pricing.bumpPriceCents,
          bumpRegularCents: pricing.bumpRegularCents,
          bumpSavingsCents: pricing.bumpSavingsCents,
        })
        .onConflictDoUpdate({
          target: [countryPricingTable.productId, countryPricingTable.countryCode],
          set: {
            currencyCode: pricing.currencyCode,
            priceCents: pricing.priceCents,
            bumpPriceCents: pricing.bumpPriceCents,
            bumpRegularCents: pricing.bumpRegularCents,
            bumpSavingsCents: pricing.bumpSavingsCents,
          },
        });
      console.log(`  + ${pricing.tierKey} - ${pricing.countryCode} (${pricing.currencyCode})`);
    }

    // ==========================================================================
    // SEED PROMPT TEMPLATES
    // ==========================================================================
    console.log("\nSeeding prompt templates...");
    for (const prompt of PROMPTS_SEED) {
      // Use upsert to handle existing prompts
      const existing = await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.agentId, prompt.agentId))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(promptTemplatesTable).values(prompt);
        console.log(`  + ${prompt.titleEn} (${prompt.agentId})`);
      } else {
        console.log(`  ~ ${prompt.titleEn} (${prompt.agentId}) - already exists`);
      }
    }

    // ==========================================================================
    // SUMMARY
    // ==========================================================================
    console.log("\n========================================");
    console.log(" Seed completed successfully!");
    console.log("========================================");
    console.log(`  Products: ${PRODUCTS_SEED.length}`);
    console.log(`  Agents: ${AGENTS_SEED.length}`);
    console.log(`  Currencies: ${CURRENCIES_SEED.length}`);
    console.log(`  Country Pricing: ${COUNTRY_PRICING_SEED.length}`);
    console.log(`  Prompt Templates: ${PROMPTS_SEED.length}`);
    console.log("========================================\n");
  } catch (error) {
    console.error("\nSeed failed:", error);
    process.exit(1);
  }

  process.exit(0);
}

seed();
