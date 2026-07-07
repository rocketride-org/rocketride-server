<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/banner-vscode.png" alt="RocketRide for VS Code" width="900">
</p>

<p align="center">
  Build, debug, and deploy AI pipelines - without leaving your IDE.
</p>

<p align="center">
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/PMXrtenMsY"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

1. Install the **RocketRide** extension from the VS Code Marketplace
2. Click the **RocketRide** icon in the Activity Bar
3. Create a `.pipe` file - it opens automatically in the visual canvas builder
4. Wire up nodes by connecting input and output lanes, then hit **Play** to run

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/canvas.png" alt="RocketRide visual canvas builder" width="800">

> **Linux users:** the downloaded engine is dynamically linked against the system C++ runtime. On Ubuntu/Debian, install once:
>
> ```bash
> sudo apt install -y libc++1 libc++abi1 libgomp1
> ```
>
> The extension auto-detects missing libraries on first run and offers a one-click install prompt. See [issue #989](https://github.com/rocketride-org/rocketride-server/issues/989) for background and troubleshooting.

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
- **Debugging & live traces** - Monitor running pipelines in real time with execution traces, token usage, and memory stats, see exactly what your agents are doing at every step.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/trace.png" alt="RocketRide debugging and live traces" width="800">

- **Connection manager** - Connect to a local engine, Docker container, system service, on-premises server, or RocketRide Cloud. Separate development and deployment targets let you build locally and deploy to a different environment.
- **SDKs for TypeScript, Python & MCP** - Embed pipelines in your apps or expose them as tools for AI assistants.

Need inspiration? Check out our [example pipelines](https://docs.rocketride.org/):

- [Advanced RAG](https://docs.rocketride.org/examples/advanced-rag-pipeline/)
- [Video Frame Grabber](https://docs.rocketride.org/examples/video-key-frame-grabber/)
- [Audio Transcription](https://docs.rocketride.org/examples/audio-transcription-simple/)

## Extension Settings

### Development Connection

| Setting                                        | Type      | Default                          | Description                                                                                                                               |
| ---------------------------------------------- | --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rocketride.development.connectionMode`        | `string`  | `"local"`                        | Connection mode: `"local"`, `"docker"`, `"service"`, `"onprem"`, or `"cloud"`                                                             |
| `rocketride.development.hostUrl`               | `string`  | `""`                             | Host URL for on-prem or direct connections                                                                                                |
| `rocketride.development.teamId`                | `string`  | `""`                             | Cloud team ID for the development connection                                                                                              |
| `rocketride.development.local.engineVersion`   | `string`  | `"latest"`                       | Engine version to download. `"latest"` for newest stable, `"prerelease"` for newest prerelease, or a specific tag like `"server-v3.1.1"`. |
| `rocketride.development.local.debugOutput`     | `boolean` | `false`                          | Enable full debug output from the local engine                                                                                            |
| `rocketride.development.local.engineArgs`      | `string`  | `""`                             | Additional arguments passed to the engine subprocess                                                                                      |

### Deployment Connection

The deployment target can use a separate connection or share the development connection.

| Setting                                       | Type             | Default                          | Description                                                                  |
| --------------------------------------------- | ---------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `rocketride.deployment.connectionMode`        | `string \| null` | `null`                           | Deployment connection mode (`null` = same as development)                    |
| `rocketride.deployment.hostUrl`               | `string`         | `""`                             | Host URL for deployment connection                                           |
| `rocketride.deployment.teamId`                | `string`         | `""`                             | Cloud team ID for the deployment connection                                  |
| `rocketride.deployment.local.engineVersion`   | `string`         | `"latest"`                       | Engine version for local deployment target                                   |
| `rocketride.deployment.local.debugOutput`     | `boolean`        | `false`                          | Enable debug output for the deployment engine                                |
| `rocketride.deployment.local.engineArgs`      | `string`         | `""`                             | Additional arguments passed to the deployment engine subprocess              |

### General

| Setting                                        | Type      | Default                          | Description                                                                                                    |
| ---------------------------------------------- | --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `rocketride.defaultPipelinePath`               | `string`  | `"${workspaceFolder}/pipelines"` | Default directory path for creating new pipeline files                                                         |
| `rocketride.pipelineRestartBehavior`           | `string`  | `"prompt"`                       | Behavior when a `.pipe` file changes while the pipeline is running: `"auto"`, `"manual"`, or `"prompt"`        |
| `rocketride.welcomeDismissed`                  | `boolean` | `false`                          | Set to `true` to skip the welcome page on startup                                                              |

### Agent Integrations

| Setting                                        | Type      | Default | Description                                                                    |
| ---------------------------------------------- | --------- | ------- | ------------------------------------------------------------------------------ |
| `rocketride.integrations.autoAgentIntegration` | `boolean` | `true`  | Auto-detect and install RocketRide documentation for coding agents on startup  |
| `rocketride.integrations.copilot`              | `boolean` | `false` | Enable RocketRide integration with GitHub Copilot                              |
| `rocketride.integrations.claudeCode`           | `boolean` | `false` | Enable RocketRide integration with Claude Code                                 |
| `rocketride.integrations.cursor`               | `boolean` | `false` | Enable RocketRide integration with Cursor                                      |
| `rocketride.integrations.windsurf`             | `boolean` | `false` | Enable RocketRide integration with Windsurf                                    |
| `rocketride.integrations.claudeMd`             | `boolean` | `false` | Install RocketRide instructions to `CLAUDE.md` at the repo root               |
| `rocketride.integrations.agentsMd`             | `boolean` | `false` | Install RocketRide instructions to `AGENTS.md` at the repo root               |

## Commands

Commands available from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command                          | Description                       |
| -------------------------------- | --------------------------------- |
| `RocketRide: Settings`           | Open extension settings           |
| `RocketRide: Server Monitor`     | Open the server monitor dashboard |
| `RocketRide: Update API Key`     | Update the stored API key         |
| `RocketRide: Refresh All`        | Refresh all views                 |
| `RocketRide Pipeline: Refresh`   | Refresh the pipeline list         |
| `RocketRide: Welcome`            | Open the welcome page             |

Additional commands are available via the sidebar and context menus:

| Action                | Location                             |
| --------------------- | ------------------------------------ |
| Connect / Disconnect  | Sidebar connection panel             |
| Create New Pipeline   | Pipelines view toolbar               |
| Run / Stop Pipeline   | Inline buttons on pipeline items     |
| Open as Text          | Pipeline context menu                |
| Deploy                | Sidebar                              |
| Setup / Clear API Key | Settings page                        |
| Install / Remove Agent Documentation | Settings page             |

## Links

- [Documentation](https://docs.rocketride.org/)
- [Discord](https://discord.gg/PMXrtenMsY)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)
- [Security](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
