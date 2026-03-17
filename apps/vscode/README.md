# RocketRide for Visual Studio Code

Build, debug, and deploy AI pipelines -- without leaving your IDE.

> RocketRide is an open source, developer-native AI pipeline platform. This extension brings the full RocketRide experience into VS Code: a visual drag-and-drop canvas builder, 50+ ready-to-use nodes, integrated debugging, and real-time analytics.

## Quick Start

1. Install the **RocketRide** extension from the VS Code Marketplace
2. Click the **RocketRide** icon in the Activity Bar
3. Create a `.pipe` file -- it opens automatically in the visual canvas builder
4. Wire up nodes by connecting input and output lanes, then hit **Play** to run

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE --
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** -- 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** -- production-grade speed and reliability
- **Deploy anywhere** -- locally, on-premises, or self-hosted with Docker
- **MIT licensed** -- fully open source, OSI-compliant

## Features

- **Visual canvas builder** -- Drag, drop, and wire up AI workflows directly in VS Code. Create `.pipe` files to get started.
- **50+ nodes out of the box** -- 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, multi-agent orchestration, and more.
- **Connection manager** -- Connect to a local engine (one click, no setup) or your own on-premises server.
- **Real-time analytics** -- Monitor running pipelines with live traces, token usage, memory stats, and more.
- **Debugger support** -- Set breakpoints in `.pipe` files and step through pipeline execution with the VS Code debugger.
- **SDKs for TypeScript, Python & MCP** -- Embed pipelines in your apps or expose them as tools for AI assistants.

## Build a Pipeline

Create a `*.pipe` file and the extension opens it in the visual builder canvas.

1. Start with a source node: **webhook**, **chat**, or **dropper**
2. Wire up nodes by connecting input and output lanes
3. Hit play to run -- or launch from the **Connection Manager**
4. Monitor running pipelines with real-time analytics -- trace calls, token usage, memory, and more

Need inspiration? Check out our [example pipelines](https://docs.rocketride.org/):

- [Advanced RAG](https://docs.rocketride.org/examples/advanced-rag-pipeline/)
- [Video Frame Grabber](https://docs.rocketride.org/examples/video-key-frame-grabber/)
- [Audio Transcription](https://docs.rocketride.org/examples/audio-transcription-simple/)

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `rocketride.connectionMode` | `string` | `"local"` | Connection mode: `"local"` (your machine), `"onprem"` (your own hosted server), or `"cloud"` |
| `rocketride.hostUrl` | `string` | `"http://localhost:5565"` | Host URL for RocketRide service. Host and port will be parsed from this URL. |
| `rocketride.defaultPipelinePath` | `string` | `"${workspaceFolder}/pipelines"` | Default directory path for creating new pipeline files |
| `rocketride.local.engineVersion` | `string` | `"latest"` | Engine version to download. `"latest"` for newest stable, `"prerelease"` for newest prerelease, or a specific tag like `"server-v3.1.1"`. |
| `rocketride.engineArgs` | `string[]` | `[]` | Additional arguments passed to the engine subprocess |
| `rocketride.autoConnect` | `boolean` | `true` | Automatically connect to RocketRide server when extension activates |
| `rocketride.pipelineRestartBehavior` | `string` | `"prompt"` | Behavior when a `.pipe` file changes while the pipeline is running: `"auto"`, `"manual"`, or `"prompt"` |

## Commands

| Command | Description |
|---------|-------------|
| `RocketRide: Connect to Server` | Connect to the RocketRide engine |
| `RocketRide: Disconnect from Server` | Disconnect from the engine |
| `RocketRide: Reconnect to Server` | Reconnect to the engine |
| `RocketRide: Open RocketRide Settings` | Open extension settings |
| `RocketRide: Open Status Page` | View server and pipeline status |
| `RocketRide Pipeline: Create New Pipeline` | Create a new `.pipe` file |
| `RocketRide Pipeline: Run` | Run the selected pipeline |
| `RocketRide Pipeline: Stop Pipeline` | Stop a running pipeline |
| `RocketRide: Open as Text` | Open a `.pipe` file as raw JSON |
| `RocketRide: Welcome` | Open the welcome page |

## Links

- [Documentation](https://docs.rocketride.org/)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)
- [Security](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)

## License

MIT -- see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
