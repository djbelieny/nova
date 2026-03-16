---
name: cloudflare-dns
description: Cloudflare DNS, domains, zones, routes, custom domains, and analytics. Use when the user asks about domains, DNS records, zones, routes, or custom domains in Cloudflare.
---

# Cloudflare DNS & Domains

## When to Use
- List or inspect domains and zones
- Manage routes
- Custom domain configuration (Workers for Platforms)
- Analytics and monitoring

## Available Tools

Fetch these MCP tools using `ToolSearch` before calling them:

| Tool | Purpose |
|------|---------|
| `mcp__cloudflare__domain_list` | List domains |
| `mcp__cloudflare__zones_list` | List zones |
| `mcp__cloudflare__zones_get` | Get zone details |
| `mcp__cloudflare__route_list` | List routes |
| `mcp__cloudflare__route_create` | Create route |
| `mcp__cloudflare__route_update` | Update route |
| `mcp__cloudflare__route_delete` | Delete route |
| `mcp__cloudflare__wfp_list_dispatch_namespaces` | List dispatch namespaces |
| `mcp__cloudflare__wfp_create_dispatch_namespace` | Create dispatch namespace |
| `mcp__cloudflare__wfp_delete_dispatch_namespace` | Delete dispatch namespace |
| `mcp__cloudflare__wfp_list_custom_domains` | List custom domains |
| `mcp__cloudflare__wfp_add_custom_domain` | Add custom domain |
| `mcp__cloudflare__wfp_remove_custom_domain` | Remove custom domain |
| `mcp__cloudflare__analytics_get` | Get analytics |

## Usage Pattern

1. Use `ToolSearch` with query `"select:mcp__cloudflare__zones_list"` (or whichever tool you need)
2. Call the fetched tool with required parameters
3. Account ID and API token come from environment configuration
