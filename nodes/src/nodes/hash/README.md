# hash

A RocketRide filter that fingerprints each document's content as it passes
through the pipeline, for deduplication and identity checks before indexing.

## What it does

Generates a deterministic fingerprint (hash) of each document's content as it
passes through the pipeline. The hash is computed from the raw or normalized
text, so identical content always produces the same fingerprint regardless of
metadata. Use it for deduplication, content tracking, and identity verification
before indexing.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `tags` | `tags` | Passes each document through, stamped with its fingerprint. |

## Configuration

This node declares no fields of its own.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
