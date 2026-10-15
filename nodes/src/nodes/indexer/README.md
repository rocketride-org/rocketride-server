# indexer

An internal RocketRide filter that builds an inverted word index from extracted text, enabling full-text keyword search over ingested content.

## What it does

The indexer consumes the text lane, tokenizes it, and writes each word into a
word database, stamping every object it indexes with the `wordBatchId` of the
batch it was written to. It is an internal node: autopipe inserts it after the
parser whenever an include entry sets `index` to true, so it is not added on
the canvas. Objects that already carry a `wordBatchId` are skipped unless they
are flagged for indexing again.

## Configuration

This node declares no fields of its own. It reads an `index` section from the
task configuration rather than from its own component config:

| Key | Default | Description |
| --- | ------- | ----------- |
| `indexOutput` | — | Required. Where each word database is written. `%BatchId%` in the URL expands to the current batch number. |
| `batchId` | `0` | Number of the first batch. |
| `compress` | `false` | Compress the word database. |
| `maxWordCount` | `250,000,000` | Words per batch before a new one starts. |
| `maxItemCount` | `300,000` | Objects per batch before a new one starts. |

### Batches

A batch is one word database file. When either limit is exceeded the current
database is closed and the next batch opens under the next batch number, so
`indexOutput` needs `%BatchId%` to keep the files apart. An object's
`wordBatchId` names the file its words went to.

## Notes

### Write and read modes

The mode follows the endpoint. In write mode the node builds word databases as
described above. In read mode it renders text back out of existing databases
instead, which requires a `batches` map in the task configuration naming the
databases to read.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
