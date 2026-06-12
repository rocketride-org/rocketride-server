---
title: "Validate"
date: 2025-07-29
---

- [Overview](#overview)
- [Method Signature](#method-signature)
- [Parameters](#parameters)
- [Returns](#returns)
- [Usage Examples](#usage-examples)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

The `validate()` method checks a pipeline configuration for structural correctness before executing it. It verifies component compatibility, connection integrity, and resolves the execution chain. This is useful for catching configuration errors early, before starting a pipeline.

Authentication is **not required** for validation: the endpoint is public.

## **Method Signature**

### Python (async)

```python
result = await client.validate(pipeline, source=None)
```

### TypeScript

```typescript
const result = await client.validate({ pipeline, source? });
```

## **Parameters**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pipeline` | `dict` / `PipelineConfig` | Yes | Pipeline configuration object to validate |
| `source` | `str` / `string` | No | Override for the source component ID |

### Source Resolution

If `source` is not provided, the server resolves it in this order:

1. Explicit `source` parameter (if provided)
2. `source` field inside the pipeline config
3. Implied source: the single component whose `config.mode` is `'Source'`

## **Returns**

- **Type**: `Dict[str, Any]` (Python) / `Record<string, unknown>` (TypeScript)
- **Description**: Validation result containing errors, warnings, the resolved source component, and the execution chain

## **Usage Examples**

### Basic Validation

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    pipeline = {
        'project_id': 'my-project',
        'source': 'webhook_1',
        'components': [
            {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
            {'id': 'processor_1', 'provider': 'ai_chat', 'config': {'model': 'gpt-4'},
             'input': [{'from': 'webhook_1', 'lane': 'output'}]},
            {'id': 'response_1', 'provider': 'response', 'config': {},
             'input': [{'from': 'processor_1', 'lane': 'answer'}]},
        ],
    }

    result = await client.validate(pipeline)
    print('Validation result:', result)
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();

const result = await client.validate({
    pipeline: {
        project_id: 'my-project',
        source: 'webhook_1',
        components: [
            { id: 'webhook_1', provider: 'webhook', config: {} },
            { id: 'processor_1', provider: 'ai_chat', config: { model: 'gpt-4' },
              input: [{ from: 'webhook_1', lane: 'output' }] },
            { id: 'response_1', provider: 'response', config: {},
              input: [{ from: 'processor_1', lane: 'answer' }] },
        ],
    },
});

if (result.errors?.length) {
    console.log('Validation errors:', result.errors);
} else {
    console.log('Pipeline is valid');
}

await client.disconnect();
```

### Validate with Source Override

```python
result = await client.validate(pipeline, source='webhook_1')
```

```typescript
const result = await client.validate({
    pipeline: myPipeline,
    source: 'webhook_1',
});
```

### Validate Before Starting

```python
# Validate first, then start if valid
result = await client.validate(pipeline)

# Check the result for errors before proceeding
# (exact structure depends on pipeline configuration)
task = await client.use(pipeline=pipeline)
```

## **Response Format**

The validation result contains information about the pipeline's structural validity, including any errors and warnings found, the resolved source component, and the execution chain.

```json
{
  "errors": [],
  "warnings": [],
  "resolved": { ... },
  "chain": [ ... ]
}
```

If validation fails (e.g., missing components, invalid connections), the `errors` array will contain descriptive messages.

## **Error Handling**

| Error | Cause |
| --- | --- |
| `RuntimeError` / `Error` | Server returned a validation error (e.g., invalid pipeline structure) |

```python
try:
    result = await client.validate(pipeline)
except RuntimeError as e:
    print(f'Validation failed: {e}')
```

## **API Endpoint**

This method communicates via the RocketRide DAP protocol over WebSocket. The equivalent HTTP endpoint is:

- **Method**: `POST /pipe/validate`
- **Authentication**: Not required (public endpoint)
- **Body**: `{ "pipeline": {...}, "source": "..." }`

## **Related Methods**

- [`use()`](./use) - Start a validated pipeline
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor pipeline status
- [`terminate()`](./terminate) - Stop a running pipeline
