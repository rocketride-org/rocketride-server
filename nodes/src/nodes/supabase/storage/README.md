# storage

The Supabase Storage service: agent tools that list, read, upload and delete files in a Supabase project's storage buckets. Pick it when an agent has to work with files kept in Supabase Storage.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Supabase Storage keeps an app's files in buckets, much like Amazon S3: each bucket is public or private, and files are reached by a path inside the bucket.

## What it does

This service is a tool node only: attach it to an agent and the agent can call the functions below. No data flows through lanes. It talks to the project's Storage API with the project URL and a secret key, which bypasses row-level security, so the **Access level** setting decides which functions may run. Small files come back inline; larger ones come back as a signed download URL, so a large file never fills the agent's context. Nothing is written to the engine's disk.

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. Messages from the node name a function `supabase_storage.<function>`, for example `supabase_storage.download_file`. A call above the node's **Access level** is refused with a message naming the level to set.

| Function | Description |
|---|---|
| `list_buckets` | No arguments. Returns `buckets` (id, name, public, created_at, updated_at, file_size_limit, allowed_mime_types), `count`, and `truncated` (true when there were more buckets than **List limit**). Needs `read`. |
| `list_files` | The files and sub-folders directly inside one folder (not recursive). Arguments: `bucket`, `prefix` (folder, default the bucket root), `limit` (default and maximum: **List limit**, 100 unless changed), `offset` (default 0). Returns `files` (name, path, is_folder, size, content_type, updated_at), `count`, and `more_may_exist` (true when the list is full; call again with a larger `offset`). Needs `read`. |
| `download_file` | Reads one file. Arguments: `bucket`, `path`, `as` (`text`, the default, or `base64`). Up to **Inline download limit** (256 KB unless changed) returns `{"inline": true, "encoding", "content", "size", "content_type"}`. A larger file returns `{"inline": false, "signed_url", "expires_in", "size", "message"}` and no content. `as: text` fails for a file that is not UTF-8. Needs `read`. |
| `create_signed_url` | A temporary download link. Arguments: `bucket`, `path`, `expires_in` (seconds, 60 to 604800; default **Signed URL lifetime**, 3600 unless changed; values outside the range are moved into it). Returns `signed_url` and `expires_in`. Needs `read`. |
| `upload_file` | Uploads one file. Arguments: `bucket`, `path`, `content`, `encoding` (`text`, the default, or `base64`), `content_type` (optional, guessed from the path), `upsert` (optional, default false: fails if the file exists; true replaces it). Content above **Upload limit** (10 MB unless changed) is refused before anything is sent. Returns bucket, path, size, content_type, upsert. Needs `write`. |
| `create_bucket` | Arguments: `name`, `public` (optional, default false). Returns name and public. Needs `admin`. |
| `delete_file` | Deletes files permanently. Arguments: `bucket`, `paths` (list, at most 1000). Returns `deleted` and `not_found` (paths that did not exist). Folders are not deleted recursively. Needs `admin`. |

Paths are relative to the bucket, for example `reports/2026/q1.csv`. A path with a leading `/`, a backslash, an empty, `.` or `..` segment, or a control character is refused before any call. A signed URL lets anyone who holds it download the file until it expires.

## Configuration

Paste the **Project URL** and a **Secret key**, then set **Access level** to the lowest level the agent needs. The four limits have safe defaults; most users can leave them alone.

### Access level

`read` (the default) allows `list_buckets`, `list_files`, `download_file` and `create_signed_url`. `write` adds `upload_file`; with `upsert: true` it replaces an existing file, so `write` can overwrite any file's content. `admin` adds `create_bucket` and `delete_file`. The secret key bypasses bucket policies, so this setting is the only guard on what the agent may change.

### Inline download limit (KB)

The largest file `download_file` returns as content (1 to 4096 KB, default 256). The limit is on the file size; base64 output is about a third longer. Above it the agent gets a signed URL instead, valid for **Signed URL lifetime**. Raise it only if the agent really needs to read larger files itself: every KB costs context tokens.

### Upload limit (MB)

The largest content `upload_file` accepts (1 to 50 MB, default 10). Checked before anything is sent. The bucket's own file size limit in Supabase still applies.

### List limit

The most entries one `list_files` or `list_buckets` call returns (1 to 1000, default 100).

### Signed URL lifetime (seconds)

How long the signed URL from `download_file` stays valid (60 to 604800, default 3600), and the default `expires_in` of `create_signed_url`.

## Authentication

Needs the project URL (`https://<project-ref>.supabase.co`) and a secret key (starts with `sb_secret_`) from Project Settings -> API Keys. Publishable and anon keys are refused at start-up. A blank URL or key stops the node at start-up with a message naming the field.

## Notes

### Reading a whole bucket in a pipeline

This service lets an agent pick files; it does not feed a whole bucket into a pipeline, and there is no Supabase source for that in this release. What is known about the general **Object Storage** source (`objstore`) with Supabase's S3 endpoint, none of it tested:

- Endpoint (its **URL** field): `https://<project-ref>.storage.supabase.co/storage/v1/s3`.
- Keys: an S3 access key ID and secret access key, made in the dashboard under Storage settings (S3 access keys). They are not the project's secret key, and they bypass row-level security.
- Region: that source's settings panel has no region field, and the source signs every request for `us-east-1` when no region is given, so only projects in `us-east-1` are expected to work.

### How download_file decides

It asks Storage for the file size first. If the size is above the inline limit, it returns a signed URL without downloading the file. Otherwise it reads the file through one capped, streamed request that stops after the inline limit plus one byte, whatever the reported size was (it can be missing, or stale when the file was replaced). A longer file gets the signed URL (with `size` from the download's `Content-Length`, or `null` when there is none or the body was compressed), so a large file is never loaded into memory.

## Upstream docs

- [Supabase Storage](https://supabase.com/docs/guides/storage)
- [Storage (Python reference)](https://supabase.com/docs/reference/python/storage-createbucket)
- [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
