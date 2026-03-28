# RocketRide MCP Server

Model Context Protocol (MCP) server that connects AI assistants to RocketRide pipelines - use Claude, Cursor, and other MCP clients to run AI workflows.

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

## Convenience Tools

The server includes built-in pipelines that work without a running RocketRide pipeline:

- **RocketRide_Document_Processor** - Extracts text, images, tables, audio, and video from documents (PDF, DOCX, etc.)

Convenience tools start their pipeline automatically when called.

## SSE Mode

For remote or Docker deployments, the server can run as an HTTP/SSE server instead of stdio:

```bash
pip install rocketride-mcp[sse]
rocketride-mcp-sse --host 0.0.0.0 --port 8080
```

SSE mode supports optional Bearer token authentication via the `MCP_API_KEY` environment variable. The `/health` endpoint is always accessible for monitoring.

## Configuration

| Variable            | Required | Description                                                         |
| ------------------- | -------- | ------------------------------------------------------------------- |
| `ROCKETRIDE_URI`    | Yes      | WebSocket URI of the RocketRide engine (e.g. `ws://localhost:5565`) |
| `ROCKETRIDE_AUTH`   | Yes\*    | API authentication token                                            |
| `ROCKETRIDE_APIKEY` | Yes\*    | Alternative to `ROCKETRIDE_AUTH`                                    |
| `MCP_API_KEY`       | No       | Bearer token for SSE server authentication                          |

\*Either `ROCKETRIDE_AUTH` or `ROCKETRIDE_APIKEY` must be set.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open-source, OSI-compliant

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
