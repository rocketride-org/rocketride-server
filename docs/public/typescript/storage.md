---
title: File Storage
sidebar_position: 6
---

# File Storage

Read, write, and manage files in your account's server-side store. All paths are
**relative** to the store root (e.g. `'docs/readme.md'`); absolute-like paths
(starting with `/` or `\`) are rejected. Method tables in the
[API reference](/clients/typescript/reference#store-file-access).

## Strings and JSON (start here)

The convenience wrappers manage the handle lifecycle for you:

```typescript
await client.fsWriteString('notes/todo.txt', 'buy milk');
const text = await client.fsReadString('notes/todo.txt');

await client.fsWriteJson('config/app.json', { debug: true });
const cfg = await client.fsReadJson<{ debug: boolean }>('config/app.json');
```

## Browse and inspect

```typescript
const { entries } = await client.fsListDir('reports'); // { entries: [{name, type, size?, modified?}], count }
for (const e of entries) console.log(e.name, e.type);

const meta = await client.fsStat('reports/q3.pdf'); // { exists, type?, size?, modified? }
await client.fsMkdir('reports/2026');
await client.fsRename('reports/q3.pdf', 'archive/q3.pdf');
await client.fsDelete('archive/q3.pdf');
await client.fsRmdir('reports/2026', true);
```

`fsRename` moves files or directories (copy+delete on object stores, recursive for
directories).

## Binary I/O (handles)

For large or binary files, use the explicit handle lifecycle — `fsOpen` →
`fsRead`/`fsWrite` → `fsClose`, in up-to-4 MB chunks. `fsClose` must receive the
same mode as `fsOpen`.

```typescript
const { handle } = await client.fsOpen('uploads/video.mp4', 'w');
try {
	const chunkSize = 4 * 1024 * 1024;
	for (let offset = 0; offset < file.size; offset += chunkSize) {
		const chunk = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
		await client.fsWrite(handle, chunk);
	}
} finally {
	await client.fsClose(handle, 'w');
}
```

Read mode's `fsOpen` result also includes `size`; an empty array from `fsRead`
means EOF.

## Batch reads

`fsReadMany(paths)` fetches many small files in **one** round trip (max 256 paths /
32 MiB total per call). Missing or unreadable files come back as per-entry results
(`ok: false` + `error`), never a call failure; results arrive in request order with
`data` as `Uint8Array`.

## Direct URLs

`fsGetUrl(path, expiresIn?, downloadName?)` returns a time-limited HTTP(S) URL for
direct browser access (`expiresIn` in seconds, default 3600). Cloud backends
(S3/Azure) return a presigned/SAS URL; the local filesystem backend returns a
JWT-signed `/task/fetch` URL. Served **inline** by default — right for
`<img>`/`<video>`/`<audio>` sources:

```typescript
const streamUrl = await client.fsGetUrl('uploads/video.mp4', 600);
```

Pass `downloadName` to force a download with that filename via
`Content-Disposition: attachment` — the only reliable way to set the download
filename for cross-origin cloud URLs (where the `<a download>` attribute is
ignored):

```typescript
const downloadUrl = await client.fsGetUrl('uploads/video.mp4', undefined, 'my video.mp4');
```
