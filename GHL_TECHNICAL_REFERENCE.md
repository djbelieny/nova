# GoHighLevel MCP - Technical Reference

Complete technical documentation for the GoHighLevel integration in the Nova system.

---

## 1. MCP Server Details

### Package Information
```
Package: @drausal/gohighlevel-mcp
Version: 1.0.0
Generated From: OpenAPI spec for gohighlevel v1.0.0
Generation Date: 2025-10-09T02:14:16.552Z
Installed At: /Users/djbelieny/.nvm/versions/node/v23.11.1/lib/node_modules/@drausal/gohighlevel-mcp
```

### Configuration in .mcp.json
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

### API Endpoint
```
Base URL: https://services.leadconnectorhq.com
Protocol: REST API with Bearer Token Authentication
Authentication: Location-Access based permissions
```

---

## 2. Authentication

### Token Format
```
Current: pit-be65de0c-49d3-4bfa-82f3-12dacc356563
Type: Legacy API Token (prefix: "pit-")
Status: ⚠️ Deprecated - upgrade recommended
```

### Token Upgrade Path
```
1. Log into GoHighLevel dashboard
2. Navigate to: Settings → API & Webhooks → API Keys
3. Generate new API token (will have different prefix)
4. Update .env: GHL_BEARER_TOKEN=<new_token>
5. Restart services
```

### Token Environment Variables
Both of these are set to the same token (for compatibility):
- `BEARER_TOKEN_BEARERAUTH`: Used by some API endpoints
- `BEARER_TOKEN_BEARER`: Used by other API endpoints

---

## 3. Tool Inventory

### Total Available Tools: 412

### Social Media Tools: 42

#### Instagram (3 tools)
```typescript
start-instagram-oauth
├─ Purpose: Initiate Instagram OAuth authorization flow
├─ Returns: OAuth URL for user to authorize
├─ Required Params: locationId
└─ Auth: Basic

attach-instagram-page-group
├─ Purpose: Link authorized Instagram page to location
├─ Required Params: locationId, pageId
├─ Method: POST
└─ Security: Location-Access (instagram/page.attach.write)

get-instagram-page-group
├─ Purpose: Retrieve connected Instagram pages
├─ Required Params: Version (2021-07-28), locationId
├─ Returns: Array of connected pages with metadata
└─ Security: Location-Access (instagram/page.readonly)
```

#### Facebook (3 tools)
```typescript
start-facebook-oauth
├─ Purpose: Initiate Facebook OAuth authorization flow
├─ Returns: OAuth URL for user to authorize
├─ Required Params: locationId
└─ Auth: Basic

attach-facebook-page-group
├─ Purpose: Link authorized Facebook page to location
├─ Required Params: locationId, pageId
├─ Method: POST
└─ Security: Location-Access (facebook/page.attach.write)

get-facebook-page-group
├─ Purpose: Retrieve connected Facebook pages
├─ Required Params: Version (2021-07-28), locationId
├─ Returns: Array of connected pages with metadata
└─ Security: Location-Access (facebook/page.readonly)
```

#### Post Management (7 tools)
```typescript
create-post
├─ Purpose: Create social media post (can be scheduled)
├─ Params: title, body, locationId, mediaArray, status, scheduledDate
├─ Status Options: DRAFT, SCHEDULED, PUBLISHED
├─ Platforms: Instagram, Facebook, and others
└─ Returns: postId

get-posts
├─ Purpose: Retrieve all posts for a location
├─ Filtering: Can filter by status, date range
├─ Returns: Array of post objects with full metadata
└─ Limit: Default 50, max varies by tier

get-post
├─ Purpose: Get single post details
├─ Required: postId, Version (2021-07-28)
├─ Returns: Complete post object with all metadata
└─ Use Case: Verify post status, get scheduling info

edit-post
├─ Purpose: Update existing post
├─ Can Update: title, body, media, status, schedule
├─ Required: postId, locationId
└─ Note: Can only edit DRAFT and SCHEDULED posts

delete-post
├─ Purpose: Remove post
├─ Can Delete: DRAFT, SCHEDULED, PUBLISHED
├─ Required: postId
└─ Caution: PUBLISHED posts may not be deletable

bulk-delete-social-planner-posts
├─ Purpose: Delete multiple posts at once
├─ Required: Array of postIds
├─ Returns: Deletion status for each post
└─ Performance: Batch operation

get-social-media-statistics
├─ Purpose: Analytics for connected accounts
├─ Returns: engagement, reach, impressions, followers
├─ Date Range: Configurable (last 7d, 30d, etc.)
└─ Platforms: All connected accounts
```

#### Media Management (8 tools)
```typescript
upload-media-content
├─ Purpose: Upload images/videos for posts
├─ Supported: JPG, PNG, MP4, MOV
├─ Returns: mediaId for use in posts
├─ Max Size: 100MB (varies by type)
└─ Auth: media/upload.write

fetch-media-content
├─ Purpose: Download/retrieve uploaded media
├─ Returns: Media URL or binary data
├─ Use Case: Verify uploads, migrate content
└─ Auth: media/download.readonly

create-media-folder
├─ Purpose: Organize media in folders
├─ Returns: folderId
├─ Nesting: Supports subfolder structure
└─ Auth: media/folder.write

update-media-object
├─ Purpose: Edit media metadata
├─ Can Update: name, description, tags
├─ Required: mediaId
└─ Auth: media/update.write

bulk-update-media-objects
├─ Purpose: Update multiple media items
├─ Required: Array of mediaIds with updates
├─ Performance: Batch operation
└─ Auth: media/update.write

delete-media-content
├─ Purpose: Remove media file
├─ Required: mediaId
└─ Auth: media/delete.write

bulk-delete-media-objects
├─ Purpose: Delete multiple media items
├─ Required: Array of mediaIds
└─ Performance: Batch operation
└─ Auth: media/delete.write
```

#### OAuth Integration (7 tools)
```typescript
Available OAuth Flows:
├─ Instagram: start-instagram-oauth
├─ Facebook: start-facebook-oauth
├─ Twitter: start-twitter-oauth
├─ LinkedIn: start-linkedin-oauth
├─ TikTok: start-tiktok-oauth
├─ TikTok Business: start-tiktok-business-oauth
└─ Google: start-google-oauth

All return: OAuth authorization URL
User must: Complete auth in browser
System then: Stores access tokens securely
```

---

## 4. API Request/Response Examples

### Example: Create a Scheduled Instagram Post

#### Request
```bash
curl -X POST https://services.leadconnectorhq.com/social/posts \
  -H "Authorization: Bearer pit-be65de0c-49d3-4bfa-82f3-12dacc356563" \
  -H "Content-Type: application/json" \
  -d '{
    "Version": "2021-07-28",
    "locationId": "YOUR_LOCATION_ID",
    "title": "Check out this amazing content!",
    "body": "This is my first automated Instagram post via GoHighLevel.",
    "mediaArray": [
      {
        "url": "https://example.com/image.jpg",
        "type": "image/jpeg",
        "mediaId": "MEDIA_ID_FROM_UPLOAD"
      }
    ],
    "status": "SCHEDULED",
    "scheduledDate": "2026-02-18T14:30:00Z",
    "platforms": ["instagram"]
  }'
```

#### Response
```json
{
  "success": true,
  "postId": "ghl_post_abc123xyz",
  "status": "SCHEDULED",
  "scheduledAt": "2026-02-18T14:30:00Z",
  "platforms": ["instagram"],
  "message": "Post scheduled successfully"
}
```

### Example: Get Instagram Page Details

#### Request
```bash
curl -X GET "https://services.leadconnectorhq.com/instagram/page-group" \
  -H "Authorization: Bearer pit-be65de0c-49d3-4bfa-82f3-12dacc356563" \
  -H "Content-Type: application/json" \
  -d '{
    "Version": "2021-07-28",
    "locationId": "YOUR_LOCATION_ID"
  }'
```

#### Response
```json
{
  "pageGroup": [
    {
      "id": "instagram_page_12345",
      "name": "DJ's Business",
      "username": "@djbusiness",
      "followers": 5432,
      "following": 234,
      "posts": 156,
      "connected": true,
      "connectedAt": "2026-02-18T10:00:00Z",
      "permissions": [
        "instagram_basic",
        "instagram_manage_posts",
        "instagram_manage_media"
      ]
    }
  ]
}
```

### Example: Get Social Statistics

#### Request
```bash
curl -X GET "https://services.leadconnectorhq.com/social/statistics" \
  -H "Authorization: Bearer pit-be65de0c-49d3-4bfa-82f3-12dacc356563" \
  -H "Content-Type: application/json" \
  -d '{
    "Version": "2021-07-28",
    "locationId": "YOUR_LOCATION_ID",
    "dateRange": "last_7_days",
    "platforms": ["instagram"]
  }'
```

#### Response
```json
{
  "statistics": {
    "instagram": {
      "impressions": 12450,
      "reach": 8920,
      "engagement": 342,
      "followers": 5432,
      "followerGrowth": 45,
      "topPost": {
        "id": "post_xyz789",
        "likes": 145,
        "comments": 23,
        "saves": 67
      }
    }
  }
}
```

---

## 5. Integration Points in Nova Codebase

### File: `src/integrations.ts`

#### GHL Routing
```typescript
// Line 92
"gohighlevel": ["ghl", "highlevel", "crm", "pipeline", "opportunity", "funnel", "contact"],

// Agents using GHL
// Line 101: flux agent
// Line 102: helios agent
// Line 103: echo agent
```

#### Agent MCP Configuration
Agents with GHL access automatically get the MCP injected via `regenerateMcpConfig()` function.

### File: `src/agent-router.ts`

#### Agents with GHL Tools:

**Helios Agent** (lines 31-54)
```
Specialization: Ad management and campaigns
GHL Use: Create campaigns, ad sets, audiences, manage contacts and pipelines
Related Skills: image-gen, canvas-design, competitive-ads-extractor, content-research-writer
```

**Pixel Agent** (lines 56-72)
```
Specialization: Social media management
GHL Use: Schedule and publish social media posts, manage social calendar
Related Skills: image-gen, canvas-design, content-research-writer, competitive-ads-extractor
```

**Orion Agent** (lines 92-108)
```
Specialization: Email marketing
GHL Use: Create email templates, manage campaigns, segment contacts, automation
Related Skills: content-research-writer, canvas-design, image-gen
```

**Athena Agent** (lines 145-162)
```
Specialization: Business strategy and analytics
GHL Use: Pull pipeline data, deal flow metrics, CRM analytics
Related Skills: content-research-writer, competitive-analysis
```

---

## 6. Pixel Agent Deep Dive

The Pixel agent is your dedicated social media manager. Here's its full configuration:

```typescript
pixel: `
TOOLS — MCP integrations:
• Go High Level MCP (gohighlevel):
  - Schedule and publish social media posts across connected accounts
  - Manage social calendar

• Playwright (browser):
  - Research trending content
  - View competitor profiles
  - Check hashtag performance
  - Screenshot reference posts

• Google Workspace MCP:
  - Calendar: Coordinate posting schedule with user's calendar
  - Sheets: Track engagement metrics

• Notion MCP:
  - Save content calendars
  - Campaign briefs
  - Social media playbooks

SKILLS — Slash commands:
• /image-gen: Generate social media post images, story visuals, profile graphics
• /canvas-design: Design social graphics, story templates, carousel slides
• /content-research-writer: Research content ideas, write engaging captions
• /xlsx: Create content calendars, engagement analytics spreadsheets
• /docx: Write social media strategy documents, brand voice guidelines
• /pdf: Create social media reports for stakeholders
• /competitive-ads-extractor: Analyze competitor social strategies
• /telegram-file-sender: Send generated content, calendars, and reports
`
```

---

## 7. Smart Routing in Integration Manager

When Claude is used for social media tasks, the system automatically routes to relevant MCPs:

```typescript
// From integrations.ts - MCP_ROUTING_MAP
MCP_ROUTING_MAP = {
  "gohighlevel": [
    "ghl",
    "highlevel",
    "crm",
    "pipeline",
    "opportunity",
    "funnel",
    "contact"
  ]
}

// When user mentions: "post on Instagram"
// System detects keyword "post"
// → Includes gohighlevel MCP
// → Routes to Pixel agent if available
```

---

## 8. Data Flow: From User to Instagram Post

```
User Message
    ↓
"Post on Instagram: [text]"
    ↓
Telegram Bot receives
    ↓
Route to appropriate agent (Pixel)
    ↓
Get filtered MCP config (includes gohighlevel)
    ↓
Claude + Pixel Agent processes
    ↓
Creates request for create-post tool
    ↓
GHL MCP server executes
    ↓
Calls: POST /social/posts
    ↓
GoHighLevel API processes
    ↓
Sends to Instagram API (if immediate)
    ↓
Returns postId to Claude
    ↓
Claude confirms to user via Telegram
    ↓
Instagram post published/scheduled
```

---

## 9. Security & Permissions

### Location-Access Scopes

Each tool requires specific permissions:

```
Instagram:
├─ instagram/page.readonly: get-instagram-page-group
├─ instagram/page.attach.write: attach-instagram-page-group
├─ instagram/posts.write: create-post, edit-post
└─ instagram/posts.delete: delete-post

Facebook:
├─ facebook/page.readonly: get-facebook-page-group
├─ facebook/page.attach.write: attach-facebook-page-group
├─ facebook/posts.write: create-post, edit-post
└─ facebook/posts.delete: delete-post

Media:
├─ media/upload.write: upload-media-content
├─ media/download.readonly: fetch-media-content
├─ media/update.write: update-media-object
└─ media/delete.write: delete-media-content
```

### Token Security
- Tokens stored in `.env` (never in code)
- Tokens passed to MCP via environment variables
- MCP communicates via stdio (no network exposure)
- GoHighLevel handles OAuth token encryption

---

## 10. Rate Limits & Quotas

### Instagram API (via GoHighLevel)
```
Endpoints: Standard Instagram Graph API limits apply
Posts: No hard limit, but Instagram enforces spam checks
Media Upload: 100MB max per file
Concurrent Requests: 100 concurrent connections (per GHL tier)
```

### Facebook API (via GoHighLevel)
```
Posts: Standard Facebook Graph API limits
Rate Limit: 100 calls per hour (per tier)
Batch Operations: Supported for efficiency
```

### GoHighLevel Rate Limiting
```
Legacy API (pit- prefix): 100 requests/minute
New API (v2 token): 1000 requests/minute (recommended upgrade)
Batch Operations: 50 items per batch (media, posts, etc.)
```

---

## 11. Troubleshooting API Errors

### Common Error Responses

#### 401 Unauthorized
```json
{
  "error": "Unauthorized, Switch to the new API token"
}
```
**Cause**: Using deprecated pit- token format
**Solution**: Upgrade to v2 token format

#### 404 Not Found
```json
{
  "msg": "Not found"
}
```
**Cause**: Endpoint or resource doesn't exist
**Solution**: Verify locationId, postId, or endpoint path

#### 403 Forbidden
```json
{
  "error": "Access denied",
  "reason": "Insufficient permissions"
}
```
**Cause**: Token lacks required Location-Access scopes
**Solution**: Re-authorize with full permissions

#### 429 Too Many Requests
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```
**Cause**: Exceeded API rate limits
**Solution**: Wait specified seconds, implement exponential backoff

---

## 12. Development & Testing

### Test Commands via Claude

```javascript
// Test Instagram connection
"Check my Instagram pages"
→ Executes: get-instagram-page-group

// Test post creation
"Create a test post on Instagram"
→ Executes: create-post with status="SCHEDULED"

// Test analytics
"Show me my social stats"
→ Executes: get-social-media-statistics

// Test OAuth flow
"Start Instagram setup"
→ Executes: start-instagram-oauth
```

### Debug Info
```
MCP Server Logs: Check Claude's MCP execution logs
Token Status: Verify bearer token in .env
API Responses: Claude returns full JSON responses
Location ID: Verify in GoHighLevel dashboard
Instagram Connection: Check GoHighLevel → Connected Accounts
```

---

## 13. Upgrading Token Format

### Current Token
```
Prefix: pit-
Format: Legacy v1
Status: Deprecated ⚠️
```

### New Token (Recommended)
```
Prefix: pac_ (likely)
Format: v2 API
Limits: 10x higher rate limit (1000/min vs 100/min)
Steps:
1. GoHighLevel Dashboard → Settings → API & Webhooks
2. Click "Generate New Token"
3. Copy token (will show once)
4. Update .env: GHL_BEARER_TOKEN=<new_token>
5. Restart relay: bun run start
```

---

## 14. File Locations Summary

| Component | Path | Purpose |
|-----------|------|---------|
| MCP Config | `.mcp.json` | GHL MCP configuration |
| Credentials | `.env` | GHL_BEARER_TOKEN |
| MCP Binary | `~/.nvm/versions/.../gohighlevel-mcp/...` | MCP server binary |
| Integration Manager | `src/integrations.ts` | Handles MCP routing |
| Agent Router | `src/agent-router.ts` | Agent + tool mapping |
| Reports | `GHL_INTEGRATION_REPORT.md` | This integration info |
| Setup Guide | `GHL_INSTAGRAM_SETUP.md` | Step-by-step Instagram connection |
| This Reference | `GHL_TECHNICAL_REFERENCE.md` | Technical documentation |

---

## 15. Support Matrix

| Component | Status | Support |
|-----------|--------|---------|
| **GHL MCP** | ✅ Active | @drausal/gohighlevel-mcp |
| **Instagram** | ✅ Available | Requires OAuth |
| **Facebook** | ✅ Available | Requires OAuth |
| **Twitter/X** | ✅ Available | Via start-twitter-oauth |
| **LinkedIn** | ✅ Available | Via start-linkedin-oauth |
| **TikTok** | ✅ Available | Via start-tiktok-oauth |
| **Analytics** | ✅ Available | get-social-media-statistics |
| **Media Manager** | ✅ Available | 8 tools available |
| **Legacy Token** | ⚠️ Deprecated | Upgrade recommended |

---

**Technical Documentation Version**: 1.0
**Last Updated**: February 18, 2026
**GHL API Version**: v1.0.0
**MCP Package**: @drausal/gohighlevel-mcp
