# Mistral Vision Node

## Overview

Integrates Mistral AI's vision-capable models into the RocketRide Data Toolchain for image analysis, OCR, and visual understanding. The node runs on the **image -> text** lane: it receives image data and returns text (e.g. descriptions, extracted text, or structured analysis).

## Features

- Image-to-text analysis using Pixtral and vision-enabled Mistral models
- Configurable system and user prompts per request (`vision.systemPrompt`, `vision.prompt`)
- Official Mistral tokenizer for token counting
- Robust error handling (invalid input, API errors, retries on transient failures)
- Supports URLs, base64 data URLs, and local file paths; 10MB image size limit

## Pipeline Integration

- **Lanes**: `image` -> `text`
- **Class type**: Image (invoke). Use in pipelines that send image chunks and expect a text response from Mistral Vision.

## Supported Models

Profiles and model IDs match the node's `services.json` preconfig. Use the **profile** key in config; the UI shows display titles.

| Profile           | Model ID             | Token Limit | Use Case                      |
| ----------------- | -------------------- | ----------- | ----------------------------- |
| pixtral-large     | pixtral-large-2411   | 128K        | Vision frontier (default)     |
| mistral-large-3   | mistral-large-2512   | 256K        | Premier vision                |
| mistral-medium-3.1| mistral-medium-2508  | 128K        | Balanced vision               |
| mistral-small-3.2 | mistral-small-2506   | 128K        | Fast, lower-cost vision       |
| ministral-14b-3   | ministral-14b-2512   | 256K        | High-performance vision       |
| ministral-8b-3    | ministral-8b-2512    | 256K        | Balanced vision (8B)          |
| ministral-3b-3    | ministral-3b-2512    | 256K        | Efficient vision (3B)         |

## Configuration

1. Get your API key from [Mistral AI](https://console.mistral.ai/).
2. Add the node to your pipeline with **profile**, **apikey**, and optional **vision.prompt** / **vision.systemPrompt**.

### Basic (pipe JSON)

```json
{
  "provider": "image_vision_mistral",
  "config": {
    "profile": "pixtral-large",
    "apikey": "your-mistral-api-key"
  }
}
```

### With prompts

```json
{
  "provider": "image_vision_mistral",
  "config": {
    "profile": "pixtral-large",
    "apikey": "your-mistral-api-key",
    "vision.systemPrompt": "You are an OCR specialist. Extract all text from images accurately.",
    "vision.prompt": "Extract the text from this document"
  }
}
```

### Configuration parameters

- **profile**: Pre-configured model key (`pixtral-large`, `mistral-large-3`, `mistral-medium-3.1`, `mistral-small-3.2`, `ministral-14b-3`, `ministral-8b-3`, `ministral-3b-3`). Default: **pixtral-large**. UI shows display titles; pipeline config uses these keys.
- **apikey**: Mistral AI API key (required). OpenAI-style (`sk-`) and Google AI keys are rejected with a clear message.
- **vision.systemPrompt**: Optional system instructions (model role/behavior for image analysis).
- **vision.prompt**: Optional default analysis prompt (what to extract or describe). Can be overridden per request; if the question carries prompt text, that is used.

## Usage

Add the node to your pipeline (pipe JSON). Image data is sent on the **image** lane (e.g. via `writeImage()` with AVI_ACTION chunks); the node returns text on the **text** lane.

```json
{
  "provider": "image_vision_mistral",
  "config": {
    "profile": "pixtral-large",
    "apikey": "${MISTRAL_API_KEY}"
  }
}
```

### Data flow

1. **Image accumulation:** `writeImage()` in `IInstance` receives image data in chunks (AVI_BEGIN, AVI_WRITE, AVI_END) and accumulates until the image is complete.
2. **Question building:** On AVI_END, the image is encoded as a base64 data URL and attached to a `Question` as context. The prompt is taken from config: **vision.prompt** if set, otherwise **prompt**; per-request prompt text from the question overrides this.
3. **LLM call:** The `Chat` class (`mistral_vision.py`) sends the question (image + prompt) to the Mistral Vision API, with optional **vision.systemPrompt** (or **systemPrompt**) as system role.
4. **Response:** The model's text response is written to the pipeline via `writeText()`.

### Expected inputs and supported types

- **Lane:** Image input via `writeImage()` with **AVI_ACTION** chunks (BEGIN, WRITE, END).
- **Formats:** `image/png`, `image/jpeg`, `image/gif`, `image/webp` (and equivalent base64 data URLs or file paths).
- **Size limit:** 10MB per image.

### Performance

- **Timeouts:** Large 120s, medium 90s, small/other 60s.
- **Retries:** Exponential backoff; large 3 retries (2s base), medium 3 retries (1.5s base), small/other 3 retries (1s base). Applied to timeouts, rate limits, and transient server/network errors.

## Error Handling

The node returns user-friendly messages for:

- Missing or invalid API key (and wrong key type, e.g. OpenAI/Google)
- Rate limiting, quota/billing
- Invalid image format or prompt
- Model unavailable
- Image/vision processing errors (format/size)
- Content policy violations
- Timeouts and network errors

## Dependencies

- `mistralai` and `mistral-common[sentencepiece]` (see `requirements.txt`).
