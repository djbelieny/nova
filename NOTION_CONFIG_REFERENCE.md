# Notion Configuration Reference

Quick reference for your Notion integration setup.

## Current Configuration Status

### MCP Server
- **Server Package**: @notionhq/notion-mcp-server
- **Type**: stdio (standard input/output)
- **Status**: Configured and active
- **Location**: `.mcp.json`

### API Credentials
- **API Key Type**: Internal integration token
- **API Key Status**: Active ✓
- **Auth Method**: Bearer token (HTTP headers)
- **Notion API Version**: 2022-06-28
- **Location**: `.env`

### Integration Permissions
- **Access Type**: Read/Write
- **Scope**: All shared databases and pages
- **Databases**: Unlimited (if integration has access)

## Environment Variables

### Required
```bash
NOTION_API_KEY=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
NOTION_MCP_HEADERS={"Authorization":"Bearer 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","Notion-Version":"2022-06-28"}
```

### Optional (for enhanced features)
```bash
# If you want to specify which databases the bot has access to
NOTION_WORKSPACE_ID=[your-workspace-id]

# If you want database-specific settings
NOTION_TASKS_DB_ID=[your-tasks-database-id]
NOTION_PROJECTS_DB_ID=[your-projects-database-id]
```

## File Locations

```
/Users/djbelieny/Projects/claude-telegram-relay/
├── .mcp.json                    # MCP server configs
├── .env                         # API credentials (never commit)
├── .env.example                 # Template (safe to commit)
├── src/relay.ts                 # Bot logic
├── NOTION_INTEGRATION_REPORT.md # Full documentation
├── NOTION_EXAMPLES.md           # Usage examples
└── NOTION_CONFIG_REFERENCE.md   # This file
```

## Available MCP Methods

Your Notion MCP server provides these methods:

### Read Operations
- `search_notion` - Search pages and databases
- `read_page_content` - Get full page content
- `query_database` - Query database with filters
- `list_databases` - List all accessible databases
- `get_page_properties` - Get page metadata

### Write Operations
- `create_page` - Create new page
- `create_database` - Create new database
- `update_page` - Update page properties
- `append_block` - Add content to page
- `update_block` - Modify block content

### Advanced
- `search_by_property` - Filter by database properties
- `get_child_pages` - Get pages under a parent
- `get_block_children` - Get page blocks
- `create_comment` - Add comments to pages

## Common Database Field Types

When creating tasks/pages, you can use:

- **Text** - Title, description, content
- **Date** - Due dates, created date
- **Select** - Status, priority, category
- **Multi-select** - Tags, labels
- **Checkbox** - Boolean flags
- **Number** - Counts, scores
- **Email** - Contact info
- **Phone** - Phone numbers
- **Relation** - Links to other databases
- **Rollup** - Aggregated data
- **Formula** - Computed values
- **Files** - Attachments

## Integration Limits

- **Rate limit**: 3 requests per second per integration
- **Page size**: Up to 100 results per database query
- **Timeout**: 30 seconds per request
- **Databases**: Unlimited (per integration access)
- **API Version**: 2022-06-28 (recommended, latest stable)

## Enabling Integration Access

To share a Notion database with the bot:

1. Open Notion workspace
2. Go to **Settings & Members** > **Connections**
3. Find the "Claude Telegram Relay" connection
4. Click to expand
5. Select database or page to share
6. Grant read and write access
7. Save

The bot will have immediate access after sharing.

## Monitoring & Debugging

### Check Integration Status
```bash
cd /Users/djbelieny/Projects/claude-telegram-relay
bun run setup:verify
```

### View Logs
```bash
# Telegram relay logs
tail -f logs/relay.log

# MCP server logs
tail -f logs/mcp.log
```

### Test Query
```bash
# Start relay in debug mode
bun run dev
# Send test message to Telegram bot
# Check console output for query results
```

## Security Best Practices

1. **API Token**
   - Never commit `.env` file
   - Rotate token if compromised
   - Use different tokens for dev/prod

2. **Database Access**
   - Only share necessary databases
   - Limit to required tables
   - Audit connections monthly

3. **Rate Limiting**
   - Be aware of 3 req/sec limit
   - Batch queries when possible
   - Cache results locally

4. **Data Privacy**
   - Only integrate with non-sensitive databases
   - Don't store credentials in logs
   - Use environment variables

## Troubleshooting

### Token Invalid
```
Error: Invalid token
```
**Solution**: Regenerate token in Notion Settings > Integrations

### Database Not Found
```
Error: Database not found
```
**Solution**: 
- Check database ID is correct
- Verify integration has access
- Refresh Notion settings

### Permission Denied
```
Error: No read/write permission
```
**Solution**: Grant access in Notion > Settings > Connections

### Rate Limited
```
Error: Too many requests
```
**Solution**: Wait 1 second, reduce request frequency

## API Documentation

Full Notion API docs: https://developers.notion.com/reference

MCP Server source: https://github.com/notionhq/notion-mcp-server

## Contact & Support

For issues with:
- **Notion API**: Notion support at notion.so/support
- **Claude integration**: Claude Code documentation
- **Telegram relay**: Check CLAUDE.md setup guide

---

**Last Updated**: February 16, 2026
**Status**: Production Ready
**Version**: Notion API 2022-06-28
