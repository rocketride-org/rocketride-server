# Perplexity AI node

Integrates Perplexity AI's language models into the RocketRide Data Toolchain, providing advanced natural language processing with real-time web search capabilities.

## Features

- Real-time web search integration
- Multiple model support with different capabilities
- Intelligent retry logic and error handling
- Production-ready with monitoring support

## Supported Models

| Model | Use Case | Token Limit |
|-------|----------|-------------|
| sonar-pro | High-accuracy search queries | 127K |
| sonar | General search and Q&A | 127K |
| sonar-reasoning-pro | Complex analysis | 127K |
| sonar-reasoning | Analytical tasks | 127K |
| sonar-deep-research | Comprehensive research | 127K |
| r1-1776 | Advanced reasoning | 128K |

## Configuration

1. Get your API key from [Perplexity AI](https://www.perplexity.ai/)
2. Configure the node:

```json
{
  "llm_perplexity": {
    "profile": "sonar-pro",
    "model": "sonar-pro",
    "modelTotalTokens": 127072,
    "apikey": "your-perplexity-api-key"
  }
}
```

## Usage

Add to your pipeline configuration:

```yaml
pipeline:
  - name: "perplexity_llm"
    type: "llm_perplexity"
    config:
      profile: "sonar-pro"
      apikey: "${PERPLEXITY_API_KEY}"
```

## Model Selection Guide

- **sonar-pro**: Fast, high-accuracy general queries
- **sonar**: Standard search and Q&A
- **sonar-reasoning-pro**: Complex analysis with citations
- **sonar-reasoning**: Standard analytical tasks
- **sonar-deep-research**: Thorough research (slower)
- **r1-1776**: Advanced reasoning tasks

## Performance

- Timeout: 60-180 seconds (model dependent)
- Retry strategy: 2-3 retries with exponential backoff
- Rate limits based on subscription tier

## Error Handling

The node provides user-friendly error messages for:
- Authentication issues
- Rate limiting
- Model availability
- Network problems
- Content policy violations

For detailed documentation, visit [Perplexity AI Documentation](https://docs.perplexity.ai/)

