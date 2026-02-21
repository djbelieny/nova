# How to Connect Your Instagram Account to GoHighLevel

This guide walks you through connecting DJ's Instagram account to the Nova social media management system.

## Prerequisites

Before starting, ensure:
- [ ] You have a **Facebook Business Account** (created at business.facebook.com)
- [ ] You have an **Instagram Business Account** (linked to the Facebook Business Account)
- [ ] Your Instagram account has business features enabled
- [ ] You have admin or editor access to both accounts
- [ ] You are logged out of personal Instagram/Facebook in your browser (or use private browsing)

### Convert Personal Instagram to Business Account (If Needed)
1. Open Instagram → Settings → Account Type and Resources
2. Select "Switch to Professional Account"
3. Choose "Business"
4. Select "Connect Business Account" → follow prompts to link to Facebook Business Account
5. Complete business profile setup with website, phone, email, etc.

---

## Step 1: Initiate Instagram OAuth Flow

Open a Telegram chat with your Nova bot and send this message:

```
Can you start the Instagram connection process? Use start-instagram-oauth tool.
```

Or, you can ask Claude directly:

```
I need to connect my Instagram account to GoHighLevel. Can you use the start-instagram-oauth tool?
```

### What Claude will do:
- Call the `start-instagram-oauth` GHL tool
- Return an authorization URL that looks like:
  ```
  https://lead-connector-oauth.leadconnectorhq.com/instagram/authorize?...
  ```

### What you do:
1. Copy the full URL provided by Claude
2. Open it in a **new browser tab**
3. You'll be redirected to authorize GoHighLevel access to Instagram

---

## Step 2: Authorize GoHighLevel

When you open the authorization URL:

1. **Log In**: Sign in with your **Facebook Business Account** credentials (not personal)
   - Use your business email/password
   - If you get a 2FA prompt, complete it

2. **Grant Permissions**: Review and approve the following scopes:
   - `instagram_graph_api`
   - `instagram_basic`
   - `instagram_manage_posts`
   - `instagram_manage_media`
   - `pages_read_engagement`
   - `pages_manage_metadata`

3. **Select Instagram Account**: When prompted, select your Instagram business account from the list

4. **Confirm**: Click "Authorize" or "Allow" to grant GoHighLevel permission

### After Authorization:
- You'll be redirected back to GoHighLevel
- A **confirmation message** will appear
- Keep this browser tab open or copy any token/confirmation provided

---

## Step 3: Verify the Connection in GoHighLevel

1. Log into your GoHighLevel account (gohighlevel.com)
2. Go to **Settings** → **Connected Accounts** (or **Integrations**)
3. Look for **Instagram** section
4. Verify your Instagram business account is listed as "Connected"

### If it doesn't appear:
- Refresh the page
- Wait 30 seconds (processing can take a moment)
- Retry the authorization flow

---

## Step 4: Attach Instagram Page to Your Location

Once Instagram is authorized in GHL, attach it to your Nova location:

Ask your Nova bot or Claude:

```
I've connected my Instagram account. Can you attach my Instagram page to my location?
Use the attach-instagram-page-group tool.
```

**Parameters Claude will need:**
- `Version`: 2021-07-28 (default)
- `locationId`: Your GoHighLevel location ID
- `requestBody`: Instagram page details from the authorization

### Note:
- Your location ID can be found in GoHighLevel dashboard → Settings → Location
- Copy it and provide to Claude if needed

---

## Step 5: Verify Instagram Connection

Test that everything works:

Ask your Nova bot:

```
Can you check my Instagram pages? Use get-instagram-page-group tool to list my connected Instagram accounts.
```

### Expected Response:
You should see something like:
```
{
  "pageGroup": [
    {
      "id": "instagram_page_id",
      "name": "Your Instagram Business Account",
      "username": "@yourusername",
      "followers": 12345,
      "connected": true
    }
  ]
}
```

If you get this, you're connected! ✅

---

## Step 6: Create Your First Test Post

Once connected, schedule a test post:

Ask your Nova bot (or Claude with Pixel agent):

```
I want to post on Instagram. Here's what I want to say: "Testing my nova social media manager! This is the first post via automation."
Can you schedule this for 30 minutes from now?
```

### Claude will:
1. Call `create-post` tool with your message
2. Set status to "SCHEDULED"
3. Return post ID and scheduling time

### After 30 minutes:
- Check your Instagram account
- You should see the post published (or see it in "Scheduled" if it's within an hour)

---

## Troubleshooting

### Problem: "Invalid OAuth Token" or Authorization Fails

**Cause**: Wrong account type logged in (personal instead of business)

**Solution**:
1. Open the authorization URL in an **Incognito/Private browser window**
2. Log out of all Instagram/Facebook sessions first
3. Log back in with your **Business Account** email
4. Try authorization again

---

### Problem: "Instagram Account Not Eligible"

**Cause**: Your account doesn't meet Instagram business requirements

**Solution**:
1. Make sure your Instagram account is **Business type** (not Creator or Personal)
2. Ensure it's linked to your **Facebook Business Page**
3. Wait 24 hours after linking (Instagram sometimes delays eligibility)
4. Retry authorization

---

### Problem: "Location ID Not Found" or "Unauthorized"

**Cause**: Missing or invalid GHL location ID

**Solution**:
1. Log into GoHighLevel
2. Go to **Settings** → **Location Settings**
3. Copy the location ID from the URL or settings
4. Provide to Claude: "My location ID is: `paste_here`"
5. Retry the attach command

---

### Problem: "Scope Not Granted" or Missing Permissions

**Cause**: Instagram Business Account doesn't have all required permissions

**Solution**:
1. Go to Instagram Business Settings → Apps and Websites
2. Find "Go High Level" in Connected Apps
3. Click it and verify all scopes are granted
4. If grayed out, remove the app and retry authorization from Step 1

---

### Problem: Post Doesn't Appear After Scheduling

**Cause**:
- Post is still in "Scheduled" status (will auto-publish at scheduled time)
- Instagram account restrictions
- Rate limiting

**Solution**:
1. Check GoHighLevel dashboard → Social Planner → Scheduled Posts
2. Verify post status (SCHEDULED vs PUBLISHED)
3. If time has passed, click "Publish Now" in GoHighLevel
4. If still failing, check Instagram account for restrictions (spam filters, action blocks)

---

## Managing Posts After Connection

### Schedule Posts
```
Command: "Schedule a post on Instagram: [your message]"
Time: "in 2 hours"
Tool Used: create-post
```

### View Scheduled/Published Posts
```
Command: "Show me all my scheduled Instagram posts"
Tool Used: get-posts
```

### Edit a Post
```
Command: "Edit my last Instagram post to say: [new text]"
Tool Used: edit-post
```

### Delete a Post
```
Command: "Delete the post I just scheduled"
Tool Used: delete-post
```

### View Analytics
```
Command: "Show me my Instagram statistics"
Tool Used: get-social-media-statistics
```

---

## What Happens Behind the Scenes

When you authorize Instagram:

1. **OAuth Flow**: Your browser redirects to GoHighLevel OAuth endpoint
2. **Token Exchange**: GHL exchanges auth code for access tokens
3. **Token Storage**: GHL stores tokens in their secure vault (not in Nova)
4. **API Access**: Nova's GHL MCP uses your tokens to manage posts
5. **Permission Checks**: Each API call verifies Instagram permissions

### Security Notes:
- Your Instagram password is **never** shared with Nova
- Only OAuth tokens are used (no password storage)
- GoHighLevel handles all token encryption
- You can revoke access anytime from Instagram Business Settings

---

## Connecting Additional Platforms

Once Instagram is working, you can also connect:

### Facebook Pages
```
Use: start-facebook-oauth (same process as Instagram)
```

### TikTok Business
```
Use: start-tiktok-business-oauth
```

### Twitter/X
```
Use: start-twitter-oauth
```

### LinkedIn
```
Use: start-linkedin-oauth
```

### Google Business Profile
```
Use: start-google-oauth
```

---

## Full Integration Timeline

| Step | Time | What Happens |
|------|------|--------------|
| 1 | 2 min | Request OAuth flow from Nova |
| 2 | 3-5 min | Authorize in browser window |
| 3 | 1 min | Verify in GoHighLevel dashboard |
| 4 | 2 min | Attach page to location |
| 5 | 1 min | Verify connection works |
| 6 | 30 sec + wait | Create test post |
| **Total** | **10-15 min + wait time** | Full setup complete |

---

## Support & Reference

### In Nova System:
- **Pixel Agent**: Handles all social media management
- **GHL MCP**: 412 total tools available, 42 social media related

### In GHL:
- Dashboard: https://app.leadconnectorhq.com
- Settings: Account → Connected Accounts
- Social Planner: Main → Social/Calendar → Social

### Useful Commands:
```
"How do I schedule an Instagram post?"
"Show me my Instagram statistics"
"Can you post this to Instagram for me?"
"Schedule an Instagram post for tomorrow at 9am"
"Publish my scheduled posts"
```

---

## Tips for Success

1. **Use Business Account**: Always authorize with your business account email
2. **Wait for Processing**: Give GHL 30 seconds to process OAuth
3. **Test First**: Always test with a simple post before scheduling important ones
4. **Timezone Aware**: Scheduled times use your set timezone (America/New_York in `.env`)
5. **Batch Posts**: Pixel agent can schedule multiple posts in one request
6. **Monitor Analytics**: Check `get-social-media-statistics` weekly to track engagement

---

## Quick Start Command Cheat Sheet

### First Time Setup:
```
"Start Instagram connection"
→ "Check my Instagram is connected"
→ "Schedule a test Instagram post"
→ "Verify the post was published"
```

### Daily Usage:
```
"Schedule 3 Instagram posts for tomorrow at 9am, 12pm, 3pm"
→ "Show my scheduled posts"
→ "Cancel the 12pm post"
→ "Show my Instagram statistics for last week"
```

---

**Status**: Ready to Connect
**Estimated Setup Time**: 15 minutes
**Next Action**: Ask Nova bot to start Instagram OAuth flow
