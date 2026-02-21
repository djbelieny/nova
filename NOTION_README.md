# Notion Integration Documentation Index

Welcome! This directory contains your complete Notion integration setup with the Claude Telegram Relay.

## Quick Links

Start here based on what you need:

### I want to understand the setup
Read: **NOTION_INTEGRATION_REPORT.md**
- Technical overview of how Notion is configured
- MCP server details
- API credentials and authentication
- Security considerations
- How it integrates with your Telegram bot

### I want to use Notion with my bot
Read: **NOTION_EXAMPLES.md**
- 11 practical examples of messages to send your bot
- Example responses you'll receive
- Advanced use cases
- Database structure recommendations
- Troubleshooting guide

### I need quick reference
Read: **NOTION_CONFIG_REFERENCE.md**
- Configuration quick reference
- Environment variables
- Available API methods
- Rate limits and constraints
- Debugging checklist

## Current Status

Your Notion integration is **fully configured and ready to use**.

- MCP Server: ✓ Active (@notionhq/notion-mcp-server)
- API Key: ✓ Valid (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)
- Bot Integration: ✓ Active in relay.ts
- Documentation: ✓ Complete

## Getting Started (5 minutes)

### 1. Start the relay
```bash
cd /Users/djbelieny/Projects/claude-telegram-relay
bun run start
```

### 2. Send a test message to your Telegram bot
```
What tasks do I have?
```

### 3. Bot queries Notion and responds
```
Here are your tasks:
• Complete Q1 roadmap (Due: Feb 28) - In Progress
• Review Claude Code skills (Due: Feb 20) - Not started
...
```

## File Overview

### New Notion Documentation
- `NOTION_README.md` - This file, quick navigation
- `NOTION_INTEGRATION_REPORT.md` - Complete technical guide
- `NOTION_EXAMPLES.md` - Usage examples and patterns
- `NOTION_CONFIG_REFERENCE.md` - Configuration reference

### Key Project Files
- `.mcp.json` - MCP server configuration (includes Notion)
- `.env` - API credentials (Notion API key)
- `src/relay.ts` - Core bot logic with Notion integration
- `src/memory.ts` - Semantic search and memory
- `CLAUDE.md` - Setup guide for entire project

## What You Can Do

With Notion MCP configured, your Telegram bot can:

#### Search & Query
- "What tasks do I have?"
- "Search my notes for [topic]"
- "Show me all in-progress projects"

#### Create & Update
- "Create a new task: [description]"
- "Mark [task name] as done"
- "Add a new project: [name]"

#### Analyze & Report
- "Give me my weekly summary"
- "Generate a status report"
- "Show me urgent tasks"

#### Cross-Reference
- "Link this task to project [name]"
- "Add deadline to [task]"
- "Show all related items"

## Integration with Other Tools

Your relay also includes:
- Google Workspace (Gmail, Calendar, Drive)
- Zoom (meeting creation)
- Square (payments & orders)
- Playwright (web automation)
- Twilio (voice calls & SMS)
- Cloudflare (DNS & Workers)
- Apple Notes (local notes)

All coordinated through the same Telegram bot.

## Troubleshooting

### "Notion API Error"
- Check Notion Settings > Connections > Internal integrations
- Verify bot has access to the database
- Token format: starts with "ntn_" (24+ characters)

### "Database not found"
- Verify database ID is correct
- Check that integration has access rights
- Run: `bun run setup:verify`

### Bot not responding
- Check relay is running: `bun run start`
- Verify .env file has NOTION_API_KEY
- Check Telegram bot token is valid

See **NOTION_CONFIG_REFERENCE.md** for more troubleshooting.

## Next Steps

1. **Identify your databases**
   - Open Notion workspace
   - Get database IDs from URLs
   - Verify bot has access

2. **Send test messages**
   - Start relay: `bun run start`
   - Message bot with examples from NOTION_EXAMPLES.md
   - Check responses in Telegram

3. **Create scheduled reports**
   ```bash
   bun run src/scheduler.ts create \
     "notion-daily-briefing" \
     "daily:09:00" \
     "bun run examples/morning-briefing.ts"
   ```

4. **Explore advanced features**
   - Sync Notion deadlines to Google Calendar
   - Create proactive check-ins that reference Notion
   - Build custom queries for your workflow

## API Documentation

- **Notion API**: https://developers.notion.com/reference
- **MCP Protocol**: https://modelcontextprotocol.io
- **Claude Code**: https://claude.ai/claude-code

## Files at a Glance

```
claude-telegram-relay/
├── NOTION_README.md                    # This file
├── NOTION_INTEGRATION_REPORT.md        # Technical overview
├── NOTION_EXAMPLES.md                  # Usage examples
├── NOTION_CONFIG_REFERENCE.md          # Configuration reference
├── .mcp.json                           # MCP configuration
├── .env                                # Credentials (keep private)
├── src/relay.ts                        # Bot implementation
├── CLAUDE.md                           # Setup guide
└── README.md                           # Project overview
```

## Support

For help with:
- **Setup**: See CLAUDE.md and the main README.md
- **Usage**: See NOTION_EXAMPLES.md
- **Configuration**: See NOTION_CONFIG_REFERENCE.md
- **Troubleshooting**: See all three Notion docs

---

**Status**: Production Ready  
**Last Updated**: February 16, 2026  
**Notion API Version**: 2022-06-28

Start with **NOTION_EXAMPLES.md** to see it in action!
