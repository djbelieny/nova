---
name: ai-video-creator
description: AI video creation and avatar video generation — scriptwriting, AI avatar videos (HeyGen, Synthesia, D-ID, Tavus), text-to-video generation (Kling, Runway, Fal.ai), and video content strategy. This skill should be used when the user asks to create AI videos, generate avatar/talking head videos, write video scripts, produce social media video content, or create video ads using AI tools.
---

# AI Video Creator

This skill handles AI-powered video creation — from scriptwriting and storyboarding to generating avatar videos and text-to-video content using the best available AI platforms.

## When to Use This Skill

- Creating AI avatar / talking head videos
- Generating text-to-video or image-to-video content
- Writing video scripts (ads, social media, tutorials, sales)
- Producing video ads for Meta, YouTube, TikTok
- Creating personalized video messages at scale
- Building a video content pipeline
- Choosing between AI video platforms
- Creating custom avatar clones

## AI Video Platforms

### Avatar / Talking Head Videos

These platforms generate realistic videos of people (real or AI) speaking your script.

#### HeyGen (Recommended for quality)
- **API:** REST API available
- **Custom Avatars:** Digital Twins (clone yourself from video)
- **Pricing:** Free (10 credits/month), Creator $29/month, Business $89/month
- **Strengths:** Best lip-sync quality, 500+ stock avatars, 40+ languages
- **Best for:** Professional video content, personalized outreach, ads
- **API endpoint:** `https://api.heygen.com/v2/video/generate`

#### Tavus (Best for personalized video at scale)
- **API:** Full REST API with voice cloning
- **Custom Avatars:** Personal Replicas from 2 min of video
- **Pricing:** Starter $1/month, Hobbyist $39/month, Business $199/month
- **Strengths:** Hyperrealistic clones, custom voice models, lowest entry price
- **Best for:** Sales outreach, personalized messages, video emails

#### D-ID (Best for real-time / interactive)
- **API:** REST API, real-time streaming
- **Custom Avatars:** V2-V4 Expressive avatars
- **Latency:** Sub-200ms, 100 FPS
- **Strengths:** Real-time conversations, sentiment-adaptive expressions
- **Best for:** Interactive agents, live support, chatbots

#### Synthesia (Best for enterprise)
- **API:** Enterprise API
- **Custom Avatars:** Yes (Express-2 with natural gestures)
- **Pricing:** Enterprise only (~$22/month entry)
- **Strengths:** 140+ languages, corporate training focus, compliance features
- **Best for:** Training videos, onboarding, internal comms

### Text-to-Video Generation

These platforms generate video clips from text descriptions or images.

#### Kling 3.0 (Best speed + quality)
- **API:** Via PiAPI or official Kling API
- **Released:** January 2026
- **Speed:** 3-5x faster than Sora
- **Resolution:** Up to 1080p
- **Free tier:** 66 daily credits (~6 videos)
- **Capabilities:** Text-to-video, image-to-video, video-to-video
- **Best for:** Quick social media clips, product demos, b-roll

#### Runway Gen-4.5 (Best cinematic quality)
- **API:** docs.dev.runwayml.com
- **Duration:** 4-8 second clips
- **Features:** Custom voice cloning, object removal
- **Best for:** High-end ad creative, cinematic content

#### Fal.ai (Best aggregator — multiple models)
- **API:** REST API with 600+ models
- **Models:** Kling, Luma Dream Machine, Mochi, Minimax Hailuo, Grok Imagine
- **Pricing:** Pay-per-generation (lowest costs at scale)
- **Best for:** High-volume generation, testing different models

### Free / Budget Options

| Platform | Free Tier | Limitations |
|----------|-----------|-------------|
| **HeyGen** | 10 credits/month | Watermark, 720p |
| **Kling AI** | 66 daily credits | ~6 videos/day |
| **Vidnoz** | 60 daily credits | 1900+ avatars, watermark |
| **Pollo AI** | Unlimited basic | Lower quality |
| **Pika** | Basic tier free | Limited features |

## Video Scriptwriting

### Script Frameworks by Use Case

#### Social Media Video (15-60 seconds)
```
HOOK (0-3 sec):
[Pattern interrupt — bold claim, question, or visual hook]
"Stop scrolling if you [target audience identifier]"

PROBLEM (3-10 sec):
[State the pain point they relate to]
"You've probably tried [common failed solution]..."

SOLUTION (10-30 sec):
[Introduce your product/service as the answer]
[Show/demonstrate the key benefit]
[One piece of social proof]

CTA (last 5 sec):
[Clear next step]
"[Action] — link in bio / comment [word] / click below"
```

#### Product Demo Video (30-90 seconds)
```
HOOK (0-5 sec):
"Here's how [product] works in [timeframe]"

DEMO (5-60 sec):
Step 1: [Show the starting point — the problem]
Step 2: [Show the product in action]
Step 3: [Show the result — the transformation]

PROOF (60-75 sec):
[Testimonial quote or stat]
"[X] customers already use this to [result]"

CTA (75-90 sec):
"Try it free at [URL]" or "Link in bio"
```

#### Talking Head / Educational (1-3 minutes)
```
HOOK (0-10 sec):
[Bold statement or question that creates curiosity]
"Most people get [topic] completely wrong. Here's why."

CONTEXT (10-30 sec):
[Why this matters — stakes, relevance]
"This matters because [consequence of not knowing]"

CONTENT (30 sec - 2.5 min):
Point 1: [Key insight + example]
Point 2: [Key insight + example]
Point 3: [Key insight + example]

SUMMARY (2.5 - 2.75 min):
"So remember: [recap 3 points in one sentence]"

CTA (last 15 sec):
"Follow for more [topic] tips" or "[Next action]"
```

#### Video Ad (15-30 seconds)
```
HOOK (0-3 sec):
[The ONE thing that stops them — visual or verbal]

PROMISE (3-8 sec):
[What they'll get — clear benefit statement]

PROOF (8-20 sec):
[Show it working — demo, testimonial, or before/after]

OFFER (20-25 sec):
[What they get + price/discount + urgency]

CTA (25-30 sec):
[Single clear action: "Shop now", "Sign up free", "Learn more"]
```

#### Personalized Sales Video (30-60 seconds)
```
GREETING (0-5 sec):
"Hey [Name], this is [Your name] from [Company]"

RELEVANCE (5-15 sec):
"I noticed [something specific about them/their company]"

VALUE (15-40 sec):
"We help [similar companies] achieve [result]"
[One specific case study or stat]

ASK (40-55 sec):
"Would it make sense to [next step]?"
"I've got [specific time] open this week"

CLOSE (55-60 sec):
"Looking forward to connecting. Talk soon."
```

## Video Production Workflow

### Step 1: Brief
```
Video Type: [avatar / text-to-video / hybrid]
Platform: [Instagram Reel / TikTok / YouTube / Ad / Email]
Duration: [X seconds/minutes]
Tone: [professional / casual / energetic / educational]
Avatar: [stock / custom clone / none]
Script: [provided or needs writing]
```

### Step 2: Script
- Write script using appropriate framework above
- Keep sentences short (spoken word ≠ written word)
- Time it: ~150 words per minute of speech
- Add visual directions in brackets [show product, cut to B-roll]

### Step 3: Generate
Choose platform based on need:
- **Avatar video:** HeyGen or Tavus API
- **B-roll / visual clips:** Kling or Fal.ai
- **Product demo with screen:** Record + AI avatar intro/outro
- **Batch personalized:** Tavus (variable injection per recipient)

### Step 4: Post-Production
- Add captions/subtitles (critical — 85% watch without sound)
- Add background music (platform-appropriate)
- Thumbnail creation (use `/image-gen` or `/canvas-design`)
- Platform-specific formatting (aspect ratio, duration)

### Step 5: Distribute
- Use `/social-media-manager` for scheduling
- Use `/meta-ads-manager` for paid promotion
- Use `/telegram-file-sender` for direct delivery

## Video Content Strategy

### Weekly Video Calendar
```
Monday:    Educational talking head (1-2 min)
Tuesday:   Product tip / demo clip (30-60 sec)
Wednesday: Customer testimonial (30 sec avatar + text overlay)
Thursday:  Behind-the-scenes / personal story (60 sec)
Friday:    Trending format / remix (15-30 sec)
```

### Content Repurposing Pipeline
```
Long-form video (5+ min)
├── 3-5 short clips (15-60 sec each)
├── Thumbnail → social media image
├── Transcript → blog post
├── Key quotes → text posts
└── Audio → podcast episode
```

### Platform-Specific Formatting

| Platform | Aspect Ratio | Duration | Captions |
|----------|-------------|----------|----------|
| Instagram Reel | 9:16 | 15-90 sec | Required |
| TikTok | 9:16 | 15-60 sec | Required |
| YouTube Short | 9:16 | < 60 sec | Recommended |
| YouTube Long | 16:9 | 8-15 min | Recommended |
| Facebook Feed | 1:1 or 4:5 | 15-60 sec | Required |
| LinkedIn | 1:1 or 16:9 | 30-90 sec | Required |
| Stories | 9:16 | 15 sec per | Optional |

## Execution via Tools

### Nova AI Video Module (Primary — `src/ai-video.ts`)

Nova has a built-in AI video module. Use it via Bash:

**HeyGen CLI (Avatar Videos):**
```bash
bun run src/ai-video.ts avatars         # List available avatars (1289)
bun run src/ai-video.ts voices          # List English voices
bun run src/ai-video.ts quota           # Check remaining credits
bun run src/ai-video.ts video-status <id>  # Check generation status
```

**Fal.ai CLI (Text-to-Video):**
```bash
bun run src/ai-video.ts text-to-video "a golden sunrise over mountains"  # Kling 2.0
bun run src/ai-video.ts fal-status <url>   # Check status
bun run src/ai-video.ts fal-result <url>   # Get completed video URL
bun run src/ai-video.ts fal-wait <url>     # Wait for completion
```

**Programmatic (import in scripts):**
```typescript
import { generateAvatarVideo, waitForVideo, generateTextToVideo, waitForFalVideo } from "./src/ai-video.ts";

// HeyGen avatar video — uses the user's avatar/voice from DB preferences
const video = await generateAvatarVideo({
  script: "Hey, welcome to our channel...",
  width: 1080, height: 1920,  // 9:16 portrait
  test: true,  // free low-res test
  user_preferences: user.preferences,  // loads heygen_avatar_id + heygen_voice_id
});
const result = await waitForVideo(video.data.video_id);
console.log(result.data.video_url);

// Fal.ai text-to-video (Kling 2.0)
const job = await generateTextToVideo({
  prompt: "A product spinning on a marble surface, cinematic lighting",
  duration: "5", aspect_ratio: "9:16",
});
const clip = await waitForFalVideo(job.response_url);
console.log(clip.video.url);
```

**Per-user avatar/voice IDs** are stored in `users.preferences` (keys: `heygen_avatar_id`, `heygen_voice_id`). Pass `user_preferences: user.preferences` to `generateAvatarVideo()` and it auto-resolves.

**Stock English Voices:** Marco, Ray (male), Amy (female), Mike (male)
**Fal.ai Models:** Kling 2.0 Master/Standard, Minimax Hailuo, Luma Dream Machine, Runway Gen-3

### Browser Automation (Playwright — Fallback)
For complex workflows not covered by the API:
- Manage avatar settings on HeyGen web
- Download generated videos
- Access Synthesia/D-ID (no API keys configured)

### Image Generation
Use `/image-gen` or `/canvas-design` for:
- Video thumbnails
- Text overlays and title cards
- B-roll images for image-to-video generation

### File Delivery
Use `/telegram-file-sender` to deliver generated videos directly to Telegram.

## Output Format

When creating a video, provide:
1. **Platform & format** (Reel, TikTok, ad, etc.)
2. **Script** (timestamped, with visual directions)
3. **Avatar/generation method** (which platform + settings)
4. **Duration estimate**
5. **Thumbnail concept**
6. **Caption/copy** for the post
7. **Distribution plan** (where to publish)

When planning a video strategy, provide:
1. Content calendar (what videos, when)
2. Platform-specific formatting needs
3. Production pipeline (who/what creates each video)
4. API/tool requirements and costs
5. Performance metrics to track
