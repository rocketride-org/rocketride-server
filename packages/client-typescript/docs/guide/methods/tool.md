---
title: "Tool"
date: 2026-06-15
---

- [Overview](#overview)
- [tool()](#tool)
- [Pipe.tool()](#pipetool)
- [Returns](#returns)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

`tool()` invokes a node's `@tool_function` **directly**, without going through an
agent. The server borrows a pipeline instance from the pool, dispatches the call to
the node that owns the named tool, and returns the tool's value. Use it to call a
node's capability (for example a database node's `list`, `stats`, `dialect`, or
`execute` tool) as a plain request/response, the same way an agent would but on your
own terms.

Like the other data methods, `tool()` needs a **token** from a started pipeline
(via `use()`).

---

## **tool()**

Invoke a `@tool_function` on a pipeline node.

### Method Signature

**Python (async):**
```python
result = await client.tool(token=token, tool='list', node_id='', input=None, timeout=None)
```

**TypeScript:**

```typescript
const result = await client.tool({ token, tool: 'list', nodeId, input, timeout });
```

### Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `str` / `string` | Yes | Pipeline task token from `use()` |
| `tool` | `str` / `string` | Yes | Name of the `@tool_function` to invoke (e.g. `'search'`, `'list'`, `'execute'`) |
| `node_id` / `nodeId` | `str` / `string` | No | Target node id. When empty, the call broadcasts to all tool-lane nodes and the first node that owns the tool handles it. |
| `input` | `dict` / `Record<string, unknown>` | No | Arguments forwarded to the tool function |
| `timeout` | `float` / `number` | No | Per-request timeout (seconds in Python, ms in TypeScript) |

### Examples

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    result = await client.use(filepath='vectordb.json')
    token = result['token']

    # List collections exposed by a database node
    collections = await client.tool(token=token, tool='list')

    # Call a specific node with input
    stats = await client.tool(
        token=token,
        tool='stats',
        node_id='qdrant_1',
        input={'collection': 'docs'},
    )
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();

const { token } = await client.use({ filepath: './vectordb.json' });

// List collections exposed by a database node
const collections = await client.tool({ token, tool: 'list' });

// Call a specific node with input
const stats = await client.tool({
    token,
    tool: 'stats',
    nodeId: 'qdrant_1',
    input: { collection: 'docs' },
});

await client.disconnect();
```

---

## **Pipe.tool()**

When you already hold an open [pipe](./send#pipe--datapipe), call `tool()` on it to
reuse that pipe's connection (the token is implicit).

**Python (async):**
```python
async with await client.pipe(token) as pipe:
    result = await pipe.tool(tool='list', node_id='', input=None)
```

**TypeScript:**

```typescript
const pipe = await client.pipe(token);
await pipe.open();
const result = await pipe.tool('list', '', {});
```

The parameters match `tool()` minus `token` (the pipe already carries it).

---

## **Returns**

- **Type**: the tool's return value, typically a `dict` / object. The shape is
  defined by the node's `@tool_function`, the SDK returns it verbatim.

The value is delivered in the DAP response `body.result` (see below).

## **Error Handling**

| Error | Cause |
| --- | --- |
| `ValueError` / `Error` | `tool` is missing, or `input` is not an object |
| `RuntimeError` / `Error` | No node handles the requested tool, the node id is invalid, or the tool raised |

```python
try:
    result = await client.tool(token=token, tool='list')
except RuntimeError as e:
    print(f'Tool invocation failed: {e}')
```

## **API Endpoint**

`tool()` is the `tool` subcommand of the `rrext_process` command over the DAP data
connection (HTTP equivalent `POST /task/data?token={token}`). See the
[WebSocket protocol](/protocols/websocket#invoking-a-node-tool) page for the wire
shape.

## **Related Methods**

- [`use()`](./use) - Start a pipeline (returns the token needed here)
- [`send()` / `pipe()`](./send) - Send data to a pipeline
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor pipeline status
