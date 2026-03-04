# Perplexity AI Node

## Overview

Integrates Perplexity AI's Sonar models into the RocketRide Data Toolchain, providing natural language processing with real-time web search. The node runs on the **questions -> answers** lane: it receives questions and returns model responses (with optional citations when supported by the model).

## Features

- Real-time web search integration (Sonar models)
- Multiple model support (standard, reasoning, deep research)
- Intelligent retry logic and exponential backoff
- Model-specific timeouts and retry configuration
- User-friendly error messages (auth, rate limits, content policy, timeouts)

## Pipeline Integration

- **Lanes**: `questions` -> `answers`
- **Class type**: LLM (invoke). Use in pipelines that need Perplexity chat completions with web grounding.

## Supported Models

Profiles and model IDs match the node's `services.json` preconfig. Use the **profile** key in config; the UI shows display titles (e.g. "Sonar Pro", "Sonar Reasoning").

| Profile              | Model ID              | Token Limit | Use Case                                        |
| -------------------- | --------------------- | ----------- | ----------------------------------------------- |
| sonar-pro            | sonar-pro             | 200K        | High-accuracy search and Q&A                    |
| sonar                | sonar                 | 128K        | General search and Q&A (default)                |
| sonar-reasoning-pro  | sonar-reasoning-pro   | 128K        | Complex analysis with citations                 |
| sonar-reasoning      | sonar-reasoning       | 128K        | Analytical tasks                                |
| sonar-deep-research  | sonar-deep-research   | 128K        | Comprehensive research (slower, longer timeout) |

### Model selection guide

- **sonar-pro**: Fast, high-accuracy general queries (200K context).
- **sonar**: Standard search and Q&A (default profile).
- **sonar-reasoning-pro**: Complex analysis with citations.
- **sonar-reasoning**: Standard analytical tasks.
- **sonar-deep-research**: Thorough research; slower and longer timeout (180s).

## Configuration

1. Get your API key from [Perplexity AI](https://www.perplexity.ai/) (API/settings).
2. Add the node to your pipeline with **profile** and **apikey**.

### Basic (pipe JSON)

```json
{
  "provider": "llm_perplexity",
  "config": {
    "profile": "sonar-pro",
    "apikey": "your-perplexity-api-key"
  }
}
```

Only the profiles above are defined; **modelTotalTokens** is set per profile in the service definition. Use environment variables for secrets (e.g. `apikey` from `${PERPLEXITY_API_KEY}`) when your pipeline runner supports it.

### Configuration parameters

- **profile**: Pre-configured model key: `sonar-pro`, `sonar`, `sonar-reasoning-pro`, `sonar-reasoning`, `sonar-deep-research`. The UI shows display titles; pipeline config uses these keys. Default when omitted is **sonar** (preconfig default).
- **model**: Set by profile; not required in config for named profiles.
- **modelTotalTokens**: Set per profile in the service (e.g. 200K for sonar-pro, 128K for others).
- **apikey**: Perplexity API key (required).

## Usage

Add the node to your pipeline (pipe JSON):

```json
{
  "provider": "llm_perplexity",
  "config": {
    "profile": "sonar-pro",
    "apikey": "${PERPLEXITY_API_KEY}"
  }
}
```

The node is invoked when a question is sent on the **questions** lane; the answer is produced on the **answers** lane.

### Performance

- **Timeouts** (from `perplexity.py`):
  - sonar-deep-research: 180 seconds
  - Reasoning models: 120 seconds
  - Standard models: 60 seconds

- **Retry strategy** (exponential backoff):
  - sonar-deep-research: 3 retries, 2s base delay
  - Reasoning models: 2 retries, 1.5s base delay
  - Standard models: 2 retries, 1s base delay

Retries apply to timeouts and transient server/network errors. Rate limits are not retried automatically; the node returns a clear message.

## Error Handling

The node converts API errors into user-friendly messages for:

- Authentication issues (invalid or missing API key)
- Rate limiting (429; consider upgrading plan)
- Model availability
- Network problems
- Content policy violations
- Timeouts (suggests retry or a faster model)

## Testing

The node defines automated tests in `services.json` (e.g. profile **sonar** and a mock-style case). See the project's node testing documentation for how to run them.

## Dependencies

- `openai`, `langchain-openai`, `transformers`, `tokenizers`, and related LangChain/transformers deps (see `requirements.txt`). The node uses the OpenAI-compatible Perplexity API client.