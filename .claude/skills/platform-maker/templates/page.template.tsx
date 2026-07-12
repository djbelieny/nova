/**
 * React Page Component Template
 *
 * This template provides patterns for generating React pages.
 * Replace {{PLACEHOLDERS}} with values from platform.config.yaml
 *
 * Patterns included:
 * - Page with authentication check
 * - tRPC data fetching
 * - Localization support
 * - Responsive layout
 * - Loading and error states
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Check, Shield, Lock, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "../lib/trpc";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { LocalizedLink } from "@/components/LocalizedLink";

// =============================================================================
// TYPE DEFINITIONS - Generated from config
// =============================================================================

/**
 * Tier information type
 * Generated from: {{config.tiers.products}}
 */
interface TierInfo {
  name: string;
  price: number;
  agentCount: number;
  features: string[];
  color: string;
}

/**
 * Tier data
 * Generated from: {{config.tiers.products}}
 */
const TIER_INFO: Record<string, TierInfo> = {
  {{#each config.tiers.products}}
  {{tierKey}}: {
    name: "{{name}}",
    price: {{divide priceCents 100}},
    agentCount: {{agentCount}},
    features: [
      {{#each features}}
      "{{this}}",
      {{/each}}
    ],
    color: "{{#if (eq tierKey 'core')}}cyan{{else if (eq tierKey 'growth')}}lime{{else}}orange{{/if}}",
  },
  {{/each}}
};

/**
 * Tier styling
 * Generated from: {{config.brand.colors.tiers}}
 */
const TIER_STYLES: Record<
  string,
  {
    button: string;
    text: string;
    border: string;
    bg: string;
    check: string;
  }
> = {
  {{#each config.tiers.products}}
  {{tierKey}}: {
    button: "bg-gradient-to-r from-{{color}}-500 to-{{color}}-600 hover:from-{{color}}-600 hover:to-{{color}}-700",
    text: "text-{{color}}-400",
    border: "border-{{color}}-500/30",
    bg: "bg-{{color}}-500/5",
    check: "text-{{color}}-400",
  },
  {{/each}}
};

// =============================================================================
// PAGE COMPONENT PATTERN - Public Page
// =============================================================================

/**
 * Public page pattern - no authentication required
 * Use for: Landing pages, pricing, legal pages
 */
export function PublicPageTemplate() {
  const { t } = useTranslation(["common", "home"]);
  const { getLocalizedHref } = useLanguage();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Language Switcher - top right */}
      <div className="absolute top-6 right-6 z-50">
        <LanguageSwitcher />
      </div>

      {/* Page Content */}
      <div className="container max-w-6xl mx-auto px-4 py-20">
        <h1 className="text-4xl md:text-5xl font-bold text-center mb-8">
          {t("home:hero.title")}
        </h1>
        <p className="text-slate-400 text-lg text-center mb-12">
          {t("home:hero.subtitle")}
        </p>

        {/* Content sections */}
      </div>
    </div>
  );
}

// =============================================================================
// PAGE COMPONENT PATTERN - Protected Page
// =============================================================================

/**
 * Protected page pattern - requires authentication
 * Use for: Dashboard, account settings, agent pages
 */
export function ProtectedPageTemplate() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation(["common", "launchpad"]);
  const { getLocalizedHref } = useLanguage();

  // Get current user
  const { data: user, isLoading: authLoading } = trpc.auth.me.useQuery();

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      setLocation(getLocalizedHref("/login"));
    }
  }, [user, authLoading, setLocation, getLocalizedHref]);

  // Loading state
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-500 mx-auto mb-4" />
          <p className="text-slate-400">{t("common:loading.loadingCommandCenter")}</p>
        </div>
      </div>
    );
  }

  // Not authenticated
  if (!user) {
    return null; // Will redirect
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Page Content */}
      <div className="container max-w-6xl mx-auto px-4 py-20">
        <h1 className="text-3xl font-bold mb-8">
          {t("launchpad:welcome", { name: user.name || user.email })}
        </h1>

        {/* User's tier badge */}
        <div className="mb-8">
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${
              TIER_STYLES[user.tier]?.bg || "bg-slate-800"
            } ${TIER_STYLES[user.tier]?.text || "text-slate-400"}`}
          >
            {TIER_INFO[user.tier]?.name || "Free"}
          </span>
        </div>

        {/* Content sections */}
      </div>
    </div>
  );
}

// =============================================================================
// PAGE COMPONENT PATTERN - Data Fetching
// =============================================================================

/**
 * Page with data fetching pattern
 * Use for: Pages that need to load data from the server
 */
export function DataFetchingPageTemplate() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();

  // Fetch products
  const { data: products, isLoading: productsLoading } =
    trpc.products.getAll.useQuery();

  // Fetch agents
  const { data: agents, isLoading: agentsLoading } =
    trpc.agents.getAll.useQuery();

  // Combined loading state
  const isLoading = productsLoading || agentsLoading;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-500 mx-auto mb-4" />
          <p className="text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      <div className="container max-w-6xl mx-auto px-4 py-20">
        {/* Products Grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          {products?.map((product) => (
            <Card
              key={product.tierKey}
              className={`p-6 ${TIER_STYLES[product.tierKey].border} ${
                TIER_STYLES[product.tierKey].bg
              }`}
            >
              <h3
                className={`text-xl font-bold mb-2 ${
                  TIER_STYLES[product.tierKey].text
                }`}
              >
                {product.name}
              </h3>
              <p className="text-3xl font-bold mb-4">{product.priceFormatted}</p>
              <ul className="space-y-2">
                {product.features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <Check
                      className={`w-4 h-4 ${
                        TIER_STYLES[product.tierKey].check
                      } mt-0.5`}
                    />
                    <span className="text-slate-300">{feature}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        {/* Agents Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents?.map((agent) => (
            <Card key={agent.agentKey} className="p-6 bg-slate-800/50">
              <h3 className="text-lg font-bold mb-1">{agent.name}</h3>
              <p className="text-sm text-slate-400 mb-3">{agent.role}</p>
              <p className="text-sm text-slate-300 line-clamp-3">
                {agent.personality}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PAGE COMPONENT PATTERN - Admin Page
// =============================================================================

/**
 * Admin page pattern - requires admin role
 * Use for: Admin dashboard, user management, settings
 */
export function AdminPageTemplate() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const { getLocalizedHref } = useLanguage();

  // Get current user
  const { data: user, isLoading: authLoading } = trpc.auth.me.useQuery();

  // Fetch admin stats (only if admin)
  const { data: stats, isLoading: statsLoading } =
    trpc.admin.dashboardStats.useQuery(undefined, {
      enabled: !!user?.isAdmin,
    });

  // Redirect if not admin
  useEffect(() => {
    if (!authLoading && (!user || !user.isAdmin)) {
      setLocation(getLocalizedHref("/"));
    }
  }, [user, authLoading, setLocation, getLocalizedHref]);

  if (authLoading || statsLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  if (!user?.isAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="container max-w-6xl mx-auto px-4 py-12">
        <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

        {/* Stats Grid */}
        <div className="grid md:grid-cols-4 gap-6 mb-12">
          <Card className="p-6 bg-slate-800/50">
            <p className="text-sm text-slate-400 mb-1">Total Users</p>
            <p className="text-3xl font-bold">{stats?.totalUsers || 0}</p>
          </Card>
          <Card className="p-6 bg-slate-800/50">
            <p className="text-sm text-slate-400 mb-1">Total Revenue</p>
            <p className="text-3xl font-bold">
              ${((stats?.totalRevenue || 0) / 100).toFixed(2)}
            </p>
          </Card>
          {/* More stat cards */}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PAGE COMPONENT PATTERN - Form Submission
// =============================================================================

/**
 * Form submission pattern with mutation
 * Use for: Checkout, account creation, settings updates
 */
export function FormPageTemplate() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const { getLocalizedHref } = useLanguage();

  // Form state
  const [email, setEmail] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  // Mutation
  const submitMutation = trpc.checkout.createCheckout.useMutation({
    onSuccess: (data) => {
      toast.success("Success!");
      // Redirect or update UI
      window.location.href = data.checkoutUrl;
    },
    onError: (error) => {
      toast.error(error.message || "Something went wrong");
      setIsProcessing(false);
    },
  });

  const handleSubmit = () => {
    if (!email) {
      toast.error("Please enter your email");
      return;
    }

    setIsProcessing(true);
    submitMutation.mutate({
      email,
      tier: "core",
      acceptedOrderBump: false,
      sessionId: crypto.randomUUID(),
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <Card className="p-8 w-full max-w-md bg-slate-900/50">
        <h2 className="text-2xl font-bold mb-6">Get Started</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-white"
              disabled={isProcessing}
            />
          </div>

          <Button
            onClick={handleSubmit}
            disabled={!email || isProcessing}
            className="w-full h-12 bg-cyan-500 hover:bg-cyan-600"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="w-5 h-5 ml-2" />
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// =============================================================================
// DEFAULT EXPORT - Main checkout page (most complex example)
// =============================================================================

export default function CheckoutPage() {
  const [location, setLocation] = useLocation();
  const [tier, setTier] = useState<string>("");
  const [email, setEmail] = useState("");
  const [orderBumpAccepted, setOrderBumpAccepted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const { t } = useTranslation(["checkout", "common"]);
  const { getLocalizedHref } = useLanguage();

  // Get current user (for pre-filling email)
  const { data: user } = trpc.auth.me.useQuery();

  // Generate a unique session ID for this checkout
  const [checkoutSessionId] = useState(() => crypto.randomUUID());

  // Create checkout mutation
  const createCheckoutMutation = trpc.checkout.createCheckout.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("pending_checkout_session_id", checkoutSessionId);
      window.location.href = data.checkoutUrl;
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create checkout");
      setIsProcessing(false);
    },
  });

  // Get tier from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tierParam = params.get("tier");
    if (tierParam && TIER_INFO[tierParam]) {
      setTier(tierParam);
    } else {
      setLocation(getLocalizedHref("/#pricing"));
    }
  }, [location, setLocation, getLocalizedHref]);

  // Pre-fill email for logged-in users
  useEffect(() => {
    if (user?.email && !email) {
      setEmail(user.email);
    }
  }, [user, email]);

  const handleProceedToPayment = () => {
    if (!email) {
      toast.error(t("errors.enterEmail"));
      return;
    }

    setIsProcessing(true);
    createCheckoutMutation.mutate({
      tier: tier as "core" | "growth" | "quantum",
      email,
      acceptedOrderBump: orderBumpAccepted,
      sessionId: checkoutSessionId,
    });
  };

  if (!tier || !TIER_INFO[tier]) {
    return null;
  }

  const tierInfo = TIER_INFO[tier];
  const tierStyles = TIER_STYLES[tier];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white py-20 px-4">
      {/* Language Switcher */}
      <div className="absolute top-6 right-6 z-50">
        <LanguageSwitcher />
      </div>

      <div className="container max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            {t("header.title")}
          </h1>
          <p className="text-slate-400 text-lg">{t("header.subtitle")}</p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {/* Order Summary */}
          <Card className="bg-slate-900/50 border-slate-800 p-8">
            <h2 className="text-2xl font-bold mb-6">{t("orderSummary.title")}</h2>

            <div
              className={`border-2 ${tierStyles.border} ${tierStyles.bg} rounded-lg p-6 mb-6`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-2xl font-bold ${tierStyles.text}`}>
                  {tierInfo.name}
                </h3>
                <div className="text-right">
                  <div className="text-3xl font-bold">${tierInfo.price}</div>
                  <div className="text-sm text-slate-400">
                    {t("common:labels.oneTime")}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {tierInfo.features.map((feature, index) => (
                  <div key={index} className="flex items-start gap-2 text-sm">
                    <Check
                      className={`w-4 h-4 ${tierStyles.check} mt-0.5 flex-shrink-0`}
                    />
                    <span className="text-slate-300">{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 text-sm text-slate-400">
              <Shield className="w-5 h-5" />
              <span>{t("trust.securePayment")}</span>
            </div>
          </Card>

          {/* Email Collection */}
          <Card className="bg-slate-900/50 border-slate-800 p-8">
            <h2 className="text-2xl font-bold mb-6">{t("userInfo.title")}</h2>

            <div className="space-y-6">
              {user ? (
                <div className="bg-slate-800/50 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center">
                      <Check className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">
                        {t("userInfo.loggedInAs")}
                      </p>
                      <p className="text-white font-medium">{user.email}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium mb-2">
                    {t("userInfo.emailLabel")}
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("userInfo.emailPlaceholder")}
                    className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-white"
                    disabled={isProcessing}
                  />
                </div>
              )}

              <Button
                onClick={handleProceedToPayment}
                disabled={!email || isProcessing}
                className={`w-full h-14 text-lg font-semibold ${tierStyles.button}`}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    {t("buttons.creatingCheckout")}
                  </>
                ) : (
                  <>
                    <Lock className="w-5 h-5 mr-2" />
                    {t("buttons.proceedToPayment")}
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </>
                )}
              </Button>
            </div>
          </Card>
        </div>

        {/* Trust Badges */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-8 text-slate-400 text-sm">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            <span>{t("trust.ssl")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5" />
            <span>{t("trust.pci")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Check className="w-5 h-5" />
            <span>{t("trust.moneyBack")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
