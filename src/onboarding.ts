/**
 * Nova — Onboarding & discoverability content.
 *
 * Pure functions that produce everything a new, non-technical user sees in Telegram:
 * the first-run welcome, /help, a plain-language /team roster grouped by outcome, and
 * tappable starter examples that beat the blank-box problem. No I/O, no side effects —
 * all rendering is driven by the live agent catalog so it never drifts out of date.
 */

import type { AgentDef } from "./agent-router.ts";

/** A starter prompt shown as a tappable button and in /examples. */
export interface StarterExample {
  key: string;
  label: string;
  prompt: string;
}

export const STARTER_EXAMPLES: StarterExample[] = [
  { key: "plan_week", label: "📅 Plan my week", prompt: "Help me plan my week. Ask me what's on my plate, then organize it into a simple daily plan." },
  { key: "write_post", label: "✍️ Write a post", prompt: "Write a short, engaging social media post for my business. Ask me what it should be about first." },
  { key: "research", label: "🔍 Research something", prompt: "I want to research a topic. Ask me what to look into, then give me a clear, sourced summary." },
  { key: "draft_email", label: "📧 Draft an email", prompt: "Help me write an email. Ask who it's to and what I want to say, then draft it in my voice." },
  { key: "ideas", label: "💡 Give me ideas", prompt: "Give me 5 fresh ideas to grow my business this month. Ask what my business is first." },
  { key: "what_can_you_do", label: "❓ What can you do?", prompt: "/team" },
];

/**
 * Every agent grouped by the outcome a non-technical user actually wants.
 * Titles are plain-language; slugs map to the .claude/agents/*.md roster.
 * Any slug not listed here falls into a "More specialists" catch-all so the
 * roster can never silently drop an agent.
 */
export const OUTCOME_GROUPS: { title: string; slugs: string[] }[] = [
  { title: "🚀 Get more customers", slugs: ["helios", "flux", "magnus", "cyra", "bridge"] },
  { title: "📣 Make content & grow your audience", slugs: ["kai", "pixel", "morpheus", "orion", "aura", "nexus", "helia"] },
  { title: "📊 Understand your data", slugs: ["digit", "cipher", "oracle"] },
  { title: "🛠️ Build & run your operation", slugs: ["architect", "joule", "zen", "tesseract", "echo"] },
  { title: "🛡️ Protect & advise your business", slugs: ["lex", "rift", "athena", "quill"] },
];

/** Plain-language, jargon-free one-liners keyed by slug. Falls back to the agent's own description. */
const FRIENDLY_BLURBS: Record<string, string> = {
  helios: "runs your paid ads",
  flux: "turns visitors into buyers",
  magnus: "gets you found on Google",
  cyra: "makes your website convert better",
  bridge: "finds partners and collaborations",
  kai: "writes your content and copy",
  pixel: "runs your social media",
  morpheus: "plans and scripts your videos",
  orion: "handles your email marketing",
  aura: "shapes your brand voice",
  nexus: "builds your community",
  helia: "handles PR and press",
  digit: "turns your numbers into insights",
  cipher: "does deep data science and forecasting",
  oracle: "spots trends before they happen",
  architect: "builds websites and technical things",
  joule: "automates repetitive work",
  zen: "keeps you focused and productive",
  tesseract: "untangles complex problems",
  echo: "handles customer support",
  lex: "flags legal and compliance risks",
  rift: "keeps you secure",
  athena: "sets business strategy",
  quill: "writes grants and proposals",
};

/** The first message Nova sends after setup — warm, in the user's name, no jargon. */
export function buildWelcomeMessage(name: string): string {
  const first = (name || "there").trim().split(/\s+/)[0] || "there";
  return [
    `👋 Hi ${first}, I'm Nova — your AI team in one chat.`,
    ``,
    `You don't need any special commands. Just tell me what you want in plain English, like you'd text a helpful assistant.`,
    ``,
    `Not sure where to start? Tap one of the buttons below, or send /help anytime.`,
  ].join("\n");
}

/** Short, human, task-oriented help — not a feature dump. */
export function buildHelpMessage(): string {
  return [
    `🧭 *How to use Nova*`,
    ``,
    `Just tell me what you want — in normal words. For example:`,
    `• "Write a post announcing our sale on Friday"`,
    `• "Research the best CRM for a small team"`,
    `• "Plan my week around a 3pm school pickup"`,
    ``,
    `I'll figure out which specialist on your team should handle it. Before I do anything with real consequences (sending an email, publishing a post), I'll show you first and ask *Approve / Change / Cancel*.`,
    ``,
    `*Handy shortcuts:*`,
    `• /team — meet your specialists`,
    `• /examples — ideas to try right now`,
    `• /status — check that I'm running`,
    `• /settings — change your name, timezone, or style`,
  ].join("\n");
}

/** Renders the roster grouped by outcome, in plain language. Every catalog agent appears exactly once. */
export function buildTeamMessage(agents: AgentDef[]): string {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const shown = new Set<string>();
  const lines: string[] = [`👥 *Your team* — here's who I can put to work for you:`, ``];

  for (const group of OUTCOME_GROUPS) {
    const members = group.slugs
      .map((slug) => bySlug.get(slug))
      .filter((a): a is AgentDef => Boolean(a));
    if (members.length === 0) continue;
    lines.push(`*${group.title}*`);
    for (const a of members) {
      shown.add(a.slug);
      const blurb = FRIENDLY_BLURBS[a.slug] || a.description;
      lines.push(`• *${a.name}* — ${blurb}`);
    }
    lines.push(``);
  }

  // Catch-all: any agent not placed in a group still gets surfaced.
  const leftovers = agents.filter((a) => !shown.has(a.slug));
  if (leftovers.length > 0) {
    lines.push(`*✨ More specialists*`);
    for (const a of leftovers) {
      lines.push(`• *${a.name}* — ${FRIENDLY_BLURBS[a.slug] || a.description}`);
    }
    lines.push(``);
  }

  lines.push(`Just describe what you need — I'll pick the right one for you.`);
  return lines.join("\n");
}

/** The /examples message body (buttons carry the actual prompts). */
export function buildExamplesMessage(): string {
  return [
    `💡 *Try one of these* — tap a button and I'll get started:`,
    ``,
    ...STARTER_EXAMPLES.filter((e) => e.key !== "what_can_you_do").map((e) => `• ${e.label}`),
  ].join("\n");
}

/** Inline-keyboard rows for the starter examples. callbackData is `nova_ex:<key>`. */
export function exampleButtons(): { label: string; callbackData: string }[][] {
  const rows: { label: string; callbackData: string }[][] = [];
  for (let i = 0; i < STARTER_EXAMPLES.length; i += 2) {
    rows.push(
      STARTER_EXAMPLES.slice(i, i + 2).map((e) => ({ label: e.label, callbackData: `nova_ex:${e.key}` }))
    );
  }
  return rows;
}

/** Resolves a starter-example key (from a `nova_ex:` callback) back to its prompt. */
export function getExamplePrompt(key: string): string | undefined {
  return STARTER_EXAMPLES.find((e) => e.key === key)?.prompt;
}

/** The set of slash commands the onboarding layer owns, with menu descriptions. */
export const NOVA_COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Say hello and see what I can do" },
  { command: "help", description: "How to use Nova" },
  { command: "team", description: "Meet your specialists" },
  { command: "examples", description: "Ideas to try right now" },
  { command: "status", description: "Check that Nova is running" },
  { command: "settings", description: "Change your name, timezone, or style" },
];
