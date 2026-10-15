# azure

A RocketRide source and target endpoint for Azure Blob Storage containers.

## What it does

The node scans blobs in one or more containers of a storage account and feeds
them into the pipeline on the `tags` lane, and can export, download or delete
blobs as a target. It is marked internal, so it is not offered on the canvas and
is reached through task or pipeline configuration only.

## Lanes

| Input | Output | Description |
| ----- | ------ | ----------- |
| `_source` | `tags` | Emits the scanned blobs to be processed. |

## Configuration

The account is addressed by name and shared key, and paths take the form
`container/folder/*`. The first path component is always the container, and a
wildcard there scans every container in the account.

### Endpoint suffix

Defaults to `blob.core.windows.net`, which the account name is prefixed to.
Change it for a sovereign or government cloud whose accounts live under a
different host.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
