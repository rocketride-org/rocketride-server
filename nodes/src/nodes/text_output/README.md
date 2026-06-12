# text_output

## What it does

Saves your pipeline's text to disk over SMB. Each upstream object becomes a `.txt` file, mirroring the source directory layout under the target path. It's the end of the line: consumes the `text` lane, emits nothing.

Empty objects are skipped, and so are objects unchanged since the last run, so you don't rewrite the same file twice. Output is UTF-8, and target subdirectories are created for you.

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
