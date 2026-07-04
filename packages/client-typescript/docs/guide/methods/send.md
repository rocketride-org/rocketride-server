---
title: "Send / Send Files / Pipe"
date: 2025-07-29
---

- [Overview](#overview)
- [send()](#send)
- [send_files() / sendFiles()](#send_files--sendfiles)
- [pipe() / DataPipe](#pipe--datapipe)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [API Endpoint](#api-endpoint)
- [Related Methods](#related-methods)

## **Overview**

RocketRide provides three methods for sending data to a running pipeline:

| Method | Use Case |
| --- | --- |
| `send()` | Send a single piece of text or binary data |
| `send_files()` / `sendFiles()` | Upload one or more files with progress tracking |
| `pipe()` / `DataPipe` | Stream large datasets in chunks |

All three methods require a **token** from a previously started pipeline (via `use()`).

---

## **send()**

Send text or binary data to a running pipeline and get the processing result.

### Method Signature

**Python (async):**
```python
result = await client.send(token, data, objinfo=None, mimetype=None)
```

**TypeScript:**

```typescript
const result = await client.send(token, data, objinfo?, mimetype?);
```

### Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `str` / `string` | Yes | Pipeline task token from `use()` |
| `data` | `str \| bytes` / `string \| Uint8Array` | Yes | Data to send for processing |
| `objinfo` | `dict` / `Record<string, unknown>` | No | Metadata about the data (e.g., `{"name": "data.txt"}`) |
| `mimetype` | `str` / `string` | No | MIME type of the data (auto-detected if not specified) |

### Returns

- **Type**: `PIPELINE_RESULT`, dictionary containing the pipeline's processing output

### Examples

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    result = await client.use(filepath='text_analyzer.json')
    token = result['token']

    # Send text data
    response = await client.send(token, 'Analyze this text for sentiment')
    print(response)

    # Send JSON data
    import json
    response = await client.send(
        token,
        json.dumps({'name': 'John', 'age': 30}),
        mimetype='application/json',
    )

    # Send binary data
    with open('data.bin', 'rb') as f:
        response = await client.send(token, f.read(), mimetype='application/octet-stream')
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();

const result = await client.use({ filepath: './text_analyzer.json' });

// Send string data
const response = await client.send(result.token, 'Analyze this text');

// Send binary data
const encoder = new TextEncoder();
const buffer = encoder.encode('Binary data');
const response2 = await client.send(result.token, buffer, { name: 'data.txt' });

await client.disconnect();
```

---

## **send_files() / sendFiles()**

Upload multiple files to a pipeline with parallel transfers and progress tracking.

### Method Signature

**Python (async):**
```python
results = await client.send_files(files, token)
```

**TypeScript:**

```typescript
const results = await client.sendFiles(files, token);
```

### Parameters

**Python:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `files` | `list` | Yes | List of file paths or tuples (see formats below) |
| `token` | `str` | Yes | Pipeline task token |

Each file entry can be:
- `"path/to/file.pdf"`: just a file path
- `("path/to/file.pdf", {"category": "doc"})`: file path with metadata
- `("path/to/file.pdf", {"name": "doc"}, "application/pdf")`: file path with metadata and MIME type

**TypeScript:**

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `files` | `Array<{ file: File, objinfo?, mimetype? }>` | Yes | Array of File objects with optional metadata |
| `token` | `string` | Yes | Pipeline task token |

### Returns

- **Type**: `UPLOAD_RESULT[]`, array of upload results, one per file

Each result contains:

| Field | Type | Description |
| --- | --- | --- |
| `action` | `str` | `'complete'` or `'error'` |
| `filepath` | `str` | File path/name |
| `bytes_sent` | `int` | Bytes transferred |
| `file_size` | `int` | Total file size |
| `upload_time` | `float` | Upload duration in seconds |
| `result` | `dict` | Pipeline processing result (if successful) |
| `error` | `str` | Error message (if failed) |

### Examples

```python
from rocketride import RocketRideClient

async with RocketRideClient(auth='your-api-key') as client:
    result = await client.use(filepath='document_processor.json')
    token = result['token']

    # Simple file list
    files = ['document1.pdf', 'data.csv', 'report.docx']
    results = await client.send_files(files, token)

    for r in results:
        if r['action'] == 'complete':
            print(f"Uploaded {r['filepath']} in {r['upload_time']:.2f}s")
        else:
            print(f"Failed {r['filepath']}: {r['error']}")

    # With metadata and MIME types
    files = [
        ('report.pdf', {'department': 'finance'}),
        ('data.csv', {'type': 'quarterly'}, 'text/csv'),
    ]
    results = await client.send_files(files, token)
```

```typescript
const files = [
    { file: fileObject1, mimetype: 'application/pdf' },
    { file: fileObject2, objinfo: { department: 'finance' } },
];
const results = await client.sendFiles(files, result.token);
```

### Progress Events

If you configure an event handler, you'll receive upload progress events:

```python
async def handle_events(event):
    if event['event'] == 'apaevt_status_upload':
        body = event['body']
        if body['action'] == 'write':
            pct = (body['bytes_sent'] / body['file_size']) * 100
            print(f"{body['filepath']}: {pct:.1f}%")

client = RocketRideClient(auth='your-api-key', on_event=handle_events)
```

---

## **pipe() / DataPipe**

Create a streaming data pipe for sending large datasets in chunks.

### Method Signature

**Python (async):**
```python
pipe = await client.pipe(token, objinfo=None, mime_type=None, provider=None)
```

**TypeScript:**

```typescript
const pipe = await client.pipe(token, objinfo?, mimeType?, provider?);
```

### Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `str` / `string` | Yes | Pipeline task token |
| `objinfo` | `dict` / `Record<string, unknown>` | No | Metadata about the data |
| `mime_type` / `mimeType` | `str` / `string` | No | MIME type of the data |
| `provider` | `str` / `string` | No | Optional provider specification |

### DataPipe Methods

| Method | Description |
| --- | --- |
| `open()` | Open the pipe for writing (must call before `write()`) |
| `write(buffer)` | Write a chunk of data (`bytes` in Python, `Uint8Array` in TypeScript) |
| `close()` | Close the pipe and get processing results |

### Examples

**Using context manager (Python, recommended):**

```python
async with await client.pipe(token, mime_type='text/csv') as pipe:
    for chunk in csv_chunks:
        await pipe.write(chunk.encode())
    result = await pipe.close()
```

**Manual open/write/close:**

```python
pipe = await client.pipe(token, mime_type='application/json')
await pipe.open()
await pipe.write(json.dumps(data_part1).encode())
await pipe.write(json.dumps(data_part2).encode())
result = await pipe.close()
```

```typescript
const pipe = await client.pipe(token, {}, 'text/csv');
await pipe.open();
await pipe.write(new TextEncoder().encode('header1,header2\n'));
await pipe.write(new TextEncoder().encode('value1,value2\n'));
const result = await pipe.close();
```

---

## **Response Format**

Both `send()` and `DataPipe.close()` return a `PIPELINE_RESULT`: the output from the pipeline's processing. The exact structure depends on your pipeline configuration, but it typically includes fields like:

```json
{
  "name": "document.pdf",
  "path": "/processed/document.pdf",
  "objectId": "obj-12345",
  "result_types": ["text", "metadata"],
  "text": ["Extracted text content..."],
  "metadata": { ... }
}
```

## **Error Handling**

| Error | Cause |
| --- | --- |
| `ValueError` / `Error` | Invalid data type (not string/bytes) |
| `RuntimeError` / `Error` | Pipeline not running, send failed, or pipe operation failed |
| `FileNotFoundError` | File path in `send_files()` doesn't exist |

```python
try:
    result = await client.send(token, data)
except RuntimeError as e:
    print(f'Send failed: {e}')
```

## **API Endpoint**

These methods communicate via the RocketRide DAP protocol over WebSocket. The equivalent HTTP endpoint for data operations is:

- **Method**: `POST /task/data`
- **Query Parameters**: `token={token}`

The `/webhook` path is also available as an alias for `POST /task/data`.

## **Related Methods**

- [`use()`](./use) - Start a pipeline (returns the token needed here)
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Monitor pipeline status
- [`terminate()`](./terminate) - Stop a running pipeline
