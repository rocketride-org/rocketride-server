---
title: Python
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Python - RocketRide Documentation</title>
</head>

## What it does

Gives agents the ability to execute Python code in a sandboxed environment. Useful for data manipulation, calculations, formatting, and any logic the agent needs to run directly rather than describe.

## Tools

| Tool             | Description                                   |
| ---------------- | --------------------------------------------- |
| `python.execute` | Execute a Python script and return its output |

### python.execute

| Parameter | Required | Description                   |
| --------- | -------- | ----------------------------- |
| `code`    | yes      | Python source code to execute |

**Response:**

```json
{
	"stdout": "...",
	"stderr": "...",
	"exit_code": 0,
	"timed_out": false,
	"result": null
}
```

`exit_code` is `0` on success, `1` on exception, `-1` on timeout. If the script assigns a value to a variable named `result`, it is returned in the `result` field.

## Configuration

| Field           | Description                                            |
| --------------- | ------------------------------------------------------ |
| Tool Namespace  | Prefix for the tool name (default: `python`)           |
| Timeout         | Max execution time in seconds (default: 20, max: 1200) |
| Allowed Modules | Additional modules to allow beyond the defaults        |

## Sandbox

Code runs in a restricted in-process sandbox using RestrictedPython. Network access, filesystem access, and subprocess execution are not available. Only the following modules are importable by default:

`math`, `cmath`, `decimal`, `fractions`, `statistics`, `random`, `string`, `textwrap`, `re`, `json`, `csv`, `collections`, `itertools`, `functools`, `operator`, `copy`, `dataclasses`, `enum`, `typing`, `datetime`, `time`, `calendar`, `base64`, `hashlib`, `hmac`, `struct`, `difflib`, `pprint`, `bisect`, `heapq`, `array`, `numbers`, `unicodedata`

Additional modules can be whitelisted in configuration.
