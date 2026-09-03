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
| `rocketride.connectionMode` | - | Connection mode: `cloud`, `onprem`, or `local` |
| `rocketride.hostUrl` | `http://localhost:5565` | RocketRide server URL |
| `rocketride.deployment.hostUrl` | `https://cloud.rocketride.ai` | Cloud deployment API URL |

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

## Where the Settings Page Saves

The **Settings** page writes to your **user** settings, never to the workspace. Two consequences are worth knowing:

- **Only fields you changed are written.** The page is populated with the values currently in effect, so saving after editing one field leaves the rest of your user settings untouched — a value pinned by a project never leaks into your global settings.
- **A project can override what you save.** VS Code resolves a setting as workspace folder → workspace → user, so a key set at either workspace scope wins over the Settings page. When that happens the page reports which keys are overridden instead of a plain "saved" confirmation. Change those keys where the workspace sets them:
  - a multi-root workspace's `.code-workspace` file (the `settings` block) — this is the *workspace* scope;
  - a folder's `.vscode/settings.json` — the *workspace folder* scope, and the only workspace scope a single-folder window has.

**Direct Connect** (on-prem) requires a Host URL that can address a server — for example `localhost:5565` or `https://engine.example.com`. The scheme and the default port `5565` are filled in when omitted. This is a format check only; use **Test Connection** to confirm the server is actually reachable.
