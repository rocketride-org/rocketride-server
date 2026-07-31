---
title: Usage Guide
date: 2026-03-02
sidebar_position: 3
---

## Creating a Pipeline

1. Right-click in the Explorer or click **+** in the RocketRide sidebar.
2. Choose **Create Pipeline** to create a new `.pipe` file.
3. The visual editor opens automatically for `.pipe` files.
4. Drag components from the component palette onto the canvas.
5. Configure each component's properties in the properties panel.
6. Connect component outputs to inputs by drawing connections between lanes.
7. Save the file, changes are auto-saved.

## Running a Pipeline

1. Right-click a `.pipe` file in the Explorer or sidebar.
2. Select **Run Pipeline**, or use `Ctrl+Shift+P` and search for **RocketRide: Run Pipeline**.
3. The **Status** page opens with real-time execution monitoring.
4. Watch data flow through components, view completion metrics, and check for errors.

## Debugging a Pipeline

1. Right-click a `.pipe` file and select **Debug Pipeline**.
2. The debugger opens with breakpoint support.
3. Set breakpoints on components to pause execution.
4. Step through the pipeline and inspect variable values at each breakpoint.

## Attaching to a Running Pipeline

If a pipeline is already running on the server:

1. Right-click a `.pipe` file and select **Attach to Pipeline**.
2. The **Status** page opens and streams real-time data from the running pipeline.

## Deploying to Cloud

1. Right-click a `.pipe` file and select **Deploy Pipeline**.
2. The **Deploy** page opens.
3. Configure deployment settings.
4. Click **Deploy** to push the pipeline to RocketRide.ai cloud.

## Pipeline Editor

The visual editor provides:

- **Component palette**: Browse and search available nodes (sources, LLMs, stores, etc.).
- **Canvas**: Drag-and-drop workspace for arranging components.
- **Properties panel**: Configure selected component settings (API keys, models, connection strings, etc.).
- **Lane connections**: Draw lines between component output and input lanes to define data flow.

## Pipeline Execution Defaults

Trace verbosity, the idle timeout (TTL), task arguments, and debug output for pipeline runs are configured once in **Settings → Pipeline** — they are workspace settings, not per-pipeline options:

- **Pipeline Trace Level** (`rocketride.pipelineTraceLevel`, default `summary`): how much execution-trace data the engine emits — `full`, `summary`, `metadata`, or `none`. Higher levels populate the **Flow** and **Trace** tabs, but `full` inlines entire payloads (including images), which can noticeably slow runs that process large images.
- **Pipeline TTL** (`rocketride.pipelineTTL`, default `900` = 15 minutes): how long the engine keeps a pipeline alive without activity before stopping it. Fixed choices from 15 minutes to 8 hours, plus "Run forever or until you stop it" (`0` = no timeout).
- **Task Arguments** (`rocketride.taskArguments`, default empty): additional command-line arguments passed to each pipeline task process. The engine splits the string using shell parsing rules, so quoted paths are preserved.
- **Pipeline Debug Output** (`rocketride.pipelineDebugOutput`, default `false`): appends `--trace=debugOut` to the task arguments (unless they already contain a `--trace=` flag) for detailed task trace logging.

The extension host reads these from the workspace settings and passes them to the engine on each `run`/`restart` (the `status:pipelineAction` message carries only the action and source). The engine process itself starts with no extra flags — these settings apply per task, not to the server.

## Environment Variables

The extension does not write or sync a workspace `.env` file. You must create `.env` yourself with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`. The RocketRide **Python SDK** reads the workspace `.env` automatically from its process working directory; the TypeScript SDK and CLIs read only process environment variables, so export the values first (for example, `set -a; source .env`).

Server-managed env (org/team/user secrets) is configured separately from the **Environment** page and merged server-side during pipeline execution — it does not require a local `.env` file.

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

Enable these in settings under `rocketride.integrations.copilot` and `rocketride.integrations.cursor`.
