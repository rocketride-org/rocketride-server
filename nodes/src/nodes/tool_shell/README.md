---
title: Shell
date: 2026-04-30
sidebar_position: 1
---

<head>
  <title>Shell - RocketRide Documentation</title>
</head>

## What it does

Tool node that runs a shell command on the host and returns stdout, stderr, and exit code. Useful for build scripts, package managers, file operations, and host-installed git.

## As a tool

When connected to an agent, exposes one function under the configured server name (default: `shell`):

| Function        | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `shell.execute` | Run a shell command and return stdout, stderr, and exit code |

**`shell.execute` parameters:**

| Parameter     | Required | Description                                                 |
| ------------- | -------- | ----------------------------------------------------------- |
| `command`     | yes      | Shell command to execute (interpreted by the host shell)    |
| `working_dir` | no       | Working directory for this call. Overrides the node default |
| `env`         | no       | Object of environment variables to inject for this call     |
| `timeout`     | no       | Per-call timeout in seconds (capped by node configuration)  |

`exit_code` is the process return code. `-1` indicates a timeout kill; `127` indicates the host shell could not be launched.

## Configuration

| Field                         | Default   | Description                                                                                                                |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Default working directory     | host CWD  | Working directory used when the agent does not provide one                                                                 |
| Execution timeout (seconds)   | `30`      | Max seconds a command may run (max 1800). On timeout the entire process tree is killed                                     |
| Max output size (bytes)       | `1048576` | Per-stream cap on stdout and stderr; output beyond this is streamed and discarded so memory stays bounded                  |
| Allow agent-supplied env vars | off       | Whether the agent may inject env vars per call. Off by default — `LD_PRELOAD`/`PATH`/`NODE_OPTIONS` can redirect execution |
| Environment variables         | —         | Variables injected into every command. Override agent-supplied vars of the same name                                       |
| Command allowlist             | —         | Regex patterns. If non-empty, the full command must match at least one (`re.fullmatch`). Use `.*` for substring matches    |

## Notes

- Commands run directly on the host with the privileges of the running process — no sandbox. Use the allowlist to restrict commands and avoid deploying in untrusted environments.
- An allowlist whose patterns all fail to compile is rejected at startup (fail-closed); individual invalid patterns are dropped with a warning.
- For portable git operations that don't require git on the host, prefer the Git node.
