---
title: Daytona
date: 2026-06-11
sidebar_position: 1
---

## What it does

Gives agents an isolated [Daytona](https://www.daytona.io) cloud sandbox for running code and shell commands — generated code executes remotely, never on the engine host. One ephemeral sandbox is created lazily on the first tool call, shared across calls (installed packages and files persist within the session), and deleted when the pipeline shuts down.

## Tools

| Tool                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `daytona.run_code`      | Execute code in the sandbox and return its output      |
| `daytona.run_command`   | Run a shell command in the sandbox                     |
| `daytona.upload_file`   | Write a text file into the sandbox                     |
| `daytona.download_file` | Read a text file from the sandbox                      |

### daytona.run_code

| Parameter | Required | Description                                          |
| --------- | -------- | ---------------------------------------------------- |
| `code`    | yes      | Source code to execute (sandbox language from config) |

Returns `exit_code`, `output` (stdout/stderr, truncated at the configured cap) and `truncated`.

### daytona.run_command

| Parameter | Required | Description                              |
| --------- | -------- | ---------------------------------------- |
| `command` | yes      | Shell command, e.g. `pip install requests && python app.py` |
| `cwd`     | no       | Working directory inside the sandbox     |

Returns `exit_code`, `output` and `truncated`.

### daytona.upload_file

| Parameter | Required | Description                            |
| --------- | -------- | -------------------------------------- |
| `path`    | yes      | Destination path inside the sandbox    |
| `content` | yes      | Text content to write (UTF-8)          |

Returns `success` and `path`, or `error` on failure.

### daytona.download_file

| Parameter | Required | Description                       |
| --------- | -------- | --------------------------------- |
| `path`    | yes      | Path of the file to read          |

Returns `content` (UTF-8, truncated at the configured cap) and `truncated`, or `error` when the file is missing or the sandbox call fails. `run_code`/`run_command` likewise return `error` instead of `exit_code`/`output` when the sandbox call itself fails.

## Configuration

| Field                       | Description                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- |
| API Key                     | Daytona API key (app.daytona.io → Keys)                                       |
| API URL                     | Endpoint override for self-hosted Daytona (empty = Daytona cloud)             |
| Target Region               | Sandbox region (`us`, `eu`; empty = organization default)                     |
| Snapshot                    | Snapshot to create the sandbox from (empty = default)                         |
| Language                    | Runtime for `run_code` (python, javascript, typescript)                       |
| Auto-stop (minutes)         | Inactivity stop; the sandbox is ephemeral, so stop also deletes it            |
| Execution Timeout (seconds) | Per-call cap for `run_code`/`run_command`                                     |
| Max Output (characters)     | Output truncation cap protecting the agent context                            |

## Cost safety

A sandbox bills while running. This node bounds the exposure three ways: the sandbox is created only when a tool is actually called; it is `ephemeral` with a 1–120 minute auto-stop (stop deletes it) even if the engine dies; and it is explicitly deleted on pipeline shutdown.

## Upstream docs

- [Daytona documentation](https://www.daytona.io/docs)
