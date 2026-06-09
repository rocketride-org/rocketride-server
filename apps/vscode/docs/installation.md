---
title: Installation
date: 2026-03-02
sidebar_position: 2
---

<head>
  <title>Installation - VS Code Extension - RocketRide Documentation</title>
</head>

## Installing the Extension

1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **RocketRide**.
4. Click **Install**.

## First-Run Setup

On first launch, the extension shows a **Welcome** page to guide you through setup:

1. **Choose a connection mode** — Cloud, on-premises, or local.
2. **Enter your server URL** — For on-premises or local mode (default: `http://localhost:5565`).
3. **Enter your API key** — Your RocketRide authentication token. This is stored securely in VS Code's secret storage.
4. **Click Connect** — The extension tests the connection and shows status in the status bar.

After initial setup, the extension auto-connects on startup.

## Configuration Settings

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and search for `rocketride` to configure:

### Connection

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.connectionMode` | — | Connection mode: `cloud`, `onprem`, or `local` |
| `rocketride.hostUrl` | `http://localhost:5565` | RocketRide server URL |
| `rocketride.deployUrl` | `https://cloud.rocketride.ai` | Cloud deployment API URL |
| `rocketride.apiKey` | — | Authentication token (stored in secure storage) |
| `rocketride.autoConnect` | — | Auto-connect to server on extension activation |

### Pipeline

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.defaultPipelinePath` | — | Default directory for new pipeline files |
| `rocketride.pipelineRestartBehavior` | — | Restart behavior: `auto`, `manual`, or `prompt` |

### Local Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.local.engineVersion` | `latest` | Engine version: `latest`, `prerelease`, or a specific tag |
| `rocketride.local.engineArgs` | — | Additional startup arguments for the local engine |

### Integrations

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.copilotIntegration` | — | Enable GitHub Copilot integration for pipeline development |
| `rocketride.cursorIntegration` | — | Enable Cursor IDE integration |
