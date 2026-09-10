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
| `rocketride.development.connectionMode` | `local` | Development connection mode: `cloud`, `docker`, `service`, `onprem`, or `local` |
| `rocketride.development.hostUrl` | - | Host URL for the development connection (onprem/docker/service modes) |
| `rocketride.development.useCustomServer` | `false` | Cloud mode: connect to `cloudUrl` instead of RocketRide Cloud |
| `rocketride.development.cloudUrl` | `https://api.rocketride.ai` | Cloud mode: the server targeted when `useCustomServer` is enabled |
| `rocketride.deployment.connectionMode` | `null` | Deployment connection mode (`null` = share the development connection) |
| `rocketride.deployment.hostUrl` | - | Host URL for the deployment connection (onprem/docker/service modes) |
| `rocketride.deployment.useCustomServer` | `false` | Cloud mode: deploy to `cloudUrl` instead of RocketRide Cloud |
| `rocketride.deployment.cloudUrl` | `https://api.rocketride.ai` | Cloud mode: the server targeted when `useCustomServer` is enabled |

In cloud mode nothing is baked into the extension: unchecked, the connection
targets the `cloudUrl` setting's default; checked, it targets the address you
enter (e.g. a staging server or `http://localhost:5565`). Sign-in exchanges
its OAuth code against the same effective server.

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
| `rocketride.local.engineVersion` | `latest` | Engine version: `latest`, `prerelease`, or a specific tag |

### Integrations

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.integrations.copilot` | - | Enable GitHub Copilot integration for pipeline development |
| `rocketride.integrations.cursor` | - | Enable Cursor IDE integration |
