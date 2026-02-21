# GoHighLevel Instagram — Quick Start (5 minutes)

## Status Right Now
✅ MCP server installed
✅ Tools available (42 social media tools)
✅ Pixel agent ready
❌ Instagram NOT connected yet

## 3-Step Setup

### Step 1: Start OAuth (2 minutes)
Open Telegram and message your Nova bot:
```
Can you start my Instagram connection?
Use the start-instagram-oauth tool.
```

Copy the authorization URL from Claude's response.

### Step 2: Authorize (2 minutes)
1. Click the URL in a **new browser tab**
2. Log in with your **Facebook Business Account** (not personal!)
3. Select your Instagram business account
4. Click "Authorize" or "Allow"

### Step 3: Verify (1 minute)
Ask your bot:
```
Are my Instagram pages connected now?
Use get-instagram-page-group to check.
```

Should return your Instagram account info if successful ✅

## That's It!

Now you can:
```
"Schedule an Instagram post for tomorrow at 9am: [message]"
"Post this to Instagram right now: [message]"
"Show my Instagram statistics"
```

## Troubleshooting (30 seconds)

### Problem: Authorization fails
→ Make sure you're using Facebook Business Account email
→ Try in incognito/private browser window
→ Allow all permissions when prompted

### Problem: Instagram page not found
→ Make sure account is Business type (not Personal/Creator)
→ Wait 24 hours if just converted to Business
→ Check Instagram is linked to Facebook Business Page

### Problem: Token error after authorization
→ Your token might need upgrade (pit- is legacy)
→ Optional: Update to v2 token in GoHighLevel Settings
→ Current token still works fine

## File Reference

| For... | Open This |
|--------|-----------|
| **Step-by-step guide** | GHL_INSTAGRAM_SETUP.md |
| **Full integration info** | GHL_INTEGRATION_REPORT.md |
| **Technical details** | GHL_TECHNICAL_REFERENCE.md |
| **Everything at a glance** | GHL_SUMMARY.txt |

## Next Steps

**Immediate:**
```
Ask your Nova bot: "Start my Instagram connection"
```

**Once connected:**
```
"Schedule 3 Instagram posts for tomorrow at 9am, 12pm, 3pm"
```

**Bonus:**
```
"Show me my Instagram analytics for last week"
"Generate Instagram post ideas about [topic]"
"Create an Instagram content calendar for February"
```

---

**Time to Instagram posting:** 5 minutes to setup + posts live when scheduled
**Questions?** Check GHL_INSTAGRAM_SETUP.md Troubleshooting section
**Ready?** Open Telegram and ask Nova to start your Instagram connection!
