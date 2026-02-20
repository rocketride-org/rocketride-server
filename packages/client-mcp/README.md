# @rocketride/client-mcp

RocketRide MCP Client - Model Context Protocol integration for the RocketRide Engine.

## Building (from source)

From the repository root:

```bash
./builder client-mcp:build
```

This builds the Python wheel. Depends on `client-python`. Use `./builder build` for a full build.

## Overview

This package provides an MCP (Model Context Protocol) server that enables AI assistants like Claude to interact with the RocketRide Engine directly.

## Installation

```bash
pip install rocketride-mcp
```

## Usage

### With Claude Desktop

Add to your Claude configuration:

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

### Available Tools

Tools are **discovered from the RocketRide server** (pipelines/tasks available to your account) plus a built-in convenience tool:

- **Server tasks** – Any pipelines or tasks returned by the server for your API key are exposed as MCP tools. Each tool accepts a `filepath` argument and sends that file’s contents to the corresponding pipeline.
- **RocketRide_Document_Processor** – A convenience tool that runs the bundled document-parsing pipeline without requiring a pre-started task.

All tools use a single `filepath` parameter (path to the file to process).

## Configuration

Set these environment variables (required; no config file is used):

```bash
export ROCKETRIDE_URI=https://your-engine.example.com
export ROCKETRIDE_APIKEY=your-api-key
```

You can use `ROCKETRIDE_AUTH` instead of `ROCKETRIDE_APIKEY` if you prefer.

## Directory Structure

```
packages/client-mcp/
├── src/rocketride_mcp/
│   ├── server.py      # MCP server implementation
│   ├── tools.py       # Tool definitions
│   ├── config.py      # Configuration
│   └── pipelines/     # Example pipelines
├── pyproject.toml     # Python package config
└── README.md          # This file
```

## License

MIT License - see [LICENSE](./LICENSE)
