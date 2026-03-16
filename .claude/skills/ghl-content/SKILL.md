---
name: ghl-content
description: GoHighLevel content — courses, file uploads, media library, documents, contracts, CSV imports. Use when the user asks about uploading files, managing media, courses, documents, or contracts in GoHighLevel.
---

# GHL Content & Media

## When to Use
- Import courses
- Upload files or attachments
- Manage media library (upload, delete, organize)
- CSV imports and bulk operations
- Documents and contracts
- Custom fields file uploads

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

| Tool | Purpose |
|------|---------|
| `mcp__gohighlevel__import-courses` | Import courses |
| `mcp__gohighlevel__upload-file-attachments` | Upload file attachments |
| `mcp__gohighlevel__upload-file-customFields` | Upload to custom fields |
| `mcp__gohighlevel__upload-media-content` | Upload media content |
| `mcp__gohighlevel__upload-to-custom-fields` | Upload to custom fields |
| `mcp__gohighlevel__upload-csv` | Upload CSV |
| `mcp__gohighlevel__start-csv-finalize` | Finalize CSV import |
| `mcp__gohighlevel__get-csv-post` | Get CSV import status |
| `mcp__gohighlevel__delete-csv` | Delete CSV |
| `mcp__gohighlevel__delete-csv-post` | Delete CSV post |
| `mcp__gohighlevel__get-upload-status` | Get upload status |
| `mcp__gohighlevel__fetch-media-content` | Fetch media content |
| `mcp__gohighlevel__delete-media-content` | Delete media |
| `mcp__gohighlevel__create-media-folder` | Create media folder |
| `mcp__gohighlevel__bulk-delete-media-objects` | Bulk delete media |
| `mcp__gohighlevel__bulk-update-media-objects` | Bulk update media |
| `mcp__gohighlevel__update-media-object` | Update media object |
| `mcp__gohighlevel__send-documents-contracts` | Send document/contract |
| `mcp__gohighlevel__send-documents-contracts-template` | Send from template |
| `mcp__gohighlevel__list-documents-contracts` | List documents |
| `mcp__gohighlevel__list-documents-contracts-templates` | List templates |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__gohighlevel__upload-media-content"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. The GHL location ID comes from the user's configured environment
