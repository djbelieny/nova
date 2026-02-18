---
name: telegram-file-sender
description: >-
  Send files as document attachments via Telegram. This skill should be used when
  the user asks to send, share, or deliver a file through Telegram — including
  generated documents (PDFs, spreadsheets, presentations, images), existing files,
  or any file that needs to be delivered as a Telegram document attachment.
---

# Telegram File Sender

Send any file as a document attachment to the user's Telegram chat using the Telegram Bot API.

## When to Use

- The user asks to "send me" a file, document, report, or any generated output
- The user says "send it to me on Telegram" or "share that file with me"
- After generating a file (PDF, DOCX, XLSX, PPTX, image, etc.) that the user wants delivered
- The user asks to "send this to Telegram" or "attach this"
- Post-call tasks that involve delivering files to the user

## Workflow

### 1. Locate or Generate the File

Identify the file to send. If the file needs to be created first (e.g., a report, document, spreadsheet), generate it using the appropriate skill or tool before proceeding.

### 2. Send the File

Execute the bundled script to send the file via Telegram:

```bash
~/.claude/skills/telegram-file-sender/scripts/send_telegram_file.sh "<file_path>" "<optional_caption>"
```

**Parameters:**
- `file_path` (required): Absolute path to the file to send
- `caption` (optional): A message to display alongside the file (supports Markdown)

**Environment variables** (loaded automatically from `.env`):
- `TELEGRAM_BOT_TOKEN` — The bot token
- `TELEGRAM_USER_ID` — The recipient's chat ID

### 3. Confirm Delivery

After the script runs, confirm to the user that the file was sent. If it fails, report the error.

## Constraints

- Maximum file size: 50MB (Telegram Bot API limit)
- For files larger than 50MB, split or compress the file first, or suggest an alternative delivery method
- The script validates file existence and size before sending
- Captions support Markdown formatting

## Examples

Send a generated PDF report:
```bash
~/.claude/skills/telegram-file-sender/scripts/send_telegram_file.sh "/tmp/quarterly-report.pdf" "Here's your Q1 report"
```

Send a spreadsheet without caption:
```bash
~/.claude/skills/telegram-file-sender/scripts/send_telegram_file.sh "/Users/djbelieny/Documents/budget.xlsx"
```

Send a presentation with formatted caption:
```bash
~/.claude/skills/telegram-file-sender/scripts/send_telegram_file.sh "/tmp/pitch-deck.pptx" "*Pitch deck* — ready for review"
```
