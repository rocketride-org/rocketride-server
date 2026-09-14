---
title: Sending Data
sidebar_position: 5
---

# Sending Data

Get data into a running pipeline: one-shot sends, concurrent file uploads with
progress, and chunked streaming. Method tables in the
[API reference](/clients/typescript/reference#data).

`send()` / `sendFiles()` / `pipe()` target pipelines whose **source** is `webhook`
or `dropper`. If your pipeline source is `chat`, use
[`client.chat()`](/clients/typescript/chat) instead.

## One-shot: `send()`

Use when you have the full payload in memory. It opens a pipe, writes once, closes,
and resolves to the pipeline result:

```typescript
const result = await client.send(token, 'Hello, pipeline!', { name: 'greeting.txt' }, 'text/plain');
```

If the MIME type is omitted the payload is sent as `application/octet-stream` —
there is no auto-detection. An optional `onSSE` callback receives server-sent
events for the transfer.

## Files: `sendFiles()`

Uploads browser `File` objects through a worker pool capped at `maxConcurrent`
(default 5, validated positive integer). Results resolve in the same order as
`files`:

```typescript
const files = [new File([content1], 'a.md'), new File([content2], 'b.md')];
const uploadResults = await client.sendFiles(
	files.map((file) => ({ file })),
	token
);
console.log('Uploaded:', uploadResults.filter((r) => r.action === 'complete').length);
```

Each entry is `{ file, objinfo?, mimetype? }`. Watch progress by subscribing to
`apaevt_status_upload` events ([Events](/clients/typescript/pipelines#events))
— bodies carry `filepath`, `bytes_sent`, `file_size`.

## Streaming: `pipe()`

Use `pipe()` when data arrives incrementally or is too large to hold in memory. One
streaming upload is **open → write (one or more) → close**; `close()` resolves to
the processing result and is a no-op if already closed. Writes take `Uint8Array`
chunks.

```typescript
const pipe = await client.pipe(token, { name: 'large.csv' }, 'text/csv');
await pipe.open();
const rl = createInterface({ input: createReadStream('large.csv') });
for await (const line of rl) {
	await pipe.write(new TextEncoder().encode(line + '\n'));
}
const result = await pipe.close();
```

Getters: `isOpened` and `pipeId` (server-assigned after `open()`). `pipe()` and the
pipe itself accept an `onSSE` callback for server-sent events, and
`DataPipe.tool()` invokes a pipeline tool function through the pipe — see the
[reference](/clients/typescript/reference#datapipe).

## Choosing

| You have | Use |
| --- | --- |
| A string or `Uint8Array` in memory | `send()` |
| Browser `File` objects, want per-file results + progress events | `sendFiles()` |
| Chunked/incremental data, or very large payloads | `pipe()` |
| A chat-source pipeline | [`chat()`](/clients/typescript/chat) |
