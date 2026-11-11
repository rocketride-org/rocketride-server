---
title: Run from the CLI
---

# Run from the CLI

The `rocketride` command-line tool runs pipelines from a terminal — the same
operations the SDKs expose, no code required. It ships with both
[clients](/clients): `pip install rocketride` (in a virtual environment) puts
`rocketride` on your path, and for Node you run it with `npx rocketride`
(`npm install rocketride` does not put it on your path). Node users run every
`rocketride` command on this page as `npx rocketride`.

The five steps below take you from a fresh install to a running pipeline. The
full command and flag reference is on the [CLI page](/connect/cli).

## 1. Point at an engine

Set your connection once with environment variables so you don't have to repeat
them on every command:

```bash
# Local engine: set the key the engine was started with. If the engine was
# started without ROCKETRIDE_APIKEY, any non-empty value works. With no key at
# all, commands fail with "No authorization provided".
export ROCKETRIDE_URI=ws://localhost:5565
export ROCKETRIDE_APIKEY=rr_local

# RocketRide Cloud — generate an API key from the online editor
export ROCKETRIDE_URI=wss://api.rocketride.ai
export ROCKETRIDE_APIKEY=your-api-key
```

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
