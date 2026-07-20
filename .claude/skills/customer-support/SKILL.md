---
name: customer-support
description: Customer support strategy, response drafting, de-escalation, FAQ development, support templates, ticket triage, and support analytics. This skill should be used when the user asks to draft support responses, handle customer complaints, create FAQ documents, build support playbooks, or improve customer service processes.
---

# Customer Support

This skill handles customer support operations — from drafting individual responses to building complete support systems and playbooks.

## When to Use This Skill

- Drafting responses to customer complaints, questions, or feedback
- De-escalating angry or frustrated customers
- Creating FAQ pages and knowledge bases
- Building support response templates
- Triaging and prioritizing support tickets
- Analyzing support trends and common issues
- Writing apology emails or service recovery messages
- Creating onboarding guides for customers
- Setting up support workflows and escalation paths
- Training support team members

## Response Framework

### The HEARD Method (for all support interactions)

1. **H**ear — Acknowledge what they said specifically (not generic "we understand")
2. **E**mpathize — Show you get why it's frustrating/concerning
3. **A**pologize — Take ownership (even if it's not your fault)
4. **R**esolve — State the specific action you're taking
5. **D**elight — Add something unexpected (discount, priority, extra help)

### Tone Guidelines

**Always:**
- Use the customer's name
- Write like a human, not a bot
- Be specific about next steps and timelines
- Own the problem ("I'll fix this" not "this will be looked into")
- Match their urgency level

**Never:**
- Use corporate jargon ("per our policy", "at this time")
- Blame the customer ("you should have...")
- Make promises you can't keep
- Use passive voice for accountability ("a mistake was made")
- Copy-paste generic responses without personalization

### Response Templates by Situation

#### Complaint / Something Went Wrong
```
Hey [Name],

I completely understand your frustration with [specific issue] — that's not the experience we want for you.

I've [specific action taken: issued a refund / escalated to team / fixed the issue], and you should see [result] within [timeframe].

To make up for the trouble, [delight: here's a discount / I've upgraded your account / I've added X to your account].

If anything else comes up, reply here and I'll handle it personally.

[Your name]
```

#### Feature Request
```
Hey [Name],

Love this idea — [specific thing they suggested] would definitely [benefit]. I've added it to our feature requests and flagged it for the team.

I can't promise a timeline, but I'll make sure you're the first to know if we build it.

In the meantime, here's a workaround that might help: [alternative approach].

[Your name]
```

#### Refund Request
```
Hey [Name],

Done — I've processed your refund of [amount]. It should hit your account in [3-5 business days].

No hoops to jump through. If you don't mind sharing, I'd love to know what we could have done better — helps us improve for everyone.

[Your name]
```

#### Bug Report
```
Hey [Name],

Thanks for flagging this — I was able to reproduce [the issue] and our team is on it.

Here's what I know:
- [What happened and why, if known]
- [What we're doing to fix it]
- [Expected resolution time]

I'll follow up once it's resolved. In the meantime, [workaround if available].

[Your name]
```

#### Angry / Escalated Customer
```
Hey [Name],

I hear you, and I want you to know I'm taking this seriously. [Specific issue] should never have happened, and I'm sorry it did.

Here's exactly what I'm doing right now:
1. [Immediate action]
2. [Follow-up action]
3. [Prevention measure]

I'm personally handling this — you won't get passed around. I'll update you by [specific time].

[Your name]
```

## De-escalation Playbook

### Escalation Levels

**Level 1 — Frustrated** (disappointed, inconvenienced)
- Acknowledge + fix quickly
- Response time: same day
- Resolution: standard fix + small gesture

**Level 2 — Angry** (repeated issue, feeling ignored)
- Personal response from senior person
- Response time: within 2 hours
- Resolution: fix + meaningful compensation + follow-up

**Level 3 — Threatening** (legal threats, public complaints, chargeback threats)
- Immediate escalation to owner/manager
- Response time: within 1 hour
- Resolution: whatever it takes to make it right + documented prevention plan
- Flag for owner review

### De-escalation Techniques

1. **Name it:** "I can tell this has been really frustrating" (validates without being condescending)
2. **Take their side:** "If I were in your shoes, I'd feel the same way"
3. **Break the script:** Say something unexpected and human — humor (carefully), honesty about a mistake, or going above and beyond
4. **Give control back:** "Would you prefer X or Y?" (options = perceived control)
5. **Commit to follow-up:** "I'll personally check in with you on [day]" (and actually do it)

## FAQ Development

### Building an Effective FAQ

**Process:**
1. Audit the last 100 support interactions for recurring questions
2. Group into categories (billing, product, account, shipping, etc.)
3. Write answers in conversational tone (not legalese)
4. Add internal notes for support team context
5. Review and update monthly

**FAQ Answer Format:**
```
**Q: [Question as the customer would ask it]**

[1-2 sentence direct answer]

[Additional context if needed — keep it brief]

[Link to more detailed guide if applicable]
```

**Anti-patterns to Avoid:**
- Don't bury the answer in corporate speak
- Don't redirect to "contact support" as the answer
- Don't assume technical knowledge
- Don't use FAQ to avoid actually solving problems

## Support Analytics

### Metrics to Track

| Metric | What It Tells You | Target |
|--------|-------------------|--------|
| First Response Time | How fast you acknowledge | < 2 hours (business) |
| Resolution Time | How fast you solve | < 24 hours |
| First Contact Resolution | Solved without escalation | > 70% |
| CSAT Score | Customer satisfaction | > 4.5/5 |
| Ticket Volume Trend | Demand / product issues | Decreasing |
| Common Topics | Where product needs work | Track top 5 |

### Weekly Support Review Template
```
## Support Review — Week of [Date]

**Volume:** X tickets (↑/↓ X% vs last week)
**Avg Response Time:** X hours
**Resolution Rate:** X%
**CSAT:** X/5

### Top Issues This Week
1. [Issue] — X tickets — [Status: fixed / in progress / known]
2. [Issue] — X tickets — [Status]
3. [Issue] — X tickets — [Status]

### Escalations
- [Summary of any Level 2-3 escalations]

### Action Items
- [ ] [What needs to change based on this week's data]
```

## Execution via Tools

### Gmail Integration
- Draft and send support responses
- Search for customer conversation history
- Flag and label tickets by priority
- Set up canned responses

### Notion Integration
- Maintain FAQ database
- Track support tickets and their status
- Store customer interaction notes
- Document common issues and resolutions
- Build knowledge base articles

### Browser Automation (Playwright)
- Access support platforms (Zendesk, Intercom, Freshdesk, etc.)
- Pull support analytics and reports
- Update ticket statuses
- Monitor review sites for new complaints

## Output Format

When drafting a support response, always provide:
1. **Tone assessment** (how upset is this customer, 1-5)
2. **Draft response** (ready to send)
3. **Internal note** (context for the team)
4. **Follow-up action** (what needs to happen next, if anything)
5. **Prevention note** (should this trigger a product/process change?)
