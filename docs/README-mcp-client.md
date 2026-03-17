# RocketRide MCP

Model Context Protocol (MCP) integration for the RocketRide Engine -- let AI assistants run your pipelines.

> [RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
> This package provides an MCP stdio server that lets AI assistants like Claude interact with a RocketRide engine directly --
> discovering tools, running pipelines, and processing documents.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE --
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** -- 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** -- production-grade speed and reliability
- **Deploy anywhere** -- locally, on-premises, or self-hosted with Docker
- **MIT licensed** -- fully open source, OSI-compliant

## Overview

This package provides an MCP (Model Context Protocol) stdio server that enables AI assistants like Claude to interact with the RocketRide Engine directly. It:

- **Discovers tools dynamically** from the connected RocketRide server
- **Provides a built-in document-parsing pipeline** as a convenience tool
- **Handles file paths** with `file://` URI support, `~` expansion, and URL decoding
- **Retries automatically** with exponential backoff when starting convenience pipelines

## Installation

```bash
pip install rocketride-mcp
```

Requires Python 3.10+ and `rocketride-client-python` >= 1.1.0.

## Usage

### With Claude Desktop

Add to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "rocketride": {
      "command": "python",
      "args": ["-m", "rocketride_mcp"]
    }
  }
}
```

### With Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "rocketride": {
      "command": "rocketride-mcp"
    }
  }
}
```

### Command line

```bash
# Using the installed entry point
rocketride-mcp

# Or using Python module
python -m rocketride_mcp
```

### Available tools

Tools are **discovered from the RocketRide server** (pipelines/tasks available to your account) plus a built-in convenience tool:

- **Server tasks** -- Any pipelines or tasks returned by the server for your API key are exposed as MCP tools. Each tool accepts a `filepath` argument and sends that file's contents to the corresponding pipeline.
- **RocketRide_Document_Processor** -- A convenience tool that runs the bundled document-parsing pipeline (`simpleparser.json`) without requiring a pre-started task. Supports multi-modal parsing (text, images, video, tables, audio).

All tools accept a single `filepath` parameter (path to the file to process). File paths support:

- Absolute and relative paths
- `file://` URIs (automatically decoded)
- `~` home directory expansion

### Response format

Tool results include both human-readable text and structured data:

- **Text content**: Confirmation message plus extracted text from the pipeline result
- **Structured content**: Raw pipeline result in `structuredContent.result` for programmatic access

## Configuration

Set these environment variables (required; no config file is used):

| Variable           | Required | Description                                          |
| ------------------ | -------- | ---------------------------------------------------- |
| `ROCKETRIDE_URI`   | Yes      | Server URI (e.g. `https://your-engine.example.com`)  |
| `ROCKETRIDE_APIKEY` | Yes*    | API key for authentication                           |
| `ROCKETRIDE_AUTH`  | Yes*     | Alternative to `ROCKETRIDE_APIKEY`                   |

\* Provide either `ROCKETRIDE_APIKEY` or `ROCKETRIDE_AUTH`.

```bash
export ROCKETRIDE_URI=https://your-engine.example.com
export ROCKETRIDE_APIKEY=your-api-key
```

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT -- see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
