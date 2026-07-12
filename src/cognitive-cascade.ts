import { selectProvider } from "./ai-router.ts";
import type { Database } from "./db.ts";

export const SELF_CRITIQUE_SCORE_THRESHOLD = 7;

export interface CascadeOpts {
  prompt: string;
  systemPrompt?: string;
  userId?: string;
  hint?: string;
  userDefaultProvider?: string;
  hasMcpConfig?: boolean;
  traceId?: string;
}

export interface CascadeResult {
  text: string;
  tier: 0 | 1 | 2 | 3 | 4;
  provider: string;
  model: string;
  iterations: number;
}

const CRITIQUE_PROMPT = (response: string, request: string) => `
You evaluated this AI response to a user request.

REQUEST:
${request}

RESPONSE:
${response}

Rate the response on four dimensions (1-10):
- Correctness: Is the answer factually accurate?
- Completeness: Does it fully address the request?
- Business-appropriateness: Is the tone/action right for this context?
- Action clarity: Are next steps unambiguous?

Respond ONLY as JSON: {"scores":{"correctness":N,"completeness":N,"business_appropriateness":N,"action_clarity":N},"weakest_dimension":"...","revision_needed":true/false}
`.trim();

interface CritiqueResult {
  scores: {
    correctness: number;
    completeness: number;
    business_appropriateness: number;
    action_clarity: number;
  };
  weakest_dimension: string;
  revision_needed: boolean;
}

function parseCritique(raw: string): CritiqueResult | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as CritiqueResult;
  } catch {
    return null;
  }
}

function allScoresAboveThreshold(c: CritiqueResult): boolean {
  const s = c.scores;
  return (
    s.correctness >= SELF_CRITIQUE_SCORE_THRESHOLD &&
    s.completeness >= SELF_CRITIQUE_SCORE_THRESHOLD &&
    s.business_appropriateness >= SELF_CRITIQUE_SCORE_THRESHOLD &&
    s.action_clarity >= SELF_CRITIQUE_SCORE_THRESHOLD
  );
}

export async function runCognitiveCascade(opts: CascadeOpts): Promise<CascadeResult> {
  const { prompt, systemPrompt, userId, hint, userDefaultProvider, hasMcpConfig } = opts;

  // Tier 1: fast provider, single pass
  const fastRoute = await selectProvider({
    tier: "fast",
    hint,
    userId,
    userDefaultProvider,
    hasMcpConfig,
  });

  const tier1Result = await fastRoute.provider.call({
    prompt,
    systemPrompt,
    model: fastRoute.model,
    userId,
    traceId: opts.traceId,
    sandboxed: true,
  });

  const tier1Text = tier1Result.text;

  // Self-critique after Tier 1
  const critiqueRaw = await fastRoute.provider.call({
    prompt: CRITIQUE_PROMPT(tier1Text, prompt),
    model: fastRoute.model,
    sandboxed: true,
  });

  const critique = parseCritique(critiqueRaw.text);

  if (!critique || (!critique.revision_needed && allScoresAboveThreshold(critique))) {
    return {
      text: tier1Text,
      tier: 1,
      provider: fastRoute.provider.name,
      model: fastRoute.model,
      iterations: 1,
    };
  }

  // Tier 2: up to 3 self-critique iterations on fast provider
  let currentText = tier1Text;
  let iterations = 1;

  for (let i = 0; i < 2; i++) {
    const revisionPrompt = `The previous response had weaknesses in: ${critique?.weakest_dimension || "quality"}. Please revise:\n\n${prompt}`;
    const revised = await fastRoute.provider.call({
      prompt: revisionPrompt,
      model: fastRoute.model,
      userId,
      sandboxed: true,
    });
    currentText = revised.text;
    iterations++;

    const recheckRaw = await fastRoute.provider.call({
      prompt: CRITIQUE_PROMPT(currentText, prompt),
      model: fastRoute.model,
      sandboxed: true,
    });
    const recheck = parseCritique(recheckRaw.text);
    if (!recheck || (!recheck.revision_needed && allScoresAboveThreshold(recheck))) {
      return {
        text: currentText,
        tier: 2,
        provider: fastRoute.provider.name,
        model: fastRoute.model,
        iterations,
      };
    }
  }

  // Tier 3: standard provider
  const standardRoute = await selectProvider({
    tier: "standard",
    hint,
    userId,
    userDefaultProvider,
    hasMcpConfig,
  });

  const tier3Result = await standardRoute.provider.call({
    prompt,
    model: standardRoute.model,
    userId,
    traceId: opts.traceId,
    sandboxed: true,
  });

  const tier3Text = tier3Result.text;

  const tier3CritiqueRaw = await standardRoute.provider.call({
    prompt: CRITIQUE_PROMPT(tier3Text, prompt),
    model: standardRoute.model,
    sandboxed: true,
  });
  const tier3Critique = parseCritique(tier3CritiqueRaw.text);

  if (!tier3Critique || (!tier3Critique.revision_needed && allScoresAboveThreshold(tier3Critique))) {
    return {
      text: tier3Text,
      tier: 3,
      provider: standardRoute.provider.name,
      model: standardRoute.model,
      iterations: iterations + 1,
    };
  }

  // Tier 4: premium provider
  const premiumRoute = await selectProvider({
    tier: "premium",
    hint,
    userId,
    userDefaultProvider,
    hasMcpConfig,
  });

  const tier4Result = await premiumRoute.provider.call({
    prompt,
    model: premiumRoute.model,
    userId,
    traceId: opts.traceId,
    sandboxed: true,
  });

  return {
    text: tier4Result.text,
    tier: 4,
    provider: premiumRoute.provider.name,
    model: premiumRoute.model,
    iterations: iterations + 2,
  };
}

export function logEscalation(
  db: Database,
  userId: string,
  messageEmbedding: Buffer | null,
  tierReached: number,
  executionPlan: string | null,
  success: boolean,
): void {
  db.insertEscalationLog(userId, {
    message_embedding: messageEmbedding,
    tier_reached: tierReached,
    execution_plan: executionPlan,
    success,
  });
}
