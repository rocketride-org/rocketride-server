---
title: Usage Guide
date: 2026-03-02
sidebar_position: 3
---

## Creating a Pipeline

1. Use **File > New File > RocketRide Pipeline**, or click **+** in the RocketRide sidebar, to create a new `.pipe` file.
2. The visual editor opens automatically for `.pipe` files.
3. Drag components from the component palette onto the canvas.
4. Configure each component's properties in the properties panel.
5. Connect component outputs to inputs by drawing connections between lanes.
6. Save the file, changes are auto-saved.

## Running a Pipeline

1. Click the inline **Run** button on the pipeline item in the RocketRide sidebar, or press **Play** on the source node in the canvas.
2. The **Status** page opens with real-time execution monitoring.
3. Watch data flow through components, view completion metrics, and check for errors.

## Debugging a Pipeline

1. In the **Run and Debug** view, start the **RocketRide: Launch Pipeline** debug configuration (a `rocketride`-type launch configuration).
2. The debugger opens with breakpoint support.
3. Set breakpoints on components to pause execution.
4. Step through the pipeline and inspect variable values at each breakpoint.

## Attaching to a Running Pipeline

If a pipeline is already running on the server:

1. In the **Run and Debug** view, start the **RocketRide: Attach to Pipeline** debug configuration.
2. The **Status** page opens and streams real-time data from the running pipeline.

## Connection Modes

The extension has two connections. **Development** is the one the canvas, the pipeline **DEPLOY** page and the App Builder use. **Deployment** shares the development connection until you check **Deploy to a different target** on the RocketRide Settings page (under **Connections**, **Deployment**); then it has a mode of its own. Each connection uses one of five modes:

| Mode                | Names the extension shows                                                                                                                                                 | What runs where                                                                                                                                                           | What you need                                                                                                                                     | Publishing and developer registration                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Local (the default) | Setting value `local`. Dropdown, status bar and sidebar: **Local**.                                                                                                       | The extension downloads the engine and runs it on this machine: one engine per VS Code window, on a new port each time it starts.                                         | On macOS and Windows, nothing. On Linux the engine needs libc++, libc++abi and libgomp: on Debian and Ubuntu the packages `libc++1`, `libc++abi1` and `libgomp1`, which the extension checks for at the first start and offers to install with apt; on Fedora and RHEL `libcxx`, `libcxxabi` and `libgomp`, which you install yourself (`dnf`). The first start downloads the engine. | Open-source server (see below).                                      |
| Docker              | Setting value `docker`. Dropdown, status bar and sidebar: **Docker**.                                                                                                     | The engine runs in a Docker container on this machine, at `http://localhost:5565`.                                                                                        | Docker installed and its daemon running. The first time, click **Install** on the Docker panel to pull the engine image and create the container. | Open-source server.                                                  |
| Service             | Setting value `service`. Dropdown, status bar and sidebar: **Service**.                                                                                                   | The engine runs as a system service on this machine, at `http://localhost:5565`, and starts on boot.                                                                      | The first time, click **Install** on the Service panel. Installing needs administrator rights (sudo on macOS and Linux, a UAC prompt on Windows). | Open-source server.                                                  |
| Direct Connect      | Setting value `onprem`. Dropdown: **Direct Connect**. Status bar and sidebar: **Direct**. Elsewhere, such as the missing Host URL error in the Output panel: **on-prem**. | The extension starts nothing. It connects to the server at the **Host URL** you enter, on this machine or elsewhere.                                                      | The server's host URL and API key.                                                                                                                | Whatever the server at that URL is: open-source or RocketRide Cloud. |
| Cloud               | Setting value `cloud`. Dropdown: **RocketRide Cloud**. Status bar and sidebar: **Cloud**.                                                                                 | The extension starts nothing. It connects to `https://api.rocketride.ai`, or to the address under **Use custom server**. Either way it must be a RocketRide Cloud server. | A RocketRide account: click **Sign In**, finish in the browser, then save.                                                                        | RocketRide Cloud server (see below).                                 |

In VS Code's own Settings editor, the descriptions of `rocketride.development.connectionMode` start with the dropdown names; `rocketride.deployment.connectionMode` lists only the setting values.

Deploying, publishing and developer registration go to the server the development connection points at. The extension checks only that the connection is live, not that you are signed in to RocketRide Cloud. The server decides what they do:

- **Open-source server.** Local, Docker and Service run the open-source edition, and a Direct Connect server can too. Apps deploy and publish to that server only, under its fixed developer id `rocketride`, and an app id outside that namespace is refused. `@public` publishes to that server's store directly, without review. Developer registration does not exist there: the server answers "Developer registration requires SaaS mode".
- **RocketRide Cloud server.** Cloud mode always connects to one. An organization admin registers the organization's developer id once, on the App Builder's Deploy tab, before any app can be deployed or published. App ids start with that id, and a `@public` release goes live only after review. The [App Builder guide](/guides/apps/app-builder) has the details.

The status bar, the sidebar and the Direct Connect panel do not say which of the two a Direct Connect server is (its **Test connection** button reports only success or failure).

The Settings page lets only one of the two connections use Cloud, and never offers Docker to one connection while the other uses Service (or the other way round), since both listen on port 5565. The Deployment dropdown leaves out the development mode, because leaving **Deploy to a different target** unchecked already shares that connection.

Inside the extension, the deployment connection drives the **Deployment** row of the sidebar menu, the **Deployment** section under **Environment Variables** on the Settings page and, when it is the Cloud connection, the name and email at the bottom of the sidebar. The Settings page's **Account** sections show the development connection's account. It also writes the `ROCKETRIDE_DEPLOY_URI` and `ROCKETRIDE_DEPLOY_APIKEY` pair in `.env`, which the `rocketride` CLI's deploy and publish commands read. The canvas, the DEPLOY page and the App Builder use the development connection even when a separate deployment target is set.

### The Status Bar

The RocketRide item at the left of the status bar shows the **development** connection only. The word in parentheses is that connection's mode, so `RocketRide: Connected (Direct)` means the development connection is up in Direct Connect mode. The connected text and its tooltip (`Connected - Click to disconnect`) do not name the host.

| Text                                              | Meaning                                                                                                | Clicking it              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| `RocketRide: Initializing...`                     | The extension is starting.                                                                             | Does nothing.            |
| `RocketRide: Setup`                               | First run: no connection has been saved and the Welcome page has not been closed.                      | Opens the Welcome page.  |
| `RocketRide: Ready`                               | Shown only for a moment at startup, until the first connection status arrives.                         | Connects.                |
| `RocketRide: Connecting...` or a progress message | Connecting, or the engine is downloading or starting.                                                  | Does nothing.            |
| `RocketRide: Connected (<mode>)`                  | The development connection is up. `<mode>` is Local, Docker, Service, Direct or Cloud.                 | Disconnects.             |
| `RocketRide: Disconnected`                        | Not connected. The tooltip shows the last error, if there is one. It can also show briefly at startup. | Connects.                |
| `RocketRide: Setup Required`                      | Cloud with no stored sign-in, or Direct Connect without a host URL or API key.                         | Opens the Settings page. |
| `RocketRide: Sign In Required`                    | The server rejected the sign-in or the API key.                                                        | Opens the Settings page. |
| `RocketRide: Failed`                              | The extension failed to start. The tooltip shows the error.                                            | Opens a status dialog.   |

The menu at the bottom of the RocketRide sidebar has a **Development** row and, when a separate deployment target is set, a **Deployment** row. Each shows `Connected (<mode>)` with the same mode names, and no host.

To see the host:

- **Direct Connect** and **Cloud**: run **RocketRide: Settings**. The **Development** and **Deployment** sections under **Connections** show the configured Direct Connect **Host URL**, or the Cloud server (`Server: https://api.rocketride.ai`, or the address under **Use custom server**).
- **Docker** and **Service**: always `http://localhost:5565`.
- **Local**: a new port each time the engine starts. The **Rocket Ride: Extension** output channel logs a `Local server started on port <port>` line.
- **Any mode**: after a successful connection, `ROCKETRIDE_URI` in the workspace `.env` holds the development connection's URL (see [`.env` Auto-Sync](#env-auto-sync)).

### Switching Modes

When you choose another mode on the Settings page (or on the Welcome page) and save:

- The mode is saved in your VS Code user settings (`rocketride.development.connectionMode` or `rocketride.deployment.connectionMode`), not in the workspace. A value for the same setting in the workspace's own settings overrides it. The other connection fields keep their values, except that choosing Direct Connect clears a Host URL that contains `cloud.rocketride` or starts with `http://localhost`.
- The extension disconnects from the old target and connects to the new one. A Local engine that no connection uses any more is stopped. A Docker container or system service keeps running; the extension only stops using it.
- Your Cloud sign-in and stored API keys stay. API keys are stored per connection (Development, Deployment), not per mode.
- The next successful connection rewrites that connection's pair in the workspace `.env`.
- What you can do may change with the server. On a RocketRide Cloud server, the canvas Run button needs an active subscription (a trial counts) and shows a padlock without one; an open-source server does not check. App ids follow the server's developer id, so an app created against an open-source server (`rocketride.<name>`) is outside a Cloud organization's namespace, and its Store and Deploy tabs are read-only there until you rename the id. The component palette lists the new server's nodes; RocketRide Cloud loads no custom nodes.
- Nothing moves between servers. Deployed pipelines and published apps stay on the server that received them, and the new server does not have them. The `.pipe` files and app folders in your workspace do not change.

## Deploying a Pipeline

1. Open the pipeline's **DEPLOY** page from the RocketRide sidebar (the file view's DEPLOY page).
2. Configure deployment settings.
3. Click **Publish** to store the saved pipeline as the next version, then deploy that version to a team. Both happen on the server the **development** connection uses, which is not necessarily RocketRide Cloud (see [Connection Modes](#connection-modes)).

## Cloud Connection — Custom Server

Cloud mode connects to the production RocketRide Cloud by default. **Settings → Development** (or **→ Deployment**) → connection mode **Cloud** offers a custom-server opt-in for staging or self-hosted cloud environments:

- **Use custom server** (per group: `rocketride.<group>.useCustomServer` plus `rocketride.<group>.cloudUrl`, where `<group>` is `development` or `deployment`): when checked, a URL field appears and sign-in plus all traffic target that server. When unchecked (or the URL is empty), the default cloud server shown under the checkbox is used — the default comes from the extension's setting declaration, nothing is baked into the webview bundles.
- **Save and reconnect:** the panel probes whichever server the form currently names (compatibility check), and **Sign In** deliberately uses the form's in-form value — the OAuth code is exchanged against the server you see, even before Save. Everything else (deploys, runs, checkout) rides the active connection, so after changing the server: save the settings, sign out, and sign in again to establish the session on the new server.
- **Session/server mismatch:** the extension records which server each sign-in was made against. If the form later targets a different server, the Cloud panel says so and withholds the Subscribe/checkout surface until you sign in on the selected server — billing always happens on the server the panel describes, never a previous one.
- **Invalid or unreachable URLs:** the compatibility probe fails and the panel reports that the configured server does not support RocketRide Cloud; sign-in stays available only for servers that pass the probe. An empty custom URL falls back to the default server.

## Pipeline Editor

The visual editor provides:

- **Component palette**: Browse and search available nodes (sources, LLMs, stores, etc.).
- **Canvas**: Drag-and-drop workspace for arranging components.
- **Properties panel**: Configure selected component settings (API keys, models, connection strings, etc.).
- **Lane connections**: Draw lines between component output and input lanes to define data flow.

## Pipeline Execution Defaults

Trace verbosity, the idle timeout (TTL), task arguments, and debug output for pipeline runs are configured once in **Settings → Rocket Builder → Pipelines** — they are workspace settings stored on the connected server (shared with the cloud workbench), not per-pipeline options or VS Code configuration:

- **Pipeline Trace Level** (`rocketride.pipeBuilder.pipelineTraceLevel`, default `full`): how much execution-trace data the engine emits — `full`, `summary`, `metadata`, or `none`. Higher levels populate the **Flow** and **Trace** tabs, but `full` inlines entire payloads (including images), which can noticeably slow runs that process large images.
- **Pipeline TTL** (`rocketride.pipeBuilder.pipelineTTL`, default `900` = 15 minutes): how long the engine keeps a pipeline alive without activity before stopping it. Fixed choices from 15 minutes to 8 hours, plus "Run forever or until you stop it" (`0` = no timeout).
- **Task Arguments** (`rocketride.pipeBuilder.taskArguments`, default empty): additional command-line arguments passed to each pipeline task process. The engine splits the string using shell parsing rules, so quoted paths are preserved.
- **Pipeline Debug Output** (`rocketride.pipeBuilder.pipelineDebugOutput`, default `false`): appends `--trace=debugOut` to the task arguments (unless they already contain a `--trace=` flag) for detailed task trace logging.

The extension host reads these from the workspace settings and passes them to the engine on each `run`/`restart` (the `status:pipelineAction` message carries only the action and source). The engine process itself starts with no extra flags — these settings apply per task, not to the server.

## `.env` Auto-Sync

After each successful connection, the extension writes that connection's URL and key to the workspace `.env`: `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` for the **development** connection, `ROCKETRIDE_DEPLOY_URI` and `ROCKETRIDE_DEPLOY_APIKEY` for the **deployment** connection. Every mode syncs, Cloud included; for Cloud the key is the persistent API key issued at sign-in. When **Deploy to a different target** is off, both pairs get the development connection's URL and key. The URI is the resolved server URL, including a Local engine's port.

The sync keeps your other variables and comments, keeps a managed comment line directly above `ROCKETRIDE_URI` and `ROCKETRIDE_DEPLOY_URI`, does not rewrite a file that is already current, and in a multi-root workspace writes the first folder's `.env`. The RocketRide **Python SDK** and the `rocketride` CLI read the `.env` in their working directory; the TypeScript SDK reads only process environment variables, so export the values first (for example, `set -a; source .env`). Both readers leave a variable that is already set in the process environment alone, so after you switch targets, unset or re-export any `ROCKETRIDE_*` value you exported earlier, or the old server stays in use.

Nothing is written when no workspace folder is open, when an existing `.env` cannot be read, or when the URL or key contains a line break. A sync failure never affects the connection itself. Keep `.env` gitignored.

The extension does not remove these keys. Disconnecting or an engine exit leaves the last values in place, and each successful connection rewrites its pair, so switching modes replaces them and a hand-edited value is overwritten. One exception: whenever the Cloud sign-in state changes and no Cloud session is stored (after you sign out, for example), the extension empties the API key of each pair whose connection uses Cloud in an existing `.env`, and keeps its URI line. When deployment shares the development connection, its pair follows the development connection's mode.

## Monitoring Execution

The **Status** page shows:

- **Component status**: Pending, running, completed, or failed indicators for each component.
- **Data flow**: Visual representation of data moving through the pipeline.
- **Metrics**: Completion rates and timing charts.
- **Errors**: Detailed error messages and logs for failed components.

## AI-Assisted Development

When enabled, the Copilot and Cursor integrations provide:

- Pipeline structure suggestions based on your use case.
- Component configuration recommendations.
- Error diagnosis and fix suggestions.
- Pipeline optimization tips.

Enable these in the RocketRide Settings page under **Integrations** (workspace settings — they follow your account, not this machine).
