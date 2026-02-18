#!/usr/bin/env python3
"""
Image generation script using Gemini 2.5 Flash (free) or OpenAI gpt-image-1 (paid fallback).

Usage:
    python generate_image.py "a cat riding a skateboard" [output.png] [--provider gemini|openai] [--size 1024x1024]

Environment variables:
    GEMINI_API_KEY   - Google AI Studio API key (free at ai.google.dev)
    OPENAI_API_KEY   - OpenAI API key (paid, used as fallback)

Dependencies:
    pip install google-genai   (for Gemini provider)
"""

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path


def generate_gemini(prompt: str, output_path: str) -> str:
    """Generate image using Gemini via the google-genai SDK (free tier: 1500/day)."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "GEMINI_API_KEY not set. Get a free key at https://ai.google.dev/aistudio"
        )

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise RuntimeError(
            "google-genai package not installed. Run: pip install google-genai"
        )

    client = genai.Client(api_key=api_key)

    # Try models in order of preference
    models = ["gemini-2.5-flash-image", "gemini-2.0-flash-exp-image-generation"]
    last_error = None

    for model_name in models:
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["TEXT", "IMAGE"],
                ),
            )
            break
        except Exception as e:
            last_error = e
            continue
    else:
        raise RuntimeError(f"All Gemini models failed. Last error: {last_error}")

    # Extract image from response parts
    if not response.candidates or not response.candidates[0].content.parts:
        raise RuntimeError(f"No content in Gemini response")

    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            mime = part.inline_data.mime_type or "image/png"
            img_bytes = part.inline_data.data

            # Adjust extension based on mime type
            ext = ".png"
            if "jpeg" in mime or "jpg" in mime:
                ext = ".jpg"
            elif "webp" in mime:
                ext = ".webp"

            if not output_path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                output_path = output_path + ext

            Path(output_path).write_bytes(img_bytes)
            return output_path

    # Check for text-only response (content policy block, etc.)
    text_parts = [p.text for p in response.candidates[0].content.parts if p.text]
    if text_parts:
        raise RuntimeError(f"Gemini returned text instead of image: {' '.join(text_parts)}")

    raise RuntimeError("No image data found in Gemini response")


def generate_openai(prompt: str, output_path: str, size: str = "1024x1024") -> str:
    """Generate image using OpenAI gpt-image-1 (paid)."""
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "OPENAI_API_KEY not set. Get a key at https://platform.openai.com/api-keys"
        )

    url = "https://api.openai.com/v1/images/generations"

    payload = {
        "model": "gpt-image-1",
        "prompt": prompt,
        "n": 1,
        "size": size,
        "quality": "low",
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API error {e.code}: {body}")

    results = data.get("data", [])
    if not results:
        raise RuntimeError(f"No results from OpenAI: {json.dumps(data, indent=2)}")

    # OpenAI returns base64 or URL
    result = results[0]
    if "b64_json" in result:
        img_bytes = base64.b64decode(result["b64_json"])
    elif "url" in result:
        with urllib.request.urlopen(result["url"], timeout=60) as img_resp:
            img_bytes = img_resp.read()
    else:
        raise RuntimeError("No image data in OpenAI response")

    if not output_path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
        output_path = output_path + ".png"

    Path(output_path).write_bytes(img_bytes)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Generate an image from a text prompt")
    parser.add_argument("prompt", help="Text description of the image to generate")
    parser.add_argument("output", nargs="?", default=None, help="Output file path (default: auto-generated)")
    parser.add_argument("--provider", choices=["gemini", "openai", "auto"], default="auto",
                        help="Image provider (default: auto — tries Gemini first, then OpenAI)")
    parser.add_argument("--size", default="1024x1024", help="Image size for OpenAI (default: 1024x1024)")
    args = parser.parse_args()

    # Generate output path if not specified
    if args.output is None:
        safe_name = "".join(c if c.isalnum() or c in " -_" else "" for c in args.prompt[:50]).strip()
        safe_name = safe_name.replace(" ", "_").lower() or "image"
        args.output = f"/tmp/{safe_name}.png"

    output_path = args.output

    if args.provider == "auto":
        # Try Gemini first (free), fall back to OpenAI
        if os.environ.get("GEMINI_API_KEY"):
            try:
                result = generate_gemini(args.prompt, output_path)
                print(f"Generated (Gemini): {result}")
                return
            except Exception as e:
                print(f"Gemini failed: {e}", file=sys.stderr)
                print("Falling back to OpenAI...", file=sys.stderr)

        if os.environ.get("OPENAI_API_KEY"):
            try:
                result = generate_openai(args.prompt, output_path, args.size)
                print(f"Generated (OpenAI): {result}")
                return
            except Exception as e:
                print(f"OpenAI failed: {e}", file=sys.stderr)

        print("ERROR: No API keys found. Set GEMINI_API_KEY (free) or OPENAI_API_KEY (paid).", file=sys.stderr)
        print("  Gemini: https://ai.google.dev/aistudio", file=sys.stderr)
        print("  OpenAI: https://platform.openai.com/api-keys", file=sys.stderr)
        sys.exit(1)

    elif args.provider == "gemini":
        result = generate_gemini(args.prompt, output_path)
        print(f"Generated (Gemini): {result}")

    elif args.provider == "openai":
        result = generate_openai(args.prompt, output_path, args.size)
        print(f"Generated (OpenAI): {result}")


if __name__ == "__main__":
    main()
