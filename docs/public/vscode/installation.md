---
title: Installation
date: 2026-03-02
sidebar_position: 2
---

## Installing the Extension

1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **RocketRide**.
4. Click **Install**.

## First-Run Setup

On first launch, the extension shows a **Welcome** page to guide you through setup:

1. **Choose a connection mode**: Cloud, on-premises, or local.
2. **Enter your server URL**: For on-premises or local mode (default: `http://localhost:5565`).
3. **Enter your API key**: Your RocketRide authentication token. This is stored securely in VS Code's secret storage.
4. **Click Connect**: The extension tests the connection and shows status in the status bar.

After initial setup, the extension auto-connects on startup.

## Configuration Settings

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and search for `rocketride` to configure:

### Connection

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.development.connectionMode` | `local` | Connection mode: `local`, `docker`, `service`, `onprem`, or `cloud` |
| `rocketride.development.hostUrl` | `""` | RocketRide server URL (empty = derived from the connection mode) |
| `rocketride.deployment.hostUrl` | `""` | Deployment server URL (empty = mode-derived / shared with development). In cloud mode the URL is fixed at build time (effective fallback `https://api.rocketride.ai`) and any user-set value is ignored. |

> Credentials are not a settings key. Enter your API key with the **Settings** page command `rocketride.page.settings.setupCredentials` (update or clear it via `rocketride.page.settings.updateApiKey` / `rocketride.page.settings.clearApiKey`). It is held in VS Code SecretStorage, not in `settings.json`.

### Pipeline

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.defaultPipelinePath` | - | Default directory for new pipeline files |
| `rocketride.pipelineRestartBehavior` | - | Restart behavior: `auto`, `manual`, or `prompt` |
| `rocketride.taskArguments` | - | Additional command-line arguments passed to each pipeline task |
| `rocketride.pipelineDebugOutput` | `false` | Enable full debug output for pipeline tasks (`--trace=debugOut`) |

### Local Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.development.local.engineVersion` | `latest` | Engine version: `latest`, `prerelease`, or a specific tag |

### Integrations

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.integrations.autoAgentIntegration` | `true` | Auto-detect and install RocketRide documentation for coding agents (Copilot, Claude Code, Cursor, Windsurf) on startup |
| `rocketride.integrations.copilot` | - | Enable GitHub Copilot integration for pipeline development |
| `rocketride.integrations.claudeCode` | - | Enable Claude Code integration |
| `rocketride.integrations.cursor` | - | Enable Cursor IDE integration |
| `rocketride.integrations.windsurf` | - | Enable Windsurf IDE integration |
| `rocketride.integrations.claudeMd` | - | Install RocketRide instructions to `CLAUDE.md` at the repo root |
| `rocketride.integrations.agentsMd` | - | Install RocketRide instructions to `AGENTS.md` at the repo root |
