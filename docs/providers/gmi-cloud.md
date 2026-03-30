# GMI Cloud — LLM Provider

GMI Cloud provides access to 40+ models via an OpenAI-compatible API, including
DeepSeek, Qwen, MiniMax, Gemini, and Claude models.

## Configuration

GMI Cloud works with the `llm_openai` node using a custom base URL:

```json
{
  "id": "analysis_node",
  "type": "llm_openai",
  "label": "Pattern Analysis (GMI Cloud)",
  "config": {
    "model": "deepseek-ai/DeepSeek-V3.2",
    "base_url_env": "GMI_BASE",
    "api_key_env": "GMI_API_KEY",
    "system": "Your system prompt here"
  }
}
```

Set environment variables:

```
GMI_API_KEY=your_api_key_here
GMI_BASE=https://api.gmi-serving.com/v1/chat/completions
```

## Available Models

| Model | Best For |
|---|---|
| `deepseek-ai/DeepSeek-V3.2` | Structured extraction, JSON output |
| `Qwen/Qwen3.5-35B-A3B` | Reasoning, analysis |
| `MiniMaxAI/MiniMax-M2.7` | Long context |
| `google/gemini-3.1-flash-lite-preview` | Fast, cheap |
| `anthropic/claude-sonnet-4-6` | High quality |

## Example: Multi-Model Evaluation Pipeline

```json
{
  "nodes": [
    {"id": "deepseek", "type": "llm_openai", "config": {"model": "deepseek-ai/DeepSeek-V3.2", "base_url_env": "GMI_BASE", "api_key_env": "GMI_API_KEY"}},
    {"id": "qwen",     "type": "llm_openai", "config": {"model": "Qwen/Qwen3.5-35B-A3B",    "base_url_env": "GMI_BASE", "api_key_env": "GMI_API_KEY"}},
    {"id": "compare",  "type": "preprocessor_code", "config": {"language": "python", "code": "..."}}
  ],
  "edges": [
    {"source": "input", "target": "deepseek"},
    {"source": "input", "target": "qwen"},
    {"source": "deepseek", "target": "compare"},
    {"source": "qwen", "target": "compare"}
  ]
}
```

Run both models in parallel and compare outputs — RocketRide's parallel DAG execution makes this straightforward.

## Getting Started

1. Sign up at [console.gmicloud.ai](https://console.gmicloud.ai)
2. Generate an API key
3. Set `GMI_API_KEY` and `GMI_BASE` in your environment
4. Use any model ID from the [GMI model catalog](https://console.gmicloud.ai/models)
