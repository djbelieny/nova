---
name: ghl-marketing
description: GoHighLevel marketing — campaigns, social media posts, email/SMS templates, blog posts, workflows. Use when the user asks about campaigns, social posts, publishing, email, SMS, blogs, or newsletters in GoHighLevel.
---

# GHL Marketing & Campaigns

## When to Use
- Create or manage social media posts
- Campaign management (add/remove contacts)
- Blog post creation and management
- Email/SMS template management
- Send messages
- Workflow management
- Social media statistics

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

| Tool | Purpose |
|------|---------|
| `mcp__gohighlevel__create-post` | Create social post |
| `mcp__gohighlevel__edit-post` | Edit social post |
| `mcp__gohighlevel__get-posts` | List social posts |
| `mcp__gohighlevel__get-post` | Get post by ID |
| `mcp__gohighlevel__delete-post` | Delete social post |
| `mcp__gohighlevel__bulk-delete-social-planner-posts` | Bulk delete posts |
| `mcp__gohighlevel__get-campaigns` | List campaigns |
| `mcp__gohighlevel__fetch-campaigns` | Fetch campaigns |
| `mcp__gohighlevel__add-contact-to-campaign` | Add contact to campaign |
| `mcp__gohighlevel__remove-contact-from-campaign` | Remove from campaign |
| `mcp__gohighlevel__remove-contact-from-every-campaign` | Remove from all campaigns |
| `mcp__gohighlevel__create-blog-post` | Create blog post |
| `mcp__gohighlevel__update-blog-post` | Update blog post |
| `mcp__gohighlevel__get-blog-post` | Get blog post |
| `mcp__gohighlevel__get-blogs` | List blogs |
| `mcp__gohighlevel__get-all-blog-authors-by-location` | Blog authors |
| `mcp__gohighlevel__get-all-categories-by-location` | Blog categories |
| `mcp__gohighlevel__send-a-new-message` | Send message |
| `mcp__gohighlevel__cancel-scheduled-message` | Cancel scheduled message |
| `mcp__gohighlevel__cancel-scheduled-email-message` | Cancel scheduled email |
| `mcp__gohighlevel__create-template` | Create email/SMS template |
| `mcp__gohighlevel__update-template` | Update template |
| `mcp__gohighlevel__fetch-template` | Fetch template |
| `mcp__gohighlevel__delete-template` | Delete template |
| `mcp__gohighlevel__GET-all-or-email-sms-templates` | List all templates |
| `mcp__gohighlevel__get-workflow` | Get workflow |
| `mcp__gohighlevel__attach-facebook-page-group` | Connect Facebook page |
| `mcp__gohighlevel__attach-instagram-page-group` | Connect Instagram |
| `mcp__gohighlevel__attach-linkedin-page-profile` | Connect LinkedIn |
| `mcp__gohighlevel__attach-tiktok-profile` | Connect TikTok |
| `mcp__gohighlevel__attach-twitter-profile` | Connect Twitter/X |
| `mcp__gohighlevel__get-social-media-statistics` | Social media stats |
| `mcp__gohighlevel__get-facebook-page-group` | Get Facebook page |
| `mcp__gohighlevel__get-instagram-page-group` | Get Instagram page |
| `mcp__gohighlevel__get-linkedin-page-profile` | Get LinkedIn profile |
| `mcp__gohighlevel__get-tiktok-profile` | Get TikTok profile |
| `mcp__gohighlevel__get-tiktok-business-profile` | Get TikTok business |
| `mcp__gohighlevel__get-twitter-profile` | Get Twitter profile |
| `mcp__gohighlevel__start-facebook-oauth` | Start Facebook OAuth |
| `mcp__gohighlevel__start-google-oauth` | Start Google OAuth |
| `mcp__gohighlevel__start-instagram-oauth` | Start Instagram OAuth |
| `mcp__gohighlevel__start-linkedin-oauth` | Start LinkedIn OAuth |
| `mcp__gohighlevel__start-tiktok-oauth` | Start TikTok OAuth |
| `mcp__gohighlevel__start-tiktok-business-oauth` | Start TikTok business OAuth |
| `mcp__gohighlevel__start-twitter-oauth` | Start Twitter OAuth |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__gohighlevel__create-post"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. The GHL location ID comes from the user's configured environment
