---
name: meta-ads-manager
description: Meta Ads (Facebook & Instagram) campaign management — creating campaigns, managing budgets, audience targeting, ad creative strategy, A/B testing, and performance optimization. This skill should be used when the user asks to create, manage, analyze, or optimize Facebook or Instagram ad campaigns, or needs ad strategy, copywriting, or audience targeting guidance.
---

# Meta Ads Manager

This skill handles end-to-end Meta advertising — from campaign strategy and creation to optimization and reporting across Facebook and Instagram.

## When to Use This Skill

- Creating new ad campaigns (Facebook or Instagram)
- Writing ad copy and headlines
- Defining audience targeting (custom, lookalike, interest-based)
- Setting and managing ad budgets
- Analyzing campaign performance (ROAS, CPA, CTR)
- A/B testing ad variations
- Optimizing underperforming campaigns
- Creating retargeting campaigns
- Scaling winning ads
- Generating performance reports

## Campaign Architecture

### Meta Ads Structure
```
Account
└── Campaign (objective: what you want)
    └── Ad Set (audience + budget + placement + schedule)
        └── Ad (creative + copy + CTA)
```

### Campaign Objectives (choose one per campaign)

| Objective | Use When | Key Metric |
|-----------|----------|------------|
| **Awareness** | Brand building, reach | CPM, Reach |
| **Traffic** | Drive website visits | CPC, CTR |
| **Engagement** | Post likes, comments, shares | CPE, Engagement Rate |
| **Leads** | Collect emails/phone via form | CPL, Lead Volume |
| **App Promotion** | Drive app installs | CPI, Install Volume |
| **Sales** | E-commerce conversions | ROAS, CPA, Conversion Rate |

### Budget Strategy

**Daily vs. Lifetime Budget:**
- **Daily budget:** Best for always-on campaigns. Meta spends roughly this amount each day.
- **Lifetime budget:** Best for time-limited promotions. Meta optimizes spend across the full period.

**Budget Guidelines:**
- Minimum: $5/day per ad set (Meta's minimum)
- Testing: $20-50/day per ad set to exit learning phase quickly
- Learning phase: ~50 conversions per ad set per week needed
- Scale: Increase budget by max 20% every 3 days (avoid resetting learning)

**Advantage Campaign Budget (CBO):**
- Let Meta distribute budget across ad sets automatically
- Best when you have 3+ ad sets and want Meta to find the best one
- Set minimum/maximum spend per ad set if needed

## Audience Targeting

### Targeting Layers

**1. Custom Audiences (warmest — retargeting)**
```
Source options:
- Website visitors (Pixel required)
- Customer list (email/phone upload)
- App activity
- Video viewers (25%, 50%, 75%, 95% watched)
- Instagram/Facebook engagers
- Lead form openers/submitters
```

**2. Lookalike Audiences (warm — expansion)**
```
Best sources for lookalikes:
- Top 25% customers by LTV (best performing)
- Purchasers from last 180 days
- Email subscribers
- Video viewers (95% watched = high intent)

Lookalike size:
- 1% = most similar (smallest, best quality)
- 1-3% = balanced
- 3-5% = broader reach (use for awareness)
```

**3. Interest/Demographic Targeting (coldest — prospecting)**
```
Layer interests with AND logic for precision:
- Interest A AND Interest B (narrower = better)
- Exclude existing customers
- Age, gender, location as base filters
```

### Audience Strategy by Funnel Stage

| Stage | Audience | Objective | Budget Split |
|-------|----------|-----------|-------------|
| **Top (Cold)** | Lookalike 1-3% + Interests | Awareness / Traffic | 40% |
| **Middle (Warm)** | Video viewers, engagers, site visitors | Engagement / Leads | 30% |
| **Bottom (Hot)** | Cart abandoners, past buyers, email list | Sales / Conversions | 30% |

## Ad Creative Strategy

### Ad Formats

**1. Single Image**
- Best for: clear offers, product shots, testimonials
- Image: 1080x1080 (square) or 1080x1350 (portrait)
- Keep text under 20% of image area

**2. Video**
- Best for: storytelling, demos, social proof
- Duration: 15-30 seconds (sweet spot)
- Hook in first 3 seconds (critical)
- Design for sound-off (add captions)
- Aspect: 9:16 (Stories/Reels), 1:1 (Feed), 16:9 (In-stream)

**3. Carousel**
- Best for: multiple products, step-by-step, storytelling
- 2-10 cards, each with own headline/link
- First card = strongest hook
- Last card = clear CTA

**4. Collection / Instant Experience**
- Best for: e-commerce, product catalogs
- Full-screen mobile experience
- Requires product catalog setup

### Ad Copy Frameworks

**Framework 1: Problem-Agitate-Solution (PAS)**
```
[Problem]: Tired of [pain point]?
[Agitate]: You've tried [common failed solutions]. Nothing works because [root cause].
[Solution]: [Product] fixes this by [mechanism]. [Social proof: "X customers already..."]
[CTA]: [Action] — link below.
```

**Framework 2: Before-After-Bridge (BAB)**
```
Before: [Current painful reality for customer]
After: [Dream outcome they want]
Bridge: [Your product is how they get there]
[CTA]
```

**Framework 3: Social Proof Lead**
```
"[Powerful customer quote or result]"

[Brief explanation of what the product does]
[More social proof — numbers, logos, reviews]
[CTA]
```

**Framework 4: Direct Offer**
```
[Bold headline with the offer]
[What they get — bullet points]
[Urgency/scarcity element]
[CTA button text]
```

### Headline Formulas
- "How [Audience] Can [Benefit] Without [Pain]"
- "[Number] [Audience] Already [Result]. You Next?"
- "Stop [Doing Thing Wrong]. Start [Doing Thing Right]."
- "[Result] in [Timeframe]. Guaranteed."
- "The [Product] That [Big Claim] — Try Free"

### Primary Text Best Practices
- First line = hook (visible before "See more")
- 125 characters max visible on mobile before truncation
- Short paragraphs (1-2 sentences)
- Use emojis sparingly for visual breaks
- End with clear CTA

## A/B Testing

### What to Test (in priority order)
1. **Creative** (image vs video, different visuals) — biggest impact
2. **Audience** (interest A vs B, lookalike 1% vs 3%)
3. **Copy** (different hooks, different frameworks)
4. **Headline** (benefit-led vs curiosity-led)
5. **Placement** (Feed vs Stories vs Reels)
6. **CTA button** (Learn More vs Shop Now vs Sign Up)

### Testing Protocol
- Test ONE variable at a time per test
- Budget: $20-50/day per variant minimum
- Duration: 3-7 days (need statistical significance)
- Winner criteria: lowest CPA or highest ROAS (not CTR alone)
- Kill losers after 3 days if clearly underperforming (2x+ CPA difference)
- Scale winners by 20% budget increase every 3 days

### Advantage+ Creative (Automated Testing)
- Let Meta auto-test headline, primary text, and image variations
- Provide 3-5 variations of each element
- Meta serves the best combination per user
- Review "Breakdown by Asset" to see which variations win

## Campaign Optimization

### Daily Checklist
1. Check spend vs. budget (any overspend?)
2. Review CPA/ROAS — are we hitting targets?
3. Check frequency (> 3 = ad fatigue, refresh creative)
4. Review ad-level performance — pause underperformers
5. Check for rejected ads or account issues

### Optimization Actions

| Problem | Diagnosis | Action |
|---------|-----------|--------|
| High CPM, low CTR | Creative not resonating | New creative, different hook |
| Good CTR, low conversions | Landing page issue | Fix landing page, check pixel |
| Rising CPA over time | Ad fatigue | Refresh creative, new audiences |
| Low reach | Audience too narrow | Broaden targeting or increase budget |
| Stuck in learning | Not enough conversions | Increase budget or broaden audience |
| High frequency | Same people seeing ad repeatedly | Expand audience or pause/rotate |

### Scaling Strategies

**Vertical Scaling (increase budget):**
- Increase by 20% max every 3 days
- Never double budget overnight (resets learning)
- Monitor for 48h after each increase

**Horizontal Scaling (expand reach):**
- Duplicate winning ad set with new audience
- Test new lookalike sources
- Expand geo-targeting
- Test new placements (if not using Advantage+)

**Creative Scaling:**
- Take winning ad, make 3-5 variations
- Same hook, different visual
- Same visual, different hook
- UGC version of best-performing studio ad

## Performance Metrics & Benchmarks

### Key Metrics

| Metric | Formula | Good | Great |
|--------|---------|------|-------|
| CTR (Link) | Clicks / Impressions | > 1% | > 2% |
| CPC | Spend / Clicks | < $1.50 | < $0.75 |
| CPM | Cost per 1000 impressions | < $15 | < $8 |
| CPA | Cost per acquisition | Varies by industry | Below break-even |
| ROAS | Revenue / Ad spend | > 3x | > 5x |
| Frequency | Impressions / Reach | < 3 | < 2 |
| Hook Rate (video) | 3-sec views / impressions | > 25% | > 40% |
| Hold Rate (video) | Avg watch time / video length | > 25% | > 50% |

### Weekly Report Template
```
## Meta Ads Report — Week of [Date]

### Overview
- Total Spend: $X
- Revenue Attributed: $X
- ROAS: Xx
- Total Conversions: X
- Average CPA: $X

### Campaign Breakdown
| Campaign | Spend | Conversions | CPA | ROAS | Status |
|----------|-------|-------------|-----|------|--------|
| [Name] | $X | X | $X | Xx | Active/Paused |

### Top Performing Ads
1. [Ad name] — CPA: $X, ROAS: Xx — Creative: [type]
2. [Ad name] — CPA: $X, ROAS: Xx — Creative: [type]

### Recommendations
- [Scale/pause/test recommendations]
- [New creative needed?]
- [Audience adjustments?]

### Budget Recommendation (next week)
- Current: $X/day → Recommended: $X/day
- Rationale: [why]
```

## Execution via Tools

### Nova Meta Ads Module (Primary — `src/meta-ads.ts`)

Nova has a built-in Meta Ads module at `src/meta-ads.ts`. Use it via Bash:

**Quick commands (CLI):**
```bash
bun run src/meta-ads.ts account     # Account info + spend
bun run src/meta-ads.ts campaigns   # List all campaigns
bun run src/meta-ads.ts adsets      # List all ad sets
bun run src/meta-ads.ts ads         # List all ads
bun run src/meta-ads.ts audiences   # List custom audiences
bun run src/meta-ads.ts pages       # List connected FB pages
bun run src/meta-ads.ts insights    # Last 7 days performance
bun run src/meta-ads.ts interests "keyword"  # Search targeting interests
bun run src/meta-ads.ts token       # Check token expiry
bun run src/meta-ads.ts long-token  # Exchange for 60-day token
```

**Programmatic (import in scripts):**
```typescript
import { createCampaign, createAdSet, createAd, getInsights, searchInterests } from "./src/meta-ads.ts";

// Create a campaign
const campaign = await createCampaign({
  name: "Spring Sale 2026",
  objective: "OUTCOME_SALES",
  status: "PAUSED",
});

// Get performance
const insights = await getInsights(campaign.id, { date_preset: "last_7d" });
```

**Available functions:** `getAdAccount`, `createCampaign`, `getCampaigns`, `updateCampaign`, `deleteCampaign`, `createAdSet`, `getAdSets`, `updateAdSet`, `createAd`, `getAds`, `updateAd`, `createCreative`, `uploadImage`, `getCustomAudiences`, `createCustomAudience`, `createLookalikeAudience`, `searchInterests`, `searchLocations`, `getInsights`, `getAccountInsights`, `getCampaignInsights`, `getPages`, `debugToken`, `exchangeForLongLivedToken`.

**Connected pages:** Rockin Red Light, Dj Belieny, Seed Digital Media, Bella Vita, Hempori, Inglês para Brasileiros, Reckless Love Ministries, TMP, The Chron Organization, O Corpo em Ação, Open Source Mind.

**Ad Account:** act_119658492 (D.j. Belieny, USD, America/Chicago)

**Token:** Long-lived (60 days). Run `bun run src/meta-ads.ts long-token` to refresh when expiring.

### Browser Automation (Playwright — Fallback)
If API is insufficient for a specific task, use Playwright to:
- Navigate Ads Manager at ads.facebook.com
- Screenshot current campaign performance
- Create campaigns via the web UI
- Export reports
- Check for rejected ads or policy issues

**Note:** API is strongly preferred. Browser automation is fragile, slower, and can trigger account flags if overused.

### Notion Integration
- Track campaign ideas and briefs
- Store approved ad copy and creatives
- Maintain audience targeting documentation
- Archive performance reports

### Existing Skill Integration
- Use `/competitive-ads-extractor` to analyze competitor ads before building yours
- Use `/image-gen` or `/canvas-design` for ad creative generation
- Use `/ai-video-creator` for video ad production

## Output Format

When creating a campaign, provide:
1. **Campaign name** and objective
2. **Ad set(s):** audience targeting, budget, schedule, placements
3. **Ad(s):** headline, primary text, description, CTA, visual direction
4. **A/B test plan** (what to test first)
5. **Success criteria** (target CPA/ROAS)
6. **Optimization schedule** (when to review/adjust)

When analyzing performance, provide:
1. **Top-line metrics** (spend, ROAS, CPA, conversions)
2. **Winners and losers** (which ads/audiences are working)
3. **Specific recommendations** (scale, pause, test, refresh)
4. **Budget adjustment** (increase/decrease and by how much)
