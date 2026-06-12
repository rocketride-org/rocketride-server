---
title: "Get Task Status"
date: 2025-07-29
---

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Returns](#returns)
- [Usage Examples](#usage-examples)
- [Task States](#task-states)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

The `get_task_status()` (Python) / `getTaskStatus()` (TypeScript) method retrieves the current status and detailed metrics of a running pipeline. Use it to monitor progress, check for errors, and determine when processing is complete.

## **Method Signature**

### Python (async)

```python
status = await client.get_task_status(token)
```

### TypeScript

```typescript
const status = await client.getTaskStatus(token);
```

## **Parameters**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `str` / `string` | Yes | Task token returned by `use()` |

## **Returns**

- **Type**: `TASK_STATUS`, a dictionary/object with comprehensive status fields

### Key Fields

| Field | Type | Description |
| --- | --- | --- |
| `state` | `int` | Current task state (see [Task States](#task-states)) |
| `completed` | `bool` | Whether the task has finished execution |
| `name` | `str` | Pipeline name |
| `project_id` | `str` | Project identifier |
| `source` | `str` | Source component ID |
| `startTime` | `float` | Task start timestamp (Unix time) |
| `endTime` | `float` | Task completion timestamp (Unix time) |
| `totalCount` | `int` | Total items to process |
| `completedCount` | `int` | Items processed successfully |
| `failedCount` | `int` | Items that failed processing |
| `totalSize` | `int` | Total size in bytes |
| `completedSize` | `int` | Bytes processed successfully |
| `rateCount` | `int` | Current processing rate (items/sec) |
| `rateSize` | `int` | Current processing rate (bytes/sec) |
| `errors` | `list[str]` | Recent error messages (max 50) |
| `warnings` | `list[str]` | Recent warning messages (max 50) |
| `status` | `str` | Current status message |
| `currentObject` | `str` | Item currently being processed |
| `exitCode` | `int` | Process exit code (0 = success) |
| `exitMessage` | `str` | Exit message details |
| `metrics` | `TASK_METRICS` | CPU, memory, and GPU utilization |
| `tokens` | `TASK_TOKENS` | Token usage for billing |
| `pipeflow` | `TASK_STATUS_FLOW` | Pipeline component execution flow |

### Metrics Fields (`metrics`)

| Field | Type | Description |
| --- | --- | --- |
| `cpu_percent` | `float` | Current CPU utilization (0-100%) |
| `cpu_memory_mb` | `float` | Current RAM usage in MB |
| `gpu_memory_mb` | `float` | Current GPU VRAM usage in MB |
| `peak_cpu_percent` | `float` | Peak CPU utilization |
| `peak_cpu_memory_mb` | `float` | Peak RAM usage in MB |
| `peak_gpu_memory_mb` | `float` | Peak GPU VRAM usage in MB |

### Token Usage Fields (`tokens`)

| Field | Type | Description |
| --- | --- | --- |
| `cpu_utilization` | `float` | Cumulative CPU utilization tokens |
| `cpu_memory` | `float` | Cumulative CPU memory tokens |
| `gpu_memory` | `float` | Cumulative GPU memory tokens |
| `total` | `float` | Total cumulative tokens |

## **Usage Examples**

### Basic Status Check

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    result = await client.use(filepath='pipeline.json')
    token = result['token']

    status = await client.get_task_status(token)
    print(f'State: {status["state"]}')
    print(f'Progress: {status["completedCount"]}/{status["totalCount"]}')
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();

const result = await client.use({ filepath: './pipeline.json' });
const status = await client.getTaskStatus(result.token);
console.log(`State: ${status.state}`);
console.log(`Progress: ${status.completedCount}/${status.totalCount}`);

await client.disconnect();
```

### Polling Until Completion

```python
import asyncio

status = await client.get_task_status(token)
while not status['completed']:
    print(f'Processing: {status["completedCount"]}/{status["totalCount"]}')

    if status['errors']:
        for error in status['errors']:
            print(f'Error: {error}')

    await asyncio.sleep(2)
    status = await client.get_task_status(token)

print(f'Pipeline finished with exit code: {status["exitCode"]}')
```

```typescript
let status = await client.getTaskStatus(token);
while (!status.completed) {
    console.log(`Processing: ${status.completedCount}/${status.totalCount}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    status = await client.getTaskStatus(token);
}
console.log('Pipeline complete!');
```

## **Task States**

| State | Value | Description |
| --- | --- | --- |
| `NONE` | `0` | Initial state: no resources allocated |
| `STARTING` | `1` | Resource allocation and subprocess preparation |
| `INITIALIZING` | `2` | Subprocess initialization and service startup |
| `RUNNING` | `3` | Operational: actively processing requests |
| `STOPPING` | `4` | Graceful shutdown in progress |
| `COMPLETED` | `5` | Finished successfully: resources cleaned up |
| `CANCELLED` | `6` | Terminated before completion |

### State Transitions

```text
NONE → STARTING → INITIALIZING → RUNNING → STOPPING → COMPLETED
                                          → STOPPING → CANCELLED
```

## **Response Format**

The method returns the full `TASK_STATUS` object. Here's an example:

```json
{
  "name": "text_analyzer",
  "project_id": "my-project",
  "state": 3,
  "completed": false,
  "startTime": 1700000000.0,
  "endTime": 0.0,
  "totalCount": 100,
  "completedCount": 45,
  "failedCount": 2,
  "rateCount": 5,
  "errors": [],
  "warnings": [],
  "metrics": {
    "cpu_percent": 25.3,
    "cpu_memory_mb": 512.0,
    "gpu_memory_mb": 1024.0
  },
  "tokens": {
    "cpu_utilization": 1.5,
    "cpu_memory": 0.8,
    "gpu_memory": 2.1,
    "total": 4.4
  },
  "pipeflow": {
    "totalPipes": 2,
    "byPipe": {
      "0": ["source", "transform", "filter"],
      "1": ["source", "transform"]
    }
  }
}
```

## **Error Handling**

| Error | Cause |
| --- | --- |
| `RuntimeError` / `Error` | Status retrieval failed (e.g., invalid token, server error) |
| Authentication error | Invalid or missing API key |

```python
try:
    status = await client.get_task_status(token)
except RuntimeError as e:
    print(f'Failed to get status: {e}')
```

## **API Endpoint**

This method communicates via the RocketRide DAP protocol over WebSocket. The equivalent HTTP endpoint is:

- **Method**: `GET /task`
- **Query Parameters**: `token={token}`

## **Related Methods**

- [`use()`](./use) - Start a pipeline (returns the token)
- [`send()` / `sendFiles()`](./send) - Send data to a pipeline
- [`terminate()`](./terminate) - Stop a running pipeline
