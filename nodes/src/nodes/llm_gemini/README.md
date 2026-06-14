# llm_gemini

A RocketRide LLM node that connects Google Gemini models to a pipeline.

## What it does

Connects Google Gemini models to your pipeline. Used primarily as an `llm` invoke
connection by agents and other nodes that need an LLM (`classType: llm`, capability
`invoke`). Can also be used directly via lanes: text arriving on the `questions` lane is
sent to the configured model and the generated text is emitted on the `answers` lane.

Uses the **google-genai** library (`genai.Client`) against the Gemini Developer API with
API-key authentication. Prompts are sent with `client.models.generate_content` and the
plain text response is returned. Token counts for budgeting are estimated locally at
roughly 0.75 tokens per word: an approximation, not the model's native tokenizer.

When you save the node configuration, it is validated with a minimal live probe (a
one-word prompt against the configured model). Provider errors (bad key, unknown model,
quota, etc.) surface as a warning that includes the provider's error code, status, and
full message. Image-output models that reject a text-only probe with an
`INVALID_ARGUMENT` "response modalities" error pass validation, since that is a probe
artifact rather than a configuration problem. The probe is skipped entirely when no API
key is present (secure fields are not decrypted at validate time).

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

The node is configured by picking a model profile and supplying an API key.

| Field              | Type / Default                         | Description                                                                 |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------- |
| `profile`          | enum, default `gemini-3_1-pro-preview` | Gemini model profile (see table below), or `custom`                         |
| `apikey`           | string (secure)                        | Google AI Developer API key                                                 |
| `model`            | string                                 | Custom profile only: Gemini model identifier (e.g. `models/gemini-2.5-pro`) |
| `modelTotalTokens` | number, default `1114112` (custom)     | Custom profile only: maximum input + output tokens                          |
| `outputTokens`     | number, default `65536` (custom)       | Custom profile only: maximum output tokens                                  |

---

## Profiles

Each preconfigured profile pins a model with its context window and output limit
(values from `services.json`):

| Profile                                       | Model                                          | Total tokens | Output tokens |
| --------------------------------------------- | ---------------------------------------------- | ------------ | ------------- |
| Gemini 3.1 Pro _(default)_                    | `models/gemini-3.1-pro-preview`                | 1,048,576    | 65,536        |
| Gemini 3.1 Flash Image Preview                | `models/gemini-3.1-flash-image-preview`        | 131,072      | 65,536        |
| Gemini 3.1 Flash Lite                         | `models/gemini-3.1-flash-lite-preview`         | 1,048,576    | 65,536        |
| Gemini 3 Flash Preview                        | `models/gemini-3-flash-preview`                | 1,048,576    | 65,536        |
| Gemini 3 Pro Image Preview                    | `models/gemini-3-pro-image-preview`            | 65,536       | 32,768        |
| Gemini 2.5 Pro                                | `models/gemini-2.5-pro`                        | 1,048,576    | 65,536        |
| Gemini 2.5 Flash                              | `models/gemini-2.5-flash`                      | 1,048,576    | 65,535        |
| Gemini 2.5 Flash Lite                         | `models/gemini-2.5-flash-lite`                 | 1,048,576    | 65,535        |
| Gemini 2.5 Flash Image                        | `models/gemini-2.5-flash-image`                | 32,768       | 32,768        |
| Google: Gemini 2.5 Flash Lite Preview 09-2025 | `models/gemini-2.5-flash-lite-preview-09-2025` | 1,048,576    | 65,535        |
| Google: Gemini 2.5 Pro Preview 06-05          | `models/gemini-2.5-pro-preview`                | 1,048,576    | 65,536        |
| Google: Gemini 2.5 Pro Preview 05-06          | `models/gemini-2.5-pro-preview-05-06`          | 1,048,576    | 65,535        |
| Google: Gemini 3.1 Pro Preview Custom Tools   | `models/gemini-3.1-pro-preview-customtools`    | 1,048,576    | 65,536        |
| Google Gemini Flash Latest                    | `models/gemini-flash-latest`                   | 1,048,576    | 65,536        |
| Google Gemini Pro Latest                      | `models/gemini-pro-latest`                     | 1,048,576    | 65,536        |
| Custom                                        | _(user-specified)_                             | configurable | configurable  |

Profiles marked **Image** support image generation output.

### Deprecated profiles

These remain selectable for existing pipelines but are deprecated; switch to the
suggested replacement:

| Deprecated profile    | Replacement                  |
| --------------------- | ---------------------------- |
| Gemini 3 Pro Preview  | `gemini-3.1-pro-preview`     |
| Gemini 3 Pro Image    | `gemini-3-pro-image-preview` |
| Gemini 2.0 Flash      | `gemini-2.5-flash`           |
| Gemini 2.0 Flash Lite | `gemini-2.5-flash-lite`      |

---

## Authentication

Provide a Google AI Developer API key in the `apikey` field of the chosen profile
(create one in Google AI Studio). The key is stored as a secure field. Key format
validation is delegated to the google-genai library; a missing key fails at pipeline
start with `Please enter your Gemini API key.`

Gotcha: the engine derives a profile sub-key from the segment after the first
underscore of the profile name (e.g. `gemini-2_5-pro` is stored under `5-pro`). The
node transparently falls back to that sub-key when reading the API key, so keys saved
under either layout work.

Vertex AI is not used by this node; it targets the Gemini Developer API only. (The
google-genai client also supports Vertex AI via `genai.Client(vertexai=True, ...)`; a
future refactor could unify the separate Vertex node with this one.)

---

## Running the tests

The node ships a `test` block in `services.json` that runs against a local test server
with a mocked `google.genai`, so no real API key is required. Set `ROCKETRIDE_MOCK` to
`nodes/test/mocks`; the test sends "What is 2+2?" on `questions` (profile
`gemini-2_5-flash`) and expects `answers` to contain "Mock LLM response".

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `gemini.apikey` | `string` | **API Key**<br/>Google AI Developer API key |  |
| `gemini.model` | `string` | **Model**<br/>Gemini model |  |
| `gemini.modelTotalTokens` | `number` | **Total Tokens**<br/>Maximum number of input + output tokens |  |
| `gemini.outputTokens` | `number` | **Output Tokens**<br/>Maximum number of output tokens |  |
| `gemini.profile` | `string` | **Model**<br/>Gemini LLM model | `"gemini-3_1-pro-preview"` |

## Dependencies

- `google-genai`
- `google-api-core`
- `google-auth`
- `googleapis-common-protos`
- `proto-plus`
- `protobuf`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_gemini)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
