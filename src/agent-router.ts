/**
 * Agent Router
 *
 * Loads agent definitions from .claude/agents/ at startup and provides:
 * - Agent catalog for the decomposer to pick the right agent per subtask
 * - Full agent prompts with relevant skills & MCPs injected per specialist
 * - Fallback to "general" for tasks that don't match a specialist
 */

import { readFile, readdir } from "fs/promises";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const AGENTS_DIR = join(PROJECT_ROOT, ".claude", "agents");

export interface AgentDef {
  name: string;         // e.g. "Helios"
  slug: string;         // e.g. "helios" (filename without .md)
  description: string;  // one-liner from frontmatter
  prompt: string;       // full markdown body (system prompt)
}

const agents = new Map<string, AgentDef>();

// ============================================================
// AGENT ↔ TOOLS/SKILLS MAPPING
// Each agent gets instructions for the MCPs and skills they should use.
// ============================================================

const AGENT_TOOLS: Record<string, string> = {
  helios: `
TOOLS — MCP integrations:
• Go High Level MCP (gohighlevel): Create campaigns, ad sets, ads, audiences, manage contacts and pipelines for ad leads.
• Playwright (browser): Research products, landing pages, competitor ads. Take screenshots for creative reference.
• Google Workspace MCP (Sheets): Pull ad performance data from connected sheets. Save budget/performance reports.
• Square MCP: Pull sales/conversion data to measure ad-to-revenue performance.

SKILLS — Slash commands you can invoke:
• /image-gen: Generate ad creative images (multiple variations for A/B testing).
• /canvas-design: Create designed ad mockups, banners, carousel ads, story ads as PNG/PDF.
• /competitive-ads-extractor: Research competitor ads from Facebook/LinkedIn ad libraries before creating campaigns.
• /content-research-writer: Research target audiences, write ad copy with proper hooks and CTAs.
• /xlsx: Create campaign performance spreadsheets, budget breakdowns, media plans, ROAS calculators.
• /pdf: Create campaign reports and media plans as PDFs for client delivery.
• /pptx: Create ad strategy presentations and campaign pitch decks.
• /telegram-file-sender: Send generated ad images, reports, and documents to the user.

WORKFLOW: When asked to create a campaign:
1. Research the product/landing page using Playwright (visit the URL, take screenshots)
2. Analyze competitors using /competitive-ads-extractor if relevant
3. Generate ad creative images using /image-gen (create multiple variations)
4. Build the campaign structure (campaign → ad sets → ads) using Go High Level MCP
5. Send the creative images and campaign summary to the user via /telegram-file-sender
`,

  pixel: `
TOOLS — MCP integrations:
• Go High Level MCP (gohighlevel): Schedule and publish social media posts across connected accounts. Manage social calendar.
• Playwright (browser): Research trending content, view competitor profiles, check hashtag performance, screenshot reference posts.
• Google Workspace MCP (Calendar): Coordinate posting schedule with the user's calendar. (Sheets): Track engagement metrics.
• Notion MCP: Save content calendars, campaign briefs, and social media playbooks.

SKILLS — Slash commands you can invoke:
• /image-gen: Generate social media post images, story visuals, and profile graphics.
• /canvas-design: Create designed social media graphics, story templates, carousel slides, cover photos.
• /content-research-writer: Research topics for content ideas, write captions with engagement hooks.
• /xlsx: Create content calendars, engagement analytics spreadsheets, and follower growth trackers.
• /docx: Write social media strategy documents and brand voice guidelines for social.
• /pdf: Create social media reports for stakeholders.
• /competitive-ads-extractor: Analyze competitor social ad strategies.
• /telegram-file-sender: Send generated social media content, calendars, and reports to the user.

PUBLISHING WORKFLOW (execute phase):
When publishing content that has been approved:
1. Use the GHL create-post tool to publish to each target platform.
2. Set status to "PUBLISHED" for immediate posting, or "SCHEDULED" with a date if specified.
3. Include all images from the prepare phase as media attachments.
4. Use the approved caption text as the post body.
5. Default platforms: Instagram AND Facebook (unless user specified otherwise).
6. Report back the post IDs and status for each platform.
`,

  kai: `
TOOLS — MCP integrations:
• Notion MCP: Save content drafts, editorial calendars, brand guidelines, and content libraries to Notion.
• Playwright (browser): Research topics, read source material, verify facts, check competitor content.
• Google Workspace MCP (Docs): Create and edit long-form content in Google Docs. (Drive): Search reference materials.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research topics, find citations, improve hooks, iterate on outlines — primary skill.
• /docx: Create polished Word documents for articles, brand guides, whitepapers.
• /pdf: Create PDF versions of content pieces for distribution and download.
• /ghostwriter: Transform transcriptions and raw materials into complete, formatted books (DOCX + PDF).
• /xlsx: Create editorial calendars, content performance trackers, and keyword-content matrices.
• /pptx: Create content strategy presentations and editorial planning decks.
• /canvas-design: Create visual content like infographics, quote cards, and header images.
• /image-gen: Generate illustrations, blog header images, and visual aids for articles.
• /telegram-file-sender: Send finished documents and content to the user.
`,

  orion: `
TOOLS — MCP integrations:
• Gmail MCP (google-workspace): Draft, send, and schedule email campaigns. Search existing emails for templates. Manage email threads.
• Go High Level MCP (gohighlevel): Create email templates, manage email campaigns, segment contacts, set up automation sequences, track opens/clicks.
• Playwright (browser): Preview email renders, test landing pages linked from emails, research competitor email strategies.
• Notion MCP: Save email templates, campaign plans, and segmentation strategies.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research and write email copy with proper hooks, CTAs, and engagement patterns.
• /docx: Create email campaign briefs, strategy documents, and sequence maps.
• /xlsx: Create email performance reports, segmentation spreadsheets, A/B test result analysis.
• /pdf: Create email marketing reports for stakeholders.
• /pptx: Create email strategy presentations.
• /canvas-design: Design email header images and visual elements.
• /image-gen: Generate images for email content.
• /telegram-file-sender: Send reports, templates, and documents to the user.
`,

  morpheus: `
TOOLS — MCP integrations:
• Playwright (browser): Research video trends, competitor content, reference material, and platform best practices.
• Google Workspace MCP (Docs): Write and collaborate on scripts. (Drive): Store and organize video assets. (Sheets): Track production schedules.
• Notion MCP: Save video production plans, shot lists, and content calendars.

SKILLS — Slash commands you can invoke:
• /image-gen: Generate storyboard frames, thumbnail concepts, visual references, and scene mockups.
• /canvas-design: Create storyboards, shot lists, visual treatments, and thumbnail designs as PNG/PDF.
• /docx: Write video scripts with proper formatting (scene headings, dialogue, directions, timing notes).
• /pptx: Create video pitch decks, storyboard presentations, and production briefs.
• /pdf: Create finalized scripts and production documents as PDFs.
• /xlsx: Create production schedules, budget breakdowns, and shot tracking spreadsheets.
• /content-research-writer: Research video topics, audience preferences, and trending formats.
• /telegram-file-sender: Send scripts, storyboards, thumbnails, and production docs to the user.
`,

  architect: `
TOOLS — MCP integrations:
• Bash: Run commands, install packages, build, test, and deploy code. Full terminal access.
• File system (Read/Write/Edit): Create and modify source code, configs, and documentation.
• Playwright (browser): Test web applications, take screenshots, verify deployments, debug UI issues.
• Cloudflare MCP: Deploy Workers, manage DNS records, configure domains, set up edge functions.
• Supabase MCP: Create tables, run migrations, deploy edge functions, manage database schema.
• Notion MCP: Document technical specs, architecture decisions, API docs, and deployment configs.
• Google Workspace MCP (Sheets): Track project tasks and bugs. (Docs): Write technical documentation.

SKILLS — Slash commands you can invoke:
• /platform-maker: Generate complete SaaS platforms from YAML configuration (full-stack).
• /docx: Create technical documentation, API guides, and architecture decision records.
• /xlsx: Create project tracking spreadsheets, sprint plans, and dependency matrices.
• /pdf: Create technical specs and deployment runbooks as PDFs.
• /telegram-file-sender: Send generated code, docs, and deployment reports to the user.
`,

  athena: `
TOOLS — MCP integrations:
• Playwright (browser): Research markets, competitors, industry data, company profiles, financial reports.
• Notion MCP: Save strategy frameworks, competitive intel, OKRs, and planning documents.
• Google Workspace MCP (Sheets): Create and analyze financial models. (Docs): Write strategy documents. (Drive): Search reference materials.
• Square MCP: Pull business revenue data, transaction trends, and customer analytics for strategy input.
• Go High Level MCP (gohighlevel): Pull pipeline data, deal flow metrics, and CRM analytics for business strategy.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Deep research with citations for strategy documents, market analysis, and competitive intel.
• /xlsx: Create competitive analysis spreadsheets, financial models, SWOT matrices, scenario plans.
• /pptx: Create strategy presentations, pitch decks, and board meeting slides.
• /docx: Write strategy documents, business plans, and market analysis reports.
• /pdf: Create polished strategy reports for stakeholders and investors.
• /canvas-design: Create strategy frameworks, market maps, and positioning diagrams.
• /lead-research-assistant: Research potential partners, investors, or acquisition targets.
• /telegram-file-sender: Send strategy documents, presentations, and reports to the user.
`,

  cyra: `
TOOLS — MCP integrations:
• Playwright (browser): Audit websites — check page speed, mobile responsiveness, UX flows, broken links, form testing. Take screenshots of issues.
• Google Workspace MCP (Sheets): Log audit findings in spreadsheets. (Docs): Write audit reports.
• Cloudflare MCP: Check DNS configuration, SSL status, and edge caching settings.
• Notion MCP: Save audit checklists, improvement trackers, and website optimization plans.

SKILLS — Slash commands you can invoke:
• /xlsx: Create SEO audit spreadsheets, CRO tracking reports, and heatmap analysis sheets.
• /docx: Write website audit reports with recommendations, priority rankings, and implementation guides.
• /pdf: Create polished audit reports for client delivery.
• /image-gen: Create mockups and wireframes of suggested UI improvements.
• /canvas-design: Design before/after comparisons, UX flow diagrams, and wireframe mockups.
• /pptx: Create website audit presentations with findings and recommendations.
• /content-research-writer: Research UX best practices, conversion optimization techniques, and competitor UX patterns.
• /telegram-file-sender: Send audit reports, screenshots, and recommendations to the user.
`,

  magnus: `
TOOLS — MCP integrations:
• Playwright (browser): Crawl websites for SEO issues, check meta tags, analyze competitor rankings, research keywords, test structured data.
• Notion MCP: Save SEO plans, keyword tracking, content calendars, and link building campaigns.
• Google Workspace MCP (Sheets): Track keyword rankings and backlink profiles. (Docs): Write SEO briefs. (Search Console access via browser).
• Cloudflare MCP: Check DNS records, redirect rules, and caching that affects SEO.

SKILLS — Slash commands you can invoke:
• /xlsx: Create keyword research spreadsheets, content gap analyses, backlink tracking, and rank monitoring.
• /docx: Write SEO strategy documents, content briefs, and technical SEO audit reports.
• /pdf: Create SEO reports for stakeholders.
• /content-research-writer: Research and write SEO-optimized content, meta descriptions, and title tags.
• /pptx: Create SEO strategy presentations and progress reports.
• /canvas-design: Create visual SEO site architecture diagrams and internal linking maps.
• /telegram-file-sender: Send SEO reports, keyword research, and content briefs to the user.
`,

  digit: `
TOOLS — MCP integrations:
• Square MCP: Pull sales data, transaction history, revenue reports, and customer analytics.
• Go High Level MCP (gohighlevel): Pull CRM analytics, pipeline data, contact stats, and campaign metrics.
• Google Workspace MCP (Sheets): Create and analyze data in Google Sheets. (Drive): Access data files.
• Supabase MCP: Query database tables directly for custom analytics and reporting.
• Notion MCP: Save dashboards, KPI definitions, and reporting frameworks.
• Playwright (browser): Access analytics platforms, scrape data from web dashboards.

SKILLS — Slash commands you can invoke:
• /xlsx: Create dashboards, data analysis spreadsheets, KPI trackers, reporting templates, and financial models.
• /pptx: Create data presentation decks with charts, insights, and executive summaries.
• /pdf: Create polished data reports for stakeholders.
• /canvas-design: Design visual dashboard mockups and data visualization concepts.
• /docx: Write data analysis reports, methodology documents, and insight summaries.
• /content-research-writer: Research industry benchmarks and best practices for KPI setting.
• /telegram-file-sender: Send reports, spreadsheets, and dashboards to the user.
`,

  echo: `
TOOLS — MCP integrations:
• Go High Level MCP (gohighlevel): Manage contacts, conversations, send responses to customers, search/update records, manage tags and workflows for support tickets.
• Gmail MCP (google-workspace): Draft and send support emails, search email history for context, manage support inbox.
• Notion MCP: Save support templates, FAQs, escalation procedures, and knowledge base articles.
• Playwright (browser): Check customer-facing pages for issues, test support flows, research competitor support practices.
• Google Workspace MCP (Sheets): Track support metrics and ticket data.

SKILLS — Slash commands you can invoke:
• /docx: Create FAQ documents, support playbooks, response templates, and training guides.
• /xlsx: Create ticket tracking spreadsheets, support analytics, SLA monitoring, and CSAT reports.
• /pdf: Create support documentation and training materials as PDFs.
• /content-research-writer: Research best practices for customer support and draft knowledge base articles.
• /pptx: Create support team training presentations and quarterly reviews.
• /telegram-file-sender: Send support documents, templates, and reports to the user.
`,

  flux: `
TOOLS — MCP integrations:
• Playwright (browser): Audit funnels, test landing pages, check conversion flows, analyze competitor funnels, test checkout processes.
• Go High Level MCP (gohighlevel): Build funnels, create landing pages, set up automation workflows, manage pipelines, create forms.
• Google Workspace MCP (Sheets): Track conversion metrics and A/B test results. (Docs): Document funnel strategies.
• Square MCP: Pull purchase/conversion data to measure funnel revenue impact.
• Notion MCP: Save funnel maps, offer sequences, and optimization playbooks.

SKILLS — Slash commands you can invoke:
• /xlsx: Create conversion tracking spreadsheets, A/B test analysis, funnel metrics dashboards.
• /docx: Write funnel strategy documents, offer sequences, and landing page copy.
• /pdf: Create funnel strategy reports and client-facing conversion reports.
• /image-gen: Generate landing page mockups, hero images, and visual concepts.
• /canvas-design: Create funnel flow diagrams, wireframes, and offer stack visuals.
• /pptx: Create funnel strategy presentations and conversion optimization reports.
• /content-research-writer: Research conversion best practices, write persuasive landing page copy.
• /telegram-file-sender: Send funnel plans, mockups, and reports to the user.
`,

  quill: `
TOOLS — MCP integrations:
• Playwright (browser): Research grant databases, funding organizations, eligibility requirements, and submission portals.
• Notion MCP: Save grant tracking, proposal templates, submission calendars, and funder research.
• Google Workspace MCP (Docs): Draft proposals collaboratively. (Sheets): Create budget tables. (Drive): Store reference materials. (Calendar): Track submission deadlines.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research grant opportunities, funding sources, eligibility criteria, and past winners.
• /docx: Write grant applications, business proposals, and funding requests with proper formatting.
• /pdf: Create polished PDF versions of proposals for submission.
• /xlsx: Create budget spreadsheets, financial projections, cost-benefit analyses, and timeline charts.
• /pptx: Create proposal pitch decks for in-person grant presentations.
• /telegram-file-sender: Send finished proposals, budgets, and application documents to the user.
`,

  lex: `
TOOLS — MCP integrations:
• Playwright (browser): Research legal requirements, compliance standards, regulations, case law, and precedents.
• Notion MCP: Save legal templates, compliance checklists, contract tracking, and regulatory calendars.
• Google Workspace MCP (Docs): Draft and review legal documents. (Drive): Store signed contracts. (Calendar): Track legal deadlines.
• Go High Level MCP (gohighlevel): Access client records for contract management.

SKILLS — Slash commands you can invoke:
• /docx: Draft contracts, terms of service, privacy policies, NDAs, and legal documents with tracked changes.
• /pdf: Create finalized PDF versions of legal documents for signing.
• /content-research-writer: Research legal topics with proper citations, regulatory requirements, and compliance standards.
• /xlsx: Create compliance tracking spreadsheets, risk assessment matrices, and regulatory checklists.
• /pptx: Create legal briefing presentations and compliance training decks.
• /telegram-file-sender: Send legal documents, contracts, and compliance reports to the user.
`,

  helia: `
TOOLS — MCP integrations:
• Gmail MCP (google-workspace): Draft and send press outreach emails, manage media relationships, follow up with journalists.
• Playwright (browser): Research media coverage, journalist contacts, industry news, and publication editorial calendars.
• Notion MCP: Save media lists, press coverage tracking, and PR campaign plans.
• Google Workspace MCP (Docs): Write press releases. (Sheets): Track media outreach and coverage. (Calendar): Plan PR timelines.
• Go High Level MCP (gohighlevel): Manage media contacts and PR pipeline.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research media outlets, journalists, PR angles, and industry narratives.
• /docx: Write press releases, media kits, PR briefs, and talking points.
• /pdf: Create media kits and press packages as polished PDFs.
• /pptx: Create PR strategy presentations and media briefing decks.
• /image-gen: Generate press release header images and PR event visuals.
• /canvas-design: Design media kits, press one-pagers, and event invitations.
• /xlsx: Create media list spreadsheets, coverage tracking, and PR campaign analytics.
• /lead-research-assistant: Research and identify journalists, editors, and media contacts.
• /telegram-file-sender: Send PR materials, press releases, and media kits to the user.
`,

  bridge: `
TOOLS — MCP integrations:
• Gmail MCP (google-workspace): Draft partnership outreach emails, follow up on proposals, manage deal communication.
• Playwright (browser): Research potential partners' websites, offerings, market position, and financials.
• Notion MCP: Save partnership tracking, deal pipelines, and collaboration frameworks.
• Google Workspace MCP (Docs): Draft MOUs and partnership agreements. (Sheets): Track partnership pipeline. (Calendar): Schedule partner meetings.
• Go High Level MCP (gohighlevel): Manage partner contacts and deal pipeline.
• Zoom MCP: Schedule partnership meetings and demos.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research potential partners, market fit, partnership models, and industry benchmarks.
• /lead-research-assistant: Research and identify potential partner companies and key decision-makers.
• /docx: Write partnership proposals, MOUs, deal terms, and collaboration frameworks.
• /pptx: Create partnership pitch decks and co-marketing presentations.
• /pdf: Create polished partnership proposals for external sharing.
• /xlsx: Create partnership evaluation matrices, revenue share models, and deal comparison spreadsheets.
• /telegram-file-sender: Send partnership documents, proposals, and research to the user.
`,

  oracle: `
TOOLS — MCP integrations:
• Playwright (browser): Research trends, emerging technologies, market shifts, industry reports, patent filings, and startup activity.
• Notion MCP: Save trend databases, scenario plans, and foresight libraries.
• Google Workspace MCP (Docs): Write trend reports. (Sheets): Build scenario models. (Drive): Store research references.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Deep research with citations on trends, forecasts, and emerging patterns.
• /xlsx: Create trend analysis spreadsheets, scenario models, and impact assessment matrices.
• /pptx: Create trend briefing presentations and strategic foresight decks.
• /docx: Write trend reports, strategic foresight documents, and innovation roadmaps.
• /pdf: Create polished trend reports for stakeholders and board presentations.
• /canvas-design: Create trend maps, technology radar visualizations, and future scenario diagrams.
• /image-gen: Generate conceptual visuals for future scenarios and trend illustrations.
• /telegram-file-sender: Send research reports, presentations, and forecasts to the user.
`,

  cipher: `
TOOLS — MCP integrations:
• Bash: Run Python scripts, install data science packages (pandas, scikit-learn, matplotlib), execute ML models, manage environments.
• File system (Read/Write): Create and manage Python scripts, Jupyter notebooks, data files, and model outputs.
• Supabase MCP: Query databases directly for analysis, create analytics views, store model results.
• Playwright (browser): Scrape data sources, access web APIs, gather datasets, download CSVs.
• Google Workspace MCP (Sheets): Import/export data to Google Sheets. (Drive): Access data files and datasets.
• Notion MCP: Document analysis methodologies, model documentation, and experiment tracking.

SKILLS — Slash commands you can invoke:
• /xlsx: Create data analysis spreadsheets, statistical reports, and interactive pivot analyses.
• /pptx: Create data science presentations with findings, visualizations, and recommendations.
• /pdf: Create polished analysis reports and model documentation as PDFs.
• /docx: Write methodology documents, experiment reports, and data dictionaries.
• /canvas-design: Create data visualizations, chart designs, and infographic summaries.
• /telegram-file-sender: Send analysis results, visualizations, and reports to the user.
`,

  rift: `
TOOLS — MCP integrations:
• Bash: Run security scans (nmap, nikto, etc.), check configurations, test vulnerabilities, audit file permissions.
• Playwright (browser): Test web application security, check for XSS/CSRF, verify HTTPS, audit cookie settings.
• Cloudflare MCP: Check and configure DNS security, WAF rules, SSL settings, rate limiting, and DDoS protection.
• Supabase MCP: Audit database permissions, RLS policies, and API security settings.
• Google Workspace MCP: Audit workspace security settings, check sharing permissions, review access logs.
• Notion MCP: Save security checklists, incident response plans, and compliance tracking.

SKILLS — Slash commands you can invoke:
• /docx: Write security audit reports, incident response plans, and security policies.
• /xlsx: Create vulnerability tracking spreadsheets, risk assessments, and compliance matrices.
• /pdf: Create polished security reports for stakeholders and compliance auditors.
• /pptx: Create security awareness training presentations and audit summary decks.
• /content-research-writer: Research security best practices, threat intelligence, and compliance requirements.
• /telegram-file-sender: Send security reports, audit findings, and recommendations to the user.
`,

  joule: `
TOOLS — MCP integrations:
• Bash: Test API integrations, run automation scripts, configure webhooks, manage cron jobs.
• Playwright (browser): Set up automations in Zapier, Make.com, and similar platforms. Test webhook endpoints.
• Go High Level MCP (gohighlevel): Configure CRM automations, workflows, triggers, and campaign sequences.
• Google Workspace MCP: Set up calendar automations, email filters, Drive workflows, and workspace integrations.
• Cloudflare MCP: Deploy webhook Workers, set up edge automations, configure cron triggers.
• Supabase MCP: Create database triggers, edge functions, and automated data pipelines.
• Notion MCP: Document automation workflows, integration maps, and runbooks.
• Zoom MCP: Automate meeting scheduling and recording workflows.

SKILLS — Slash commands you can invoke:
• /docx: Document automation workflows, integration specs, and troubleshooting guides.
• /xlsx: Create automation inventory spreadsheets, integration maps, and ROI calculators.
• /pdf: Create automation documentation as polished PDFs.
• /canvas-design: Create workflow diagrams and integration architecture visuals.
• /pptx: Create automation strategy presentations.
• /telegram-file-sender: Send automation documentation and reports to the user.
`,

  nexus: `
TOOLS — MCP integrations:
• Playwright (browser): Research community platforms (Discord, Circle, Discourse), analyze competitor communities, monitor engagement.
• Notion MCP: Save community guidelines, member directories, event calendars, and engagement playbooks.
• Google Workspace MCP (Docs): Write community content. (Sheets): Track community metrics. (Calendar): Plan community events.
• Go High Level MCP (gohighlevel): Manage community member contacts, send announcements, track member journeys.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research community building strategies, engagement tactics, and moderation best practices.
• /docx: Write community guidelines, moderation policies, engagement playbooks, and welcome sequences.
• /xlsx: Create community metrics dashboards, growth tracking, and engagement analytics.
• /pdf: Create community onboarding guides and member handbooks as PDFs.
• /canvas-design: Create community branding, event graphics, and welcome visuals.
• /image-gen: Generate community banners, event thumbnails, and social graphics.
• /pptx: Create community strategy presentations and growth reports.
• /telegram-file-sender: Send community documents, graphics, and reports to the user.
`,

  aura: `
TOOLS — MCP integrations:
• Playwright (browser): Research competitor brands, positioning, visual identity, and messaging across websites and social media.
• Notion MCP: Save brand guidelines, voice libraries, messaging frameworks, and brand asset trackers.
• Google Workspace MCP (Docs): Write brand documents. (Drive): Store brand assets. (Slides): Create brand presentations.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research brand positioning, competitor voice, audience preferences, and industry tone trends.
• /docx: Create brand voice guidelines, messaging frameworks, tone documents, and brand bibles.
• /pptx: Create brand identity presentations and brand launch decks.
• /pdf: Create polished brand guidelines as PDFs for distribution.
• /canvas-design: Create brand mood boards, visual identity concepts, color palette sheets, and typography samples.
• /image-gen: Generate brand visual concepts, logo explorations, and style references.
• /xlsx: Create brand audit spreadsheets, competitor comparison matrices, and brand health trackers.
• /telegram-file-sender: Send brand documents, mood boards, and guidelines to the user.
`,

  zen: `
TOOLS — MCP integrations:
• Google Workspace MCP (Calendar): Review and optimize the user's calendar, create time blocks, schedule focus time, identify meeting overload. (Gmail): Set up email filters, manage inbox rules. (Docs): Create workflow documentation.
• Notion MCP: Create task boards, project trackers, productivity dashboards, and habit trackers.
• Playwright (browser): Research productivity tools, set up integrations, configure apps.
• Go High Level MCP (gohighlevel): Review and optimize the user's task pipeline and CRM workflows for efficiency.

SKILLS — Slash commands you can invoke:
• /xlsx: Create time tracking spreadsheets, productivity analytics, energy mapping worksheets, and priority matrices.
• /docx: Write productivity guides, workflow documentation, SOPs, and delegation frameworks.
• /pdf: Create productivity reports and workflow checklists as PDFs.
• /pptx: Create productivity review presentations and goal-setting decks.
• /canvas-design: Create visual productivity frameworks, time-blocking templates, and priority quadrant diagrams.
• /telegram-file-sender: Send productivity reports, schedules, and frameworks to the user.
`,

  tesseract: `
TOOLS — MCP integrations:
• Playwright (browser): Research complex systems, gather data on interconnections, study industry dynamics and feedback loops.
• Notion MCP: Save systems maps, causal loop diagrams, and leverage point analyses.
• Google Workspace MCP (Docs): Write systems analysis reports. (Sheets): Build system models and simulation data.
• Supabase MCP: Query data for systems analysis and model complex relationships.

SKILLS — Slash commands you can invoke:
• /content-research-writer: Research complex systems, interdependencies, causal relationships, and second-order effects.
• /canvas-design: Create causal loop diagrams, system maps, stock-flow diagrams, and iceberg models.
• /pptx: Create systems analysis presentations and stakeholder briefing decks.
• /docx: Write systems analysis reports with leverage point recommendations and intervention strategies.
• /xlsx: Create impact matrices, scenario analysis spreadsheets, and system dynamics models.
• /pdf: Create polished systems analysis reports for decision-makers.
• /image-gen: Generate conceptual system visualizations and mental model illustrations.
• /telegram-file-sender: Send analysis documents, diagrams, and reports to the user.
`,
};

/**
 * Load all agent definitions from .claude/agents/*.md
 * Call once at startup.
 */
export async function loadAgents(): Promise<void> {
  try {
    const files = await readdir(AGENTS_DIR);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      try {
        const content = await readFile(join(AGENTS_DIR, file), "utf-8");
        const parsed = parseFrontmatter(content);
        if (!parsed) continue;

        const slug = file.replace(/\.md$/, "").toLowerCase();
        agents.set(slug, {
          name: parsed.name || slug,
          slug,
          description: parsed.description || "",
          prompt: parsed.body,
        });
      } catch (e) {
        console.error(`Failed to load agent ${file}:`, e);
      }
    }

    console.log(`[agent-router] Loaded ${agents.size} agents: ${[...agents.keys()].join(", ")}`);
  } catch (e) {
    console.error("[agent-router] Could not read agents directory:", e);
  }
}

/**
 * Parse YAML frontmatter from a markdown file.
 */
function parseFrontmatter(content: string): { name: string; description: string; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  let name = "";
  let description = "";

  for (const line of frontmatter.split("\n")) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim();
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
  }

  return { name, description, body };
}

/**
 * Get agent by slug (e.g. "helios", "architect").
 */
export function getAgent(slug: string): AgentDef | undefined {
  return agents.get(slug.toLowerCase());
}

/**
 * Get all loaded agents.
 */
export function getAllAgents(): AgentDef[] {
  return [...agents.values()];
}

/**
 * Build the agent catalog string for the decomposer prompt.
 * Lists all available agents with their tools so Haiku routes intelligently.
 */
export function getAgentCatalog(): string {
  if (agents.size === 0) return "";

  const lines = [...agents.values()].map((a) => {
    const tools = AGENT_TOOLS[a.slug];
    const toolHint = tools
      ? ` [Tools: ${extractToolNames(tools)}]`
      : "";
    return `- "${a.slug}": ${a.name} — ${a.description}${toolHint}`;
  });

  return [
    "Available specialist agents (use the slug as the \"agent\" field):",
    ...lines,
    "",
    "Use \"general\" if no specialist fits. Prefer specialists when the subtask clearly matches one.",
    "Each specialist has access to specific MCPs and skills — route tasks to the agent whose tools match the work.",
  ].join("\n");
}

/**
 * Extract a short list of tool names from the tool instructions for the catalog.
 */
function extractToolNames(toolBlock: string): string {
  const names: string[] = [];
  const patterns = [
    /\/(\S+) skill/g,
    /(Playwright|Bash|Gmail|Notion|Square|Cloudflare|Google Calendar|Go High Level|Meta Ads)/gi,
  ];
  for (const pat of patterns) {
    for (const m of toolBlock.matchAll(pat)) {
      const name = m[1] || m[0];
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 5).join(", ") || "general tools";
}

/**
 * Extract a compact 2-3 line identity from an agent's full prompt.
 * Used for subtask execution where the full personality/playbook is unnecessary overhead.
 * Keeps the agent name, role, and core strength — drops backstory, playbook rules, etc.
 */
function getCompactIdentity(agent: AgentDef): string {
  // Extract just the first section: "# Name — Role" and the first paragraph
  const lines = agent.prompt.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# ")) || `# ${agent.name}`;

  // Find the first non-empty paragraph after the title
  let firstParagraph = "";
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith("# ")) { foundTitle = true; continue; }
    if (foundTitle && line.trim() && !line.startsWith("#")) {
      firstParagraph = line.trim();
      break;
    }
  }

  return `${titleLine}\n\n${firstParagraph}\n\nSpecialization: ${agent.description}`;
}

function getArtifactTagInstructions(workspaceDir?: string): string {
  const saveInstructions = workspaceDir
    ? `\nFILE WORKSPACE — Save ALL generated files (images, documents, etc.) to: ${workspaceDir}/
Use descriptive filenames like: slide_1_cover.png, report.docx, chart.xlsx
Do NOT save files to /tmp or random paths — always use the workspace directory above.
`
    : "";

  return `
ARTIFACT TAGGING — When you produce deliverables, tag them so the next phase can use them:
  [ARTIFACT: image | ${workspaceDir || "/path/to"}/slide_1_cover.png]
  [ARTIFACT: copy | "Your ad headline or body text here"]
  [ARTIFACT: audience | Women 25-45, interested in skincare]
  [ARTIFACT: url | https://example.com/landing-page]
  [ARTIFACT: file | ${workspaceDir || "/path/to"}/document.docx]
  [ARTIFACT: data | key finding or structured data]
${saveInstructions}
Tag every file you create, every piece of copy you write, and every key data point.
These tags are parsed automatically — the execute phase needs them to proceed.
`;
}

/**
 * Build a subtask prompt with the agent's personality + tools/skills injected.
 * Falls back to the generic buildPrompt if no agent matches.
 * phase parameter controls whether artifact tagging instructions are included.
 */
export function buildAgentPrompt(
  agentSlug: string,
  taskDescription: string,
  basePrompt: string,
  depContext?: string,
  phase?: "prepare" | "execute",
  workspaceDir?: string
): string {
  const agent = agents.get(agentSlug.toLowerCase());

  if (!agent) {
    // No specialist — use the base prompt as-is
    // Still add artifact instructions for prepare phase
    if (phase === "prepare") {
      return basePrompt + "\n\n" + getArtifactTagInstructions(workspaceDir);
    }
    return basePrompt;
  }

  const tools = AGENT_TOOLS[agentSlug.toLowerCase()] || "";

  // For subtask execution, use a compact identity instead of the full personality prompt.
  // The full prompt has playbook rules designed for interactive sessions that don't apply
  // when the agent receives a single specific subtask from the orchestrator.
  const compactIdentity = getCompactIdentity(agent);

  const parts = [
    compactIdentity,
    "",
    "---",
    "",
    "You are responding via Telegram. Keep responses concise and well-formatted.",
    "You have FULL access to all tools below. USE THEM — do not just describe what to do, actually do it.",
    "",
  ];

  if (tools) {
    parts.push(tools);
    parts.push("");
  }

  parts.push(
    "IMPORTANT EXECUTION RULES:",
    "- Actually execute actions using the tools listed above. Do not just outline steps.",
    "- Generate real images using /image-gen when visuals are needed.",
    "- Create real files using /docx, /xlsx, /pptx when documents are needed.",
    "- Use MCP tools to interact with real APIs (Meta Ads, Google, Notion, etc.).",
    "- Send deliverables to the user via /telegram-file-sender.",
    "- If a tool fails, note the error and try an alternative approach.",
    ""
  );

  // Add artifact tagging for prepare-phase subtasks
  if (phase === "prepare") {
    parts.push(getArtifactTagInstructions(workspaceDir));
    parts.push("");
  }

  if (depContext) {
    parts.push("Context from prior steps:");
    parts.push(depContext);
    parts.push("");
  }

  parts.push(`Task: ${taskDescription}`);

  return parts.join("\n");
}
