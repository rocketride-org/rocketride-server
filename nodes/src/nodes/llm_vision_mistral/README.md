# llm_vision_mistral

A RocketRide node that sends images to Mistral AI's vision-capable models and returns text analysis.

## What it does

Accepts either a single image (via the `image` lane) or a stream of image documents (via the `documents` lane, e.g. from a frame grabber), calls the configured Mistral vision model, and returns the model's response as text or as text documents.

Uses the official **mistralai** Python SDK with a custom `httpx` client (120 s timeout, redirects followed) to handle large image payloads. Token counting uses the **mistral-common** tokenizer, with per-model tokenizers loaded strictly; the v3 tokenizer is used as a fallback when no model-specific tokenizer is available.

All requests are sent with **temperature 0.0** for deterministic output. Transient failures (timeouts, connection errors, 5xx responses) are retried up to 3 times with exponential backoff. The base delay scales with model size: 2.0 s for `large` models, 1.5 s for `medium`, 1.0 s for all others. API errors are translated into user-friendly messages covering authentication failures, rate limits, quota exhaustion, content-policy violations, and image-processing errors.

## Lanes

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

## Configuration

Choose a model from the **Model** selector for the quality, latency, and context window
the task needs, then set the API key and prompts. Each listed model pins its model id
and token limit. The default is **Mistral Large 3 - Premier Vision (256k tokens)**
(`mistral-large-2512`).

The model settings (the selector, a custom model id and its token limits), the system prompt and the prompt are per-call parameters: a pipeline can expose them in its `parameters` map, and each call then sends its own values to the same running node, which keeps one client, sends each request on the call's model and counts tokens with that model's tokenizer (built once per model). The call's output limit is sent to the provider as the request's output cap. A caller may choose the model and its limits; an LLM may not, through a tool call.

### Models

| Model | Model id | Context tokens | Output tokens |
| ----- | -------- | -------------- | ------------- |
| Mistral Large 3 - Premier Vision (256k tokens) **(default)** | `mistral-large-2512` | 256,000 | — |
| Mistral Medium 3.1 - Balanced Vision (128k tokens) | `mistral-medium-2508` | 128,000 | — |
| Mistral Small 3.2 - Fast & Cheap Vision (128k tokens) | `mistral-small-2506` | 128,000 | — |
| Ministral 3 14B - High Performance Vision (256k tokens) | `ministral-14b-2512` | 256,000 | — |
| Ministral 3 8B - Balanced Vision (256k tokens) | `ministral-8b-2512` | 256,000 | — |
| Ministral 3 3B - Efficient Vision (256k tokens) | `ministral-3b-2512` | 256,000 | — |
| Custom model | _(user-specified)_ | editable | editable |

### Custom model

Select **Custom model** to enter a Mistral model id exactly as Mistral names it, its
total context length in tokens (default 256,000), and optionally its output token limit
(at least 1,024). Choose a model that accepts image input. The output limit is
sent to Mistral as each request's output cap; the node lowers it to the context
limit, requires at least 1,024, and reports it to nodes that ask for the model's
output length.

When the output limit is empty (always, for a listed model), each request carries
an output cap of 4,096 tokens and a longer reply stops there; choose **Custom model**
and set a higher output limit when you expect long answers. The output cap and the
input (the image and the prompt) share the context window: keep the output limit
below the context length, leaving room for the input, or the provider refuses the
request. A reasoning model counts its thinking against the same cap, so even a short
answer can come back cut off or empty: for a reasoning model, set the output limit
well above the reply you expect.

### Lane behavior

On the `image` lane, incoming image bytes are buffered across chunks, base64-encoded
with the source MIME type, and sent to the model with the **Prompt**. The answer
is written downstream as text.

On the `documents` lane, only documents of type `Image` are processed. Other document
types and images with empty content are skipped with a warning. The document's
`page_content` is expected to be base64-encoded PNG. Each answer is emitted as a
`Text` document that preserves the original metadata (`chunkId`, `time_stamp`, and
other fields). A failed chunk is logged and skipped without stopping the batch.
Documents the node does not convert — the original `Image` documents, skipped
types, and failed chunks — do not flow downstream.

### System prompt and Prompt

Use **System prompt** to define the model's role and behavior. Use **Prompt** to
describe what to extract or explain from every image; it defaults to
`Describe this image in detail.`

## Authentication

Provide a Mistral AI API key in the `apikey` field. The node validates the key format at startup: if you supply an OpenAI key (starting with `sk-`) or a Google AI/Gemini key (starting with `AI`), initialization fails immediately with a specific error message pointing to the wrong provider.

## Notes

### Image input

Both lanes hand the image to Mistral as a base64 data URI (`data:<mime>;base64,...`),
passed through as-is. The node only picks up context items that begin with
`data:image/` or `data:application/`; a request without one fails with an "Invalid
image input" error. HTTP(S) URLs and local file paths are not accepted on either lane.

## Upstream docs

- [Mistral vision documentation](https://docs.mistral.ai/capabilities/vision/)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `image_vision_mistral.profile` | `string` | **Vision Model**<br/>Select the Mistral vision model to use | `"mistral-large-3"` |
| `model` | `string` | **Model**<br/>Mistral Vision model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Maximum context length in tokens |  |
| `vision.prompt` | `string` | **Analysis Prompt**<br/>Describe what you want to analyze or extract from the image |  |
| `vision.systemPrompt` | `string` | **System Instructions**<br/>Define the model's role and behavior for image analysis |  |

## Dependencies

- `mistralai`
- `mistral-common[sentencepiece]`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_vision_mistral)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
