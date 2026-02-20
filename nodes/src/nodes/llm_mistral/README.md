# Mistral AI node

Integrates Mistral AI's language models into the RocketRide Data Toolchain, providing advanced natural language processing with state-of-the-art models.

## Features

- Comprehensive model support from small to large contexts
- Intelligent retry logic and error handling
- Model-specific timeouts and configurations
- Production-ready with monitoring support

## Supported Models

| Model | Use Case | Token Limit | Response Time |
|-------|----------|-------------|---------------|
| mistral-large-2411 | High-accuracy complex tasks | 131K | ~2-3s |
| mistral-medium-2505 | Balanced performance | 131K | ~1-2s |
| mistral-small-2407 | Fast responses | 32K | <1s |
| mistral-small-2506 | Latest small with large context | 131K | ~1s |
| mistral-small-2503 | Previous small with large context | 131K | ~1s |
| mistral-small-2501 | Base small model | 32K | <1s |
| magistral-small-2506 | Specialized reasoning | 40K | ~1-2s |
| devstral-small-2507 | Technical/code tasks | 131K | ~1-2s |
| ministral-8b-2410 | Edge deployment (8B) | 131K | <1s |
| ministral-3b-2410 | Edge deployment (3B) | 131K | <1s |

## Configuration

1. Get your API key from [Mistral AI](https://console.mistral.ai/)
2. Configure the node:

```json
{
  "llm_mistral": {
    "profile": "mistral-large",
    "model": "mistral-large-2411",
    "modelTotalTokens": 131072,
    "apikey": "your-mistral-api-key"
  }
}
```

## Usage

Add to your pipeline configuration:

```yaml
pipeline:
  - name: "mistral_llm"
    type: "llm_mistral"
    config:
      profile: "mistral-large"
      apikey: "${MISTRAL_API_KEY}"
```

## Model Selection Guide

- **mistral-large**: Best for complex tasks requiring deep understanding
- **mistral-medium**: Good balance of performance and speed
- **mistral-small**: Fast responses for simple tasks
- **mistral-small-latest**: Latest small model with large context
- **magistral-small**: Specialized for reasoning tasks
- **devstral-small**: Optimized for technical content
- **ministral-8b/3b**: Edge deployment with good performance

## Performance

- Timeouts:
  - Large models: 120 seconds
  - Medium models: 90 seconds
  - Small models: 60 seconds

- Retry Strategy:
  - Large models: 3 retries, 2s base delay
  - Medium models: 2 retries, 1.5s base delay
  - Small models: 2 retries, 1s base delay

## Error Handling

The node provides user-friendly error messages for:
- Authentication issues
- Rate limiting
- Model availability
- Network problems
- Content policy violations
- Wrong API key format (e.g., using OpenAI or Gemini keys)

## Examples

1. Basic Chat:
```python
from nodes.llm_mistral import Chat

chat = Chat(provider="llm_mistral", config={
    "model": "mistral-large-2411",
    "apikey": "your-api-key"
})

response = chat.chat("What is quantum computing?")
print(response.getAnswer())
```

2. Pipeline Configuration:
```yaml
pipeline:
  - name: "quantum_expert"
    type: "llm_mistral"
    config:
      profile: "mistral-large"
      apikey: "${MISTRAL_API_KEY}"
    input:
      - lane: "questions"
        output:
          - lane: "answers"
```

## Best Practices

1. Model Selection:
   - Use large models for complex tasks
   - Use small models for quick responses
   - Consider context window needs

2. Error Handling:
   - Implement proper retry logic
   - Handle rate limits gracefully
   - Monitor API usage

3. Performance:
   - Use appropriate timeouts
   - Consider model-specific retry strategies
   - Monitor response times

For detailed documentation, visit [Mistral AI Documentation](https://docs.mistral.ai/) 