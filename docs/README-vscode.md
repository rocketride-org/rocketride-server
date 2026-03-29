<p align="center">
  <img src="../images/banner-vscode.svg" alt="RocketRide for VS Code" width="900">
</p>

<p align="center">
  Build, debug, and deploy AI pipelines - without leaving your IDE.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride"><img src="https://img.shields.io/visual-studio-marketplace/v/RocketRide.rocketride?color=222223&label=marketplace" alt="VS Code Marketplace"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/9hr3tdZmEG"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/license-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

1. Install the **RocketRide** extension from the VS Code Marketplace
2. Click the **RocketRide** icon in the Activity Bar
3. Create a `.pipe` file - it opens automatically in the visual canvas builder
4. Wire up nodes by connecting input and output lanes, then hit **Play** to run

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/canvas.png" alt="RocketRide visual canvas builder" width="800">

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

You build your `.pipe` - and you run it against the fastest AI runtime available.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open-source, OSI-compliant

## Features

- **Visual canvas builder** - Drag, drop, and wire up AI workflows directly in VS Code. Create `.pipe` files to get started.
- **Debugging & live traces** - Monitor running pipelines in real time with execution traces, token usage, and memory stats — see exactly what your agents are doing at every step.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/trace.png" alt="RocketRide debugging and live traces" width="800">

- **Connection manager** - Connect to a local engine (one click, no setup) or your own on-premises server.
- **SDKs for TypeScript, Python & MCP** - Embed pipelines in your apps or expose them as tools for AI assistants.

Need inspiration? Check out our [example pipelines](https://docs.rocketride.org/):

- [Advanced RAG](https://docs.rocketride.org/examples/advanced-rag-pipeline/)
- [Video Frame Grabber](https://docs.rocketride.org/examples/video-key-frame-grabber/)
- [Audio Transcription](https://docs.rocketride.org/examples/audio-transcription-simple/)

## Extension Settings

| Setting                              | Type       | Default                          | Description                                                                                                                               |
| ------------------------------------ | ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rocketride.connectionMode`          | `string`   | `"local"`                        | Connection mode: `"local"` (your machine), `"onprem"` (your own hosted server), or `"cloud"` (coming soon)                                |
| `rocketride.hostUrl`                 | `string`   | `"http://localhost:5565"`        | Host URL for RocketRide service. Host and port will be parsed from this URL.                                                              |
| `rocketride.defaultPipelinePath`     | `string`   | `"${workspaceFolder}/pipelines"` | Default directory path for creating new pipeline files                                                                                    |
| `rocketride.local.engineVersion`     | `string`   | `"latest"`                       | Engine version to download. `"latest"` for newest stable, `"prerelease"` for newest prerelease, or a specific tag like `"server-v3.1.1"`. |
| `rocketride.engineArgs`              | `string[]` | `[]`                             | Additional arguments passed to the engine subprocess                                                                                      |
| `rocketride.autoConnect`             | `boolean`  | `true`                           | Automatically connect to RocketRide server when extension activates                                                                       |
| `rocketride.pipelineRestartBehavior` | `string`   | `"prompt"`                       | Behavior when a `.pipe` file changes while the pipeline is running: `"auto"`, `"manual"`, or `"prompt"`                                   |
| `rocketride.oauth2RootUrl`           | `string`   | `"https://oauth2.rocketride.ai"` | Root OAuth2 URL for the refresh path passed to the services OAuth2 endpoint                                                               |
| `rocketride.integrations.copilot`    | `boolean`  | `false`                          | Enable RocketRide integration with GitHub Copilot                                                                                         |
| `rocketride.integrations.claudeCode` | `boolean`  | `false`                          | Enable RocketRide integration with Claude Code                                                                                            |
| `rocketride.integrations.cursor`     | `boolean`  | `false`                          | Enable RocketRide integration with Cursor                                                                                                 |
| `rocketride.integrations.windsurf`   | `boolean`  | `false`                          | Enable RocketRide integration with Windsurf                                                                                               |

## Commands

| Command                                    | Description                      |
| ------------------------------------------ | -------------------------------- |
| `RocketRide: Connect to Server`            | Connect to the RocketRide engine |
| `RocketRide: Disconnect from Server`       | Disconnect from the engine       |
| `RocketRide: Reconnect to Server`          | Reconnect to the engine          |
| `RocketRide: Open RocketRide Settings`     | Open extension settings          |
| `RocketRide: Open Status Page`             | View server and pipeline status  |
| `RocketRide Pipeline: Create New Pipeline` | Create a new `.pipe` file        |
| `RocketRide Pipeline: Run`                 | Run the selected pipeline        |
| `RocketRide Pipeline: Stop Pipeline`       | Stop a running pipeline          |
| `RocketRide: Open as Text`                 | Open a `.pipe` file as raw JSON  |
| `RocketRide: Welcome`                      | Open the welcome page            |

## Links

- [Documentation](https://docs.rocketride.org/)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)
- [Security](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
