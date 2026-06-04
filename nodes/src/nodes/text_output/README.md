# text_output

## What it does

Writes pipeline text output to the file system over SMB. Receives text from upstream nodes and saves each object as a `.txt` file, preserving the source directory structure under the target path. This is a target (sink) node — it consumes the `text` lane and has no output lane.

Objects that produce no text are skipped, and objects whose source and target are unchanged since the last run are skipped to avoid redundant writes. Files are written in UTF-8 and target subdirectories are created automatically.

Requires the `network` capability and is not available in remote (`noremote`) or SaaS (`nosaas`) deployments.

**Lanes:**

| Lane in | Description                   |
| ------- | ----------------------------- |
| `text`  | Text content to write to disk |

## Configuration

| Field      | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| Parameters | Target parameters, including `anonymize` for the written text. |
| Mode       | Target write mode.                                           |

The source file extension is replaced with `.txt` on output.
