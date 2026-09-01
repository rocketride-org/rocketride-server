# llm_deepseek

A RocketRide LLM node that connects DeepSeek models to a pipeline, via the DeepSeek cloud API, locally through Ollama, or through OpenRouter.

## What it does

Provides DeepSeek language models as an `llm` invoke connection for agents and other
nodes that need an LLM. It can also be used directly via lanes: send a question in,
receive a generated answer out.

Built on **LangChain's `ChatOpenAI`** client (DeepSeek exposes an OpenAI-compatible
API), so the same node works against the DeepSeek cloud endpoint, a local Ollama
server, or OpenRouter. Requests are made with **temperature 0**, and `max_tokens` is
capped at the selected profile's output-token limit.

At save time, the node validates cloud configurations (`deepseek-reasoner` and
`deepseek-chat` only) by sending a minimal 1-token probe to
`https://api.deepseek.com/v1`. Local/Ollama profiles are intentionally **not**
validated at save time: a misconfigured local server only surfaces at runtime.

## Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

## Profiles

Default: **Cloud Reasoner** (`cloud-reasoner`).

| Profile | Model | Context tokens | Output tokens |
| ------- | ----- | -------------- | ------------- |
| Cloud Reasoner **(default)** | `deepseek-reasoner` | 128,000 | 4,096 |
| DeepSeek: DeepSeek V4 Pro | `deepseek-v4-pro` | 1,048,576 | 384,000 |
| DeepSeek: DeepSeek V4 Flash | `deepseek-v4-flash` | 1,048,576 | 393,216 |
| DeepSeek: DeepSeek V3.2 | `deepseek-v3.2` | 163,840 | 65,536 |
| DeepSeek: DeepSeek V3.2 Exp | `deepseek-v3.2-exp` | 163,840 | 65,536 |

<details>
<summary><strong>View 19 more models</strong></summary>

| Profile | Model | Context tokens | Output tokens |
| ------- | ----- | -------------- | ------------- |
| Cloud Chat | `deepseek-chat` | 163,840 | 16,000 |
| DeepSeek R1 1.5B (`deepseek-r1-1_5b`) | `deepseek-r1:1.5b` | 128,000 | 4,096 |
| DeepSeek R1 7B (`deepseek-r1-7b`) | `deepseek-r1:7b` | 128,000 | 4,096 |
| DeepSeek R1 8B (`deepseek-r1-8b`) | `deepseek-r1:8b` | 128,000 | 4,096 |
| DeepSeek R1 14B (`deepseek-r1-14b`) | `deepseek-r1:14b` | 128,000 | 4,096 |
| DeepSeek R1 32B (`deepseek-r1-32b`) | `deepseek-r1:32b` | 128,000 | 4,096 |
| DeepSeek R1 70B (`deepseek-r1-70b`) | `deepseek-r1:70b` | 128,000 | 4,096 |
| DeepSeek R1 671B (`deepseek-r1-671b`) | `deepseek-r1:671b` | 128,000 | 4,096 |
| DeepSeek V3 (`deepseek-v3`) | `deepseek-v3` | 128,000 | 4,096 |
| DeepSeek: DeepSeek V3 0324 | `deepseek-chat-v3-0324` | 163,840 | 65,536 |
| DeepSeek: DeepSeek V3.1 | `deepseek-chat-v3.1` | 163,840 | 32,768 |
| DeepSeek: R1 | `deepseek-r1` | 163,840 | 16,000 |
| DeepSeek: R1 0528 | `deepseek-r1-0528` | 163,840 | 32,768 |
| DeepSeek: R1 Distill Llama 70B | `deepseek-r1-distill-llama-70b` | 8,192 | 8,192 |
| DeepSeek: R1 Distill Qwen 32B | `deepseek-r1-distill-qwen-32b` | 32,768 | 32,768 |
| TNG: DeepSeek R1T2 Chimera | `deepseek-r1t2-chimera` | 163,840 | 163,840 |
| Nex AGI: DeepSeek V3.1 Nex N1 | `deepseek-v3.1-nex-n1` | 131,072 | 163,840 |
| DeepSeek: DeepSeek V3.1 Terminus | `deepseek-v3.1-terminus` | 163,840 | 32,768 |
| DeepSeek: DeepSeek V3.2 Speciale | `deepseek-v3.2-speciale` | 163,840 | 163,840 |

</details>

Cloud profiles use the DeepSeek API, local profiles use an Ollama-compatible
endpoint, and OpenRouter profiles use OpenRouter credentials.

## Configuration

Choose a profile for the provider and deployment you intend to use. Each profile
sets the model, model source, context and output limits, and—where applicable—the
endpoint; most users only need to provide the corresponding API key.

### Endpoint

Local profiles use the OpenAI-compatible `serverbase`, which defaults to
`http://localhost:11434/v1` for Ollama. The selected model must already be pulled
into Ollama. An empty endpoint raises `DeepSeek serverbase is required.` Cloud and
OpenRouter profiles supply their own endpoints.

## Authentication

DeepSeek cloud profiles require a key beginning with `sk-`; another format raises
`Invalid DeepSeek API key format` at startup. OpenRouter profiles require an
OpenRouter API key. Local profiles need no credential, so the node supplies the
placeholder `sk-local-dummy-key` required by the OpenAI client.

## Notes

### Save-time validation

When a pipeline is saved, `validateConfig` runs a 1-token probe (`"Hi"`) against the
DeepSeek cloud API using the official `openai` SDK, but only when the configured model
is `deepseek-reasoner` or `deepseek-chat`. Provider errors are surfaced as warnings
with the HTTP status, error type, and message preserved (e.g.
`Error 401: authentication_error - ...`); they do not block the save. All other
profiles (local and OpenRouter) are skipped at save time and will only fail at runtime
if misconfigured.

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
