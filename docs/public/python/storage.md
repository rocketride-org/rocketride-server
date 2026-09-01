---
title: File Storage
sidebar_position: 6
---

# File Storage

Read, write, and manage files in your account's server-side store. All paths are
**relative** to the store root (e.g. `"docs/readme.md"`); `..` traversal is
rejected client-side, and `fs_rmdir`, `fs_rename`, `fs_get_url`, and
`fs_read_many` additionally reject absolute-like paths (leading `/` or `\`). Method tables in the
[API reference](/clients/python/reference#store-file-access).

## Strings and JSON (start here)

The convenience wrappers manage the handle lifecycle for you:

```python
await client.fs_write_string('notes/todo.txt', 'buy milk')
text = await client.fs_read_string('notes/todo.txt')

await client.fs_write_json('config/app.json', {'debug': True})
cfg = await client.fs_read_json('config/app.json')
```

## Browse and inspect

```python
listing = await client.fs_list_dir('reports')  # {entries: [{name, type, size?, modified?}], count}
for entry in listing['entries']:
    print(entry['name'], entry['type'])

meta = await client.fs_stat('reports/q3.pdf')  # {exists, type, size, modified}
await client.fs_mkdir('reports/2026')
await client.fs_rename('reports/q3.pdf', 'archive/q3.pdf')
await client.fs_delete('archive/q3.pdf')
await client.fs_rmdir('reports/2026', recursive=True)
```

`fs_rename` moves files or directories (copy+delete on object stores, recursive for
directories). `fs_rmdir` raises `ValueError` on empty or absolute-like paths.

## Binary I/O (handles)

For large or binary files, use the explicit handle lifecycle — `fs_open` →
`fs_read`/`fs_write` → `fs_close`, in up-to-4 MB chunks. `fs_close` must receive the
same mode as `fs_open`.

```python
info = await client.fs_open('uploads/video.mp4', 'w')
handle = info['handle']
try:
    with open('video.mp4', 'rb') as f:
        while chunk := f.read(4_194_304):
            await client.fs_write(handle, chunk)
finally:
    await client.fs_close(handle, 'w')
```

Read mode's `fs_open` result also includes `'size'`; an empty `bytes` from
`fs_read` means EOF.

## Batch reads

`fs_read_many(paths)` fetches many small files in **one** round trip (max 256 paths
/ 32 MiB total per call). Missing or unreadable files come back as per-entry results
(`ok: False` + `error`), never a call failure; results arrive in request order with
`data` as `bytes`.

## Direct URLs

`fs_get_url(path, expires_in=3600, download_name=None)` returns a time-limited
HTTP(S) URL for direct browser access. Cloud backends (S3/Azure) return a
presigned/SAS URL; the local filesystem backend returns a JWT-signed `/task/fetch`
URL. Served **inline** by default — right for streaming and `<img>`/`<video>`
sources:

```python
stream_url = await client.fs_get_url('uploads/video.mp4', expires_in=600)
```

Pass `download_name` to force a download with that filename via
`Content-Disposition: attachment` — the only reliable way to set the download
filename for cross-origin cloud URLs (where the browser `<a download>` hint is
ignored):

```python
download_url = await client.fs_get_url('uploads/video.mp4', download_name='my video.mp4')
```
