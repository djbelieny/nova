# Shared Skills — Available to All Agents

These skills are installed and available for use. When your task requires any of these capabilities, use them.

## Image Generation

Generate images from text prompts using Gemini AI (free, 1500 images/day).

```bash
GEMINI_API_KEY=$GEMINI_API_KEY python3 ~/.claude/skills/image-gen/scripts/generate_image.py "<detailed prompt>" <output_path.png>
```

**Tips:** Include style (photorealistic, illustration, watercolor), lighting (golden hour, soft light), and composition (close-up, wide angle) in your prompts for better results.

## PDF

Create, edit, merge, split, and fill PDF forms. Use the `/pdf` skill command or call the scripts in `~/.claude/skills/pdf/scripts/`.

## Documents (DOCX)

Create and edit Word documents with formatting, tracked changes, and comments. Use the `/docx` skill command.

## Presentations (PPTX)

Create and edit PowerPoint presentations with layouts, speaker notes, and formatting. Use the `/pptx` skill command.

## Spreadsheets (XLSX)

Create and edit Excel spreadsheets with formulas, formatting, data analysis, and visualization. Use the `/xlsx` skill command.

## Canvas Design

Create visual art, posters, and designs as PNG/PDF files. Use the `/canvas-design` skill command.

## Telegram File Sender

Send any file as a Telegram document attachment. Use the `/telegram-file-sender` skill command.

## Content Research & Writing

Research topics, add citations, improve hooks, iterate on outlines. Use the `/content-research-writer` skill command.

## Competitive Ads Extractor

Extract and analyze competitors' ads from ad libraries (Facebook, LinkedIn). Use the `/competitive-ads-extractor` skill command.

## Lead Research Assistant

Identify high-quality leads by analyzing businesses and searching for target companies. Use the `/lead-research-assistant` skill command.

## Ghostwriter

Transform raw materials into complete, professionally formatted books with proper structure. Use the `/ghostwriter` skill command.

## File Organizer

Organize files and folders, find duplicates, suggest better structures. Use the `/file-organizer` skill command.

## Platform Maker

Generate complete SaaS platforms from YAML configuration. Use the `/platform-maker` skill command.

## NotebookLM

Query Google NotebookLM notebooks for source-grounded, citation-backed answers. Use the `/notebooklm` skill command.

## Workboards

Boards of typed cards you can create, fill, and move through stages. Use them when a task produces
a set of like things to track (leads, POs, applicants, content ideas) rather than one answer.

```bash
nova workboard list                                  # what boards exist
nova workboard describe <board>                      # its fields and stages — read this before writing
nova workboard create <name> --purpose '<text>' \
  --fields '[{"key":"company","label":"Company","type":"text","primary":true}]' \
  --stages '[{"key":"new","label":"New","order":0}]'
nova workboard card add <board> --stage <key> --fields '{…}'
nova workboard card add-many <board> --stage <key> --file cards.json
nova workboard card move <card-id> --to <stage>
nova workboard card update <card-id> --fields '{…}'
nova workboard query <board> [--stage <key>] [--limit <n>]   # read the cards back as JSON
```

Field types: `text`, `longtext`, `number`, `money`, `date`, `email`, `url`, `select` (needs
`options`), `checkbox`, `agent`, `link`. Mark one field `"primary": true` — it supplies card titles.

Always `describe` a board before writing to it; a field the board doesn't declare is rejected.
Creating a board and writing cards are local and reversible, so do them directly. Moving a card
into a stage that carries an action queues that action for the relay — say so when you report back.
