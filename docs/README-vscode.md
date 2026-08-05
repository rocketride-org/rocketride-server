<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/banner-vscode.png" alt="RocketRide for VS Code" width="900">
</p>

<p align="center">
  Build, debug, and deploy AI pipelines without leaving your IDE.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride"><img src="https://img.shields.io/visual-studio-marketplace/v/RocketRide.rocketride?color=222223&label=Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/PMXrtenMsY"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

1. Install the **RocketRide** extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride) or [Open VSX](https://open-vsx.org/extension/RocketRide/rocketride)
2. Click the **RocketRide** icon in the Activity Bar
3. Pick how to run the engine when prompted: **Local** (recommended, downloads and runs on your machine with no extra setup; on Linux see the runtime library note below), Docker, an on-premises server, or [RocketRide Cloud](https://cloud.rocketride.ai/)
4. Create a `.pipe` file: it opens automatically in the visual canvas builder
5. Wire up nodes by connecting input and output lanes, then hit **Play** to run

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/install-extension.png" alt="Install RocketRide extension" width="800">

> **Linux users:** the downloaded engine is dynamically linked against the system C++ runtime. On Ubuntu/Debian, install once:
>
> ```bash
> sudo apt install -y libc++1 libc++abi1 libgomp1
> ```
>
> The extension auto-detects missing libraries on first run and offers a one-click install prompt. See [issue #989](https://github.com/rocketride-org/rocketride-server/issues/989) for background and troubleshooting.

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform. It lets you build, debug, and deploy production AI workflows without leaving your IDE, using a visual drag-and-drop canvas or code-first with the TypeScript and Python SDKs. Pipelines are portable JSON (`.pipe` files) executed by a multithreaded C++ engine.

- **115+ pipeline nodes**: 16 LLM providers, 9 vector databases, OCR, NER, PII anonymization, chunking, embeddings, and more
- **High-performance C++ engine**: native multithreading built for production AI and data workloads
- **Two ways to run**: self-hosted on Docker, on-prem, or local hardware; or [RocketRide Cloud](https://cloud.rocketride.ai/) managed hosting
- **MIT licensed**: the self-hosted engine is free, fully open source, and OSI-compliant

## Features

- **Visual canvas builder**: drag, drop, and wire up AI workflows directly in VS Code. Create `.pipe` files to get started.
- **Debugging & live traces**: monitor running pipelines in real time with execution traces, token usage, and memory stats. See exactly what your agents are doing at every step.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/pipeline-example.png" alt="Build and run AI pipelines inside your IDE" width="800">

- **Connection manager**: connect to a local engine, Docker container, system service, on-premises server, or RocketRide Cloud. Separate development and deployment targets let you build locally and deploy to a different environment.
- **Server Monitor**: real-time dashboard of connections, running tasks, and aggregate engine metrics.
- **Pipeline variables**: manage `ROCKETRIDE_*` variables per connection from the Variables page, with autocomplete for `${ROCKETRIDE_*}` in node config fields.
- **Coding agent ready**: auto-detects GitHub Copilot, Claude Code, Cursor, and Windsurf and installs RocketRide documentation for them, so your agent can build and modify pipelines through natural language.
- **SDKs for TypeScript, Python & MCP**: embed pipelines in your apps or expose them as tools for AI assistants.

Need inspiration? Check out [awesome-rocketride](https://github.com/rocketride-org/awesome-rocketride#demos--examples), a collection of example projects built on RocketRide.

## Extension Settings

### Development Connection

| Setting                                      | Type     | Default    | Description                                                                                                                               |
| -------------------------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `rocketride.development.connectionMode`      | `string` | `"local"`  | Connection mode: `"local"`, `"docker"`, `"service"`, `"onprem"`, or `"cloud"`                                                             |
| `rocketride.development.hostUrl`             | `string` | `""`       | Host URL for the development connection                                                                                                   |
| `rocketride.development.local.engineVersion` | `string` | `"latest"` | Engine version to download. `"latest"` for newest stable, `"prerelease"` for newest prerelease, or a specific tag like `"server-v3.1.1"`. |

### Deployment Connection

The deployment target can use a separate connection or share the development connection.

| Setting                                     | Type             | Default    | Description                                               |
| ------------------------------------------- | ---------------- | ---------- | --------------------------------------------------------- |
| `rocketride.deployment.connectionMode`      | `string \| null` | `null`     | Deployment connection mode (`null` = same as development) |
| `rocketride.deployment.hostUrl`             | `string`         | `""`       | Host URL for the deployment connection                    |
| `rocketride.deployment.local.engineVersion` | `string`         | `"latest"` | Engine version for the local deployment target            |

### General

| Setting                              | Type      | Default                          | Description                                                                                             |
| ------------------------------------ | --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `rocketride.defaultPipelinePath`     | `string`  | `"${workspaceFolder}/pipelines"` | Default directory path for creating new pipeline files                                                  |
| `rocketride.pipelineRestartBehavior` | `string`  | `"prompt"`                       | Behavior when a `.pipe` file changes while the pipeline is running: `"auto"`, `"manual"`, or `"prompt"` |
| `rocketride.pipelineTTL`             | `integer` | `900`                            | Default idle timeout in seconds before a running pipeline is shut down (`0` = run until stopped)        |
| `rocketride.pipelineTraceLevel`      | `string`  | `"full"`                         | Tracing verbosity for pipeline execution: `"none"`, `"metadata"`, `"summary"`, or `"full"`              |
| `rocketride.taskArguments`           | `string`  | `""`                             | Additional command-line arguments passed to each pipeline task                                          |
| `rocketride.pipelineDebugOutput`     | `boolean` | `false`                          | Enable full debug output for pipeline tasks (`--trace=debugOut`)                                        |
| `rocketride.welcomeDismissed`        | `boolean` | `false`                          | Set to `true` to skip the welcome page on startup                                                       |

### Agent Integrations

| Setting                                        | Type      | Default | Description                                                                    |
| ---------------------------------------------- | --------- | ------- | ------------------------------------------------------------------------------ |
| `rocketride.integrations.autoAgentIntegration` | `boolean` | `true`  | Auto-detect and install RocketRide documentation for coding agents on startup  |
| `rocketride.integrations.copilot`              | `boolean` | `false` | Enable RocketRide integration with GitHub Copilot                              |
| `rocketride.integrations.claudeCode`           | `boolean` | `false` | Enable RocketRide integration with Claude Code                                 |
| `rocketride.integrations.cursor`               | `boolean` | `false` | Enable RocketRide integration with Cursor                                      |
| `rocketride.integrations.windsurf`             | `boolean` | `false` | Enable RocketRide integration with Windsurf                                    |
| `rocketride.integrations.claudeMd`             | `boolean` | `false` | Install RocketRide instructions to `CLAUDE.md` at the repo root                |
| `rocketride.integrations.agentsMd`             | `boolean` | `false` | Install RocketRide instructions to `AGENTS.md` at the repo root                |

## Commands

Commands available from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command                        | Description                       |
| ------------------------------ | --------------------------------- |
| `RocketRide: Settings`         | Open extension settings           |
| `RocketRide: Server Monitor`   | Open the server monitor dashboard |
| `RocketRide: Update API Key`   | Update the stored API key         |
| `RocketRide: Refresh All`      | Refresh all views                 |
| `RocketRide Pipeline: Refresh` | Refresh the pipeline list         |
| `RocketRide: Welcome`          | Open the welcome page             |

Additional commands are available via the sidebar and context menus:

| Action                               | Location                         |
| ------------------------------------ | -------------------------------- |
| Connect / Disconnect                 | Sidebar connection panel         |
| Create New Pipeline                  | Pipelines view toolbar           |
| Run / Stop Pipeline                  | Inline buttons on pipeline items |
| Open as Text                         | Pipeline context menu            |
| Deploy                               | Sidebar                          |
| Setup / Clear API Key                | Settings page                    |
| Install / Remove Agent Documentation | Settings page                    |

## Links

- [Documentation](https://docs.rocketride.org/)
- [Home](https://rocketride.org)
- [Discord](https://discord.gg/PMXrtenMsY)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)
- [Security](https://github.com/rocketride-org/rocketride-server/blob/develop/SECURITY.md)
- [RocketRide Cloud](https://cloud.rocketride.ai/)

## License

MIT, see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
