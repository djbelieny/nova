---
name: ghl-contacts
description: GoHighLevel CRM — search, create, update contacts, manage pipelines and opportunities. Use when the user asks about contacts, leads, CRM, pipelines, or opportunities in GoHighLevel.
---

# GHL Contacts & CRM

## When to Use
- Search, create, or update contacts
- Manage pipelines and opportunities
- Tag management on contacts
- Workflow enrollment / removal
- Duplicate contact detection
- Contact followers

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

| Tool | Purpose |
|------|---------|
| `mcp__gohighlevel__search-contacts-advanced` | Search contacts with filters |
| `mcp__gohighlevel__create-contact` | Create a new contact |
| `mcp__gohighlevel__update-contact` | Update contact fields |
| `mcp__gohighlevel__get-contact` | Get contact by ID |
| `mcp__gohighlevel__get-contacts` | List contacts |
| `mcp__gohighlevel__upsert-contact` | Create or update contact |
| `mcp__gohighlevel__delete-contact` | Delete a contact |
| `mcp__gohighlevel__get-duplicate-contact` | Find duplicate contacts |
| `mcp__gohighlevel__get-contacts-by-businessId` | Contacts by business |
| `mcp__gohighlevel__add-tags` | Add tags to contact |
| `mcp__gohighlevel__remove-tags` | Remove tags from contact |
| `mcp__gohighlevel__get-pipelines` | List pipelines |
| `mcp__gohighlevel__create-opportunity` | Create opportunity |
| `mcp__gohighlevel__update-opportunity` | Update opportunity |
| `mcp__gohighlevel__search-opportunity` | Search opportunities |
| `mcp__gohighlevel__get-opportunity` | Get opportunity by ID |
| `mcp__gohighlevel__delete-opportunity` | Delete opportunity |
| `mcp__gohighlevel__Upsert-opportunity` | Upsert opportunity |
| `mcp__gohighlevel__update-opportunity-status` | Update opportunity status |
| `mcp__gohighlevel__add-followers-contact` | Add followers to contact |
| `mcp__gohighlevel__remove-followers-contact` | Remove followers |
| `mcp__gohighlevel__add-followers-opportunity` | Add followers to opportunity |
| `mcp__gohighlevel__remove-followers-opportunity` | Remove followers from opportunity |
| `mcp__gohighlevel__add-contact-to-workflow` | Add contact to workflow |
| `mcp__gohighlevel__delete-contact-from-workflow` | Remove from workflow |
| `mcp__gohighlevel__add-remove-contact-from-business` | Business association |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__gohighlevel__search-contacts-advanced"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. The GHL location ID comes from the user's configured environment
