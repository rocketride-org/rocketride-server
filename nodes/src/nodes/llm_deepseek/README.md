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

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
|-------------|-----------|------------------------------------------------------|
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

| Field        | Type / Default                 | Description                                                                     |
|--------------|--------------------------------|---------------------------------------------------------------------------------|
| `profile`    | enum, default `cloud-reasoner` | Which DeepSeek model profile to use (see below). Shown as **Model** in the UI. |
| `apikey`     | string                         | API key. Cloud and OpenRouter profiles only; local profiles have no key field.  |
| `serverbase` | string                         | OpenAI-compatible endpoint URL. Local profiles only; default `http://localhost:11434/v1` (Ollama). |

Each profile pre-configures `model`, `modelSource`, `modelTotalTokens`,
`modelOutputTokens`, and (for cloud/local) `serverbase`. Only the fields listed
above are user-editable; the rest come from the selected profile.

### API key handling

- For the cloud endpoint (`serverbase` containing `api.deepseek`), the key must start
  with `sk-`; anything else raises `Invalid DeepSeek API key format` at startup.
- For local profiles no key is needed; the node substitutes a dummy key
  (`sk-local-dummy-key`) internally because the OpenAI client requires a non-empty value.
- `serverbase` is required: an empty value raises `DeepSeek serverbase is required.`

---

## Profiles

The default profile is **Cloud Reasoner** (`cloud-reasoner`).

### Cloud (DeepSeek API)

Served from `https://api.deepseek.com/v1`; requires a DeepSeek API key.

| Profile                    | Model               | Context / output tokens |
|----------------------------|---------------------|-------------------------|
| Cloud Reasoner *(default)* | `deepseek-reasoner` | 128,000 / 4,096         |
| Cloud Chat                 | `deepseek-chat`     | 163,840 / 16,384        |

### Local via Ollama

Served from `serverbase` (default `http://localhost:11434/v1`); no API key required.
All local profiles are configured with 128,000 context / 4,096 output tokens. The
model must already be pulled into Ollama before the pipeline runs.

| Profile          | Model              |
|------------------|--------------------|
| DeepSeek R1 1.5B | `deepseek-r1:1.5b` |
| DeepSeek R1 7B   | `deepseek-r1:7b`   |
| DeepSeek R1 8B   | `deepseek-r1:8b`   |
| DeepSeek R1 14B  | `deepseek-r1:14b`  |
| DeepSeek R1 32B  | `deepseek-r1:32b`  |
| DeepSeek R1 70B  | `deepseek-r1:70b`  |
| DeepSeek R1 671B | `deepseek-r1:671b` |
| DeepSeek V3      | `deepseek-v3`      |

### Via OpenRouter

These profiles have `modelSource: openrouter` and require an OpenRouter API key. They
are not probed at save time.

| Profile                          | Model                           | Context / output tokens |
|----------------------------------|---------------------------------|-------------------------|
| DeepSeek: DeepSeek V3 0324       | `deepseek-chat-v3-0324`         | 163,840 / 16,384        |
| DeepSeek: DeepSeek V3.1          | `deepseek-chat-v3.1`            | 32,768 / 7,168          |
| DeepSeek: R1                     | `deepseek-r1`                   | 64,000 / 16,000         |
| DeepSeek: R1 0528                | `deepseek-r1-0528`              | 163,840 / 32,768        |
| DeepSeek: R1 Distill Llama 70B   | `deepseek-r1-distill-llama-70b` | 131,072 / 16,384        |
| DeepSeek: R1 Distill Qwen 32B    | `deepseek-r1-distill-qwen-32b`  | 32,768 / 32,768         |
| TNG: DeepSeek R1T2 Chimera       | `deepseek-r1t2-chimera`         | 163,840 / 163,840       |
| Nex AGI: DeepSeek V3.1 Nex N1   | `deepseek-v3.1-nex-n1`          | 131,072 / 163,840       |
| DeepSeek: DeepSeek V3.1 Terminus | `deepseek-v3.1-terminus`        | 163,840 / 32,768        |
| DeepSeek: DeepSeek V3.2          | `deepseek-v3.2`                 | 131,072 / 65,536        |
| DeepSeek: DeepSeek V3.2 Exp      | `deepseek-v3.2-exp`             | 163,840 / 65,536        |
| DeepSeek: DeepSeek V3.2 Speciale | `deepseek-v3.2-speciale`        | 163,840 / 163,840       |
| DeepSeek: DeepSeek V4 Flash      | `deepseek-v4-flash`             | 1,048,576 / 384,000     |
| DeepSeek: DeepSeek V4 Pro        | `deepseek-v4-pro`               | 1,048,576 / 384,000     |

---

## Config validation

When a pipeline is saved, `validateConfig` runs a 1-token probe (`"Hi"`) against the
DeepSeek cloud API using the official `openai` SDK, but only when the configured model
is `deepseek-reasoner` or `deepseek-chat`. Provider errors are surfaced as warnings
with the HTTP status, error type, and message preserved (e.g.
`Error 401: authentication_error - ...`); they do not block the save. All other
profiles (local and OpenRouter) are skipped at save time and will only fail at runtime
if misconfigured.

---

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
