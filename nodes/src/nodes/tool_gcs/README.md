# tool_gcs

A RocketRide tool node that gives an agent read access to a Google Cloud
Storage bucket. Pick it when an agent needs to discover object names in a
bucket and pull one down to the engine host for further processing.

## About Google Cloud Storage

Google Cloud Storage is Google Cloud's object storage service. Data is kept as
objects inside buckets, addressed by a key that usually reads like a directory
path, and access is governed by Google Cloud IAM. It is commonly used for data
lakes, backups, media, and as the staging area between systems in a cloud
pipeline.

## What it does

The node has no data lanes and no control-plane connections; it exists purely
as an agent tool. It exposes two read-only operations against one configured
bucket: listing object names and downloading a single object to a temporary
file on the engine host. Pick it over a generic HTTP client when the agent
should stay scoped to one bucket — and optionally one prefix within it — with
credentials and a download size cap held by the node rather than by the agent.
It reads objects only; it cannot upload, delete, or otherwise modify a bucket.

## As a tool

The server-name prefix is `gcs`, producing these registered functions.

| Function | Description |
|---|---|
| `gcs.list_files` | List object names in the configured bucket. |
| `gcs.download_file` | Download one object to a temporary file on the engine host and return its local path. |

`list_files` takes no required arguments. Optional `prefix` narrows the listing
and is appended to the node's configured **Path Prefix**; optional
`max_results` caps the number of names returned and defaults to 10. It returns
a list of object names. On failure it returns a single-element list whose entry
is an error string rather than raising.

`download_file` requires `file_name`, the object's name or path inside the
bucket, which is likewise resolved beneath the configured **Path Prefix**. On
success it returns `success`, `local_path` (the temporary file on the engine
host), and `size` in bytes. Every failure — client not connected, bucket not
configured, object over the size cap, or any GCS error — comes back as a
dictionary with a single `error` key, so an agent should check for `error`
before reading `local_path`.

Only the most recent download is retained: starting a new download deletes the
previous temporary file, and anything left is removed when the node shuts down.
An agent that needs a downloaded file must consume it before requesting the
next one.

## Configuration

Set the bucket the node is allowed to touch and how it authenticates; the rest
has working defaults. **Bucket Name** is what makes the tool functions usable —
without it both functions return a "Bucket name not configured" error. The node
verifies its credentials and fetches the bucket at startup, so a bad key, a
missing bucket, or insufficient permission fails the pipeline immediately
rather than at the agent's first call.

### Bucket Name

The name of the single Google Cloud Storage bucket this node reads. It is not
an argument the agent can supply, so one node instance means one bucket;
connect a second `tool_gcs` node to expose a second bucket to the same agent.

### Path Prefix

An optional path inside the bucket that scopes every operation. When set, the
node normalizes it to end with `/` before use, so `reports` matches objects
under `reports/` and not a sibling key such as `reports-archive/2024.csv`.
Object names the agent passes are resolved beneath it: with a prefix of
`reports`, `download_file` called with `q1.csv` reads `reports/q1.csv`, and a
`prefix` argument to `list_files` is appended rather than replacing it. Leave
it blank to expose the whole bucket. Note that this scopes what the tool
functions address, not what the credentials are permitted to read — use IAM for
an enforced boundary.

### Max Download Bytes

The ceiling, in bytes, on a single `download_file` call; the default is
52,428,800 (50 MiB). The node checks the object's reported size before
downloading and re-checks the file's actual size afterwards, in case the object
changed in between, so an oversized object cannot land on disk. Both checks
return an `error` naming the object's size and the configured limit. Raise it
when the agent legitimately needs larger objects and the engine host has the
disk for them; lower it to keep an agent from consuming host disk on a bucket
of large files.

## Authentication

The node uses the shared RocketRide Google Cloud credentials fields and
requests the read-only Cloud Storage scope
(`https://www.googleapis.com/auth/devstorage.read_only`). Two authentication
types are available:

- **Application Default Credentials** (the default) — no key is configured and
  credentials are discovered from the environment. Use this when the engine
  runs on Google Cloud with an attached service account, or where `gcloud`
  application-default credentials are already present.
- **Service Account JSON** — upload the service account's JSON key file. The
  key is a secret; the field is stored as an uploaded file.

**Project ID** is optional in both modes. Left blank, it is taken from the
service account key or from the ambient credentials. The identity needs
permission to read the configured bucket and to list its objects; the startup
bucket check will fail otherwise.

## Limitations

The node declares the `noremote` capability, so it runs on the local engine
host and is not available for remote execution. That host needs network access
to Google Cloud Storage and enough disk for the largest download **Max Download
Bytes** allows. Downloaded objects are written to the engine host's temporary
directory and are only reachable by whatever runs there — the tool returns a
local path, not a URL. Access is read-only: there is no write, upload, or
delete path in this node.

## Upstream docs

- [Google Cloud Storage documentation](https://cloud.google.com/storage/docs)
- [`google-cloud-storage` Python client](https://cloud.google.com/python/docs/reference/storage/latest)
- [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `gcs.bucketName` | `string` | **Bucket Name**<br/>The Google Cloud Storage bucket name. |  |
| `gcs.maxDownloadBytes` | `integer` | **Max Download Bytes**<br/>Reject downloads larger than this many bytes (default 50 MiB). Protects server disk from oversized objects. | `52428800` |
| `gcs.prefix` | `string` | **Path Prefix**<br/>Optional path prefix inside the bucket. |  |
| `gcs.profile` | `string` |  | `"default"` |

## Dependencies

- `google-auth` `>=2.23.3`
- `google-cloud-storage` `>=2.13.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_gcs)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
