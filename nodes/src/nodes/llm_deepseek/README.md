# llm_deepseek

A RocketRide LLM node that connects DeepSeek models to a pipeline, via the DeepSeek cloud API or locally through Ollama.

## What it does

Provides DeepSeek language models as an `llm` invoke connection for agents and other
nodes that need an LLM. It can also be used directly via lanes: send a question in,
receive a generated answer out.

Built on **LangChain's `ChatOpenAI`** client (DeepSeek exposes an OpenAI-compatible
API), so the same node works against the DeepSeek cloud endpoint, a local Ollama
server, or any other OpenAI-compatible endpoint set on the Custom model. Requests are
made with **temperature 0**, and `max_tokens` is capped at the selected model's
output-token limit.

At save time, the node validates configurations whose endpoint is the DeepSeek API
(`api.deepseek.com`) by sending a minimal 1-token probe to it. Local/Ollama models
are intentionally **not** validated at save time: a misconfigured local server only
surfaces at runtime.

## Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Configuration

Choose a model from the **Model** selector for the deployment you intend to use. Each
listed model pins its model id, context and output limits, and its endpoint; the
cloud models use the DeepSeek API at `https://api.deepseek.com/v1`, so most users only
need to provide a DeepSeek API key. The default is **Cloud Reasoner**
(`deepseek-reasoner`).

### Models

| Model | Model id | Context tokens | Output tokens |
| ----- | -------- | -------------- | ------------- |
| Cloud Reasoner **(default)** | `deepseek-reasoner` | 128,000 | 4,096 |
| Cloud Chat | `deepseek-chat` | 163,840 | 16,384 |
| deepseek-r1-1_5b | `deepseek-r1:1.5b` | 128,000 | 4,096 |
| deepseek-r1-7b | `deepseek-r1:7b` | 128,000 | 4,096 |
| deepseek-r1-8b | `deepseek-r1:8b` | 128,000 | 4,096 |
| deepseek-r1-14b | `deepseek-r1:14b` | 128,000 | 4,096 |
| deepseek-r1-32b | `deepseek-r1:32b` | 128,000 | 4,096 |
| deepseek-r1-70b | `deepseek-r1:70b` | 128,000 | 4,096 |
| deepseek-r1-671b | `deepseek-r1:671b` | 128,000 | 4,096 |
| deepseek-v3 | `deepseek-v3` | 128,000 | 4,096 |
| DeepSeek: DeepSeek V3 0324 | `deepseek-chat-v3-0324` | 163,840 | 147,456 |
| DeepSeek: DeepSeek V3.1 | `deepseek-chat-v3.1` | 163,840 | 144,900 |
| DeepSeek: R1 | `deepseek-r1` | 64,000 | 16,000 |
| DeepSeek: R1 0528 | `deepseek-r1-0528` | 163,840 | 32,768 |
| DeepSeek: R1 Distill Llama 70B | `deepseek-r1-distill-llama-70b` | 8,192 | 7,372 |
| DeepSeek: DeepSeek V3.1 Terminus | `deepseek-v3.1-terminus` | 163,840 | 32,768 |
| DeepSeek: DeepSeek V3.2 | `deepseek-v3.2` | 163,840 | 65,536 |
| DeepSeek: DeepSeek V3.2 Exp | `deepseek-v3.2-exp` | 163,840 | 65,536 |
| DeepSeek: DeepSeek V4 Flash | `deepseek-v4-flash` | 1,048,576 | 384,000 |
| DeepSeek: DeepSeek V4 Pro | `deepseek-v4-pro` | 1,048,576 | 384,000 |
| DeepSeek: DeepSeek V4 Flash 0731 | `deepseek-v4-flash-0731` | 1,310,720 | 131,072 |
| DeepSeek V4 Flash Latest | `deepseek-v4-flash-latest` | 1,310,720 | 393,216 |
| DeepSeek: DeepSeek V4 Flash Vision Exp | `deepseek-v4-flash-vision-exp` | 1,048,576 | 384,000 |
| DeepSeek: DeepSeek V4 Pro 0813 | `deepseek-v4-pro-0813` | 1,048,576 | 384,000 |
| Custom model | _(user-specified)_ | editable | editable |

The models whose ids carry an Ollama tag (`deepseek-r1:1.5b` through
`deepseek-r1:671b`) and `deepseek-v3` are local models served by Ollama; every other
listed model uses the DeepSeek API.

### Endpoint

Local models use the OpenAI-compatible `serverbase`, which defaults to
`http://localhost:11434/v1` for Ollama. The selected model must already be pulled
into Ollama. An empty endpoint raises `DeepSeek serverbase is required.` Cloud models
pin the DeepSeek API endpoint.

### Custom model

Select **Custom model** to enter a model id, its total token limit (128,000 by
default), its output limit (4,096 by default), and the **Server URL** of the
OpenAI-compatible endpoint that serves it (`https://api.deepseek.com/v1` by default).

## Authentication

Whenever the endpoint is the DeepSeek API (`api.deepseek.com`), a key is required
and must begin with `sk-`: a missing key raises `DeepSeek API key is required for the
DeepSeek API endpoint.` and another format raises `Invalid DeepSeek API key format` at
startup. Local endpoints need no credential, so the node supplies the placeholder
`sk-local-dummy-key` required by the OpenAI client when no key is set.

## Notes

### Save-time validation

When a pipeline is saved, `validateConfig` runs a 1-token probe (`"Hi"`) using the
official `openai` SDK, but only when the configured endpoint is the DeepSeek API
(`api.deepseek.com`); a missing key there is reported as a warning instead. Provider
errors are surfaced as warnings with the HTTP status, error type, and message preserved
(e.g. `Error 401: authentication_error - ...`); they do not block the save. Local
models are skipped at save time and will only fail at runtime if misconfigured.

## Upstream docs

- [DeepSeek API documentation](https://platform.deepseek.com/docs)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `deepseek.profile` | `string` | **Model**<br/>Deepseek LLM model | `"cloud-reasoner"` |
| `model` | `string` | **Model**<br/>Deepseek model |  |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_deepseek)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
