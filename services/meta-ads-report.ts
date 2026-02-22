/**
 * Meta Ads Daily Report
 *
 * Pulls performance data from Meta Ads API and sends a summary to Telegram.
 * Covers: yesterday's spend, last 7 days overview, active campaign breakdowns.
 *
 * Schedule: daily at 8:30 AM ET (after morning briefing)
 * Run manually: bun run services/meta-ads-report.ts
 */

import { dirname, join } from "path";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// Load .env manually for scheduled execution
const envPath = join(PROJECT_ROOT, ".env");
const envFile = await Bun.file(envPath).text().catch(() => "");
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  if (!process.env[key]) process.env[key] = val;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || "";

const BASE_URL = `https://graph.facebook.com/v21.0`;

// ─── Helpers ─────────────────────────────────────────────

async function metaGet(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set("access_token", META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  return data;
}

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_USER_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Telegram error:", e);
    return false;
  }
}

function formatMoney(cents: string | number): string {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function formatSpend(dollars: string | number): string {
  return `$${Number(dollars).toFixed(2)}`;
}

function getAction(actions: any[] | undefined, type: string): string {
  if (!actions) return "0";
  const action = actions.find((a: any) => a.action_type === type);
  return action ? action.value : "0";
}

// ─── Data Fetching ───────────────────────────────────────

async function getAccountInsights(datePreset: string) {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: "impressions,reach,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type,frequency",
    date_preset: datePreset,
  });
}

async function getCampaignInsights(datePreset: string) {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    level: "campaign",
    fields: "campaign_name,impressions,reach,clicks,spend,cpc,ctr,actions,cost_per_action_type",
    date_preset: datePreset,
    limit: "20",
    filtering: JSON.stringify([
      { field: "spend", operator: "GREATER_THAN", value: "0" },
    ]),
  });
}

async function getActiveCampaigns() {
  return metaGet(`${META_AD_ACCOUNT_ID}/campaigns`, {
    fields: "name,status,daily_budget,lifetime_budget",
    filtering: JSON.stringify([
      { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
    ]),
    limit: "20",
  });
}

// ─── Report Builder ──────────────────────────────────────

async function buildReport(): Promise<string> {
  const [yesterday, last7d, campaigns, activeCampaigns] = await Promise.all([
    getAccountInsights("yesterday").catch(() => ({ data: [] })),
    getAccountInsights("last_7d").catch(() => ({ data: [] })),
    getCampaignInsights("yesterday").catch(() => ({ data: [] })),
    getActiveCampaigns().catch(() => ({ data: [] })),
  ]);

  const lines: string[] = [];
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  lines.push(`<b>📊 Meta Ads Report — ${dateStr}</b>`);
  lines.push("");

  // Yesterday's summary
  if (yesterday.data?.length) {
    const y = yesterday.data[0];
    const leads = getAction(y.actions, "lead");
    const purchases = getAction(y.actions, "purchase");
    const linkClicks = getAction(y.actions, "link_click");

    lines.push("<b>Yesterday</b>");
    lines.push(`  Spend: ${formatSpend(y.spend)}`);
    lines.push(`  Reach: ${Number(y.reach).toLocaleString()} | Impressions: ${Number(y.impressions).toLocaleString()}`);
    lines.push(`  Clicks: ${y.clicks} (CTR: ${Number(y.ctr).toFixed(2)}%)`);
    lines.push(`  CPC: ${formatSpend(y.cpc)} | CPM: ${formatSpend(y.cpm)}`);
    if (Number(leads) > 0) lines.push(`  Leads: ${leads}`);
    if (Number(purchases) > 0) lines.push(`  Purchases: ${purchases}`);
    if (Number(linkClicks) > 0 && linkClicks !== y.clicks) lines.push(`  Link clicks: ${linkClicks}`);
    lines.push("");
  } else {
    lines.push("<b>Yesterday</b>: No spend");
    lines.push("");
  }

  // Last 7 days summary
  if (last7d.data?.length) {
    const w = last7d.data[0];
    const leads = getAction(w.actions, "lead");
    const purchases = getAction(w.actions, "purchase");

    lines.push("<b>Last 7 Days</b>");
    lines.push(`  Spend: ${formatSpend(w.spend)} | Reach: ${Number(w.reach).toLocaleString()}`);
    lines.push(`  Clicks: ${w.clicks} (CTR: ${Number(w.ctr).toFixed(2)}%)`);
    lines.push(`  CPC: ${formatSpend(w.cpc)} | Freq: ${Number(w.frequency).toFixed(1)}`);
    if (Number(leads) > 0) lines.push(`  Leads: ${leads}`);
    if (Number(purchases) > 0) lines.push(`  Purchases: ${purchases}`);
    lines.push("");
  }

  // Campaign breakdown (yesterday, only campaigns with spend)
  if (campaigns.data?.length) {
    lines.push("<b>Campaigns (Yesterday)</b>");
    for (const c of campaigns.data) {
      const leads = getAction(c.actions, "lead");
      const clicks = c.clicks || "0";
      let detail = `${formatSpend(c.spend)} spent, ${clicks} clicks`;
      if (Number(leads) > 0) detail += `, ${leads} leads`;
      lines.push(`  • ${c.campaign_name}`);
      lines.push(`    ${detail}`);
    }
    lines.push("");
  }

  // Active campaigns count
  const activeCount = activeCampaigns.data?.length || 0;
  lines.push(`<i>${activeCount} active campaign${activeCount !== 1 ? "s" : ""}</i>`);

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log("Building Meta Ads report...");

  if (!BOT_TOKEN || !TELEGRAM_USER_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.error("Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID");
    process.exit(1);
  }

  try {
    const report = await buildReport();
    console.log("Report built, sending to Telegram...");
    const sent = await sendTelegram(report);
    if (sent) {
      console.log("Meta Ads report sent!");
    } else {
      console.error("Failed to send report");
      process.exit(1);
    }
  } catch (error) {
    console.error("Error building report:", error);
    // Send error notification
    await sendTelegram(`⚠️ Meta Ads report failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
