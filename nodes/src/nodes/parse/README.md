# parse

A RocketRide filter that extracts structured content from a wide variety of
document types, routing each kind of embedded content to its own output lane.

## What it does

Extracts structured content from a wide variety of document types. The parser
automatically identifies embedded content and routes it to the appropriate
output lane, making text, tables, images, audio, and video accessible for
downstream processing.

## Lanes

| Lane in | Lane out | Description |
| ------- | -------- | ----------- |
| `tags` | `text` | Extracted plain text. |
| `tags` | `table` | Extracted tables. |
| `tags` | `image` | Extracted images. |
| `tags` | `video` | Extracted video streams. |
| `tags` | `audio` | Extracted audio streams. |

## Configuration

This node declares no fields of its own.

## Notes

**Provenance — not for audit-grade extraction.** Output is flattened to
Markdown: page boundaries, bbox/polygon coordinates, and the table-HTML cell
grid are dropped, so cell-level provenance and coordinate-based review cannot be
reconstructed. Do not use this node where every value must trace back to its
exact source cell, such as financial-table or regulatory extraction. For
structure-preserving parsing that retains table HTML plus page and coordinate
data, use the `datalab_parse` node instead.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
