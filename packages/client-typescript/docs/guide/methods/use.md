---
title: "Use"
date: 2025-07-29
---

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Returns](#returns)
- [Usage Examples](#usage-examples)
- [Pipeline Configuration Structure](#pipeline-configuration-structure)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

The `use()` method starts a RocketRide pipeline for processing data. Pipelines define how data is processed: they can analyze text, extract information, perform AI operations, transform data formats, and more. You can start pipelines from JSON configuration files or from pipeline configuration objects.

The method returns a **token** that you use for all subsequent operations on that pipeline (sending data, checking status, terminating).

## **Method Signature**

### Python (async)

```python
result = await client.use(
    filepath="pipeline.json",   # or pipeline={...}
    token=None,
    source=None,
    threads=None,
    use_existing=None,
    args=None,
    ttl=None,
    pipelineTraceLevel=None,
)
```

### TypeScript

```typescript
const result = await client.use({
    filepath: './pipeline.json',  // or pipeline: {...}
    token: undefined,
    source: undefined,
    threads: undefined,
    useExisting: undefined,
    args: undefined,
    ttl: undefined,
    pipelineTraceLevel: undefined,
});
```

## **Parameters**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pipeline` | `dict` / `PipelineConfig` | One of `pipeline` or `filepath` required | Pipeline configuration object |
| `filepath` | `str` / `string` | One of `pipeline` or `filepath` required | Path to a JSON or JSON5 pipeline configuration file |
| `token` | `str` / `string` | No | Custom task token (server generates one if not provided) |
| `source` | `str` / `string` | No | Override the source component specified in the pipeline config |
| `threads` | `int` / `number` | No | Number of processing threads (server decides default) |
| `use_existing` / `useExisting` | `bool` / `boolean` | No | Reuse an existing pipeline with the same token |
| `args` | `list[str]` / `string[]` | No | Command-line style arguments to pass to the pipeline |
| `ttl` | `int` / `number` | No | Time-to-live in seconds for idle pipelines (0 = no timeout) |
| `pipelineTraceLevel` | `str` / `string` | No | Trace level: `'none'`, `'metadata'`, `'summary'`, or `'full'` |

## **Returns**

- **Type**: `Dict[str, Any]` (Python) / `Record<string, unknown> & { token: string }` (TypeScript)
- **Description**: Object containing the task `token` and other pipeline startup metadata

The returned `token` is required for all subsequent operations: sending data, checking status, and terminating the pipeline.

## **Usage Examples**

### Start a Pipeline from a File

```python
from rocketride import RocketRideClient

async with RocketRideClient(uri='https://cloud.rocketride.ai', auth='your-api-key') as client:
    result = await client.use(filepath='text_analyzer.json')
    token = result['token']
    print(f'Pipeline started with token: {token}')
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
    auth: 'your-api-key',
    uri: 'https://cloud.rocketride.ai',
});
await client.connect();

const result = await client.use({ filepath: './text_analyzer.json' });
console.log(`Pipeline started with token: ${result.token}`);

await client.disconnect();
```

### Start with Custom Parameters

```python
result = await client.use(
    filepath='data_processor.json',
    threads=8,
    args=['--verbose'],
    source='custom_input',
    ttl=300,
)
token = result['token']
```

```typescript
const result = await client.use({
    filepath: './data_processor.json',
    threads: 8,
    args: ['--verbose'],
    source: 'custom_input',
    ttl: 300,
});
```

### Start from a Pipeline Configuration Object

```python
config = {
    'name': 'My Pipeline',
    'project_id': 'my-project',
    'source': 'webhook_1',
    'components': [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
        {'id': 'llm_1', 'provider': 'llm_openai', 'config': {'model': 'gpt-4'},
         'input': [{'from': 'webhook_1', 'lane': 'output'}]},
        {'id': 'response_1', 'provider': 'response', 'config': {},
         'input': [{'from': 'llm_1', 'lane': 'answer'}]},
    ],
}
result = await client.use(pipeline=config)
```

### Full Workflow: Start, Send Data, Check Status

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    # Start pipeline
    result = await client.use(filepath='pipeline.json')
    token = result['token']

    # Send data for processing
    response = await client.send(token, 'Analyze this text for sentiment')

    # Check status
    status = await client.get_task_status(token)
    print(f'State: {status["state"]}')

    # Terminate when done
    await client.terminate(token)
```

## **Pipeline Configuration Structure**

Pipeline configuration files define the processing workflow:

```json
{
  "name": "Pipeline Name",
  "description": "What this pipeline does",
  "project_id": "project-identifier",
  "source": "entry_component_id",
  "components": [
    {
      "id": "webhook_1",
      "provider": "webhook",
      "config": {}
    },
    {
      "id": "processor_1",
      "provider": "llm_openai",
      "config": { "model": "gpt-4" },
      "input": [{ "from": "webhook_1", "lane": "output" }]
    },
    {
      "id": "response_1",
      "provider": "response",
      "config": {},
      "input": [{ "from": "processor_1", "lane": "answer" }]
    }
  ]
}
```

### Environment Variable Substitution

The SDK automatically substitutes `${ROCKETRIDE_*}` patterns in pipeline configs with values from your `.env` file:

```json
{
  "project_id": "${ROCKETRIDE_PROJECT_ID}",
  "components": [
    {
      "id": "processor",
      "provider": "transform",
      "config": {
        "apiKey": "${ROCKETRIDE_APIKEY}"
      }
    }
  ]
}
```

## **Response Format**

### Successful Response

```json
{
  "status": "OK",
  "data": {
    "token": "${TASK_TOKEN}"
  }
}
```

The SDK returns the `body` of this response directly, so `result['token']` gives you the task token.

## **Error Handling**

| Error | Cause |
| --- | --- |
| `ValueError` / `Error` | Neither `filepath` nor `pipeline` was provided |
| `FileNotFoundError` | Pipeline config file not found at the given path |
| `json.JSONDecodeError` | Invalid JSON in the pipeline config file |
| `RuntimeError` / `Error` | Pipeline execution failed to start (check error message for details) |
| Authentication error | Invalid or missing API key |

```python
from rocketride import RocketRideClient, RocketRideException

try:
    result = await client.use(filepath='pipeline.json')
except FileNotFoundError:
    print('Pipeline file not found')
except RuntimeError as e:
    print(f'Pipeline failed to start: {e}')
```

## **API Endpoint**

This method communicates via the RocketRide DAP (Debug Adapter Protocol) over WebSocket. The equivalent HTTP endpoint is:

- **Method**: `POST /task`
- **Body**: Pipeline configuration with API key and parameters

## **Related Methods**

- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor pipeline status
- [`send()` / `sendFiles()`](./send) - Send data to a running pipeline
- [`terminate()`](./terminate) - Stop a running pipeline
- [`validate()`](./validate) - Validate pipeline configuration before starting
