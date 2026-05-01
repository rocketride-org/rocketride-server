---
title: Shell
date: 2026-04-30
sidebar_position: 1
---

<head>
  <title>Shell - RocketRide Documentation</title>
</head>

## What it does

Executes shell commands in the host environment. Use to run scripts, manage processes, install packages, and interact with the operating system via the command line.

Common use cases:

- Build scripts: `npm run build`, `python setup.py install`, `make`
- Package management: `npm install`, `pip install`, `apt-get install`
- Process management: starting/stopping services, checking process status
- File operations: `cp`, `mv`, `rm`, `mkdir`, `find`, `grep`
- Environment inspection: `env`, `echo $PATH`, `which <binary>`
- Git operations (when git is available on the host): `git status`, `git add`, `git commit -m "message"`, `git push`, `git pull`, `git clone <url>`, `git log --oneline`, `git diff`, `git checkout -b <branch>`, `git merge <branch>`

> Note: For portable git operations that do not depend on the host environment having git installed, use the Git node instead.

## Tools

| Tool            | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `shell.execute` | Run a shell command and return stdout, stderr, and exit code |

### shell.execute

| Parameter     | Required | Description                                                                                 |
| ------------- | -------- | ------------------------------------------------------------------------------------------- |
| `command`     | yes      | Shell command to execute (interpreted by the host shell)                                    |
| `working_dir` | no       | Working directory for this call. Overrides the node default. Must be an existing directory. |
| `env`         | no       | Object of environment variables to inject for this call                                     |
| `timeout`     | no       | Per-call timeout in seconds (capped by node configuration)                                  |

**Response:**

```json
{
	"stdout": "...",
	"stderr": "...",
	"exit_code": 0,
	"timed_out": false,
	"truncated": false
}
```

`exit_code` is the process return code. `-1` indicates the command was killed due to timeout; `127` indicates the host shell could not be launched.

## Configuration

| Field                         | Description                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool Namespace                | Prefix for the tool name (default: `shell`)                                                                                                  |
| Default working directory     | Working directory used when the agent does not provide one. Defaults to the host process CWD                                                 |
| Execution timeout (seconds)   | Maximum seconds a command may run (default 30, max 1800)                                                                                     |
| Max output size (bytes)       | Cap on stdout and stderr each (default 1 MiB). Output beyond this is truncated                                                               |
| Allow agent-supplied env vars | Whether the agent may add env vars per call (default off). Node-defined vars always take precedence when on                                  |
| Environment variables         | Variables injected into every command                                                                                                        |
| Command allowlist             | Regex patterns. If non-empty, the full command must match at least one pattern (re.fullmatch). Use `.*` for substring matches, e.g. `npm .*` |

## Security

This node executes commands directly on the host with the privileges of the running process. It does not sandbox the command. Use the command allowlist to restrict which commands can run, set a working directory to scope file access, and avoid deploying this node in untrusted environments.
