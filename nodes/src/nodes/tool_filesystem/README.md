---
title: File System
date: 2026-04-16
sidebar_position: 1
---

<head>
  <title>File System - RocketRide Documentation</title>
</head>

## What it does

Gives agents read/write access to the account-scoped RocketRide file store — the same storage area exposed to the client SDK via `fs_*` methods. All paths are relative to `users/<client_id>/files/`, so files and agent writes via this tool are visible to the client SDK and vice versa. This node has no pipeline lanes — it is connected to agents via the `tool` invoke channel.

## Tools

| Tool               | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `read_file`        | Read a file and return its decoded contents            |
| `write_file`       | Create or overwrite a file with text content           |
| `list_directory`   | List the immediate children of a directory             |
| `create_directory` | Create a directory (intermediate segments are created) |
| `stat_file`        | Get metadata for a file or directory                   |
| `delete_file`      | Delete a file (only when `Delete files` is enabled)    |

Each tool is namespaced by the node id: e.g. an agent sees `tool_filesystem_1.read_file`. Tools whose corresponding allow-flag is disabled are hidden from the agent at discovery time, not just blocked at invocation.

## Configuration

| Field              | Description                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Read files         | Enable `read_file`                                                                                                |
| Write files        | Enable `write_file`                                                                                               |
| List directories   | Enable `list_directory`                                                                                           |
| Create directories | Enable `create_directory`                                                                                         |
| Stat (metadata)    | Enable `stat_file`                                                                                                |
| Delete files       | Enable `delete_file`                                                                                              |
| Path Whitelist     | Optional regex patterns. If non-empty, every operation's path must match at least one pattern. Empty = allow all. |

## Storage location

Files land under the configured storage backend (defaults to `~/.rocketlib/store/`). For the default filesystem backend the absolute path is:

```text
<store>/users/<client_id>/files/<path>
```

Each account gets its own isolated `files/` directory — the node picks up the current account automatically, no configuration needed.
