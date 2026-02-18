---
name: image-gen
description: Generate images from text prompts using AI models. This skill should be used when the user asks to create, generate, draw, design, or make an image, picture, illustration, photo, graphic, logo, icon, artwork, or visual. Supports Gemini 2.5 Flash (free, 1500 images/day) and OpenAI gpt-image-1 (paid fallback). Also handles image editing when a source image is provided with modification instructions.
---

# Image Generation

Generate images from text descriptions using the `scripts/generate_image.py` script. Primary provider is **Gemini 2.5 Flash** (free tier: 1,500 images/day). Falls back to **OpenAI gpt-image-1** if Gemini is unavailable.

## Quick Start

```bash
python scripts/generate_image.py "a sunset over mountains in watercolor style" /tmp/sunset.png
```

## Workflow

### 1. Craft the Prompt

Transform the user's request into a detailed image generation prompt:

- Add **style** descriptors: "photorealistic", "oil painting", "minimalist illustration", "3D render"
- Add **lighting**: "golden hour", "soft natural light", "dramatic shadows"
- Add **composition**: "close-up", "wide angle", "centered", "rule of thirds"
- Add **mood**: "serene", "energetic", "mysterious", "whimsical"
- Keep the user's core intent — enhance, don't override

### 2. Generate the Image

Run the script with the crafted prompt:

```bash
python /Users/djbelieny/.claude/skills/image-gen/scripts/generate_image.py "<prompt>" <output_path>
```

**Arguments:**
- `prompt` (required) — text description of the image
- `output` (optional) — file path for the output image (default: `/tmp/<name>.png`)
- `--provider gemini|openai|auto` — force a specific provider (default: `auto`)
- `--size 1024x1024` — image size, OpenAI only (options: `1024x1024`, `1024x1536`, `1536x1024`)

**Environment variables required:**
- `GEMINI_API_KEY` — free key from https://ai.google.dev/aistudio (primary)
- `OPENAI_API_KEY` — paid key from https://platform.openai.com (fallback)

### 3. Present the Result

After generation, read the output image file to display it to the user. The script prints the output path on success.

### 4. Iterate

If the user wants changes, modify the prompt and regenerate. Common adjustments:
- "Make it more colorful" — add "vibrant colors, saturated"
- "More realistic" — add "photorealistic, 8K, detailed"
- "Simpler" — add "minimalist, clean, simple"
- "Different style" — replace style descriptors

## Provider Selection

| Provider | Cost | Speed | Quality | Best For |
|---|---|---|---|---|
| Gemini 2.5 Flash | **Free** (1,500/day) | Fast (3-5s) | Good | Most tasks |
| OpenAI gpt-image-1 | $0.011+/image | Medium (5-15s) | Excellent | Text in images, photorealism |

The script auto-selects: Gemini first (if `GEMINI_API_KEY` is set), then OpenAI fallback.

## Setup

If no API key is configured, guide the user:

1. Go to https://ai.google.dev/aistudio
2. Sign in with Google account
3. Click "Get API Key" → "Create API key"
4. Set it: `export GEMINI_API_KEY=<key>` (or add to `.env`)

## Reference

For detailed API documentation, provider comparison, and prompt engineering tips, see `references/api_reference.md`.
