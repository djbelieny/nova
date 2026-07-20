/**
 * Task Decomposer & Executor
 *
 * Handles complex tasks by decomposing them into subtasks,
 * executing independent groups in parallel, and aggregating results.
 *
 * Model strategy:
 * - Haiku for decomposition (structured output, cheap)
 * - Sonnet for subtask execution (quality matters)
 * - Haiku for aggregation (formatting, not reasoning)
 *
 * Agent routing:
 * - Decomposer sees the full agent catalog and picks specialists
 * - Each subtask gets the specialist's full system prompt injected
 * - Falls back to generic prompt if no specialist matches
 *
 * Phase execution:
 * - "prepare" subtasks run first (research, create content, generate images)
 * - "execute" subtasks run after approval (create campaigns, send emails, publish)
 * - Artifacts (file paths, copy, audiences) flow from prepare → execute
 */

import type { Database } from "./db.ts";
import { stat } from "fs/promises";
import type { ExecutionPlan } from "./patterns.ts";
import type { ModelTier } from "./ai-provider.ts";
import { getAgentCatalog, buildAgentPrompt, getAgent, getAllAgents, queryToolRegistry, getToolInstructions } from "./agent-router.ts";
import { getReputationContext } from "./reputation.ts";
import { emit } from "./events.ts";
import { recordSubtaskAction } from "./ledger.ts";
import { verifyOutcome, recordVerification } from "./verify.ts";

let _callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string, systemPrompt?: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => { systemPrompt: string; userPrompt: string };

export function initPlanner(
  callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string, systemPrompt?: string) => Promise<string>,
  buildPrompt: (...args: any[]) => { systemPrompt: string; userPrompt: string }
): void {
  _callClaude = callClaude;
  _buildPrompt = buildPrompt;
}

export interface Artifact {
  type: string;   // "image", "copy", "audience", "url", "file", etc.
  value: string;  // file path, text content, or URL
  source: number; // subtask index that produced it
}

export interface SubtaskResult {
  index: number;
  description: string;
  agent?: string;
  result: string;
  success: boolean;
  artifacts: Artifact[];
}

export type ProgressCallback = (index: number, status: "started" | "completed" | "failed" | "healing") => void;

/**
 * Determine if a subtask description implies it should produce artifacts.
 * Used for validation — if expected artifacts are missing, we retry.
 */
function shouldExpectArtifacts(description: string): boolean {
  const lower = description.toLowerCase();
  const artifactIndicators = [
    "generate", "create", "produce", "build", "write", "draft",
    "image", "slide", "graphic", "design", "photo",
    "document", "report", "spreadsheet", "presentation",
    "/image-gen", "/canvas-design", "/docx", "/xlsx", "/pptx", "/pdf",
    "save to workspace", "save all",
  ];
  // Must match at least one indicator AND not be purely a research/analysis task
  const hasIndicator = artifactIndicators.some((ind) => lower.includes(ind));
  const isResearchOnly = /^(?:research|analyze|investigate|find|search|look up)/i.test(lower);
  return hasIndicator && !isResearchOnly;
}

/**
 * Parse [CONFIDENCE: 0.XX] tag from agent output.
 * Returns null if no tag found.
 */
export function parseConfidenceScore(text: string): number | null {
  const match = text.match(/\[CONFIDENCE:\s*([\d.]+)\s*\]/i);
  if (!match) return null;
  const score = parseFloat(match[1]);
  if (isNaN(score)) return null;
  return Math.min(1.0, Math.max(0.0, score));
}

/**
 * Strip [CONFIDENCE: ...] tags from agent output before delivery.
 */
export function stripConfidenceTag(text: string): string {
  return text.replace(/\[CONFIDENCE:\s*[\d.]+\s*\]/gi, "").trim();
}

/**
 * Parse [SPEND: category | $amount | description] tags from agent output.
 */
export function parseSpendRequests(text: string): Array<{ category: string; amount: number; description: string }> {
  const requests: Array<{ category: string; amount: number; description: string }> = [];
  const pattern = /\[SPEND:\s*([^|]+?)\s*\|\s*\$?([\d.]+)\s*\|\s*(.+?)\s*\]/g;
  for (const match of text.matchAll(pattern)) {
    const amount = parseFloat(match[2]);
    if (!isNaN(amount) && amount > 0) {
      requests.push({
        category: match[1].trim().toLowerCase(),
        amount,
        description: match[3].trim(),
      });
    }
  }
  return requests;
}

/**
 * Strip [SPEND: ...] tags from agent output before delivery.
 */
export function stripSpendTags(text: string): string {
  return text.replace(/\[SPEND:[^\]]+\]/gi, "").trim();
}

/**
 * Parse [PROJECT_ARTIFACT: name | ref] and [PROJECT_DECISION: text] tags.
 */
export function parseProjectTags(text: string): {
  artifacts: Array<{ name: string; ref: string }>;
  decisions: string[];
} {
  const artifacts: Array<{ name: string; ref: string }> = [];
  const decisions: string[] = [];

  const artifactPattern = /\[PROJECT_ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
  for (const match of text.matchAll(artifactPattern)) {
    artifacts.push({ name: match[1].trim(), ref: match[2].trim() });
  }

  const decisionPattern = /\[PROJECT_DECISION:\s*(.+?)\s*\]/g;
  for (const match of text.matchAll(decisionPattern)) {
    decisions.push(match[1].trim());
  }

  return { artifacts, decisions };
}

/**
 * Parse [ARTIFACT: type | value] tags from agent output.
 */
export function extractArtifacts(text: string, sourceIndex: number): Artifact[] {
  const artifacts: Artifact[] = [];
  const pattern = /\[ARTIFACT:\s*(\w+)\s*\|\s*(.+?)\]/g;
  for (const match of text.matchAll(pattern)) {
    artifacts.push({
      type: match[1].toLowerCase(),
      value: match[2].trim(),
      source: sourceIndex,
    });
  }
  return artifacts;
}

/**
 * Collect all artifacts from a set of subtask results.
 */
export function collectArtifacts(results: SubtaskResult[]): Artifact[] {
  return results.flatMap((r) => r.artifacts);
}

/**
 * Enrich a list of artifacts by auto-analyzing screenshot/image artifacts with Gemini vision.
 * Appends screenshot_analysis artifacts for any image/screenshot type found.
 * Best-effort — never throws.
 */
export async function enrichArtifactsWithVision(artifacts: Artifact[]): Promise<Artifact[]> {
  const enriched: Artifact[] = [...artifacts];
  for (const artifact of artifacts) {
    const typeL = artifact.type.toLowerCase();
    if (typeL.includes("screenshot") || typeL.includes("image")) {
      try {
        const { analyzeImage } = await import("./ai-router.ts");
        const analysis = await analyzeImage(
          artifact.value,
          "Describe this screenshot: what page/interface is shown, what's the key content, any errors or notable state?"
        );
        if (analysis && !analysis.startsWith("[Image analysis")) {
          enriched.push({
            type: "screenshot_analysis",
            value: analysis.slice(0, 500),
            source: artifact.source,
          });
        }
      } catch {
        // vision analysis is best-effort
      }
    }
  }
  return enriched;
}

/**
 * Verify artifacts exist on disk and register them in the task_artifacts table.
 * Returns the number of verified artifacts and appends warnings for missing ones.
 */
export async function verifyAndRegisterArtifacts(
  taskId: string | null,
  userId: string,
  artifacts: Artifact[],
  db: Database | null,
): Promise<{ verified: number; missing: string[] }> {
  const missing: string[] = [];
  let verified = 0;

  for (const artifact of artifacts) {
    // Only verify file-based artifacts (not copy/data/audience/url)
    const isFileBased = ["image", "file", "document", "project", "code"].includes(artifact.type);
    let fileExists = false;
    let fileSize: number | null = null;

    if (isFileBased && artifact.value) {
      try {
        const fileStat = await stat(artifact.value);
        fileExists = true;
        fileSize = fileStat.size;
        verified++;
      } catch {
        missing.push(artifact.value);
      }
    } else {
      // Non-file artifacts (copy, data, url) are always "verified"
      fileExists = true;
      verified++;
    }

    // Register in DB
    if (db) {
      try {
        db.insertArtifact({
          task_id: taskId,
          user_id: userId,
          artifact_type: artifact.type,
          file_path: isFileBased ? artifact.value : null,
          file_name: isFileBased ? artifact.value.split("/").pop() : null,
          file_size: fileSize,
          description: !isFileBased ? artifact.value : null,
          verified: fileExists,
          delivered: false,
          metadata: { source_subtask: artifact.source },
        });
      } catch (e) {
        console.debug("[planner] Artifact save non-critical:", e);
      }
    }
  }

  return { verified, missing };
}

/**
 * Build a deterministic execution plan for social media post creation.
 * Bypasses the LLM decomposer to enforce a fixed 5-step pipeline:
 * research → content creation → image generation → Telegram delivery → GHL publishing.
 */
export function buildSocialMediaPlan(topic: string, platforms: string[]): ExecutionPlan {
  const platformList = platforms.join(", ");

  return {
    subtasks: [
      {
        description: `Research the topic '${topic}' for a social media post. Find: current trends, relevant statistics, popular hashtags, trending angles, and what's working right now on ${platformList}. Use web search to find real, current information. Output a structured research brief.`,
        agent: "general",
        dependsOn: [],
        phase: "prepare",
      },
      {
        description: `Based on the research provided, create a complete social media post package for ${platformList}: 1) Post caption with hook, body, CTA, and hashtags. 2) For each image/slide needed: exact description for image generation including style, colors, text overlays, dimensions (1080x1080 for feed, 1080x1920 for stories). 3) Carousel layout if multiple slides. Be specific — every image description must be detailed enough for /image-gen to produce it.`,
        agent: "pixel",
        dependsOn: [0],
        phase: "prepare",
      },
      {
        description: `Generate ALL images described in the content plan using /image-gen. For carousels, generate each slide as a separate image. Save all images to the workspace directory. Tag each image with [ARTIFACT: image | path].`,
        agent: "pixel",
        dependsOn: [1],
        phase: "prepare",
      },
      {
        description: `Send all generated images to the user via /telegram-file-sender. Include the full caption, hashtags, and posting schedule in the message. Present it as a preview for approval before publishing to ${platformList}.`,
        agent: "pixel",
        dependsOn: [2],
        phase: "prepare",
      },
      {
        description: `Publish the approved content to ${platformList} using the GHL create-post MCP tool. Include all image files as media. Use the approved caption as the post body. Set status to PUBLISHED. Report the post IDs and status for each platform.`,
        agent: "pixel",
        dependsOn: [3],
        phase: "execute",
      },
    ],
  };
}

/**
 * Build a deterministic plan for email campaign creation.
 * research → copy → template → test send → approval → broadcast
 */
export function buildEmailCampaignPlan(topic: string, audience: string): ExecutionPlan {
  return {
    subtasks: [
      {
        description: `Research the topic '${topic}' for an email campaign${audience ? ` targeting ${audience}` : ""}. Find: current best practices, subject line trends, email engagement benchmarks, and compelling angles. Use web search for real data.`,
        agent: "general",
        dependsOn: [],
        phase: "prepare",
      },
      {
        description: `Based on the research, create a complete email campaign package: 1) 3 subject line variations with open rate reasoning. 2) Email body with hook, value section, and CTA. 3) Audience segmentation recommendation. 4) Send time recommendation based on engagement data.`,
        agent: "orion",
        dependsOn: [0],
        phase: "prepare",
      },
      {
        description: `Create the email template in GHL using the finalized copy. Set up the campaign structure, audience segments, and scheduling. Send a test email to the user for preview.`,
        agent: "orion",
        dependsOn: [1],
        phase: "prepare",
      },
      {
        description: `Send the final email campaign to the configured audience segments via GHL. Report delivery status, recipient count, and campaign ID.`,
        agent: "orion",
        dependsOn: [2],
        phase: "execute",
      },
    ],
  };
}

/**
 * Build a deterministic plan for blog post creation.
 * research → outline → draft → image → deliver
 */
export function buildBlogPostPlan(topic: string): ExecutionPlan {
  return {
    subtasks: [
      {
        description: `Research the topic '${topic}' for a blog post. Find: current trends, statistics, expert quotes, competing articles, and unique angles. Use web search to gather 5+ real data points and recent sources.`,
        agent: "general",
        dependsOn: [],
        phase: "prepare",
      },
      {
        description: `Write a complete, publication-ready blog post about '${topic}' using the research. Include: engaging headline, hook opening, data-backed arguments, subheadings, actionable takeaways, and a strong conclusion. Target 1200-2000 words. Tag the final text with [ARTIFACT: copy | "full blog post text"].`,
        agent: "kai",
        dependsOn: [0],
        phase: "prepare",
      },
      {
        description: `Generate a hero/header image for the blog post using /image-gen. The image should visually represent the topic '${topic}' and be suitable for a blog header (1200x630). Tag with [ARTIFACT: image | path].`,
        agent: "kai",
        dependsOn: [1],
        phase: "prepare",
      },
      {
        description: `Send the blog post text and header image to the user via /telegram-file-sender for review before publishing.`,
        agent: "kai",
        dependsOn: [2],
        phase: "prepare",
      },
      {
        description: `Publish the approved blog post to GHL using the create-blog-post tool. Include the header image and all formatted content. Report the published URL.`,
        agent: "kai",
        dependsOn: [3],
        phase: "execute",
      },
    ],
  };
}

/**
 * Build a deterministic plan for presentation/deck creation.
 * research → outline → content → slides → deliver
 */
export function buildPresentationPlan(topic: string): ExecutionPlan {
  return {
    subtasks: [
      {
        description: `Research the topic '${topic}' for a presentation. Find: key data points, statistics, industry insights, and compelling narrative angles. Use web search for current, factual information.`,
        agent: "general",
        dependsOn: [],
        phase: "prepare",
      },
      {
        description: `Based on the research, create a detailed presentation outline for '${topic}': slide-by-slide breakdown with title, key points, speaker notes, and visual suggestions for each slide. Target 10-15 slides. Output the outline as structured text.`,
        agent: "athena",
        dependsOn: [0],
        phase: "prepare",
      },
      {
        description: `Create the PowerPoint presentation using /pptx based on the outline. Include: professional design, data visualizations where relevant, clear hierarchy, and speaker notes. Save to workspace and tag with [ARTIFACT: file | path]. Then send the file to the user via /telegram-file-sender.`,
        agent: "athena",
        dependsOn: [1],
        phase: "prepare",
      },
    ],
  };
}

/**
 * Build a deterministic plan for ad campaign creation.
 * research → creative → image gen → campaign setup → approval → launch
 */
export function buildAdCampaignPlan(topic: string, platforms: string[]): ExecutionPlan {
  const platformList = platforms.join(", ");
  return {
    subtasks: [
      {
        description: `Research for a ${platformList} ad campaign about '${topic}'. Find: target audience demographics, competitor ad strategies, best-performing ad formats, and current CPC/CPM benchmarks. Use web search and /competitive-ads-extractor if relevant.`,
        agent: "general",
        dependsOn: [],
        phase: "prepare",
      },
      {
        description: `Based on the research, create a complete ad campaign plan for ${platformList}: 1) Campaign objective and budget recommendation. 2) 2-3 audience segments with targeting criteria. 3) 3 ad copy variations with different hooks and CTAs. 4) Detailed image descriptions for each ad creative.`,
        agent: "helios",
        dependsOn: [0],
        phase: "prepare",
      },
      {
        description: `Generate all ad creative images described in the campaign plan using /image-gen. Create at least 3 variations. Save all to workspace and tag each with [ARTIFACT: image | path].`,
        agent: "helios",
        dependsOn: [1],
        phase: "prepare",
      },
      {
        description: `Send all ad creatives and the campaign plan summary to the user via /telegram-file-sender for approval before launching.`,
        agent: "helios",
        dependsOn: [2],
        phase: "prepare",
      },
      {
        description: `Create the ad campaign in GHL with the approved copy, creatives, audience targeting, and budget. Set up the campaign structure (campaign → ad sets → ads). Report the campaign IDs and status.`,
        agent: "helios",
        dependsOn: [3],
        phase: "execute",
      },
    ],
  };
}

/**
 * Decompose a complex task into ordered subtasks with dependencies and phases.
 * Uses Haiku — this is structured output, not creative work.
 * Includes the agent catalog so Haiku routes to the right specialist.
 */
export async function decompose(
  text: string,
  user: { name: string; timezone: string },
  db?: Database | null
): Promise<ExecutionPlan> {
  const catalog = getAgentCatalog();

  // Feed learned agent reputation into routing so past success/failure shifts which
  // specialists get picked for critical work (empty string until enough history exists).
  let reputationHint = "";
  if (db) {
    try { reputationHint = getReputationContext(db); } catch {}
  }

  const prompt = `Task decomposition engine. Break request into 2-5 subtasks.
Output ONLY valid JSON (no markdown): {"subtasks":[{"description":"...","agent":"slug","dependsOn":[],"phase":"prepare"}]}

${catalog || 'Agents: "general"'}
${reputationHint}
Agent routing: pixel=social posts | helios=paid ads | kai=long-form writing | orion=email | digit=analytics | athena=strategy | magnus=SEO | cyra=website-CRO | architect=web-dev | general=research/search
phase: "prepare"=safe reversible work | "execute"=API creates/sends/publishes/spends money. Default prepare if unsure.
dependsOn: 0-indexed positions. Parallel tasks → empty arrays.

EX: "blog post + publish" → [research(general,prepare,[]), write(kai,prepare,[0]), publish(kai,execute,[1])]
EX: "FB ad campaign" → [research(general,prepare,[]), copy+structure(helios,prepare,[0]), creatives(helios,prepare,[1]), create-in-GHL(helios,execute,[2])]
EX: "sales report" → [pull-Square-data(digit,prepare,[]), build-Excel-report(digit,prepare,[0])]

User: ${user.name}
Request: ${text}`;

  const raw = await _callClaude(prompt, "haiku" as any);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error("Invalid plan structure");
    }

    // Build set of valid agent slugs for validation
    const validSlugs = new Set(getAllAgents().map((a) => a.slug));
    validSlugs.add("general");

    const plan: ExecutionPlan = {
      subtasks: parsed.subtasks.map((s: any) => {
        let agent = String(s.agent || "general").toLowerCase();
        // Validate agent slug — reject hallucinated slugs
        if (!validSlugs.has(agent)) {
          emit({ type: "agent.dispatched", level: "warn", data: { message: `Unknown agent slug "${agent}" — falling back to "general"`, module: "planner" } });
          agent = "general";
        }
        return {
          description: String(s.description || "").substring(0, 500),
          agent,
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
          phase: s.phase === "execute" ? "execute" : "prepare",
        };
      }),
    };

    // Log the routing decisions
    emit({ type: "task.created", level: "info", data: { message: `Decomposed into ${plan.subtasks.length} subtasks`, subtaskCount: plan.subtasks.length, module: "planner" } });
    for (const st of plan.subtasks) {
      emit({ type: "agent.dispatched", level: "info", agentSlug: st.agent, data: { message: `→ ${st.agent} [${st.phase}]: ${st.description.substring(0, 60)}`, description: st.description, phase: st.phase, module: "planner" } });
    }

    return plan;
  } catch (error) {
    emit({ type: "error", level: "error", data: { message: `Decomposition parse error: ${error}`, module: "planner" } });
    return { subtasks: [{ description: text, agent: "general", phase: "prepare" }] };
  }
}

/**
 * Execute subtasks for a specific phase, respecting dependencies.
 * Each subtask gets its specialist agent's system prompt injected.
 * Prepare-phase agents are instructed to output [ARTIFACT:] tags.
 */
export async function executePhase(
  plan: ExecutionPlan,
  phase: "prepare" | "execute",
  user: any,
  db: Database | null,
  parentTaskId?: string,
  priorArtifacts?: Artifact[],
  priorResults?: SubtaskResult[],
  onProgress?: ProgressCallback,
  workspaceDir?: string
): Promise<SubtaskResult[]> {
  const results: SubtaskResult[] = [...(priorResults || [])];
  const completed = new Set<number>(results.map((r) => r.index));
  const actionIdByIndex = new Map<number, string>();

  // Only execute subtasks matching the requested phase
  const phaseIndices = new Set<number>();
  for (let i = 0; i < plan.subtasks.length; i++) {
    const subtaskPhase = plan.subtasks[i].phase || "prepare";
    if (subtaskPhase === phase) phaseIndices.add(i);
  }

  // Log subtasks to agent_tasks table
  const subtaskIds: (string | null)[] = [];
  for (let i = 0; i < plan.subtasks.length; i++) {
    if (!phaseIndices.has(i)) {
      subtaskIds.push(null);
      continue;
    }
    const subtask = plan.subtasks[i];
    if (db) {
      try {
        const id = db.insertTask({
          agent: subtask.agent || "general",
          description: subtask.description,
          status: "pending",
          user_id: user.id,
          parent_task_id: parentTaskId || null,
        });
        subtaskIds.push(id);
      } catch (insertErr: any) {
        emit({ type: "error", level: "error", data: { message: `Failed to insert subtask ${i} (${subtask.agent}): ${insertErr.message}`, module: "planner" } });
        subtaskIds.push(null);
      }
    } else {
      subtaskIds.push(null);
    }
  }

  // Build artifact context string for execute-phase subtasks
  const artifactContext = priorArtifacts?.length
    ? "\n\nArtifacts from prepare phase:\n" +
      priorArtifacts.map((a) => `- [${a.type}]: ${a.value}`).join("\n")
    : "";

  // Execute in dependency order
  const allIndices = [...phaseIndices];
  while (completed.size < plan.subtasks.length && allIndices.some((i) => !completed.has(i))) {
    const ready: number[] = [];
    for (const i of allIndices) {
      if (completed.has(i)) continue;
      const deps = plan.subtasks[i].dependsOn || [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(i);
      }
    }

    if (ready.length === 0) {
      // Check if remaining subtasks are all from other phase (not a circular dep)
      const remaining = allIndices.filter((i) => !completed.has(i));
      if (remaining.length > 0) {
        emit({ type: "error", level: "error", data: { message: "Circular dependency detected in subtasks", module: "planner" } });
      }
      break;
    }

        // Execute ready subtasks in parallel
    const batchResults = await Promise.all(
      ready.map(async (idx) => {
        const subtask = plan.subtasks[idx];
        const agentSlug = subtask.agent || "general";
        const reviewAgentSlug = subtask.reviewAgent;

        if (db && subtaskIds[idx]) {
          db.updateTask(subtaskIds[idx]!, { status: "in_progress" });
        }

        // Build context from completed dependency results
        const depContext = (subtask.dependsOn || [])
          .map((d) => {
            const depResult = results.find((r) => r.index === d);
            return depResult
              ? `[Result from "${depResult.description}"]: ${depResult.result}`
              : "";
          })
          .filter(Boolean)
          .join("\n\n");

        // Add artifact context for execute-phase subtasks
        const fullDepContext = phase === "execute"
          ? (depContext ? depContext + artifactContext : artifactContext)
          : depContext;

        const { userPrompt: baseUserPrompt } = _buildPrompt(
          user,
          `${fullDepContext ? `Context from prior steps:\n${fullDepContext}\n\n` : ""}Task: ${subtask.description}`,
        );

        try {

        let attempts = 0;
        const maxAttempts = 3;
        let lastResult = "";
        let lastArtifacts: Artifact[] = [];
        let criticism = "";
        let dynamicTools = "";

        while (attempts < maxAttempts) {
          attempts++;
          const isRetry = attempts > 1;
          
          const { systemPrompt: agentSysPrompt, userPrompt: agentUserPrompt } = buildAgentPrompt(
            agentSlug,
            subtask.description + (criticism ? `\n\nYOUR PREVIOUS ATTEMPT FAILED. CRITICISM:\n${criticism}\n\nFix these issues and try again.` : "") + (dynamicTools ? `\n\nDYNAMICALLY LOADED TOOLS:\n${dynamicTools}` : ""),
            baseUserPrompt,
            fullDepContext || undefined,
            phase,
            workspaceDir,
            undefined, // useMcp2cli
            undefined, // userMcpConfig
            user?.id,  // userId for gws CLI instructions
            user?.timezone
          );

          emit({ type: "agent.dispatched", level: "info", agentSlug, data: { message: `Executing subtask ${idx} via ${agentSlug} [${phase}] (attempt ${attempts}/${maxAttempts}): ${subtask.description.substring(0, 50)}`, description: subtask.description, phase, subtaskIndex: idx, module: "planner", attempt: attempts } });
          if (attempts === 1) {
            onProgress?.(idx, "started");
            emit({
              type: "agent.start",
              level: "info",
              agentSlug,
              agentDisplayName: agentSlug.charAt(0).toUpperCase() + agentSlug.slice(1),
              stepMessage: subtask.description.slice(0, 80),
              data: {
                message: `${agentSlug.charAt(0).toUpperCase() + agentSlug.slice(1)} starting: ${subtask.description.slice(0, 80)}`,
                subtaskIndex: idx,
                phase,
                module: "planner",
              },
            });
          } else onProgress?.(idx, "healing");

          try {
            const routingHint = `${agentSlug} ${subtask.description}`;
            // Increase temperature slightly on retries to encourage different output
            // Note: _callClaude doesn't currently accept temperature, but we can append a hint
            const retryHint = isRetry ? "\n\n(Retry: be creative and avoid previous mistakes)" : "";
            
            let result = await _callClaude(agentUserPrompt + retryHint, isRetry ? ("sonnet" as any) : undefined, user?.id, routingHint, agentSysPrompt);

            // DYNAMIC TOOL DISCOVERY
            if (result.includes("[REQUEST_TOOL:")) {
              const toolDescription = result.match(/\[REQUEST_TOOL:\s*(.+?)\]/)?.[1];
              if (toolDescription) {
                emit({ type: "agent.progress", level: "info", agentSlug, data: { message: `Subtask ${idx}: Agent requested tool for "${toolDescription.substring(0, 50)}"...`, subtaskIndex: idx, module: "planner" } });
                const toolMatch = queryToolRegistry(toolDescription);
                if (toolMatch) {
                  const instructions = getToolInstructions(toolMatch.name);
                  if (instructions) {
                    emit({ type: "agent.progress", level: "info", agentSlug, data: { message: `Subtask ${idx}: Dynamically loading tool "${toolMatch.name}"`, tool: toolMatch.name, subtaskIndex: idx, module: "planner" } });
                    dynamicTools += `\n- ${toolMatch.name}: ${instructions}`;
                    criticism = `You have been granted access to the tool: ${toolMatch.name}. Use it to complete the task.`;
                    continue; // Retry with new tool
                  }
                }
                emit({ type: "agent.progress", level: "warn", agentSlug, data: { message: `Subtask ${idx}: No matching tool found for "${toolDescription.substring(0, 50)}"`, subtaskIndex: idx, module: "planner" } });
                criticism = `No tool found matching your request for "${toolDescription}". Try to complete the task with your existing tools or explain why it is impossible.`;
                continue; // Retry with rejection
              }
            }

            // Extract artifacts from the result
            let artifacts = extractArtifacts(result, idx);

            // Artifact validation
            if (phase === "prepare" && artifacts.length === 0 && shouldExpectArtifacts(subtask.description)) {
              emit({ type: "agent.progress", level: "warn", agentSlug, data: { message: `Subtask ${idx} (${agentSlug}) expected artifacts but produced none — triggering self-healing`, subtaskIndex: idx, module: "planner" } });
              criticism = "You failed to produce any [ARTIFACT:] tags. You MUST tag every deliverable you create (images, copy, files, data). Do NOT just describe it.";
              continue; // Retry
            }

            // Verify file artifacts exist on disk
            if (artifacts.length > 0) {
              const verification = await verifyAndRegisterArtifacts(subtaskIds[idx], user.id, artifacts, db);
              if (verification.missing.length > 0) {
                const warning = `File(s) not found on disk: ${verification.missing.join(", ")}`;
                emit({ type: "agent.progress", level: "warn", agentSlug, data: { message: `Subtask ${idx}: ${warning}`, subtaskIndex: idx, module: "planner" } });
                criticism = `The following files you claimed to create were not found: ${verification.missing.join(", ")}. Ensure you actually write the files to the workspace.`;
                continue; // Retry
              }
            }

            // PEER REVIEW
            if (reviewAgentSlug) {
              emit({ type: "agent.progress", level: "info", agentSlug: reviewAgentSlug, data: { message: `Peer reviewing subtask ${idx} output via ${reviewAgentSlug}...`, subtaskIndex: idx, module: "planner" } });
              
              const reviewPrompt = `You are the ${reviewAgentSlug} reviewing work done by the ${agentSlug}.
              
ORIGINAL TASK: ${subtask.description}
AGENT OUTPUT:
${result}

Critically evaluate this output. Does it fully satisfy the task? Is it accurate?
If it is good, respond with ONLY "[APPROVED]".
If it has issues, respond with "[REJECTED: reason for rejection]".`;

              const reviewResult = await _callClaude(reviewPrompt, "haiku" as any, user?.id, `review ${reviewAgentSlug}`);
              
              if (reviewResult.includes("[REJECTED:")) {
                const reason = reviewResult.match(/\[REJECTED:\s*(.+?)\]/)?.[1] || "Rejected by reviewer";
                emit({ type: "agent.progress", level: "warn", agentSlug: reviewAgentSlug, data: { message: `Subtask ${idx} REJECTED by ${reviewAgentSlug}: ${reason}`, subtaskIndex: idx, module: "planner" } });
                criticism = `Your output was REJECTED by the ${reviewAgentSlug} for the following reason: ${reason}`;
                continue; // Retry
              } else {
                emit({ type: "agent.progress", level: "info", agentSlug: reviewAgentSlug, data: { message: `Subtask ${idx} APPROVED by ${reviewAgentSlug}`, subtaskIndex: idx, module: "planner" } });
              }
            }

            // Extract confidence score and strip tags before delivery
            const confidenceScore = parseConfidenceScore(result);
            result = stripConfidenceTag(result);

            // Strip spend tags from user-visible output
            result = stripSpendTags(result);

            // Success!
            if (db && subtaskIds[idx]) {
              db.updateTask(subtaskIds[idx]!, {
                status: "completed",
                result: result.substring(0, 500),
                ...(confidenceScore !== null ? { confidence_score: confidenceScore } : {}),
              });
            }

            // Record reputation outcome
            if (db) {
              try { db.recordAgentOutcome(agentSlug, { success: true, confidenceScore: confidenceScore ?? undefined }); } catch {}
            }

            onProgress?.(idx, "completed");
            emit({
              type: "agent.finish",
              level: "info",
              agentSlug,
              agentDisplayName: agentSlug.charAt(0).toUpperCase() + agentSlug.slice(1),
              data: {
                message: `${agentSlug} finished subtask ${idx}`,
                subtaskIndex: idx,
                success: true,
                confidenceScore,
                module: "planner",
              },
            });

            const subtaskResult: SubtaskResult = {
              index: idx,
              description: subtask.description,
              agent: subtask.agent,
              result,
              success: true,
              artifacts,
            };
            (subtaskResult as any).confidenceScore = confidenceScore;
            return subtaskResult;

          } catch (error) {
            emit({ type: "agent.progress", level: "error", agentSlug, data: { message: `Subtask ${idx} (${agentSlug}) error on attempt ${attempts}: ${error}`, subtaskIndex: idx, module: "planner" } });
            criticism = `Your last attempt threw an error: ${error}`;
            if (attempts >= maxAttempts) throw error;
          }
        }

        // If we get here, we exhausted retries
        throw new Error(`Subtask ${idx} failed after ${maxAttempts} attempts. Last error: ${criticism}`);

      } catch (finalError) {
        const subtask = plan.subtasks[idx];
        const agentSlug = subtask.agent || "general";
        
        emit({ type: "agent.completed", level: "error", agentSlug, data: { message: `Subtask ${idx} (${agentSlug}) final failure: ${finalError}`, success: false, subtaskIndex: idx, module: "planner" } });
        emit({ type: "agent.finish", level: "warn", agentSlug, data: { message: `${agentSlug} failed subtask ${idx}`, subtaskIndex: idx, success: false, module: "planner" } });

        if (db && subtaskIds[idx]) {
          db.updateTask(subtaskIds[idx]!, { status: "blocked", result: String(finalError) });
        }

        // Record reputation outcome for failure
        if (db) {
          try { db.recordAgentOutcome(agentSlug, { success: false }); } catch {}
        }

        onProgress?.(idx, "failed");

        return {
          index: idx,
          description: subtask.description,
          agent: subtask.agent,
          result: `Final Error: ${finalError}`,
          success: false,
          artifacts: [],
        };
      }
    })
  );

    for (const r of batchResults) {
      results.push(r);
      completed.add(r.index);
      const actionId = recordSubtaskAction(user?.id ?? "unknown", phase, r);
      if (actionId) actionIdByIndex.set(r.index, actionId);
    }
  }

  // Verification phase: after a consequential (execute) phase, check whether each subtask
  // actually achieved its goal and record the verdict on the ledger row. Best-effort — this
  // block must never block or crash the execution path.
  if (phase === "execute" && db) {
    await verifyExecutedSubtasks(results, phaseIndices, actionIdByIndex, user?.id ?? "unknown", db);
  }

  // Return only the results from this phase
  return results.filter((r) => phaseIndices.has(r.index));
}

/**
 * Best-effort post-execute verification. For each executed subtask, ask a cheap fast-tier
 * model whether the outcome achieved the subtask's goal and patch the ledger row with the
 * verdict. Failed subtasks short-circuit to a `failed` verdict with no model call. Never throws.
 */
async function verifyExecutedSubtasks(
  results: SubtaskResult[],
  phaseIndices: Set<number>,
  actionIdByIndex: Map<number, string>,
  userId: string,
  db: Database,
): Promise<void> {
  try {
    const toVerify = results.filter((r) => phaseIndices.has(r.index) && actionIdByIndex.has(r.index));
    await Promise.all(
      toVerify.map(async (r) => {
        const actionId = actionIdByIndex.get(r.index)!;
        try {
          const verdict = r.success
            ? await verifyOutcome({
                goal: r.description,
                result: r.result,
                agent: r.agent,
                artifacts: r.artifacts.map((a) => ({ type: a.type, value: a.value })),
              })
            : { status: "failed" as const, reason: "subtask execution failed", confidence: 0.9 };
          recordVerification(userId, actionId, verdict, db);
          emit({
            type: "agent.progress",
            level: "info",
            agentSlug: r.agent || "general",
            data: { message: `Verification: ${verdict.status} (${r.description.slice(0, 60)})`, subtaskIndex: r.index, verification: verdict, module: "planner" },
          });
        } catch (err) {
          console.debug("[planner] Verification non-critical failure:", err);
        }
      }),
    );
  } catch (err) {
    console.debug("[planner] Verification phase non-critical failure:", err);
  }
}

/**
 * Execute all subtasks (legacy — runs both phases without approval gate).
 * Kept for backward compatibility with auto-approve flow.
 */
export async function executeSubtasks(
  plan: ExecutionPlan,
  user: any,
  db: Database | null,
  parentTaskId?: string,
  onProgress?: ProgressCallback,
  workspaceDir?: string
): Promise<SubtaskResult[]> {
  const prepareResults = await executePhase(plan, "prepare", user, db, parentTaskId, undefined, undefined, onProgress, workspaceDir);
  const artifacts = await enrichArtifactsWithVision(collectArtifacts(prepareResults));

  const hasExecute = plan.subtasks.some((s) => s.phase === "execute");
  if (!hasExecute) return prepareResults;

  const executeResults = await executePhase(
    plan, "execute", user, db, parentTaskId, artifacts, prepareResults, onProgress, workspaceDir
  );

  return [...prepareResults, ...executeResults];
}

/**
 * Aggregate subtask results into a coherent final response.
 * Uses Haiku — this is formatting/synthesis, not heavy reasoning.
 * Mentions which agents contributed so the user knows who did what.
 */
export async function aggregate(
  originalRequest: string,
  results: SubtaskResult[]
): Promise<string> {
  // Even for single subtask, clean up the response to remove internal artifacts
  if (results.length === 1) {
    const raw = results[0].result;
    // Strip [ARTIFACT:] tags that are for internal planner use
    return raw.replace(/\[ARTIFACT:\s*[^\]]+\]/g, "").trim();
  }

  const resultSummary = results
    .sort((a, b) => a.index - b.index)
    .map((r) => `## [${r.agent || "general"}] ${r.description}\n${r.result}`)
    .join("\n\n---\n\n");

  const prompt = `You are synthesizing results from specialist agents into one coherent response for a Telegram user.

Original request: ${originalRequest}

Agent results:
${resultSummary}

Instructions:
- Combine into a single, well-organized response.
- Remove redundancy between agent outputs.
- Keep it concise and actionable.
- Do NOT mention "agents" or "subtasks" — present it as one unified answer.
- Preserve any actionable items, numbers, and specific recommendations.
- Use Telegram-friendly formatting (bold for headers, bullet points for lists).
- If any subtask failed or produced no verified output, clearly state what did NOT work.
- Do NOT present partial work as fully complete. Be explicit about failures.
- Never list files that weren't verified to exist on disk.
- If a WARNING about missing files appears in any result, surface it to the user.`;

  return _callClaude(prompt, "sonnet" as any);
}
