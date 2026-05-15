# llm_openai Node — Usage Guide

The `llm_openai` node connects to any OpenAI-compatible LLM API for text generation,
structured extraction, and chat-based interactions.

## Configuration

```json
{
  "id": "llm_node",
  "type": "llm_openai",
  "label": "Text Analysis",
  "config": {
    "model": "gpt-4o",
    "apikey_env": "ROCKETRIDE_OPENAI_KEY",
    "system": "You are a helpful assistant. Return concise, structured answers."
  }
}
```

## Using Alternative Providers (OpenAI-compatible APIs)

The `llm_openai` node works with any OpenAI-compatible API via `base_url_env`:

```json
{
  "id": "deepseek_node",
  "type": "llm_openai",
  "label": "DeepSeek Analysis",
  "config": {
    "model": "deepseek-ai/DeepSeek-V3.2",
    "base_url_env": "GMI_BASE",
    "api_key_env": "GMI_API_KEY",
    "system": "Extract financial signals as structured JSON."
  }
}
```

Providers tested with `llm_openai`:

| Provider | `base_url_env` value | Notes |
|---|---|---|
| OpenAI | *(omit — uses default)* | `gpt-4o`, `gpt-4o-mini`, etc. |
| GMI Cloud | `https://api.gmi-serving.com/v1/chat/completions` | 40+ models including DeepSeek, Qwen, MiniMax |
| Ollama | `http://localhost:11434/v1` | Local models |
| Azure OpenAI | Your Azure endpoint | Requires `api_version` config |

## Structured JSON Output

For structured extraction, set `expectJson: true` in the pipeline or use a system
prompt that instructs the model to return JSON:

```json
{
  "id": "extractor",
  "type": "llm_openai",
  "config": {
    "model": "gpt-4o",
    "apikey_env": "ROCKETRIDE_OPENAI_KEY",
    "system": "Extract the following fields as valid JSON: {company_name, revenue, industry, risk_level}. Return only the JSON object, no prose.",
    "expectJson": true
  }
}
```

## Parallel LLM Calls

Run multiple models simultaneously and merge results — a common pattern for
consensus extraction or model evaluation:

```json
{
  "nodes": [
    {"id": "input",   "type": "source/webhook",    "config": {}},
    {"id": "model_a", "type": "llm_openai",        "config": {"model": "gpt-4o", "apikey_env": "OPENAI_KEY", "system": "..."}},
    {"id": "model_b", "type": "llm_openai",        "config": {"model": "deepseek-ai/DeepSeek-V3.2", "base_url_env": "GMI_BASE", "api_key_env": "GMI_API_KEY", "system": "..."}},
    {"id": "merge",   "type": "preprocessor_code", "config": {"language": "python", "code": "import json; a=json.loads(input_a); b=json.loads(input_b); return json.dumps({'model_a': a, 'model_b': b})"}}
  ],
  "edges": [
    {"source": "input",   "target": "model_a"},
    {"source": "input",   "target": "model_b"},
    {"source": "model_a", "target": "merge"},
    {"source": "model_b", "target": "merge"}
  ]
}
```

Both models run in parallel; the `preprocessor_code` node merges their outputs.

## Token Limits

Set `modelTotalTokens` to cap total token usage per invocation:

```json
{
  "config": {
    "model": "gpt-4o",
    "modelTotalTokens": 4096
  }
}
```

## Environment Variables

```
# OpenAI
ROCKETRIDE_OPENAI_KEY=sk-...

# GMI Cloud
GMI_API_KEY=your_key
GMI_BASE=https://api.gmi-serving.com/v1/chat/completions
```
