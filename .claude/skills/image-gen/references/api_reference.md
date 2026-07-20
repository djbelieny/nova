# Image Generation API Reference

## Provider Comparison

| Feature | Gemini 2.5 Flash | OpenAI gpt-image-1 |
|---|---|---|
| **Cost** | FREE (1,500/day) | $0.011–$0.25/image |
| **Speed** | 3-5 seconds | 5-15 seconds |
| **Quality** | Good | Best in class |
| **Text rendering** | Decent | Excellent |
| **Photorealism** | Good | Excellent |
| **API key** | ai.google.dev | platform.openai.com |

## Gemini 2.5 Flash Image API

### Endpoint
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key={API_KEY}
```

### Request Body
```json
{
  "contents": [
    {
      "parts": [
        {"text": "A watercolor painting of a sunset over mountains"}
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

### Response
Images are returned as base64-encoded data in `inlineData`:
```json
{
  "candidates": [{
    "content": {
      "parts": [
        {
          "inlineData": {
            "mimeType": "image/png",
            "data": "<BASE64>"
          }
        },
        {
          "text": "Here is the generated image..."
        }
      ]
    }
  }]
}
```

### Free Tier Limits
- 1,500 requests per day
- 60 requests per minute
- No credit card required
- Get key at: https://ai.google.dev/aistudio

### Image Editing (Send image + text)
To edit an existing image, include both image and text parts:
```json
{
  "contents": [{
    "parts": [
      {
        "inlineData": {
          "mimeType": "image/png",
          "data": "<BASE64_OF_SOURCE_IMAGE>"
        }
      },
      {"text": "Remove the background and replace with a beach scene"}
    ]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"]
  }
}
```

## OpenAI gpt-image-1 API

### Endpoint
```
POST https://api.openai.com/v1/images/generations
```

### Request Body
```json
{
  "model": "gpt-image-1",
  "prompt": "A watercolor painting of a sunset over mountains",
  "n": 1,
  "size": "1024x1024",
  "quality": "low"
}
```

### Quality Tiers & Pricing
| Quality | Size | Price |
|---|---|---|
| low | 1024x1024 | $0.011 |
| medium | 1024x1024 | $0.042 |
| high | 1024x1024 | $0.167 |

### Size Options
- `1024x1024` (square)
- `1024x1536` (portrait)
- `1536x1024` (landscape)

### Response
```json
{
  "data": [
    {
      "b64_json": "<BASE64>",
      "revised_prompt": "..."
    }
  ]
}
```

## Prompt Engineering Tips

### For better results:
1. **Be specific** — "A golden retriever puppy playing in autumn leaves, soft natural lighting, shallow depth of field" beats "a dog"
2. **Specify style** — "oil painting", "watercolor", "photorealistic", "3D render", "minimalist illustration"
3. **Include lighting** — "golden hour", "dramatic shadows", "soft diffused light", "neon glow"
4. **Add composition** — "close-up", "wide angle", "bird's eye view", "centered composition"
5. **Reference mood** — "serene", "energetic", "mysterious", "whimsical"
