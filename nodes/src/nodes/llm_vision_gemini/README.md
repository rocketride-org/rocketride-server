# llm_vision_gemini

A RocketRide filter node that sends images to Google Gemini vision-capable models and emits the model's text analysis.

## What it does

Sends images to Google Gemini vision models and returns text analysis: image description, OCR, visual understanding, and scene description. Accepts either a single streamed image (via the `image` lane) or a stream of image documents such as frames from a frame grabber (via the `documents` lane). Metadata such as frame number and timestamp is preserved on the `documents` output.

Uses the **google-genai** SDK (`>=1.14.0`). Each inference call runs in its own client and worker thread with a **30-second hard timeout**, plus one automatic retry with exponential backoff for transient errors (timeouts, connection failures, 5xx responses). If no analysis prompt is configured, the node defaults to `Describe this image in detail.`

Most profiles support a 1 million token context window, making this node well-suited for high-volume frame analysis pipelines where many images are processed in sequence. The exception is Gemini 3.1 Flash Image Preview, which has a 131,072-token limit.

When both lanes are connected for the same frame, the node calls Gemini once and reuses the cached answer for the second lane, so you are not billed twice per image.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                                      |
|-------------|-------------|----------------------------------------------------------------------------------|
| `image`     | `text`      | Analyze a single streamed image, receive the model's text response               |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved   |

On the `documents` lane, each incoming `Image` document is replaced by a `Text` document containing the model's answer, carrying the original metadata. The document content is treated as base64-encoded PNG data. The original `Image` documents do not flow downstream. Documents with a type other than `Image`, or with empty content, are skipped with a warning. On the `image` lane, empty frames are also skipped with a warning.

If inference fails for a document, the node logs a warning and continues with the next one: a single bad frame does not stop the pipeline.

### Fields

The node shape exposes a single **Vision Model** profile selector (`image_vision_gemini.profile`); the remaining fields appear once a profile is chosen.

| Field | Type | Description |
|---|---|---|
| `apikey` | string | Google AI API key. Get one at https://aistudio.google.com/apikey |
| `model` | string | Gemini Vision model |
| `modelTotalTokens` | number | Maximum context length in tokens |
| `systemPrompt` | string | Define the model's role and behavior for image analysis |
| `prompt` | string | Describe what you want to analyze or extract from the image |
| `profile` | string | Default "gemini-2_5-flash". Select the Gemini vision model to use |

The system prompt, when set, is sent to Gemini as the `system_instruction` of every request.

---

## Profiles

**Gemini 2.5**

| Profile                       | Model                          | Context   |
|-------------------------------|--------------------------------|-----------|
| Gemini 2.5 Flash _(default)_  | `models/gemini-2.5-flash`      | 1,048,576 |
| Gemini 2.5 Pro                | `models/gemini-2.5-pro`        | 1,048,576 |
| Gemini 2.5 Flash Lite         | `models/gemini-2.5-flash-lite` | 1,048,576 |

**Gemini 3.1 (Preview)**

| Profile                        | Model                                   | Context   |
|--------------------------------|-----------------------------------------|-----------|
| Gemini 3.1 Pro Preview         | `models/gemini-3.1-pro-preview`         | 1,048,576 |
| Gemini 3.1 Flash Image Preview | `models/gemini-3.1-flash-image-preview` | 131,072   |

### Choosing a profile

- **Flash Lite**: fastest and cheapest; good for high-throughput frame pipelines where speed matters more than detail
- **Flash**: balanced speed and quality; the recommended default for most vision tasks
- **Pro**: highest quality analysis; use when accuracy is critical and latency is acceptable
- **3.1 Pro Preview / Flash Image Preview**: latest generation previews; expect higher capability but potential instability as models are still in preview

---

## Authentication

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Keys are free for development use and grant access to all Gemini models listed above.

The node validates the key format at startup: keys beginning with `sk-` are rejected immediately with a clear message indicating that the key appears to be an OpenAI key. When the configuration is saved, the node also runs a minimal API probe against the selected model and surfaces any provider error (invalid key, missing model, quota exceeded, etc.) as a warning. The probe is skipped while the key is still blank.

---

## Error handling

API errors are mapped to user-friendly messages: authentication failures, rate limits, billing and quota issues, safety-filter blocks, model unavailability, timeouts, and 5xx service errors each produce a clear explanation instead of a raw stack trace.

Retry behavior: one retry for transient errors (timeout, connection, `500`/`502`/`503`/`504`, service unavailable) with exponential backoff starting at 1 second. Repeated timeouts are not retried beyond the second attempt, so a hung request costs at most two 30-second waits before the error is surfaced.

---

## Upstream docs

- [Gemini API documentation](https://ai.google.dev/gemini-api/docs)
- [Gemini model overview](https://ai.google.dev/gemini-api/docs/models)
- [Google AI Studio](https://aistudio.google.com/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `image_vision_gemini.apikey` | `string` | **API Key**<br/>Google AI API key. Get one at https://aistudio.google.com/apikey |  |
| `image_vision_gemini.profile` | `string` | **Vision Model**<br/>Select the Gemini vision model to use | `"gemini-2_5-flash"` |
| `model` | `string` | **Model**<br/>Gemini Vision model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |
| `vision.prompt` | `string` | **Analysis Prompt**<br/>Describe what you want to analyze or extract from the image |  |
| `vision.systemPrompt` | `string` | **System Instructions**<br/>Define the model's role and behavior for image analysis |  |

## Dependencies

- `google-genai` `>=1.14.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_vision_gemini)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
