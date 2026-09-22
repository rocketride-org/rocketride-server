# media_render

Render caller-supplied edits from named media streams, with synchronized audio, captions and supplied framing.

## What it does

Receives media as BEGIN/WRITE/END streams and processes it when the input object closes. Temporary files are private to that object and are released after processing, failure or cancellation cleanup. The node never calls account storage, fetches URLs, or keeps a persistent source cache. Connect downstream nodes to persist results.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `video` | `text` | JSON measurement/report |
| `video` | `answers` | Structured result manifest |
| `video` | `image` | Named JPEG streams |
| `video` | `audio` | Named audio streams |
| `video` | `video` | Named video streams |
| `audio` | `text` | JSON measurement/report |
| `audio` | `answers` | Structured result manifest |
| `audio` | `image` | Named JPEG streams |
| `audio` | `audio` | Named audio streams |
| `audio` | `video` | Named video streams |
| `image` | `text` | JSON measurement/report |
| `image` | `answers` | Structured result manifest |
| `image` | `image` | Named JPEG streams |
| `image` | `audio` | Named audio streams |
| `image` | `video` | Named video streams |

## Profiles

Default: **Default** (`default`).

| Profile | Purpose |
| --- | --- |
| `default` **(default)** | 960-pixel preview, CRF 28, ultrafast, sidecars off |
| `export` | 1920-pixel output, CRF 20, veryfast, sidecars on |

## Configuration

Set overrides in the selected profile block. `chunk_kb` controls output chunk size (clamped to 64–8192 KB); input bytes are spooled incrementally to temporary disk. `event_type` names progress events; progress is not written to a file.

### Request

`request` is a JSON object encoded as a string. `mode` selects the operation. `input_name` optionally selects the incoming media descriptor name. The defaults are `render`. A source must arrive on a media lane: a storage path alone is not input. Top-level `write_to`, `probe_to`, `status_to` and `report_to` are rejected.

### Render specification

`request.spec` is the render document. Supply `keep` as source-millisecond intervals and a non-empty `outputs` array, plus optional `media` metadata, `audio`, `subtitles`, `framing`, and `mode` (`preview` or `export`). The default `request` intentionally has no specification: configure one before running. Selection and framing decisions remain with the caller. Each output has a unique `key` and relative `file`; use `container: "wav"` or `"mp3"` for audio outputs and a supported video container (default `"mp4"`) for video outputs.

`spec.source` identifies a received audio/video stream by name. It may be omitted only when there is exactly one audio/video input. Overlays, music and concatenated assets must also arrive as named streams in the same object; source references are resolved only in that temporary workspace. A filename or URL does not cause a download. Inputs named under `outputs/` are reserved and rejected.

`spec.write_to`, `probe_to`, `report_to` and `status_to` are rejected. Output names are validated relative names. Generated media is streamed through its matching lane, which must have a sink. `files` contains emitted names, not persisted paths. `artifacts` describes name, MIME and byte count; UTF-8 sidecars include their `text` there, preserving SRT/VTT/JSON content and names in the result manifest. The stock text sink persists this manifest as `.md`; it does not create individually named sidecar files.

`part_ms` bounds intermediate video encodes; parts are scratch files and do not survive a request. Supplied framing, captions, mutes, bleeps, multiple aspects, audio mastering and programme assembly remain render operations.

## Notes

### Stream lifecycle and limits

`ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT` bounds each FFmpeg encode (default 3600 seconds, configurable from above 0 to 86400). Metadata subprocesses have a maximum 60-second timeout. Invalid timeout values fail explicitly.

Each descriptor should declare `size` and a unique `name`. Empty, truncated, oversized-relative-to-declaration and duplicate inputs fail. At most 128 streams are accepted per object. This processor accepts multiple named streams for a source and its assets. Media ingress uses bounded stream chunks. Decoders, analysis and speech models have additional memory requirements; temporary disk usage scales with input and intermediate outputs. Abrupt process termination may leave scratch files for host cleanup.

No browser download/re-upload relay is required by the node contract. The stock `filestore_source` currently rejects saved files above 100 MiB; direct webhook uploads avoid that source limit. These nodes do not change the stock source or sink. Durable progress, recovery and output naming belong to pipeline/application orchestration.

### Verification

Tests are in `nodes/test/media_render`: stream lifecycle, isolation, path validation, real FFmpeg operations and live engine integration. The shipped `example.pipe` uses webhook → parse → this node → response and stock file-store sinks; configure each sink destination before running. This node does not load a speech model.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `media_render.captions` | `boolean` | **Allow burned-in captions** | `true` |
| `media_render.chunk_kb` | `number` | **Stream chunk size (KB)** | `1024` |
| `media_render.crf` | `number` | **Default x264 quality (lower = better)** | `20` |
| `media_render.event_type` | `string` | **Name of the progress event this pipeline emits** | `"media_render"` |
| `media_render.fps` | `number` | **Default frames per second** | `30` |
| `media_render.long_edge` | `number` | **Default long edge in pixels (an output may state its own size)** | `1920` |
| `media_render.part_ms` | `number` | **Length of one rendered part of a long timeline (ms)** | `300000` |
| `media_render.preset` | `string` | **Default x264 speed preset** | `"veryfast"` |
| `media_render.profile` | `string` | **Profile** | `"default"` |
| `media_render.request` | `string` | **Operation request (JSON)**<br/>JSON request with mode render and a spec object. All referenced sources must arrive as named media streams. | `"{}"` |
| `media_render.sidecars` | `boolean` | **Write SRT / VTT sidecars (unless the document says otherwise)** | `true` |

## Dependencies

- `av` `>=18,<19`
- `imageio-ffmpeg` `>=0.6,<0.7`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/media_render)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
