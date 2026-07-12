/**
 * Meta Ads API Module for Nova
 *
 * Provides programmatic access to Facebook/Instagram ad management:
 * - Campaign, ad set, and ad CRUD
 * - Audience management (custom + lookalike)
 * - Performance insights and reporting
 * - Creative upload
 *
 * All monetary values are in cents (Meta API standard).
 * e.g., $50/day = 5000
 */

const META_API_VERSION = "v21.0";
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || "";

// ─── Helpers ───────────────────────────────────────────────

async function metaGet(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("access_token", ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Meta API Error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function metaPost(endpoint: string, body: Record<string, any> = {}): Promise<any> {
  const url = `${BASE_URL}/${endpoint}`;
  const form = new URLSearchParams();
  form.set("access_token", ACCESS_TOKEN);
  for (const [k, v] of Object.entries(body)) {
    form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API Error: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function metaDelete(endpoint: string): Promise<any> {
  const url = `${BASE_URL}/${endpoint}?access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url, { method: "DELETE" });
  return res.json();
}

// ─── Account ───────────────────────────────────────────────

export async function getAdAccount() {
  return metaGet(AD_ACCOUNT_ID, {
    fields: "name,account_status,amount_spent,balance,currency,timezone_name,business_name",
  });
}

// ─── Campaigns ─────────────────────────────────────────────

export type CampaignObjective =
  | "OUTCOME_AWARENESS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_APP_PROMOTION"
  | "OUTCOME_SALES";

export interface CreateCampaignParams {
  name: string;
  objective: CampaignObjective;
  status?: "ACTIVE" | "PAUSED";
  daily_budget?: number; // cents — only if using CBO
  lifetime_budget?: number; // cents — only if using CBO
  special_ad_categories?: string[]; // CREDIT, EMPLOYMENT, HOUSING, ISSUES_ELECTIONS_POLITICS
}

export async function createCampaign(params: CreateCampaignParams) {
  return metaPost(`${AD_ACCOUNT_ID}/campaigns`, {
    name: params.name,
    objective: params.objective,
    status: params.status || "PAUSED",
    special_ad_categories: params.special_ad_categories || [],
    ...(params.daily_budget ? { daily_budget: params.daily_budget } : {}),
    ...(params.lifetime_budget ? { lifetime_budget: params.lifetime_budget } : {}),
  });
}

export async function getCampaigns(status?: string) {
  const params: Record<string, string> = {
    fields: "name,status,objective,daily_budget,lifetime_budget,created_time,updated_time",
    limit: "50",
  };
  if (status) params.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]);
  return metaGet(`${AD_ACCOUNT_ID}/campaigns`, params);
}

export async function updateCampaign(campaignId: string, updates: Record<string, any>) {
  return metaPost(campaignId, updates);
}

export async function deleteCampaign(campaignId: string) {
  return metaDelete(campaignId);
}

// ─── Ad Sets ───────────────────────────────────────────────

export interface Targeting {
  geo_locations?: { countries?: string[]; cities?: { key: string }[]; zips?: { key: string }[] };
  age_min?: number;
  age_max?: number;
  genders?: number[]; // 0=all, 1=male, 2=female
  interests?: { id: string; name: string }[];
  behaviors?: { id: string; name: string }[];
  custom_audiences?: { id: string }[];
  excluded_custom_audiences?: { id: string }[];
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
}

export interface CreateAdSetParams {
  name: string;
  campaign_id: string;
  daily_budget?: number; // cents
  lifetime_budget?: number; // cents
  bid_amount?: number; // cents — manual bid
  billing_event: "IMPRESSIONS" | "LINK_CLICKS" | "APP_INSTALLS";
  optimization_goal:
    | "REACH"
    | "IMPRESSIONS"
    | "LINK_CLICKS"
    | "LANDING_PAGE_VIEWS"
    | "CONVERSATIONS"
    | "LEAD_GENERATION"
    | "OFFSITE_CONVERSIONS"
    | "APP_INSTALLS";
  targeting: Targeting;
  status?: "ACTIVE" | "PAUSED";
  start_time?: string; // ISO 8601
  end_time?: string; // ISO 8601
  promoted_object?: { page_id?: string; pixel_id?: string; custom_event_type?: string };
}

export async function createAdSet(params: CreateAdSetParams) {
  return metaPost(`${AD_ACCOUNT_ID}/adsets`, {
    ...params,
    status: params.status || "PAUSED",
  });
}

export async function getAdSets(campaignId?: string) {
  const endpoint = campaignId ? `${campaignId}/adsets` : `${AD_ACCOUNT_ID}/adsets`;
  return metaGet(endpoint, {
    fields: "name,status,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,start_time,end_time",
    limit: "50",
  });
}

export async function updateAdSet(adSetId: string, updates: Record<string, any>) {
  return metaPost(adSetId, updates);
}

// ─── Ads ───────────────────────────────────────────────────

export interface CreateAdParams {
  name: string;
  adset_id: string;
  creative: { creative_id: string } | { object_story_spec: any };
  status?: "ACTIVE" | "PAUSED";
  tracking_specs?: any[];
}

export async function createAd(params: CreateAdParams) {
  return metaPost(`${AD_ACCOUNT_ID}/ads`, {
    ...params,
    status: params.status || "PAUSED",
  });
}

export async function getAds(adSetId?: string) {
  const endpoint = adSetId ? `${adSetId}/ads` : `${AD_ACCOUNT_ID}/ads`;
  return metaGet(endpoint, {
    fields: "name,status,creative{id,name,thumbnail_url,body,title,link_url},created_time",
    limit: "50",
  });
}

export async function updateAd(adId: string, updates: Record<string, any>) {
  return metaPost(adId, updates);
}

// ─── Ad Creatives ──────────────────────────────────────────

export interface CreateCreativeParams {
  name: string;
  object_story_spec: {
    page_id: string;
    link_data?: {
      link: string;
      message: string;
      name?: string; // headline
      description?: string;
      call_to_action?: { type: string; value?: { link: string } };
      image_hash?: string;
    };
    video_data?: {
      video_id: string;
      message: string;
      title?: string;
      call_to_action?: { type: string; value?: { link: string } };
      image_hash?: string; // thumbnail
    };
  };
}

export async function createCreative(params: CreateCreativeParams) {
  return metaPost(`${AD_ACCOUNT_ID}/adcreatives`, params);
}

export async function uploadImage(imageUrl: string, name?: string) {
  return metaPost(`${AD_ACCOUNT_ID}/adimages`, {
    url: imageUrl,
    name: name || "nova-upload",
  });
}

// ─── Audiences ─────────────────────────────────────────────

export async function getCustomAudiences() {
  return metaGet(`${AD_ACCOUNT_ID}/customaudiences`, {
    fields: "name,subtype,approximate_count,delivery_status,data_source",
    limit: "50",
  });
}

export async function createCustomAudience(params: {
  name: string;
  subtype: "CUSTOM" | "WEBSITE" | "ENGAGEMENT" | "LOOKALIKE";
  description?: string;
  customer_file_source?: "USER_PROVIDED_ONLY" | "PARTNER_PROVIDED_ONLY" | "BOTH_USER_AND_PARTNER_PROVIDED";
  rule?: any; // for website/engagement audiences
}) {
  return metaPost(`${AD_ACCOUNT_ID}/customaudiences`, params);
}

export async function createLookalikeAudience(params: {
  name: string;
  origin_audience_id: string;
  lookalike_spec: {
    country: string; // ISO country code
    ratio: number; // 0.01 to 0.20 (1% to 20%)
    type: "similarity" | "reach";
  };
}) {
  return metaPost(`${AD_ACCOUNT_ID}/customaudiences`, {
    name: params.name,
    subtype: "LOOKALIKE",
    origin_audience_id: params.origin_audience_id,
    lookalike_spec: params.lookalike_spec,
  });
}

// ─── Interest Search (for targeting) ───────────────────────

export async function searchInterests(query: string) {
  return metaGet("search", {
    type: "adinterest",
    q: query,
    limit: "20",
  });
}

export async function searchLocations(query: string, type: "city" | "zip" | "country" | "region" = "city") {
  return metaGet("search", {
    type: `ad${type === "country" ? "country" : type === "region" ? "region" : type === "zip" ? "adzip" : "city"}`,
    q: query,
    limit: "20",
  });
}

// ─── Insights (Reporting) ──────────────────────────────────

export type InsightsLevel = "account" | "campaign" | "adset" | "ad";
export type DatePreset =
  | "today"
  | "yesterday"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_7d"
  | "last_14d"
  | "last_30d"
  | "last_90d";

export interface InsightsParams {
  level?: InsightsLevel;
  date_preset?: DatePreset;
  time_range?: { since: string; until: string }; // YYYY-MM-DD
  fields?: string;
  breakdowns?: string; // age, gender, country, placement, etc.
  filtering?: any[];
  limit?: number;
}

export async function getInsights(objectId?: string, params: InsightsParams = {}) {
  const id = objectId || AD_ACCOUNT_ID;
  const fields =
    params.fields ||
    "campaign_name,adset_name,ad_name,impressions,reach,clicks,cpc,cpm,ctr,spend,actions,cost_per_action_type,frequency,conversions,cost_per_conversion";

  const queryParams: Record<string, string> = {
    fields,
    limit: String(params.limit || 50),
  };

  if (params.level) queryParams.level = params.level;
  if (params.date_preset) queryParams.date_preset = params.date_preset;
  if (params.time_range) queryParams.time_range = JSON.stringify(params.time_range);
  if (params.breakdowns) queryParams.breakdowns = params.breakdowns;
  if (params.filtering) queryParams.filtering = JSON.stringify(params.filtering);

  return metaGet(`${id}/insights`, queryParams);
}

export async function getAccountInsights(datePreset: DatePreset = "last_7d") {
  return getInsights(AD_ACCOUNT_ID, {
    date_preset: datePreset,
    fields: "impressions,reach,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type,frequency",
  });
}

export async function getCampaignInsights(campaignId: string, datePreset: DatePreset = "last_7d") {
  return getInsights(campaignId, { date_preset: datePreset });
}

// ─── Pages (needed for ad creatives) ───────────────────────

export async function getPages() {
  return metaGet("me/accounts", {
    fields: "name,id,access_token,category,fan_count",
  });
}

// ─── Token Info ────────────────────────────────────────────

export async function debugToken() {
  return metaGet("debug_token", {
    input_token: ACCESS_TOKEN,
  });
}

export async function exchangeForLongLivedToken() {
  return metaGet("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID || "",
    client_secret: process.env.META_APP_SECRET || "",
    fb_exchange_token: ACCESS_TOKEN,
  });
}

// ─── CLI for quick testing ─────────────────────────────────

if (import.meta.main) {
  const cmd = process.argv[2];

  const commands: Record<string, () => Promise<void>> = {
    account: async () => console.log(JSON.stringify(await getAdAccount(), null, 2)),
    campaigns: async () => console.log(JSON.stringify(await getCampaigns(), null, 2)),
    adsets: async () => console.log(JSON.stringify(await getAdSets(), null, 2)),
    ads: async () => console.log(JSON.stringify(await getAds(), null, 2)),
    audiences: async () => console.log(JSON.stringify(await getCustomAudiences(), null, 2)),
    pages: async () => console.log(JSON.stringify(await getPages(), null, 2)),
    insights: async () => console.log(JSON.stringify(await getAccountInsights(), null, 2)),
    token: async () => console.log(JSON.stringify(await debugToken(), null, 2)),
    "long-token": async () => {
      const result = await exchangeForLongLivedToken();
      console.log("Long-lived token (60 days):");
      console.log(result.access_token);
      console.log(`\nExpires in: ${Math.round(result.expires_in / 86400)} days`);
    },
    interests: async () => {
      const q = process.argv[3];
      if (!q) { console.log("Usage: bun run src/meta-ads.ts interests <query>"); return; }
      console.log(JSON.stringify(await searchInterests(q), null, 2));
    },
  };

  if (!cmd || !commands[cmd]) {
    console.log("Nova Meta Ads CLI");
    console.log("Usage: bun run src/meta-ads.ts <command>\n");
    console.log("Commands:");
    Object.keys(commands).forEach((c) => console.log(`  ${c}`));
  } else {
    await commands[cmd]();
  }
}
