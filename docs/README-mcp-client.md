<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/banner-mcp.png" alt="RocketRide MCP Server" width="900">
</p>

<p align="center">
  Let AI assistants run your RocketRide pipelines via the Model Context Protocol.
</p>

<p align="center">
  <a href="https://glama.ai/mcp/servers/rocketride-org/rocketride-server"><img src="https://glama.ai/mcp/servers/rocketride-org/rocketride-server/badges/score.svg" alt="Glama MCP Score"></a>
</p>

<p align="center">
  <a href="https://pypi.org/project/rocketride-mcp/"><img src="https://img.shields.io/pypi/v/rocketride-mcp?color=222223&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/9hr3tdZmEG"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/license-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

```bash
pip install rocketride-mcp
```

Configure your MCP client to use the server (see examples below), then ask your AI assistant to process files through your running RocketRide pipelines.

## How It Works

The MCP server connects to a running RocketRide engine and dynamically exposes your pipelines as MCP tools. When an AI assistant calls a tool, the server sends the file to the corresponding pipeline and returns the result.

```
AI Assistant (Claude, Cursor, ...)
        |
   MCP Protocol
        |
  rocketride-mcp server
        |
   WebSocket (DAP)
        |
  RocketRide Engine
        |
   Your Pipelines
```

Running pipelines are discovered automatically - start a pipeline in VS Code or via the SDK, and it appears as a callable tool in your AI assistant.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE --
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open-source, OSI-compliant

## Installation

```bash
pip install rocketride-mcp
```

Requires Python 3.10+ and `rocketride-client-python` >= 1.1.0.

## Client Configuration

### Claude Desktop

Add to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
	"mcpServers": {
		"rocketride": {
			"command": "rocketride-mcp",
			"env": {
				"ROCKETRIDE_URI": "ws://localhost:5565",
				"ROCKETRIDE_AUTH": "your-api-key"
			}
		}
	}
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace:

```json
{
	"mcpServers": {
		"rocketride": {
			"command": "rocketride-mcp",
			"env": {
				"ROCKETRIDE_URI": "ws://localhost:5565",
				"ROCKETRIDE_AUTH": "your-api-key"
			}
		}
	}
}
```

### Claude Code

```bash
claude mcp add rocketride -- rocketride-mcp
```

Set `ROCKETRIDE_URI` and `ROCKETRIDE_AUTH` in your environment before running.

### Command line

```bash
# Using the installed entry point
rocketride-mcp

# Or using Python module
python -m rocketride_mcp
```

## Available Tools

Tools are **discovered from the RocketRide server** (pipelines/tasks available to your account) plus a built-in convenience tool:

- **Server tasks** - Any pipelines or tasks returned by the server for your API key are exposed as MCP tools. Each tool accepts a `filepath` argument and sends that file's contents to the corresponding pipeline.
- **RocketRide_Document_Processor** - A convenience tool that runs the bundled document-parsing pipeline (`simpleparser.json`) without requiring a pre-started task. Supports multi-modal parsing (text, images, video, tables, audio).

All tools accept a single `filepath` parameter (path to the file to process). File paths support:

- Absolute and relative paths
- `file://` URIs (automatically decoded)
- `~` home directory expansion

### Response format

Tool results include both human-readable text and structured data:

- **Text content**: Confirmation message plus extracted text from the pipeline result
- **Structured content**: Raw pipeline result in `structuredContent.result` for programmatic access

## SSE Mode

For remote or Docker deployments, the server can run as an HTTP/SSE server instead of stdio:

```bash
pip install rocketride-mcp[sse]
rocketride-mcp-sse --host 0.0.0.0 --port 8080
```

SSE mode supports optional Bearer token authentication via the `MCP_API_KEY` environment variable. The `/health` endpoint is always accessible for monitoring.

## Configuration

Set these environment variables (required; no config file is used):

| Variable            | Required | Description                                                         |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `ROCKETRIDE_URI`    | Yes      | WebSocket URI of the RocketRide engine (e.g. `ws://localhost:5565`) |
| `ROCKETRIDE_AUTH`   | Yes\*    | API authentication token                                            |
| `ROCKETRIDE_APIKEY` | Yes\*    | Alternative to `ROCKETRIDE_AUTH`                                    |
| `MCP_API_KEY`       | No       | Bearer token for SSE server authentication                          |

\*Either `ROCKETRIDE_AUTH` or `ROCKETRIDE_APIKEY` must be set.

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
