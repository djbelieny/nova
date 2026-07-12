---
name: email-marketing
description: Email marketing strategy, campaign creation, automation sequences, newsletter drafting, audience segmentation, and performance analysis. This skill should be used when the user asks to create email campaigns, write newsletters, set up drip sequences, manage email lists, or analyze email marketing performance.
---

# Email Marketing

This skill handles end-to-end email marketing — from strategy and copywriting to campaign execution and performance analysis.

## When to Use This Skill

- Drafting newsletters or email campaigns
- Creating automated email sequences (welcome, onboarding, nurture, re-engagement, abandoned cart)
- Writing subject lines and preview text
- Segmenting email audiences
- Analyzing email campaign performance (open rates, CTR, conversions)
- Planning email marketing calendars
- A/B testing email variations
- Creating lead magnets and opt-in sequences
- Writing transactional emails (order confirmations, receipts, shipping updates)

## Capabilities

### 1. Campaign Strategy

**Email Types You Can Create:**
- Newsletters (weekly/monthly updates, curated content)
- Promotional emails (launches, sales, limited offers)
- Drip sequences (automated series triggered by actions)
- Welcome sequences (new subscriber onboarding)
- Re-engagement campaigns (win-back inactive subscribers)
- Event invitations and follow-ups
- Educational series (courses, tips, how-tos)
- Transactional emails (receipts, confirmations, shipping)

**Strategy Framework:**
1. Define the goal (awareness, engagement, conversion, retention)
2. Identify the audience segment
3. Choose email type and frequency
4. Write copy following proven frameworks
5. Design layout structure
6. Set up automation triggers
7. Define success metrics

### 2. Copywriting Frameworks

**Subject Line Formulas:**
- Curiosity gap: "The one thing most [audience] get wrong about [topic]"
- Urgency: "[First name], this expires in 24 hours"
- Benefit-led: "How to [achieve result] without [pain point]"
- Social proof: "[Number] people already [action] — here's why"
- Question: "Are you still [struggling with X]?"
- Personalized: "[First name], I noticed you [action]..."

**Email Body Frameworks:**
- **PAS** (Problem-Agitate-Solve): Identify pain → amplify it → present solution
- **AIDA** (Attention-Interest-Desire-Action): Hook → engage → create want → CTA
- **BAB** (Before-After-Bridge): Current state → desired state → how to get there
- **4Ps** (Promise-Picture-Proof-Push): Make promise → paint picture → show evidence → CTA
- **Story-Lesson-CTA**: Share relatable story → extract insight → drive action

**Best Practices:**
- One primary CTA per email (secondary CTA allowed in PS)
- Write at 6th-8th grade reading level
- Front-load value in the first 2 lines (preview text)
- Use the recipient's name in subject line (increases open rate ~20%)
- Keep paragraphs to 1-3 sentences max
- Use white space liberally — emails are scanned, not read
- PS line gets high readership — use it for secondary offers or urgency

### 3. Automation Sequences

**Welcome Sequence (5-7 emails over 14 days):**
```
Email 1 (Day 0): Welcome + deliver lead magnet + set expectations
Email 2 (Day 1): Your story / origin — build connection
Email 3 (Day 3): Quick win / actionable tip — deliver value
Email 4 (Day 5): Case study / social proof — build trust
Email 5 (Day 7): Soft pitch — introduce your offer
Email 6 (Day 10): Handle objections — FAQ style
Email 7 (Day 14): Direct offer + urgency/scarcity
```

**Nurture Sequence (ongoing, weekly):**
```
Week 1: Educational content (how-to, tips)
Week 2: Story/case study
Week 3: Curated resources + your take
Week 4: Promotional/offer email
Repeat cycle
```

**Re-engagement Sequence (3 emails over 10 days):**
```
Email 1 (Day 0): "We miss you" + value reminder
Email 2 (Day 5): Best content recap / exclusive offer
Email 3 (Day 10): Last chance / unsubscribe warning
→ If no engagement: auto-remove from active list
```

### 4. Segmentation Strategy

**Behavioral Segments:**
- New subscribers (< 30 days)
- Engaged readers (opened 3+ of last 5 emails)
- Inactive (no opens in 60+ days)
- Buyers vs. non-buyers
- Product/topic interest (based on clicks)
- Lead magnet source (which opt-in they used)

**Demographic Segments:**
- Location/timezone (for send time optimization)
- Industry/role (for B2B)
- Purchase history / lifetime value

### 5. Performance Analysis

**Key Metrics & Benchmarks:**
| Metric | Good | Great | Action if Low |
|--------|------|-------|---------------|
| Open Rate | 20-25% | 30%+ | Improve subject lines, clean list |
| Click Rate | 2-3% | 5%+ | Better CTAs, more relevant content |
| Unsubscribe | < 0.5% | < 0.2% | Check frequency, improve targeting |
| Bounce Rate | < 2% | < 0.5% | Clean list, verify emails |
| Conversion | 1-2% | 3%+ | Improve offer, landing page |

**Deliverability Checklist:**
- Authenticate domain (SPF, DKIM, DMARC)
- Warm up new sending domains gradually
- Maintain clean list (remove bounces, unengaged)
- Avoid spam trigger words in subject lines
- Include physical address and unsubscribe link
- Text-to-image ratio should favor text
- Send from a real person's name, not "noreply"

### 6. A/B Testing

**What to Test (in priority order):**
1. Subject lines (biggest impact on open rates)
2. Send time/day
3. CTA text and placement
4. Email length (short vs. long)
5. Personalization level
6. From name

**Testing Protocol:**
- Test ONE variable at a time
- Minimum sample: 1,000 per variant (or 20% of list)
- Wait 24-48 hours before declaring winner
- Document results for future reference

## Execution via Tools

### Gmail (Direct Send)
For 1:1 or small batch emails, use Gmail integration:
- Draft and send personalized emails
- Follow up on threads
- Schedule sends for optimal times

### Browser Automation (Playwright)
For email platforms (Mailchimp, ConvertKit, Beehiiv, etc.):
- Navigate to the platform dashboard
- Create campaigns, set up automations
- Import/export subscriber lists
- Pull analytics and reports
- Set up A/B tests

### Notion Integration
- Maintain email content calendar in Notion
- Track campaign performance in a Notion database
- Store email templates and swipe files
- Document audience segments and their preferences

## Output Formats

When asked to create an email, always provide:
1. **Subject line** (+ 2 alternatives for A/B testing)
2. **Preview text** (40-90 characters)
3. **Email body** (formatted for easy copy-paste)
4. **CTA button text**
5. **Suggested send time** (based on audience timezone)
6. **Segment recommendation** (who should receive this)

When asked to create a sequence, provide:
1. Sequence overview (goal, trigger, duration)
2. Each email with timing, subject, body, and CTA
3. Branch logic (if applicable)
4. Exit conditions
5. Success metrics to track
