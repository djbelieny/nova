---
name: reviews-testimonials
description: Reviews and testimonials management — collecting, responding to, repurposing, and analyzing customer reviews across Google, Yelp, Facebook, Trustpilot, and other platforms. This skill should be used when the user asks to respond to reviews, collect testimonials, manage online reputation, create testimonial content, or analyze review sentiment.
---

# Reviews & Testimonials Manager

This skill handles end-to-end review and testimonial management — from monitoring and responding to reviews, to collecting testimonials and repurposing them into marketing assets.

## When to Use This Skill

- Responding to Google, Yelp, Facebook, or Trustpilot reviews
- Collecting customer testimonials (via email, SMS, or forms)
- Analyzing review sentiment and trends
- Repurposing reviews into marketing content (social posts, website copy, ads)
- Managing online reputation
- Creating review request campaigns
- Building testimonial pages or case studies
- Handling negative reviews and reputation crises
- Generating review response templates
- Monitoring competitor reviews for insights

## Review Response Framework

### Positive Reviews (4-5 stars)

**Goal:** Thank them, reinforce the positive, encourage return/referral.

**Template:**
```
[Name], this made my day! Really glad [specific thing they mentioned] hit the mark.

[Personal touch related to their experience].

We'd love to see you back — [soft next step: mention upcoming event, new product, or referral program].

— [Your name], [Business name]
```

**Rules:**
- Always mention something specific from their review (proves it's not copy-paste)
- Keep it warm and human — match their energy
- Never ask them to leave a review elsewhere in your response (platform violation)
- Respond within 24-48 hours

### Negative Reviews (1-2 stars)

**Goal:** De-escalate publicly, resolve privately, show future readers you care.

**Template:**
```
[Name], I'm sorry about [specific issue]. That's not the experience we aim for, and I want to make this right.

I'd like to [specific resolution offer] — could you reach out to [direct contact: email/phone] so we can take care of this personally?

— [Your name], [Title]
```

**Rules:**
- NEVER argue, get defensive, or blame the customer publicly
- Acknowledge the specific issue (don't be vague)
- Take the conversation offline with a direct contact method
- Respond within 24 hours (faster = better for reputation)
- After resolving, it's OK to politely ask if they'd consider updating their review
- If the review is fake/spam, flag it on the platform with evidence

### Mixed Reviews (3 stars)

**Template:**
```
[Name], thanks for the honest feedback. Great to hear [positive thing], and I hear you on [negative thing].

We're [specific action being taken to improve]. [Personal touch or invitation to try again].

— [Your name]
```

## Testimonial Collection System

### Collection Methods

**1. Post-Purchase Email Sequence:**
```
Timing: 7 days after purchase/service delivery
Subject: "Quick question, [Name]?"
Body:
Hey [Name],

Hope you're enjoying [product/service]. Quick favor — would you mind sharing a few words about your experience?

Just reply to this email with:
1. What problem were you trying to solve?
2. How did [product/service] help?
3. What would you tell someone considering it?

Takes 2 minutes and helps others find us.

[Your name]
```

**2. SMS Request:**
```
Hey [Name]! Glad we could help with [service]. Would you mind leaving a quick review? Here's the link: [Google/Yelp link]. Thanks! — [Business name]
```

**3. In-Person Ask Script:**
```
"[Name], it's been great working with you on [project]. If you have 2 minutes, a quick Google review would really help us out. I can text you the link right now."
```

**4. Video Testimonial Request:**
```
Subject: "Would you share your story? (60 seconds)"

Hey [Name],

Your results with [product/service] have been incredible — [specific result]. Would you be open to recording a quick 60-second video testimonial?

No script needed — just answer these 3 questions on your phone:
1. What was your situation before [product/service]?
2. What's different now?
3. Who would you recommend this to?

You can send it right back to this email or text it to [number].

As a thank you, [incentive: discount, free month, gift card].
```

### Optimal Timing for Requests

| Business Type | Best Time to Ask | Why |
|--------------|------------------|-----|
| Service business | Day of completion | Peak satisfaction |
| SaaS / Digital | 7-14 days after signup | Had time to see results |
| E-commerce | 5-7 days after delivery | Used the product |
| Course / Coaching | After milestone/completion | Can articulate transformation |
| Restaurant / Retail | Same day (SMS within 2 hours) | Experience is fresh |

## Repurposing Reviews into Marketing Assets

### Social Media Posts
```
Format: Screenshot of review + caption

Caption template:
"[Key quote from review]"

This is why we do what we do. [Name] came to us with [problem] and now [result].

[CTA: Want the same? Link in bio / DM us / Book a call]
```

### Website Testimonial Section
```
"[Powerful quote — 1-2 sentences max]"
— [Full name], [Title/Company or Location]
[Star rating]
[Photo if available]
```

### Ad Creative
```
Hook: "[Customer name] tried [product] and..."
Body: [Their words, lightly edited for clarity]
CTA: "Join [number]+ happy customers"
```

### Case Study Structure (from detailed testimonial)
```
1. The Challenge: What problem they faced
2. The Solution: How your product/service helped
3. The Results: Specific outcomes (numbers > feelings)
4. In Their Words: Direct quote
5. CTA: How to get similar results
```

## Review Monitoring & Analytics

### Sentiment Analysis

When analyzing reviews, categorize by:

**Themes:**
- Product/service quality
- Customer service experience
- Pricing/value perception
- Speed/delivery
- Specific features/aspects

**Sentiment Score:** Rate each review 1-5 and track monthly average

**Review Analysis Report Template:**
```
## Review Analysis — [Month/Quarter]

**Total Reviews:** X (↑/↓ vs last period)
**Average Rating:** X.X/5
**Sentiment Trend:** Improving / Stable / Declining

### Platform Breakdown
- Google: X reviews, X.X avg
- Yelp: X reviews, X.X avg
- Facebook: X reviews, X.X avg

### Top Positive Themes
1. [Theme] — mentioned in X% of positive reviews
2. [Theme] — mentioned in X%
3. [Theme] — mentioned in X%

### Top Negative Themes
1. [Theme] — mentioned in X% of negative reviews → [Action taken]
2. [Theme] — mentioned in X% → [Action taken]

### Notable Reviews
- [Quote from best review]
- [Quote from most concerning review + action plan]

### Competitor Comparison
- [Competitor A]: X.X avg rating, common praise for [X], common complaints about [Y]
- [Competitor B]: X.X avg rating, common praise for [X], common complaints about [Y]
```

## Reputation Crisis Playbook

### If You Get Hit with Multiple Negative Reviews

1. **Don't panic.** Assess if they're legitimate or coordinated/fake.
2. **Respond to every single one** within hours — use the negative review template.
3. **Take it offline** — provide direct contact for resolution.
4. **Activate happy customers** — reach out to recent satisfied customers and ask (genuinely) for reviews. Do NOT incentivize fake reviews.
5. **Document everything** — screenshots, timestamps, resolutions.
6. **Flag fake reviews** — if you have evidence of fake/competitor reviews, report to the platform with documentation.
7. **Post a public statement** if needed (only for serious situations).

## Execution via Tools

### Browser Automation (Playwright)
- Monitor Google Business Profile for new reviews
- Check Yelp, Facebook, Trustpilot for new reviews
- Post responses directly on review platforms
- Screenshot reviews for repurposing
- Monitor competitor review pages

### Gmail Integration
- Send testimonial request emails
- Follow up on pending testimonial requests
- Respond to reviews forwarded via email notifications

### Notion Integration
- Maintain a testimonial database (quote, source, rating, date, permission status)
- Track review response status
- Store review analytics reports
- Manage testimonial content calendar

### SMS (Twilio)
- Send review request texts with direct links
- Follow up on testimonial requests

## Output Format

When responding to a review, provide:
1. **Platform** (Google, Yelp, Facebook, etc.)
2. **Sentiment assessment** (positive/mixed/negative + severity 1-5)
3. **Draft response** (ready to post)
4. **Internal action item** (if any follow-up needed)
5. **Repurpose recommendation** (can this review be used in marketing?)

When collecting testimonials, provide:
1. **Outreach message** (email/SMS draft)
2. **Follow-up timing** (when to nudge if no response)
3. **Suggested incentive** (if appropriate)
4. **Usage rights note** (remind to get permission for marketing use)
