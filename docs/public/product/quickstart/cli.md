---
title: Run from the CLI
---

# Run from the CLI

The `rocketride` command-line tool runs pipelines from a terminal — the same
operations the SDKs expose, no code required. It ships with both
[clients](/clients): `pip install rocketride` or `npm install rocketride`.
With a global npm install `rocketride` is on your PATH; with a local
install use `npx rocketride`.

The five steps below take you from a fresh install to a running pipeline. The
full command and flag reference is on the [CLI page](/connect/cli).

## 1. Point at an engine

Set your connection once with environment variables so you don't have to repeat
them on every command:

```bash
# Local engine - no pre-registered key is required, but the client must send one.
# A fresh engine accepts any non-empty value, so use any string:
export ROCKETRIDE_URI=ws://localhost:5565
export ROCKETRIDE_APIKEY=local-dev

# RocketRide Cloud — generate an API key from the online editor
export ROCKETRIDE_URI=wss://api.rocketride.ai
export ROCKETRIDE_APIKEY=your-api-key
```

A fresh engine with no `ROCKETRIDE_APIKEY` set accepts any non-empty key, but
a client that sends none is refused with `No authorization provided`. Pick any
string for local use; when you set a real key on the engine you must send the
matching one here.

See [Choose How to Run RocketRide](/operate) for engine setup.

## 2. Start a pipeline

Pass a `.pipe` file. The command starts the task, prints its token, and exits;
the pipeline keeps running on the engine:

```bash
rocketride start --pipeline ./my-pipeline.pipe
```

The CLI prints a **task token** when the run starts. Copy it, you'll use it
in the next steps.

```
Starting pipeline from ./my-pipeline.pipe...
Pipeline started.
Token: ey...
Stop it with: rocketride stop --token ey...
```

## 3. Upload files through a pipeline

Use `upload` to push one or more files through an extraction or processing
pipeline:

```bash
rocketride upload --pipeline ./extract.pipe ./document.pdf
```

Or feed files into a task that's already running by passing its token:

```bash
rocketride upload --token <task-token> ./report-q1.pdf ./report-q2.pdf
```

## 4. Check what is running

List the active tasks to confirm yours is still up and to find its token again:

```bash
rocketride list
```

The CLI does not stream events; live monitoring belongs to the platform's
monitor apps.

## 5. Stop a task

When you're done, or need to cancel early:

```bash
rocketride stop --token <task-token>
```

## Next steps

- [CLI reference](/connect/cli): every command, flag, and the file-store operations.
- [Integrate with an SDK](/quickstart/sdk-integration): the same operations, in code.
- [Examples](/examples/rag-pipeline): full pipelines to run.
