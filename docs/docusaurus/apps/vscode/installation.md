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

1. **Choose a connection mode**: Local, Docker, Service, Direct Connect (your own server; the `onprem` setting value) or RocketRide Cloud. [Connection Modes](/clients/vscode/usage#connection-modes) says what runs where in each mode and what it allows.
2. **Fill in the panel for that mode**: Direct Connect takes the server's host URL and API key; the key is stored in VS Code's secret storage. Cloud signs in with your RocketRide account in the browser. Local takes nothing. Docker and Service take no URL or key, but the first time you click **Install** on their panel, since **Save & Connect** does not install them. Until you save, the status bar reads `RocketRide: Setup`; after saving it reads `RocketRide: Disconnected` until the install is done.
3. **Click Save & Connect**: The extension connects and shows the result in the status bar, for example `RocketRide: Connected (Local)`. [The Status Bar](/clients/vscode/usage#the-status-bar) lists the other texts and where to find the host.

After initial setup, the extension auto-connects on startup.

## Configuration Settings

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and search for `rocketride` to configure:

### Connection

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.development.connectionMode` | `local` | Development connection mode: `cloud`, `docker`, `service`, `onprem` (Direct Connect in the UI), or `local`. See [Connection Modes](/clients/vscode/usage#connection-modes) |
| `rocketride.development.hostUrl` | - | Host URL for the development connection; used only by Direct Connect (`onprem`) |
| `rocketride.development.useCustomServer` | `false` | Cloud mode: connect to `cloudUrl` instead of RocketRide Cloud |
| `rocketride.development.cloudUrl` | `https://api.rocketride.ai` | Cloud mode: the server targeted when `useCustomServer` is enabled |
| `rocketride.deployment.connectionMode` | `null` | Deployment connection mode (`null` = share the development connection) |
| `rocketride.deployment.hostUrl` | - | Host URL for the deployment connection; used only by Direct Connect (`onprem`) |
| `rocketride.deployment.useCustomServer` | `false` | Cloud mode: deploy to `cloudUrl` instead of RocketRide Cloud |
| `rocketride.deployment.cloudUrl` | `https://api.rocketride.ai` | Cloud mode: the server targeted when `useCustomServer` is enabled |

In cloud mode nothing is baked into the extension: unchecked, the connection
targets the `cloudUrl` setting's default; checked, it targets the address you
enter (e.g. a staging server or `http://localhost:5565`). Sign-in exchanges
its OAuth code against the same effective server.

> Credentials are not a settings key. Enter your API key with the **Settings** page command `rocketride.page.settings.setupCredentials` (update or clear it via `rocketride.page.settings.updateApiKey` / `rocketride.page.settings.clearApiKey`). It is held in VS Code SecretStorage, not in `settings.json`.

### Local Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `rocketride.development.local.engineVersion` | `latest` | Engine version: `latest`, `prerelease`, or a specific tag |

### Everything else

Pipeline defaults (TTL, trace level, restart behavior, task arguments, debug
output, default paths) and the agent integrations (Copilot, Claude Code,
Cursor, Windsurf, CLAUDE.md, AGENTS.md) are **workspace settings**, edited in
the RocketRide Settings page (*RocketRide: Settings* → Rocket Builder /
Integrations). They are stored on the connected server and follow you between
VS Code and the cloud workbench — they are not VS Code configuration keys.
