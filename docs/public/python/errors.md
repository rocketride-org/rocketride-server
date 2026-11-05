---
title: Error Handling
sidebar_position: 9
---

# Error Handling

What the SDK raises, when, and how to catch it.

## What actually raises

| Situation | Raised |
| --- | --- |
| Bad API key / credentials during connect or login | `AuthenticationException` |
| Connection and transport failures | builtin `ConnectionError` (timeouts: `asyncio.TimeoutError`) |
| Data-pipe errors (open / write / close) | `PipeException` |
| `use()` argument problems (neither `filepath` nor `pipeline`; both; bad types) | `ValueError` |
| `use()` with a missing pipeline file | `FileNotFoundError` |
| Server rejects a command through `call()`: `tool()`, `use()`, `terminate()`, `get_tasks()`, `get_task_pipeline()` and the other methods built on it | `CommandException` (a `RuntimeError`; `code` set when the server sent one) |
| Server rejects a request in a method that re-raises it (`restart()`, `validate()`, `fs_read()`, `fs_read_many()`, pipe `tool()`), or `use()` gets no task token back | `RuntimeError` (no `code`) |
| `get_service('')` / unknown service name | `ValueError` / `RuntimeError` |
| `send_files` without an API key, or a missing file | `RuntimeError` / `ValueError` |
| `Answer.getJson()` on non-JSON content | `ValueError` |

```python
from rocketride import RocketRideClient, AuthenticationException
from rocketride.core.exceptions import PipeException

try:
    async with RocketRideClient(uri=uri, auth=auth) as client:
        result = await client.use(filepath='pipeline.pipe')
        await client.send(result['token'], data)
except AuthenticationException:
    print('Bad credentials')
except (ValueError, FileNotFoundError) as e:
    print(f'Bad pipeline arguments: {e}')
except PipeException as e:
    print(f'Data transfer error: {e}')
except ConnectionError as e:
    print(f'Transport failure: {e}')
except RuntimeError as e:
    print(f'Server rejected the request: {e}')
```

`AuthenticationException` is raised on DAP auth failure. In
[persist mode](/clients/python/configuration#reconnection) the client catches it,
calls `on_connect_error`, and does **not** retry — fix credentials and call
`connect()` again.

## The hierarchy

```text
DAPException                    # Base DAP protocol error (has dap_result dict)
└── RocketRideException         # Base for all RocketRide errors
    ├── ConnectionException     # Reserved: transport failures raise builtin ConnectionError
    │   └── AuthenticationException  # Bad API key or credentials (actively raised)
    ├── PipeException           # Data pipe errors (also subclasses RuntimeError)
    ├── CommandException        # A command the server rejected (also subclasses RuntimeError)
    ├── ExecutionException      # Reserved: defined but not currently raised
    └── ValidationException     # Reserved: defined but not currently raised
```

All exceptions in the hierarchy expose a `dap_result` dict with detailed server
error context, plus `code` and `hint`:

- `code` is the server's machine-readable classification, or `None`. Task
  failures carry one: `TASK_NOT_REGISTERED` (the token names no live task —
  never started, terminated, replaced, or the engine restarted),
  `TASK_AMBIGUOUS`, `TASK_COMPLETED`, `TASK_STOPPED`; a refused pipe raises
  `PipeException` with `OUT_OF_CREDITS` (the org is out of credit; clears when
  it tops up). **Classify on `code`, not
  on the message text**, which is written for people and may be reworded.
- `hint` is troubleshooting text the SDK attached for a developer, or `None`.
  It is kept out of `str(e)` so an application can show the message to an end
  user without the developer checklist.

```python
except PipeException as e:
    if e.code == 'TASK_NOT_REGISTERED':
        await restart_pipeline()      # the task is gone; start a new one
    else:
        print(e)                      # safe to show
        if e.hint:
            log.debug(e.hint)         # developer detail
```

`PipeException` and `CommandException` also subclass `RuntimeError`, so a broad
`except RuntimeError` catches pipe and command failures too. A rejected
`client.call()` keeps the server's message as `str(e)` and its code as `e.code`,
so a tool caller can tell a task that stopped before the call reached it
(`TASK_STOPPED`) from a failure inside the tool or a call no node handled (no
code):

```python
from rocketride import CommandException

try:
    rows = await client.tool(token=token, tool='read_query', node_id=node_id, input=args)
except CommandException as e:
    if e.code == 'TASK_STOPPED':
        ...  # the task stopped (or is restarting) before the call reached the node
    raise
```

`ConnectionException`, `ExecutionException`, and `ValidationException` exist in
`rocketride.core.exceptions` but the SDK does not currently raise them: transport
failures surface as the builtin `ConnectionError`, a rejected pipeline start as
`CommandException`, and `validate()` failures as a plain `RuntimeError` (see the
table above). Don't write handlers that rely on them.
