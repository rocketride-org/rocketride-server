# webhook

Let external input reach a pipeline over HTTP. Three variants — Chat, Dropper, and Web Hook — all served from a single FastAPI endpoint.

## What it does

It's a `source` node: it stands up its own HTTP endpoint (host/port supplied by the engine) and forwards incoming data into the attached pipeline. The three variants share the same code (`nodes.webhook`) but differ by protocol and by the surface they expose:

- **Chat** (`chat://`) — serves a web-based chat UI. Users type questions in the browser, which flow through the pipeline. Output lane: `questions`.
- **Dropper** (`dropper://`) — serves a web-based file-drop UI. Users drop files for ingestion and processing. Output lane: `tags`.
- **Web Hook** (`webhook://`) — a raw HTTP intake (also used for the RocketRide DataToolchain / ADS flow). External systems POST documents, media, or data for the pipeline to process. Output lanes: `tags`, `text`, `audio`, `video`, `image`, `questions`.

Each variant uses `_source` as its internal input and emits to the lanes listed above. On startup the node publishes its interface URL, a public authorization key, and a private token so callers know how to reach it.

## Configuration

The node creates its endpoint from the host and port passed in by the engine (`--data_host`, `--data_port`, defaulting to `localhost:5567`). There are no per-variant config fields beyond the standard source parameters.

| Field          | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| `source.mode`  | —       | Standard pipeline source mode.                                     |
| `parameters`   | *(empty)* | Source parameters object; no variant-specific options are defined. |
