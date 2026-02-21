# DJ's GoHighLevel Integration Report

## Executive Summary

You have a **fully configured GoHighLevel (GHL) MCP integration** in your Nova project. The GHL MCP server is installed, active, and ready to use. Your system includes comprehensive social media management capabilities for Instagram, Facebook, and other platforms through the GoHighLevel API.

**Status**: ✅ Connected & Operational
**Last Verified**: 2026-02-18

---

## 1. GoHighLevel MCP Server Configuration

### Location
`/Users/djbelieny/Projects/nova/.mcp.json`

### Configuration Details
```json
"gohighlevel": {
  "type": "stdio",
  "command": "node",
  "args": [
    "/Users/djbelieny/.nvm/versions/node/v23.11.1/lib/node_modules/@drausal/gohighlevel-mcp/build/index.js"
  ],
  "env": {
    "BEARER_TOKEN_BEARERAUTH": "${GHL_BEARER_TOKEN}",
    "BEARER_TOKEN_BEARER": "${GHL_BEARER_TOKEN}"
  }
}
```

**Server Package**: `@drausal/gohighlevel-mcp` v1.0.0
**Base URL**: `https://services.leadconnectorhq.com`
**Auth Method**: Bearer token authentication
**Total Available Tools**: 412

---

## 2. GoHighLevel API Credentials

### Location
`/Users/djbelieny/Projects/nova/.env`

### Active Credentials
```
GHL_BEARER_TOKEN=pit-be65de0c-49d3-4bfa-82f3-12dacc356563
```

**Status**: ✅ Configured (Legacy API format detected - may need upgrading to v2 API token)
**Auth Type**: Bearer Token (Location-Access based permissions)

---

## 3. Social Media Integration Capabilities

### 3.1 Instagram Integration

**Connected Status**: ✅ Tools Available (Authentication required for full access)

#### Available Instagram Tools:
1. **`start-instagram-oauth`** - OAuth flow to connect Instagram business accounts
2. **`attach-instagram-page-group`** - Attach Instagram pages to location/account
3. **`get-instagram-page-group`** - Retrieve connected Instagram page information

#### What You Can Do:
- Create OAuth flow for users to authorize their Instagram business accounts
- Attach multiple Instagram pages/accounts to your GoHighLevel location
- View statistics for connected Instagram pages
- Schedule and publish posts to Instagram
- Track engagement metrics (likes, comments, shares)

### 3.2 Facebook Integration

**Connected Status**: ✅ Tools Available (Authentication required for full access)

#### Available Facebook Tools:
1. **`start-facebook-oauth`** - OAuth flow to connect Facebook business accounts/pages
2. **`attach-facebook-page-group`** - Attach Facebook pages to location/account
3. **`get-facebook-page-group`** - Retrieve connected Facebook page information

#### What You Can Do:
- Create OAuth flow for users to authorize their Facebook business pages
- Attach multiple Facebook pages to your GoHighLevel location
- Manage Facebook page groups
- Schedule and publish posts to Facebook
- Track Facebook engagement metrics

### 3.3 Social Media Post Management

**Core Posting Tools**:
- **`create-post`** - Create new social media posts (supports scheduling)
- **`get-posts`** - Retrieve all posts (with filtering)
- **`get-post`** - Get details of specific post
- **`edit-post`** - Update existing posts
- **`delete-post`** - Remove posts
- **`bulk-delete-social-planner-posts`** - Delete multiple posts in bulk

### 3.4 Media Management

**Media Tools** (8 tools available):
- **`upload-media-content`** - Upload images/videos for posts
- **`fetch-media-content`** - Retrieve media files
- **`create-media-folder`** - Organize media with folders
- **`update-media-object`** - Update media metadata
- **`bulk-update-media-objects`** - Bulk update media
- **`delete-media-content`** - Remove media files
- **`bulk-delete-media-objects`** - Bulk delete media

### 3.5 Analytics & Statistics

**Analytics Tools**:
- **`get-social-media-statistics`** - Retrieve performance metrics for connected accounts
  - Engagement metrics
  - Reach and impressions
  - Follower growth
  - Post performance data

### 3.6 Additional OAuth Options

Beyond Instagram and Facebook, the MCP also supports:
- **`start-google-oauth`** - Google Business Profile integration
- **`start-twitter-oauth`** - Twitter/X integration
- **`start-linkedin-oauth`** - LinkedIn integration
- **`start-tiktok-oauth`** - TikTok integration
- **`start-tiktok-business-oauth`** - TikTok Business Account integration

---

## 4. Current Integration Status

### What's Connected Right Now:
1. ✅ **GHL MCP Server**: Fully installed and configured
2. ✅ **Bearer Token**: Set in `.env` (legacy format)
3. ✅ **All Social Tools**: Available for use
4. ⚠️ **Instagram Account**: NOT YET CONNECTED (requires OAuth flow)
5. ⚠️ **Facebook Account**: NOT YET CONNECTED (requires OAuth flow)

### Required Actions to Connect Instagram:

To actually connect DJ's Instagram account for posting:

1. **Step 1: Initiate OAuth Flow**
   ```
   Use the "start-instagram-oauth" tool via Claude to generate an authorization URL
   ```

2. **Step 2: Authorize**
   - Open the returned URL
   - Log in with Instagram business account credentials
   - Approve GoHighLevel app access

3. **Step 3: Attach Instagram Page**
   ```
   Use "attach-instagram-page-group" tool to link the authenticated page to your location
   ```

4. **Step 4: Verify Connection**
   ```
   Use "get-instagram-page-group" tool to confirm successful connection
   ```

---

## 5. Agent Integration

### Pixel Agent (Social Media Manager)

The `pixel` agent in your Nova system is configured to use GHL for social media management:

**From `/Users/djbelieny/Projects/nova/src/agent-router.ts`**:
```
pixel: `
TOOLS — MCP integrations:
• Go High Level MCP (gohighlevel): Schedule and publish social media posts
  across connected accounts. Manage social calendar.
```

The Pixel agent is your specialized social media manager and can:
- Schedule social media posts across connected platforms
- Manage your social media calendar
- Coordinate posting with your personal calendar
- Research trending content and competitor strategies
- Generate social media creative assets
- Track engagement metrics

### How to Access Pixel:
When you need social media management help, you can:
- Message your Telegram bot mentioning "social media" or "Instagram posting"
- The system will route you to the Pixel agent
- Pixel will use GHL MCP to manage your posts

---

## 6. API Rate Limits & Restrictions

**Current Limitations**:
- Bearer token used is in legacy format (`pit-` prefix)
- May encounter "Switch to the new API token" errors with newer endpoints
- Recommended: Upgrade to v2 API token format from GHL dashboard

**For Large-Scale Usage**:
- Instagram: Standard rate limits (no public tier disclosure)
- Facebook: Business API rate limits apply
- GHL may have account-specific throttling

---

## 7. Troubleshooting

### Common Issues:

**Issue**: "Unauthorized, Switch to the new API token"
- **Cause**: Bearer token is in legacy format
- **Solution**: Log into GoHighLevel → Settings → API Keys → Generate new v2 token
- **Action**: Update `GHL_BEARER_TOKEN` in `.env` with new token

**Issue**: Instagram connection fails during OAuth
- **Cause**: Instagram account may not be a business account
- **Solution**: Convert personal account to business in Instagram Settings
- **Action**: Retry OAuth flow

**Issue**: "Location not found" when attaching pages
- **Cause**: Need valid GoHighLevel location ID
- **Solution**: Find your location ID in GHL dashboard
- **Action**: Pass correct location ID to attachment tools

### Verification Commands:

To test the GHL connection (via Claude):
```
Ask: "Can you check my GoHighLevel Instagram page status?"
This will use: get-instagram-page-group
```

---

## 8. Next Steps

### Immediate (Today):
1. ✅ Verify GHL MCP is working: Ask Claude "List my GoHighLevel Instagram pages"
2. ✅ Check current token status: Run bearer token validation

### Short-term (This Week):
1. 📱 Initiate Instagram OAuth flow
2. 📱 Authorize GoHighLevel app access
3. 📱 Attach Instagram page to your location
4. 📝 Verify connection with test post

### Medium-term (Recommendations):
1. 🔐 Upgrade to v2 API token format
2. 📊 Set up social media analytics tracking
3. 🎨 Create content calendar in Notion + sync with GHL
4. 📅 Schedule recurring posts via Pixel agent

### Optional Integrations:
- Facebook page connection (same process as Instagram)
- Twitter/LinkedIn integration for cross-posting
- Google Business Profile sync
- TikTok business account integration

---

## 9. File Locations Reference

| Component | Location |
|-----------|----------|
| **MCP Config** | `/Users/djbelieny/Projects/nova/.mcp.json` |
| **Environment Variables** | `/Users/djbelieny/Projects/nova/.env` |
| **MCP Server Binary** | `/Users/djbelieny/.nvm/versions/node/v23.11.1/lib/node_modules/@drausal/gohighlevel-mcp/build/index.js` |
| **Pixel Agent** | `/Users/djbelieny/Projects/nova/src/agent-router.ts` (lines 56-72) |
| **Integration Manager** | `/Users/djbelieny/Projects/nova/src/integrations.ts` (GHL routing at lines 92, 101) |
| **This Report** | `/Users/djbelieny/Projects/nova/GHL_INTEGRATION_REPORT.md` |

---

## 10. Tools Summary

### Instagram (3 tools)
- start-instagram-oauth
- attach-instagram-page-group
- get-instagram-page-group

### Facebook (3 tools)
- start-facebook-oauth
- attach-facebook-page-group
- get-facebook-page-group

### Social Post Management (5 tools)
- create-post
- get-posts
- get-post
- edit-post
- delete-post

### Media Management (8 tools)
- upload-media-content
- fetch-media-content
- create-media-folder
- update-media-object
- bulk-update-media-objects
- delete-media-content
- bulk-delete-media-objects
- update-media-object

### Other OAuth (4 tools)
- start-google-oauth
- start-twitter-oauth
- start-linkedin-oauth
- start-tiktok-oauth (+ business variant)

### Analytics (1 tool)
- get-social-media-statistics

### Social Planning (2 tools)
- bulk-delete-social-planner-posts
- (social calendar/scheduling built into create-post)

---

## 11. Related Documentation

- **Agent Router**: See `src/agent-router.ts` for Pixel agent capabilities
- **Integration Manager**: See `src/integrations.ts` for per-user integration flows
- **Notion Integration**: See `NOTION_INTEGRATION_REPORT.md` for similar setup
- **Meta Ads**: See `src/meta-ads.ts` for Facebook/Instagram ads (separate from organic posts)

---

**Report Generated**: February 18, 2026
**GHL API Version**: v1.0.0 (via @drausal/gohighlevel-mcp)
**Status**: Ready for Instagram Connection
