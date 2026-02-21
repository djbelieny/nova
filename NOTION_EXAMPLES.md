# Notion Integration Examples for DJ

This file shows practical examples of how to use Notion with your Telegram bot relay.

## Quick Start

### Prerequisites
1. Telegram bot running: `bun run start` (from `/Users/djbelieny/Projects/claude-telegram-relay/`)
2. Valid Notion API key in `.env` ✓ (already configured)
3. Notion databases shared with the integration

### How It Works
1. You send a message to your Telegram bot
2. The relay spawns Claude Code with Notion MCP access
3. Claude executes Notion queries
4. Results come back in Telegram

## Example Messages to Your Telegram Bot

### 1. Query Tasks

**Message:**
```
What tasks do I have?
```

**What happens:**
- Claude queries your Notion Tasks database
- Returns tasks with status, due date, priority
- Example response:
  ```
  Here are your tasks:
  
  • Complete Q1 roadmap (Due: Feb 28) - In Progress
  • Review Claude Code skills (Due: Feb 20) - Not started
  • Update Telegram relay docs (Due: Feb 25) - In Progress
  ```

### 2. Search for Specific Content

**Message:**
```
Search my notes for anything related to "Notion API"
```

**What happens:**
- Claude searches all Notion pages with that text
- Returns relevant snippets and page links
- Example response:
  ```
  Found 3 mentions of "Notion API":
  
  1. In "Integration Setup" (Feb 10)
     - "Notion API Key stored in .env"
  
  2. In "API Documentation" (Feb 12)
     - "Bearer token authentication"
  
  3. In "Project Checklist" (Feb 15)
     - "Configure NOTION_MCP_HEADERS"
  ```

### 3. Create a New Task

**Message:**
```
Create a new task: "Test Notion integration" due tomorrow
```

**What happens:**
- Claude creates a new entry in your Tasks database
- Sets title, status, due date automatically
- Example response:
  ```
  Created task "Test Notion integration"
  Due: Feb 17, 2026
  Status: Not started
  ```

### 4. Update Existing Entry

**Message:**
```
Mark "Review Claude Code skills" as done
```

**What happens:**
- Claude finds the task
- Updates status to "Done"
- Example response:
  ```
  Updated task "Review Claude Code skills"
  Status: Done ✓
  ```

### 5. Filter and List

**Message:**
```
Show me all my in-progress projects
```

**What happens:**
- Claude queries Projects database
- Filters by Status = "In Progress"
- Returns list with details
- Example response:
  ```
  Your in-progress projects:
  
  1. Claude Telegram Relay
     - Started: Jan 15
     - Current: Notion integration
  
  2. Zaarvy AI Enhancement
     - Started: Feb 1
     - Current: Voice features
  ```

### 6. Weekly Review

**Message:**
```
Give me my weekly task summary
```

**What happens:**
- Claude queries Tasks database
- Filters by week (this week)
- Counts by status, shows deadlines
- Example response:
  ```
  Weekly Summary
  ============
  Total tasks this week: 8
  Completed: 2 ✓
  In progress: 3
  Not started: 3
  
  Urgent (due today): 1
  Due this week: 5
  
  Next deadline: "Update documentation" - Feb 18
  ```

### 7. Cross-Reference Data

**Message:**
```
Show me all tasks related to my "Claude Telegram Relay" project
```

**What happens:**
- Claude searches for project references
- Finds linked tasks and subtasks
- Returns complete context
- Example response:
  ```
  Project: Claude Telegram Relay
  
  Tasks (5):
  • Setup Supabase connection - DONE
  • Configure Notion integration - IN PROGRESS
  • Test voice transcription - NOT STARTED
  • Document API setup - IN PROGRESS
  • Deploy to production - NOT STARTED
  
  Related Pages (3):
  • Integration Setup Guide
  • API Documentation
  • Deployment Checklist
  ```

### 8. Create Multiple Entries

**Message:**
```
Create 3 tasks for me:
1. Review budget - due Friday
2. Send proposal - due tomorrow
3. Team meeting prep - due Wednesday
```

**What happens:**
- Claude creates all three tasks
- Sets dates intelligently
- Confirms in response
- Example response:
  ```
  Created 3 new tasks:
  ✓ Review budget (Feb 21)
  ✓ Send proposal (Feb 17)
  ✓ Team meeting prep (Feb 19)
  ```

## Advanced Examples

### 9. Smart Check-ins with Notion Data

**Schedule a daily check-in** that pulls from Notion:

```bash
bun run src/scheduler.ts create \
  "daily-notion-briefing" \
  "daily:09:00" \
  "bun run examples/morning-briefing.ts"
```

This creates a task that:
1. Reads your Notion dashboard
2. Pulls today's priorities
3. Checks project status
4. Sends a briefing to Telegram

### 10. Sync Notion to Google Calendar

**Message:**
```
Add all my upcoming task deadlines to my Google Calendar
```

**What happens:**
- Claude queries Notion for tasks with due dates
- Creates calendar events
- Includes task links in event descriptions
- Example creates 8 calendar events

### 11. Status Reports

**Message:**
```
Generate a status report on all my projects
```

**What happens:**
- Claude queries Projects database
- Pulls task counts per project
- Checks recent updates
- Formats as report
- Example response:
  ```
  PROJECT STATUS REPORT
  Generated: Feb 16, 2026
  
  Claude Telegram Relay [████████░░] 80%
  - 8 total tasks
  - 6 completed
  - 2 in progress
  - Last update: Feb 15
  
  Zaarvy AI [██████░░░░] 60%
  - 5 total tasks
  - 3 completed
  - 2 in progress
  - Last update: Feb 14
  ```

## Database Structures

For these examples to work, your Notion should have at minimum:

### Tasks Database
- **Title** (text)
- **Status** (select: Not started, In Progress, Done)
- **Due Date** (date)
- **Priority** (select: Low, Medium, High)
- **Project** (relation to Projects)

### Projects Database
- **Name** (text)
- **Status** (select: Planning, Active, On Hold, Completed)
- **Start Date** (date)
- **Current Focus** (text)

### Notes Database
- **Title** (text)
- **Content** (rich text)
- **Created** (date)
- **Tags** (multi-select)

## Troubleshooting

### "Notion API Error"
- Check if bot has access: Notion Settings > Connections
- Verify database is shared with the integration
- Check token is still active (24 chars starting with "ntn_")

### "Database not found"
- Get correct database ID from Notion URL
- Verify integration has access rights
- Run: `bun run setup:verify`

### "Permission denied"
- Integration needs read/write access
- In Notion: Settings > Connections > Select integration > Grant access

## Testing

### Test Notion Connection
```bash
# From /Users/djbelieny/Projects/claude-telegram-relay/
bun run setup:verify
```

This checks:
- API credentials valid
- MCP server responding
- Databases accessible

### Manual Query
You can also test directly in Claude Code:
```bash
claude --env=.env
# Then ask: "Query my Notion tasks database"
```

## Files Reference

- Configuration: `/Users/djbelieny/Projects/claude-telegram-relay/.mcp.json`
- API Key: `/Users/djbelieny/Projects/claude-telegram-relay/.env`
- Bot Logic: `/Users/djbelieny/Projects/claude-telegram-relay/src/relay.ts`
- Full Report: `/Users/djbelieny/Projects/claude-telegram-relay/NOTION_INTEGRATION_REPORT.md`

---

**Ready to use!** Start your bot and begin messaging:

```bash
cd /Users/djbelieny/Projects/claude-telegram-relay
bun run start
```

Then message your Telegram bot with any of the examples above.
