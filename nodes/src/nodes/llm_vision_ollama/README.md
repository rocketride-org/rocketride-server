# llm_vision_ollama

A RocketRide image node that sends images to locally-hosted Ollama vision models and returns text analysis.

## What it does

Connects to open-source multimodal models (Llama 3.2 Vision, LLaVA, Moondream, MiniCPM-V, Qwen 2.5 VL, or any custom model) served by a local Ollama instance. No API key is required: models run entirely on your own hardware, making the node suitable for privacy-sensitive workloads. It accepts either a single image or a stream of image documents (e.g. from a frame grabber); metadata such as frame number and timestamp is preserved on the `documents` output.

Uses **langchain-openai** (`ChatOpenAI`) against Ollama's OpenAI-compatible `/v1` endpoint. The configured server base URL is normalized to end with `/v1` automatically, and a placeholder API key (`"ollama"`) is sent because Ollama ignores it. Requests run with `temperature: 0`.

Each inference attempt is capped by a 30-second hard timeout; a timed-out or retryable failure is retried once with exponential backoff (a fresh HTTP client is created per attempt so a hung request cannot exhaust the connection pool). API errors are translated into actionable user-facing messages (see Troubleshooting).

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------ |
| `image`     | `text`      | Analyze a single image, receive text                                           |
| `documents` | `documents` | Analyze image documents, return text analysis with original metadata preserved |

### Image to text

Raw image bytes arrive in chunks over the AVI protocol, are accumulated, encoded as a base64 data URL with the incoming MIME type, and sent to the model together with the configured analysis prompt. The model's answer is written to the `text` lane.

### Documents to documents

Each incoming `Doc` of type `Image` (its `page_content` is base64-encoded PNG, since the frame grabber always outputs PNG) is analyzed individually. The answer is emitted as a `Text` Doc that preserves the original document metadata (`chunkId`, `time_stamp`, etc.). Non-`Image` documents and `Image` documents with empty content are skipped with a warning; a per-document inference failure is logged and skipped rather than failing the batch. The original image documents do not flow downstream.

If no analysis prompt is configured, the question text from the request is used; if that is also empty, the prompt defaults to `Describe this image.`

### Fields

The node is configured by selecting a profile in the **Vision Model** field (`image_vision_ollama.profile`, default `llama3_2-vision-11b`). All profiles expose the same connection and prompt fields; the **Custom** profile additionally exposes the model name and token limit.

| Field | Type | Description |
|---|---|---|
| `model` | string | Ollama vision model name |
| `modelTotalTokens` | number | Total Tokens |
| `systemPrompt` | string | Define the model's role and behavior for image analysis |
| `prompt` | string | Describe what you want to analyze or extract from the image |
| `profile` | string | Default "llama3_2-vision-11b". Select the Ollama vision model to use |

---

## Profiles

| Profile                          | Model                 | Context tokens |
| -------------------------------- | --------------------- | -------------- |
| Llama 3.2 Vision 11B _(default)_ | `llama3.2-vision:11b` | 128,000        |
| Llama 3.2 Vision 90B             | `llama3.2-vision:90b` | 128,000        |
| Qwen 2.5 VL 3B                   | `qwen2.5vl:3b`        | 128,000        |
| Qwen 2.5 VL 7B                   | `qwen2.5vl:7b`        | 128,000        |
| LLaVA 7B                         | `llava:7b`            | 32,768         |
| LLaVA 13B                        | `llava:13b`           | 4,096          |
| LLaVA 34B                        | `llava:34b`           | 4,096          |
| MiniCPM-V                        | `minicpm-v`           | 8,192          |
| Moondream 2                      | `moondream`           | 2,048          |
| Custom                           | _(user-specified)_    | configurable   |

See the [Ollama model library](https://ollama.com/library) for available models. The selected model must be pulled into Ollama before use (`ollama pull <model>`).

---

## Troubleshooting

The node maps common API failures to clear messages:

| Symptom                               | Meaning / fix                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "Cannot connect to Ollama server"     | Ollama is not running, or `serverbase` points to the wrong host/port                              |
| "Model '...' is not loaded in Ollama" | Pull the model first: `ollama pull <model>`                                                       |
| "Too many requests to Ollama"         | Rate limited: wait a moment and retry                                                             |
| "Ollama returned a server error"      | Check the Ollama server logs                                                                      |
| "Vision request timed out"            | Inference exceeded the 30 s hard timeout; large models may need a warm-up run or a smaller model |
| "Image processing error"              | Use a supported image format: JPEG, PNG, GIF, WEBP                                                |

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `image_vision_ollama.profile` | `string` | **Vision Model**<br/>Select the Ollama vision model to use | `"llama3_2-vision-11b"` |
| `model` | `string` | **Model**<br/>Ollama vision model name |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |
| `vision.prompt` | `string` | **Analysis Prompt**<br/>Describe what you want to analyze or extract from the image |  |
| `vision.systemPrompt` | `string` | **System Instructions**<br/>Define the model's role and behavior for image analysis |  |

## Dependencies

- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_vision_ollama)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
