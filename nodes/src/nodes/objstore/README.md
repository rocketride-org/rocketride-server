# objstore

A RocketRide source and target endpoint for S3 buckets: Amazon S3 itself, or any S3-compatible object store such as MinIO.

## What it does

The node scans objects in one or more buckets and feeds them into the pipeline
on the `tags` lane, and can export, download, or delete objects as a target.
It registers two services backed by the same implementation: `aws` for Amazon
S3, addressed by region, and `objstore` for S3-compatible stores, addressed by
endpoint URL. Pick `objstore` for anything that is not Amazon S3.

## Lanes

| Input | Output | Description |
| ----- | ------ | ----------- |
| `_source` | `tags` | Emits the scanned objects to be processed. |

## Configuration

Both services take an access key and secret key, and paths in the form
`bucket/folder/*` for include and exclude. The first path component is always
the bucket.

### aws

Set the region the buckets live in. The endpoint is derived from it, so no URL
is needed.

### objstore

Set the store's endpoint URL, e.g. `localhost:9000` for a local MinIO.
`useSSL` defaults to true; set it to false for a plain HTTP endpoint.

## Notes

### One library, two services

Both services name the same `objstore` library, which the engine loads once,
on the first lookup of either. That load registers both services' factories
and initializes the AWS SDK, which is shut down again when the engine unloads
its nodes.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
