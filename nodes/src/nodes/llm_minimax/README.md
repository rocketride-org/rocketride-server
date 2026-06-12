# llm_minimax

A RocketRide LLM node that connects MiniMax models to a pipeline via the MiniMax cloud API or a self-hosted OpenAI-compatible server.

## What it does

Provides MiniMax chat models as an `llm` invoke connection for agents and other nodes that need an LLM, and can also be used directly via lanes. It works against the MiniMax cloud API or a self-hosted OpenAI-compatible server (vLLM, SGLang, MLX, or Ollama).

The MiniMax API is OpenAI-compatible, so the node uses **langchain-openai** (`ChatOpenAI`) pointed at the configured base URL, with `temperature: 0` and the profile's output-token limit as `max_tokens`. Config validation at save time runs a minimal one-token probe through the **openai** SDK and surfaces provider errors as warnings.

MiniMax M2-series models return chain-of-thought wrapped in `<think>...</think>` inside the `content` field; the node strips that block so downstream pipeline nodes only see the final answer.

---

## Configuration

### Lanes

| Lane in     | Lane out  | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `questions` | `answers` | Send a question directly, receive a generated answer |

### Fields

| Field              | Type / Default                              | Description                                                                 |
| ------------------ | ------------------------------------------- | --------------------------------------------------------------------------- |
| `profile`          | enum, default `minimax-m2`                  | MiniMax model profile (see below)                                           |
| `model`            | string (set by profile)                     | MiniMax model id (editable on the Custom profile)                           |
| `modelTotalTokens` | number (set by profile)                     | Total token (context) budget for the model                                  |
| `serverbase`       | string, default `https://api.minimax.io/v1` | OpenAI-compatible base URL: `https://api.minimax.io/v1` for cloud (international), `https://api.minimaxi.com/v1` for China, local URLs for self-hosted servers (Custom and Local profiles only) |
| `apikey`           | string                                      | MiniMax API key (cloud profiles only; local profiles don't require one, the node passes a dummy token) |

---

## Profiles

### Cloud

| Profile                | Model                    | Context      |
| ---------------------- | ------------------------ | ------------ |
| MiniMax M3             | `MiniMax-M3`             | 1M tokens    |
| MiniMax M2 _(default)_ | `MiniMax-M2`             | 200K tokens  |
| MiniMax M2.1           | `MiniMax-M2.1`           | 200K tokens  |
| MiniMax M2.1 Highspeed | `MiniMax-M2.1-highspeed` | 200K tokens  |
| MiniMax M2.5           | `MiniMax-M2.5`           | 200K tokens  |
| MiniMax M2.5 Highspeed | `MiniMax-M2.5-highspeed` | 200K tokens  |
| MiniMax M2.7           | `MiniMax-M2.7`           | 200K tokens  |
| MiniMax M2.7 Highspeed | `MiniMax-M2.7-highspeed` | 200K tokens  |
| Custom Model           | User-defined             | User-defined |

The `-highspeed` variants are MiniMax's faster/cheaper tier of the same generation. MiniMax M3 is MiniMax's frontier multimodal coding model, with 5x the M2-family context (1M tokens) and a 128K-token recommended output limit (max 512K). M3 is multimodal at the API level (text + image + video), though the `llm_minimax` node only exposes the text path.

### Local deploy

Defaults target vLLM / SGLang on `http://localhost:8000/v1` with the HuggingFace model path, which is the configuration MiniMax itself documents in its local deployment guide.

| Profile              | Model (HF path)          | Server base URL (default)  | Context     |
| -------------------- | ------------------------ | -------------------------- | ----------- |
| MiniMax M2 (Local)   | `MiniMaxAI/MiniMax-M2`   | `http://localhost:8000/v1` | 200K tokens |
| MiniMax M2.5 (Local) | `MiniMaxAI/MiniMax-M2.5` | `http://localhost:8000/v1` | 200K tokens |
| MiniMax M2.7 (Local) | `MiniMaxAI/MiniMax-M2.7` | `http://localhost:8000/v1` | 200K tokens |

**Hardware notes.** MiniMax's open-weight models are MIT-licensed but large: M2 / M2.5 / M2.7 are all 230B-parameter MoE architectures (~10B active per token). The recommended local setups are:

- **Linux + GPU (>=96 GB VRAM total)**: vLLM or SGLang on port `8000`. Use the HF model path as shown above.
- **Apple Silicon Mac Studio (>=128 GB unified memory)**: MLX on port `8080`. Edit the Server base URL to `http://localhost:8080/v1` and change the model to a quantized MLX build, e.g. `mlx-community/MiniMax-M2.7-4bit`.
- **Ollama (<128 GB systems, fallback only)**: listed in MiniMax's docs as an alternative for low-memory setups. Edit the Server base URL to `http://localhost:11434/v1` and the model to whatever tag you pulled (verify with `ollama pull <tag>` before use; tags may not yet exist for every M2 variant).

These models will not fit on a typical laptop without aggressive quantization. M2.7 is the only variant whose local-deploy steps are formally documented today; the M2 and M2.5 entries are scaffolded against the same HuggingFace naming so they work as soon as their upstream guides land. M2.7 is a reasoning model: its responses split `message.content` (final answer) from `message.reasoning_content` (chain of thought), so set generous output token budgets (`max_tokens >= ~200`) even for short prompts.

---

## Authentication

Cloud profiles require a MiniMax API key in `apikey`. The key requirement is enforced by base-URL match: if `serverbase` contains `api.minimax` (covers both `api.minimax.io` international and `api.minimaxi.com` China) and no key is set, the node raises `MiniMax API key is required for cloud profiles.` at startup.

Local profiles (vLLM / SGLang / MLX / Ollama) have no `apikey` field; local OpenAI-compatible servers accept any token, so the node passes a dummy key (`sk-local-dummy-key`).

---

## Upstream docs

- [MiniMax platform documentation](https://platform.minimaxi.com/document/)
- [MiniMax API reference (OpenAI-compatible)](https://www.minimax.io/platform/document/ChatCompletion)
- [MiniMax local deployment guide](https://platform.minimax.io/docs/guides/local-deploy)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `minimax.profile` | `string` | **Model**<br/>MiniMax LLM model | `"minimax-m2"` |
| `minimax.serverbase` | `string` | **Server base URL**<br/>OpenAI-compatible base URL for the MiniMax endpoint (e.g. https://api.minimax.io/v1 for international, https://api.minimaxi.com/v1 for China). | `"https://api.minimax.io/v1"` |
| `model` | `string` | **Model**<br/>MiniMax model |  |
| `modelTotalTokens` | `number` | **Tokens**<br/>Total Tokens |  |

## Dependencies

- `openai`
- `langchain-openai`
- `langchain-core`
- `langchain`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/llm_minimax)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
