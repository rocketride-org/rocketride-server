---
title: Sending Data
sidebar_position: 5
---

# Sending Data

Get data into a running pipeline: one-shot sends, file uploads with progress, and
chunked streaming. Method tables in the
[API reference](/clients/python/reference#data).

`send()` / `send_files()` / `pipe()` target pipelines whose **source** is `webhook`
or `dropper`. If your pipeline source is `chat`, use
[`client.chat()`](/clients/python/chat) instead.

## One-shot: `send()`

Use when you have the full payload in memory. It opens a pipe, writes once, closes,
and returns the pipeline result:

```python
result = await client.send(token, 'Hello, pipeline!', objinfo={'name': 'greeting.txt'}, mimetype='text/plain')
```

If `mimetype` is omitted the payload is sent as `application/octet-stream` — there
is no auto-detection. An optional `on_sse` callback receives server-sent events for
the transfer.

## Files: `send_files()`

Uploads a list of files concurrently (all at once via `asyncio.gather`) and returns
one `UPLOAD_RESULT` per file. Each entry is a path `str`, a `(path, objinfo)` tuple,
or a `(path, objinfo, mimetype)` tuple:

```python
files = ['doc1.md', 'doc2.md', ('doc3.json', {'tag': 'export'}, 'application/json')]
upload_results = await client.send_files(files, token)
for r in upload_results:
    if r['action'] == 'complete':
        print('OK', r['filepath'])
    else:
        print('Failed', r['filepath'], r.get('error'))
```

Two things to know:

- `send_files` **requires an API key** on the client (it raises `RuntimeError`
  without one).
- A missing file raises `ValueError` (`'File not found: …'`).

Watch progress by subscribing to `apaevt_status_upload` events
([Events](/clients/python/pipelines#events)) — bodies carry `filepath`,
`bytes_sent`, `file_size`.

## Streaming: `pipe()`

Use `pipe()` when data arrives incrementally or is too large to hold in memory. One
streaming upload is **open → write (one or more) → close**; `close()` returns the
processing result. The pipe reads files best in ~1 MB chunks and enforces `bytes`
payloads.

```python
pipe = await client.pipe(token, objinfo={'name': 'large.csv'}, mime_type='text/csv')
await pipe.open()
with open('large.csv', 'rb') as f:
    while True:
        chunk = f.read(64 * 1024)
        if not chunk:
            break
        await pipe.write(chunk)
result = await pipe.close()
```

`DataPipe` is also an async context manager — entering calls `open()`, exiting calls
`close()`:

```python
async with await client.pipe(token, mime_type='application/json') as pipe:
    await pipe.write(b'{"key": "value1"}')
    await pipe.write(b'{"key": "value2"}')
```

Properties: `is_opened` and `pipe_id` (server-assigned after `open()`). `pipe()` and
the pipe itself accept an `on_sse` callback for server-sent events, and
`DataPipe.tool()` invokes a pipeline tool function through the pipe — see the
[reference](/clients/python/reference#datapipe).

## Choosing

| You have | Use |
| --- | --- |
| A string or bytes in memory | `send()` |
| Files on disk, want per-file results + progress events | `send_files()` |
| Chunked/incremental data, or very large payloads | `pipe()` |
| A chat-source pipeline | [`chat()`](/clients/python/chat) |
