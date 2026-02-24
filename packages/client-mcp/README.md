# rocketride-mcp

RocketRide MCP Client — Model Context Protocol integration for the RocketRide Engine. Complete API reference below.

---

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

### Available Tools

Tools are **discovered from the RocketRide server** (pipelines/tasks available to your account) plus a built-in convenience tool:

- **Server tasks** — Any pipelines or tasks returned by the server for your API key are exposed as MCP tools. Each tool accepts a `filepath` argument and sends that file’s contents to the corresponding pipeline.
- **RocketRide_Document_Processor** — A convenience tool that runs the bundled document-parsing pipeline (`simpleparser.json`) without requiring a pre-started task. Supports multi-modal parsing (text, images, video, tables, audio).

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

| Variable | Required | Description |
|----------|----------|-------------|
| `ROCKETRIDE_URI` | Yes | Server URI (e.g. `https://your-engine.example.com`) |
| `ROCKETRIDE_APIKEY` | Yes* | API key for authentication |
| `ROCKETRIDE_AUTH` | Yes* | Alternative to `ROCKETRIDE_APIKEY` |

\* Provide either `ROCKETRIDE_APIKEY` or `ROCKETRIDE_AUTH`.

```bash
export ROCKETRIDE_URI=https://your-engine.example.com
export ROCKETRIDE_APIKEY=your-api-key
```

## Directory Structure

```text
packages/client-mcp/
├── src/rocketride_mcp/
│   ├── server.py      # MCP server implementation and entry point
│   ├── tools.py       # Tool definitions and execution
│   ├── config.py      # Configuration (env var loading)
│   └── pipelines/     # Bundled pipelines
│       └── simpleparser.json  # Document-parsing pipeline
├── pyproject.toml     # Python package config
└── README.md          # This file
```

## License

MIT License — see [LICENSE](./LICENSE)
