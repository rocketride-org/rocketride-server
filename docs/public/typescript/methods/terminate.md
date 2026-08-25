---
title: "Terminate"
date: 2025-07-29
---

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Returns](#returns)
- [Usage Examples](#usage-examples)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

The `terminate()` method stops a running pipeline. This is a graceful termination: the pipeline will complete any item currently being processed but will not accept new data. After termination, the pipeline cannot be restarted; you must start a new one with `use()`.

## **Method Signature**

### Python (async)

```python
await client.terminate(token)
```

### TypeScript

```typescript
await client.terminate(token);
```

## **Parameters**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `str` / `string` | Yes | Task token of the pipeline to terminate (from `use()`) |

## **Returns**

- **Type**: `None` (Python) / `Promise<void>` (TypeScript)
- **Description**: No return value. The method completes when the termination request is accepted.

## **Usage Examples**

### Basic Termination

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    result = await client.use(filepath='pipeline.json')
    token = result['token']

    # Send some data
    await client.send(token, 'Process this text')

    # Terminate the pipeline
    await client.terminate(token)
    print('Pipeline terminated successfully')
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();

const result = await client.use({ filepath: './pipeline.json' });

// Send some data
await client.send(result.token, 'Process this text');

// Terminate the pipeline
await client.terminate(result.token);
console.log('Pipeline terminated successfully');

await client.disconnect();
```

### Terminate with Error Handling

```python
try:
    await client.terminate(token)
    print('Pipeline terminated successfully')
except RuntimeError as e:
    print(f'Failed to terminate pipeline: {e}')
```

### Terminate After Monitoring

```python
import asyncio

result = await client.use(filepath='long_processor.json')
token = result['token']

# Monitor for a while, then terminate
await asyncio.sleep(30)

status = await client.get_task_status(token)
if not status['completed']:
    await client.terminate(token)
    print('Pipeline was still running — terminated')
else:
    print('Pipeline already completed')
```

## **Error Handling**

| Error | Cause |
| --- | --- |
| `RuntimeError` / `Error` | Termination failed (e.g., invalid token, pipeline already terminated) |
| Authentication error | Invalid or missing API key |

```python
try:
    await client.terminate(token)
except RuntimeError as e:
    print(f'Termination failed: {e}')
```

## **API Endpoint**

This method communicates via the RocketRide DAP protocol over WebSocket. The equivalent HTTP endpoint is:

- **Method**: `DELETE /task`
- **Query Parameters**: `token={token}`

## **Related Methods**

- [`use()`](./use) - Start a pipeline (returns the token)
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Check if the pipeline is still running
- [`send()` / `sendFiles()`](./send) - Send data to a pipeline
