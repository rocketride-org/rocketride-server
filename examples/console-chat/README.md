# Console Chat Example

A simple console-based chat application demonstrating RocketRide Engine integration.

## Overview

This example shows how to:
- Connect to the RocketRide Engine
- Execute a chat pipeline
- Handle streaming responses
- Process user input

## Prerequisites

- Node.js 18+
- Running RocketRide Engine instance

## Installation

```bash
cd examples/console-chat
pnpm install
```

## Usage

```bash
# Start the chat
pnpm start

# With custom engine host
pnpm start --host localhost --port 8080
```

## Code Structure

```
console-chat/
├── src/
│   └── index.ts       # Main entry point
├── chat.pipe.json     # Chat pipeline configuration
├── package.json       # Package configuration
├── tsconfig.json      # TypeScript configuration
└── README.md          # This file
```

## Pipeline Configuration

The `chat.pipe.json` defines the chat pipeline:

```json
{
  "source": {
    "type": "chat"
  },
  "filters": [
    {
      "type": "llm_openai",
      "model": "gpt-4",
      "systemPrompt": "You are a helpful assistant."
    }
  ]
}
```

## Example Session

```
RocketRide Chat Console
Type 'exit' to quit.

> Hello, what can you help me with?
I can help you with:
- Searching and analyzing your documents
- Answering questions about your data
- Classifying and organizing content
- And much more!

> exit
Goodbye!
```

## License

MIT License - see [LICENSE](../../LICENSE)
