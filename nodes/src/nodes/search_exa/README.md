# Exa Search node

`search_exa` is a direct search node that sends a single user question to Exa Search and returns the raw Exa JSON response.

## Pipeline shape

- **Input lane**: `questions`
- **Output lanes**: `answers`, `text`
- **Category**: `search`

Use it in pipelines such as:

```json
{
  "components": [
    {
      "id": "chat_1",
      "provider": "chat",
      "config": {
        "mode": "Source",
        "type": "chat"
      }
    },
    {
      "id": "search_exa_1",
      "provider": "search_exa",
      "config": {
        "apikey": "${ROCKETRIDE_APIKEY_EXA}",
        "profile": "default",
        "default": {
          "type": "auto",
          "numResults": 5,
          "includeHighlights": true,
          "highlightChars": 600
        }
      },
      "input": [
        {
          "lane": "questions",
          "from": "chat_1"
        }
      ]
    },
    {
      "id": "response_1",
      "provider": "response",
      "config": {
        "lanes": []
      },
      "input": [
        {
          "lane": "answers",
          "from": "search_exa_1"
        }
      ]
    }
  ],
  "source": "chat_1"
}
```

## Configuration

- `apikey`: Exa API key. Required.
- `profile`: currently `default`.
- `type`: `auto`, `keyword`, or `neural`.
- `numResults`: number of results to request.
- `includeHighlights`: whether to request Exa highlights.
- `highlightChars`: maximum highlight characters returned by Exa.

For local development, prefer environment-backed configuration:

```bash
ROCKETRIDE_APIKEY_EXA=your_exa_api_key
```

and in the pipe:

```json
"apikey": "${ROCKETRIDE_APIKEY_EXA}"
```

## Behavior

- Expects exactly one question per invocation.
- Returns the raw Exa API response JSON.
- Maps common Exa errors into clearer authentication, rate-limit, and request failure messages.
