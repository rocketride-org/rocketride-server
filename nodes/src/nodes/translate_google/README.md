# Google Translate

Translates text between languages using the Google Cloud Translation API (v3).

## What it does

- `text → text` — translates plain text in one request at stream close.
- `documents → documents` — translates `Doc.page_content` for each segment in a batch request and passes `metadata` through unchanged, preserving `time_stamp` / `time_stamp_end` so downstream nodes (e.g., Video Player) keep subtitle timing.

Source language can be auto-detected (leave "Source language" blank) or specified explicitly.

## Setup

1. Create or select a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Enable **Cloud Translation API** (APIs & Services → Library → search "Cloud Translation").
3. Create an API key (APIs & Services → Credentials → Create credentials → API key).
4. (Recommended) Restrict the key to the Cloud Translation API.
5. Paste the key into the node's **API Key** field.

> This is **not** the same key as your Gemini / AI Studio key. Reusing a Gemini key here will return `PERMISSION_DENIED`.

## Pricing

Cloud Translation charges **$20 per 1,000,000 characters** beyond the first **500,000 free characters per billing account per month**. Source-side characters are counted. See [cloud.google.com/translate/pricing](https://cloud.google.com/translate/pricing) for current rates.

A 2-hour transcript (~100,000 characters) costs roughly $0.002 per target language.

## Example pipeline: translated video subtitles

```
video source → Transcribe → Google Translate → Video Player
                                                      ↑
              video source ───────────────────────────┘
```

- `Transcribe.documents → Google Translate.documents` — timed transcript chunks enter, translated chunks exit with the same timestamps.
- `source.video → Video Player.video` — original video stream.
- `Google Translate.documents → Video Player.documents` — translated subtitles.

## Supported languages

The node's UI lists ~20 common BCP-47 codes. The full v3 list is much larger — any two-letter or region-tagged code supported by Google Cloud Translation (e.g., `es-MX`, `pt-BR`) works if entered manually.

## Limits

- A single request translates up to 1024 segments or ~30,000 characters of source text. The node automatically splits batches above that threshold.
- For very long transcripts, translation is issued as multiple sequential v3 calls.

## Errors

Invalid or unauthorized API keys surface as UI warnings at save-time. Common causes:

- Cloud Translation API not enabled on the project backing the key.
- API key restricted to a different API (check Credentials → Edit API key → API restrictions).
- Using a Gemini / AI Studio key instead of a Google Cloud API key.
