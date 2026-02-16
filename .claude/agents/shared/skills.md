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
