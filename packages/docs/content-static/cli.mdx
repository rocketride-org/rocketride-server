---
title: CLI Reference
---

import { SiPython, SiTypescript } from 'react-icons/si';

# CLI Reference

The `rocketride` command-line tool starts pipelines, streams files through them,
and manages the engine's file store — the same operations the
[SDKs](/develop/typescript) expose, from a terminal. It ships with both the
[TypeScript](/develop/typescript) and [Python](/develop/python) clients, so
installing either package puts `rocketride` on your path.

> **Python vs TypeScript CLI:** Both packages ship a `rocketride` command. The
> core commands (`start`, `upload`, `status`, `stop`, `store`) are available in
> both, but flag names differ in a few places and the Python CLI includes two
> additional commands (`events`, `list`) not present in TypeScript. Differences
> are called out inline below.

## Install

Install either SDK to get `rocketride` on your path:

<div className="rr-card-grid">

<a className="rr-side-card" href="/develop/python">
  <span className="rr-side-card__head"><SiPython className="rr-card-icon" /><span className="rr-side-card__title">Python SDK</span></span>
  <span className="rr-side-card__body"><code>pip install rocketride</code> — installs the CLI alongside the Python client.</span>
</a>

<a className="rr-side-card" href="/develop/typescript">
  <span className="rr-side-card__head"><SiTypescript className="rr-card-icon" /><span className="rr-side-card__title">TypeScript SDK</span></span>
  <span className="rr-side-card__body"><code>npm install rocketride</code> — installs the CLI alongside the Node.js client.</span>
</a>

</div>

## Quick Start

The steps below assume you've installed one of the SDKs above. They take you
from a fresh install to a running pipeline.

### 1. Point at an engine

Set your connection once with environment variables so you don't have to repeat
them on every command:

```bash
# Local engine (default — no API key needed)
export ROCKETRIDE_URI=ws://localhost:5565

# RocketRide Cloud — generate an API key from the online editor
export ROCKETRIDE_URI=wss://api.rocketride.ai
export ROCKETRIDE_APIKEY=your-api-key
```

See [Cloud](/cloud) or [Self-hosting](/self-hosting) for engine setup.

### 2. Start a pipeline

Pass a `.pipe` file and watch events stream back live:

```bash
# TypeScript CLI
rocketride start --pipeline ./my-pipeline.pipe

# Python CLI
rocketride start ./my-pipeline.pipe
```

The CLI prints a **task token** at the start of the run — copy it, you'll use it
in the next steps.

```
task token: ey...
```

### 3. Upload files through a pipeline

Use `upload` to push one or more files through an extraction or processing
pipeline:

```bash
# TypeScript CLI
rocketride upload --pipeline ./extract.pipe ./document.pdf

# Python CLI
rocketride upload --pipeline_path ./extract.pipe ./document.pdf
```

Or feed files into a task that's already running by passing its token:

```bash
rocketride upload --token <task-token> ./report-q1.pdf ./report-q2.pdf
```

### 4. Monitor progress

Use the token from step 2 to watch a long-running task in real time:

```bash
rocketride status --token <task-token>
```

Press `Ctrl+C` to stop watching — the task keeps running.

### 5. Stop a task

When you're done, or need to cancel early:

```bash
rocketride stop --token <task-token>
```

---

## Connecting

Every command accepts connection options, which also read from the environment
so you can set them once:

| Option           | Env var                | Default               | Description                                                            |
| ---------------- | ---------------------- | --------------------- | ---------------------------------------------------------------------- |
| `--uri <uri>`    | `ROCKETRIDE_URI`       | `ws://localhost:5565` | Engine endpoint (see [Cloud](/cloud) / [Self-hosting](/self-hosting)). |
| `--apikey <key>` | `ROCKETRIDE_APIKEY`    | -                     | API token for authentication.                                          |
| `--pipeline <path>` | `ROCKETRIDE_PIPELINE` | -                  | Default pipeline path for `start`/`upload`. Python CLI only.          |
| `--token <token>` | `ROCKETRIDE_TOKEN`    | -                     | Default task token for token-bearing commands. Python CLI only.        |

Against a [Cloud](/cloud) endpoint use an `https://`/`wss://` URI so the
connection is encrypted.

## Commands

| Command  | What it does                                                               |
| -------- | -------------------------------------------------------------------------- |
| `start`  | Start a new pipeline from a `.pipe` file and stream its events.            |
| `upload` | Send files through a pipeline (by `--pipeline` or an existing task token). |
| `status` | Monitor a running task's status continuously.                              |
| `stop`   | Stop a running task.                                                       |
| `events` | Stream all raw events from a running task. Python CLI only.                |
| `list`   | List all active tasks. Python CLI only.                                    |
| `store`  | File-store operations: `dir`, `type`, `write`, `rm`, `mkdir`, `stat`.     |

### start

Use `start` when you want to run a pipeline and watch its event stream live.
The command loads the pipeline, starts the engine task, and prints structured
events as they arrive — node status, lane data, errors, and completion.

```bash
# TypeScript CLI: pipeline path is a named flag
rocketride start --pipeline ./rag.pipe

# Python CLI: pipeline path is a positional argument
rocketride start ./rag.pipe

# Start with extra worker threads (useful for CPU-bound nodes)
rocketride start --pipeline ./rag.pipe --threads 8

# Attach to a pipeline that is already running (e.g. a long-lived webhook source)
rocketride start --token <task-token>
```

Key flags:

| Flag | Description |
| --- | --- |
| `--pipeline <path>` (TypeScript) / `<path>` positional (Python) | Path to the `.pipe` JSON file. |
| `--threads <n>` | Number of worker threads. Default 4. |
| `--token <token>` | Reuse an existing running task instead of starting a new one. |

### upload

Use `upload` when you need to push one or more files through a pipeline. The
command starts a new pipeline task (or reuses one via `--token`), uploads each
file, and streams results back.

```bash
# TypeScript CLI: uses --pipeline
rocketride upload --pipeline ./extract.pipe ./invoice.pdf

# Python CLI: uses --pipeline_path (underscore)
rocketride upload --pipeline_path ./extract.pipe ./invoice.pdf

# Upload multiple files concurrently (TypeScript CLI)
rocketride upload --pipeline ./extract.pipe ./docs/*.pdf --max-concurrent 4

# Feed files into an already-running task
rocketride upload --token <task-token> ./report-q1.pdf ./report-q2.pdf
```

Key flags:

| Flag | Description |
| --- | --- |
| `--pipeline <path>` (TypeScript) / `--pipeline_path <path>` (Python) | Path to the `.pipe` file. Required unless `--token` is given. |
| `--token <token>` | Send files to an existing task instead of starting a new one. |
| `--max-concurrent <n>` | Maximum number of files to upload in parallel. Default 5. TypeScript CLI only. |

### status

Use `status` to watch a running task in real time — useful for long-running
ingestion jobs or pipelines processing many files.

```bash
# Watch task progress
rocketride status --token <task-token>
```

The command prints node status events, timing, and any errors as they arrive.
Press `Ctrl+C` to stop watching (the task continues running).

### stop

Use `stop` to terminate a running task. This sends a stop signal to the engine,
which cleanly shuts down the pipeline run.

```bash
rocketride stop --token <task-token>
```

The token is printed by `start` and `upload` at the beginning of the run, and
by `status`. Save it if you need to stop a long-running pipeline later.

### events

Use `events` to stream all raw events from a running task to your terminal or a
log file — useful when debugging pipeline internals or monitoring detailed node
output beyond what `status` shows.

```bash
# Stream all events
rocketride events --token <task-token>

# Filter to specific event types
rocketride events --token <task-token> DETAIL,SUMMARY

# Stream all events and write them to a log file
rocketride events --token <task-token> ALL --log ./debug.log
```

Key flags:

| Flag | Description |
| --- | --- |
| `[event_types]` | Optional positional. Comma-separated list: `DETAIL`, `SUMMARY`, `OUTPUT`, `ALL`. Defaults to all event types. |
| `--log <file>` | Write all events to a file in addition to stdout. |

> Available in the Python CLI only.

### list

Use `list` to display all active tasks for your account — handy when you have
multiple pipelines running and need to find a task token.

```bash
rocketride list
rocketride list --json
```

Key flags:

| Flag | Description |
| --- | --- |
| `--json` | Output results as JSON instead of human-readable text. |

> Available in the Python CLI only.

### store

Use `store` to inspect or write files in the engine's built-in file store. This
is useful for debugging pipeline outputs or seeding input data.

```bash
# List the root of the file store
rocketride store dir /

# List a subdirectory
rocketride store dir /pipeline-outputs

# Print the contents of a file
rocketride store type /pipeline-outputs/result.json

# Write a local file into the store
rocketride store write /pipeline-inputs/source.txt --file ./local-source.txt

# Write inline content without a local file
rocketride store write /pipeline-inputs/prompt.txt --content "Summarize this document"

# Delete a file from the store
rocketride store rm /pipeline-outputs/old-result.json

# Create a directory in the store
rocketride store mkdir /pipeline-outputs/archive

# Print metadata for a file or directory
rocketride store stat /pipeline-outputs/result.json
```

Sub-commands:

| Sub-command | Description |
| --- | --- |
| `dir <path>` | List directory contents at `<path>`. |
| `type <path>` | Print the contents of the file at `<path>`. |
| `write <path> --file <local>` | Upload `<local>` to the store at `<path>`. |
| `write <path> --content <text>` | Write inline text to the store at `<path>`. |
| `rm <path>` | Delete a file from the store. |
| `mkdir <path>` | Create a directory in the store. |
| `stat <path>` | Print metadata (size, type, modified time) for `<path>`. |

## Related

- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python): the
  same operations, in code.
- [WebSocket protocol](/protocols/websocket): what the CLI sends to the engine.
- [Cloud](/cloud) · [Self-hosting](/self-hosting): where the engine runs.
