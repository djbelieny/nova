/**
 * tRPC Router Template
 *
 * This template defines the main router structure for the generated platform.
 * Replace {{PLACEHOLDERS}} with values from platform.config.yaml
 *
 * Router structure:
 * - system: Health checks and version info
 * - auth: Authentication (login, logout, password reset)
 * - products: Product/tier queries
 * - agents: Agent catalog queries
 * - prompts: Prompt template queries
 * - tier: User tier management
 * - checkout: Payment flow
 * - payment: Square webhooks
 * - referral: Referral system
 * - pricing: Localized pricing
 * - admin: Admin dashboard
 */

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { getDb, upsertUser } from "./db";
import { users, promptTemplates } from "../drizzle/schema";
import { eq, asc, and, gt } from "drizzle-orm";
import { squarePaymentRouter } from "./payment/squarePayment.js";
import { checkoutRouter } from "./square/checkout.js";
import { sdk } from "./_core/sdk";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { sendPasswordResetEmail } from "./email/index.js";
import {
  getProduct,
  getAllProducts,
  formatPrice,
  type TierKey,
} from "./db/products.js";
import {
  getAgent,
  getAgentsForTier,
  getAllAgents,
  checkAgentAccess,
} from "./db/agents.js";
import { referralRouter } from "./routers/referral.js";
import { adminRouter } from "./routers/admin.js";
import { pricingRouter } from "./routers/pricing.js";

// =============================================================================
// TIER HIERARCHY - Generated from config.tiers.hierarchy
// =============================================================================

/**
 * Tier hierarchy for access control
 * Generated from: {{config.tiers.hierarchy}}
 */
const TIER_HIERARCHY: Record<string, number> = {
  {{#each config.tiers.hierarchy}}
  "{{this}}": {{@index}},
  {{/each}}
};

/**
 * Tier keys for validation
 */
const TIER_KEYS = [
  {{#each config.tiers.hierarchy}}
  "{{this}}",
  {{/each}}
] as const;

type TierKeyType = (typeof TIER_KEYS)[number];

// =============================================================================
// MAIN APP ROUTER
// =============================================================================

export const appRouter = router({
  // ---------------------------------------------------------------------------
  // IMPORTED ROUTERS
  // ---------------------------------------------------------------------------

  /** System health and version info */
  system: systemRouter,

  /** Square payment processing */
  payment: squarePaymentRouter,

  /** Checkout flow */
  checkout: checkoutRouter,

  /** Referral system */
  referral: referralRouter,

  /** Admin dashboard */
  admin: adminRouter,

  /** Localized pricing */
  pricing: pricingRouter,

  // ---------------------------------------------------------------------------
  // PRODUCTS ROUTER - Fetch product/tier information
  // ---------------------------------------------------------------------------

  products: router({
    /**
     * Get all active products
     */
    getAll: publicProcedure.query(async () => {
      const productsList = await getAllProducts();
      return productsList.map((p) => ({
        tierKey: p.tierKey,
        name: p.name,
        description: p.description,
        priceCents: p.priceCents,
        priceFormatted: formatPrice(p.priceCents),
        agentCount: p.agentCount,
        templateCount: p.templateCount,
        features: p.features as string[],
        displayOrder: p.displayOrder,
      }));
    }),

    /**
     * Get a single product by tier key
     */
    getByTier: publicProcedure
      .input(
        z.object({
          tier: z.enum([
            {{#each config.tiers.products}}
            "{{tierKey}}",
            {{/each}}
          ]),
        })
      )
      .query(async ({ input }) => {
        const product = await getProduct(input.tier);
        if (!product) return null;

        return {
          tierKey: product.tierKey,
          name: product.name,
          description: product.description,
          priceCents: product.priceCents,
          priceFormatted: formatPrice(product.priceCents),
          agentCount: product.agentCount,
          templateCount: product.templateCount,
          features: product.features as string[],
          displayOrder: product.displayOrder,
        };
      }),
  }),

  // ---------------------------------------------------------------------------
  // AGENTS ROUTER - Fetch agent information
  // ---------------------------------------------------------------------------

  agents: router({
    /**
     * Get all active agents
     */
    getAll: publicProcedure.query(async () => {
      const agentsList = await getAllAgents();
      return agentsList.map((a) => ({
        agentKey: a.agentKey,
        name: a.name,
        role: a.role,
        tierKey: a.tierKey,
        chatgptUrl: a.chatgptUrl,
        personality: a.personality,
        communicationStyle: a.communicationStyle,
        signatureQuote: a.signatureQuote,
        idealFor: a.idealFor as string[] | null,
        realWorldUse: a.realWorldUse,
        valueProposition: a.valueProposition,
        displayOrder: a.displayOrder,
      }));
    }),

    /**
     * Get a single agent by key
     */
    getByKey: publicProcedure
      .input(
        z.object({
          agentKey: z.string(),
        })
      )
      .query(async ({ input }) => {
        const agent = await getAgent(input.agentKey);
        if (!agent) return null;

        return {
          agentKey: agent.agentKey,
          name: agent.name,
          role: agent.role,
          tierKey: agent.tierKey,
          chatgptUrl: agent.chatgptUrl,
          personality: agent.personality,
          communicationStyle: agent.communicationStyle,
          signatureQuote: agent.signatureQuote,
          idealFor: agent.idealFor as string[] | null,
          realWorldUse: agent.realWorldUse,
          valueProposition: agent.valueProposition,
          displayOrder: agent.displayOrder,
        };
      }),

    /**
     * Get agents accessible to the current user's tier
     */
    getForUserTier: protectedProcedure.query(async ({ ctx }) => {
      const userTier = ctx.user.tier;
      if (userTier === "none") {
        return [];
      }

      const agentsList = await getAgentsForTier(userTier as TierKey);
      return agentsList.map((a) => ({
        agentKey: a.agentKey,
        name: a.name,
        role: a.role,
        tierKey: a.tierKey,
        chatgptUrl: a.chatgptUrl,
        personality: a.personality,
        communicationStyle: a.communicationStyle,
        signatureQuote: a.signatureQuote,
        idealFor: a.idealFor as string[] | null,
        realWorldUse: a.realWorldUse,
        valueProposition: a.valueProposition,
        displayOrder: a.displayOrder,
      }));
    }),

    /**
     * Check if user has access to a specific agent
     */
    checkAccess: protectedProcedure
      .input(
        z.object({
          agentKey: z.string(),
        })
      )
      .query(async ({ input, ctx }) => {
        const userTier = ctx.user.tier;
        const hasAccess = await checkAgentAccess(
          userTier as TierKey | "none",
          input.agentKey
        );
        const agent = await getAgent(input.agentKey);

        return {
          hasAccess,
          userTier,
          requiredTier: agent?.tierKey || null,
        };
      }),
  }),

  // ---------------------------------------------------------------------------
  // PROMPTS ROUTER - Fetch prompt templates
  // ---------------------------------------------------------------------------

  prompts: router({
    /**
     * Get prompts for an agent with language support
     * Generated from: {{config.i18n.supportedLanguages}}
     */
    getByAgent: publicProcedure
      .input(
        z.object({
          agentId: z.string(),
          lang: z
            .enum([
              {{#each config.i18n.supportedLanguages}}
              "{{code}}",
              {{/each}}
            ])
            .default("{{config.i18n.defaultLanguage}}"),
        })
      )
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Database not available",
          });

        const promptsTable =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).promptTemplates
            : (await import("../drizzle/schema.sqlite")).promptTemplates;

        // @ts-ignore
        const prompts = await db
          .select()
          .from(promptsTable)
          .where(eq(promptsTable.agentId, input.agentId))
          .orderBy(asc(promptsTable.displayOrder));

        // Return prompts with the requested language, falling back to English
        return prompts.map((p: any) => {
          let title = p.titleEn;
          let description = p.descriptionEn;
          let prompt = p.promptEn;

          // Language fallback logic - add more languages as needed
          {{#each config.i18n.supportedLanguages}}
          {{#unless (eq code "en")}}
          if (input.lang === "{{code}}") {
            title = p.title{{capitalize code}} || p.titleEn;
            description = p.description{{capitalize code}} || p.descriptionEn;
            prompt = p.prompt{{capitalize code}} || p.promptEn;
          }
          {{/unless}}
          {{/each}}

          return {
            id: p.id,
            agentId: p.agentId,
            title,
            description,
            prompt,
          };
        });
      }),
  }),

  // ---------------------------------------------------------------------------
  // AUTH ROUTER - Authentication
  // ---------------------------------------------------------------------------

  auth: router({
    /**
     * Get current user
     */
    me: publicProcedure.query((opts) => opts.ctx.user),

    /**
     * Logout - clear session cookie
     */
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    /**
     * Login with email and password
     */
    login: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          password: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const table =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).users
            : (await import("../drizzle/schema.sqlite")).users;

        // @ts-ignore
        const usersFound = await db
          .select()
          .from(table)
          .where(eq(table.email, input.email))
          .limit(1);
        const user = usersFound[0];

        if (!user || !user.password) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password",
          });
        }

        const isValid = await bcrypt.compare(input.password, user.password);
        if (!isValid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password",
          });
        }

        // Create session
        const sessionToken = await sdk.createSessionToken(user.openId, {
          name: user.name || "",
          expiresInMs: ONE_YEAR_MS,
        });

        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });

        return { success: true };
      }),

    /**
     * Create account from Square purchase
     */
    createAccountFromPurchase: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          password: z.string().min(8),
          tier: z.enum([
            {{#each config.tiers.products}}
            "{{tierKey}}",
            {{/each}}
          ]),
          productId: z.string(),
          transactionId: z.string().optional(),
          orderId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // Generate unique openId for this email-based user
        const openId = `square_${crypto
          .createHash("sha256")
          .update(input.email)
          .digest("hex")
          .substring(0, 16)}`;
        const name = input.email.split("@")[0];

        // Hash the provided password
        const hashedPassword = await bcrypt.hash(input.password, 10);

        await upsertUser({
          openId,
          email: input.email,
          name,
          loginMethod: "square_purchase",
          lastSignedIn: new Date(),
          password: hashedPassword,
        });

        // Update tier
        await db
          .update(users)
          .set({ tier: input.tier })
          .where(eq(users.openId, openId));

        // Create session token and set cookie (Auto-login after purchase)
        const sessionToken = await sdk.createSessionToken(openId, {
          name,
          expiresInMs: ONE_YEAR_MS,
        });

        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });

        return {
          success: true,
          email: input.email,
          tier: input.tier,
        };
      }),

    /**
     * Request password reset
     */
    forgotPassword: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
        })
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const table =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).users
            : (await import("../drizzle/schema.sqlite")).users;

        const passwordResetTokensTable =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).passwordResetTokens
            : (await import("../drizzle/schema.sqlite")).passwordResetTokens;

        // @ts-ignore
        const usersFound = await db
          .select()
          .from(table)
          .where(eq(table.email, input.email))
          .limit(1);
        const user = usersFound[0];

        // Always return success to prevent email enumeration
        if (!user) {
          console.log("[Auth] Password reset requested for non-existent email");
          return { success: true };
        }

        // Generate secure random token
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Store reset token
        // @ts-ignore
        await db.insert(passwordResetTokensTable).values({
          userId: user.id,
          token,
          expiresAt,
        });

        // Send reset email
        await sendPasswordResetEmail({
          to: user.email!,
          name: user.name || user.email!.split("@")[0],
          resetToken: token,
        });

        console.log("[Auth] Password reset email sent to:", user.email);
        return { success: true };
      }),

    /**
     * Reset password with token
     */
    resetPassword: publicProcedure
      .input(
        z.object({
          token: z.string(),
          password: z.string().min(8),
        })
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const table =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).users
            : (await import("../drizzle/schema.sqlite")).users;

        const passwordResetTokensTable =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).passwordResetTokens
            : (await import("../drizzle/schema.sqlite")).passwordResetTokens;

        // @ts-ignore
        const tokensFound = await db
          .select()
          .from(passwordResetTokensTable)
          .where(
            and(
              eq(passwordResetTokensTable.token, input.token),
              gt(passwordResetTokensTable.expiresAt, new Date())
            )
          )
          .limit(1);

        const resetToken = tokensFound[0];

        if (!resetToken) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid or expired reset token",
          });
        }

        if (resetToken.usedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This reset link has already been used",
          });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(input.password, 10);

        // Update user password
        // @ts-ignore
        await db
          .update(table)
          .set({ password: hashedPassword, updatedAt: new Date() })
          .where(eq(table.id, resetToken.userId));

        // Mark token as used
        // @ts-ignore
        await db
          .update(passwordResetTokensTable)
          .set({ usedAt: new Date() })
          .where(eq(passwordResetTokensTable.id, resetToken.id));

        console.log(
          "[Auth] Password reset successful for userId:",
          resetToken.userId
        );
        return { success: true };
      }),
  }),

  // ---------------------------------------------------------------------------
  // TIER ROUTER - User tier management
  // ---------------------------------------------------------------------------

  tier: router({
    /**
     * Get current user's tier
     */
    getUserTier: protectedProcedure.query(async ({ ctx }) => {
      return {
        tier: ctx.user.tier,
        userId: ctx.user.id,
      };
    }),

    /**
     * Complete purchase for logged-in user (fallback when webhook doesn't fire)
     */
    completePurchase: protectedProcedure
      .input(
        z.object({
          sessionId: z.string().uuid(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        const pendingCheckoutsTable =
          process.env.NODE_ENV === "production"
            ? (await import("../drizzle/schema.postgres")).pendingCheckouts
            : (await import("../drizzle/schema.sqlite")).pendingCheckouts;

        // @ts-ignore
        const checkouts = await db
          .select()
          .from(pendingCheckoutsTable)
          .where(eq(pendingCheckoutsTable.sessionId, input.sessionId))
          .limit(1);
        const checkout = checkouts[0];

        if (!checkout) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Checkout session not found",
          });
        }

        // Verify the checkout belongs to this user
        if (checkout.userId && checkout.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Checkout does not belong to this user",
          });
        }

        // Update user's tier to the purchased tier
        const finalTier = checkout.finalTier as TierKeyType;
        await db
          .update(users)
          .set({ tier: finalTier, updatedAt: new Date() })
          .where(eq(users.id, ctx.user.id));

        // Mark checkout as completed
        // @ts-ignore
        await db
          .update(pendingCheckoutsTable)
          .set({ status: "completed", updatedAt: new Date() })
          // @ts-ignore
          .where(eq(pendingCheckoutsTable.id, checkout.id));

        console.log(
          `[Tier] Completed purchase for user ${ctx.user.id}, tier: ${finalTier}`
        );

        return { success: true, tier: finalTier };
      }),

    /**
     * Update user tier
     */
    updateTier: protectedProcedure
      .input(
        z.object({
          tier: z.enum([
            {{#each config.tiers.hierarchy}}
            "{{this}}",
            {{/each}}
          ]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        await db
          .update(users)
          .set({ tier: input.tier })
          .where(eq(users.id, ctx.user.id));

        return { success: true, tier: input.tier };
      }),

    /**
     * Check if user has access to a specific agent tier
     */
    checkAgentAccess: protectedProcedure
      .input(
        z.object({
          agentTier: z.enum([
            {{#each config.tiers.products}}
            "{{tierKey}}",
            {{/each}}
          ]),
        })
      )
      .query(async ({ ctx, input }) => {
        const userTier = ctx.user.tier;
        const hasAccess =
          TIER_HIERARCHY[userTier] >= TIER_HIERARCHY[input.agentTier];

        return {
          hasAccess,
          userTier,
          requiredTier: input.agentTier,
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
