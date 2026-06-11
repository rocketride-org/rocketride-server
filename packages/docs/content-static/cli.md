---
title: CLI Reference
---

# CLI Reference

The `rocketride` command-line tool starts pipelines, streams files through them,
and manages the engine's file store — the same operations the
[SDKs](/develop/typescript) expose, from a terminal. It ships with both the
[TypeScript](/develop/typescript) and [Python](/develop/python) clients, so
installing either package puts `rocketride` on your path.

## Connecting

Every command accepts the connection options, which also read from the
environment so you can set them once:

| Option           | Env var             | Default               | Description                                                            |
| ---------------- | ------------------- | --------------------- | ---------------------------------------------------------------------- |
| `--uri <uri>`    | `ROCKETRIDE_URI`    | `ws://localhost:5565` | Engine endpoint (see [Cloud](/cloud) / [Self-hosting](/self-hosting)). |
| `--apikey <key>` | `ROCKETRIDE_APIKEY` | —                     | API token for authentication.                                          |

Against a [Cloud](/cloud) endpoint use an `https://`/`wss://` URI so the
connection is encrypted.

## Commands

| Command  | What it does                                                               |
| -------- | -------------------------------------------------------------------------- |
| `start`  | Start a new pipeline from a `.pipe` file and stream its events.            |
| `upload` | Send files through a pipeline (by `--pipeline` or an existing task token). |
| `status` | Monitor a running task's status continuously.                              |
| `stop`   | Stop a running task.                                                       |
| `store`  | File-store operations: `dir`, `type`, `write`.                             |

### start

```bash
rocketride start --pipeline ./my-pipeline.pipe --threads 4
```

Loads the pipeline, runs it, and prints engine [events](/protocols/websocket) as
they arrive. Reuse a running task with `--token <token>`.

### upload

```bash
rocketride upload --pipeline ./parser.pipe ./invoice.pdf ./report.pdf
```

Pushes one or more files through the pipeline. Use `--token <token>` to feed an
already-running task instead of starting a new one, and `--max-concurrent` to
cap parallel uploads.

### status / stop

```bash
rocketride status --token <token>   # watch
rocketride stop   --token <token>   # terminate
```

### store

```bash
rocketride store dir /              # list directory contents
rocketride store type /path/file    # print a file
rocketride store write /path/file --file ./local.txt   # write a file
```

## Related

- [TypeScript SDK](/develop/typescript) · [Python SDK](/develop/python) — the
  same operations, in code.
- [WebSocket protocol](/protocols/websocket) — what the CLI sends to the engine.
- [Cloud](/cloud) · [Self-hosting](/self-hosting) — where the engine runs.
