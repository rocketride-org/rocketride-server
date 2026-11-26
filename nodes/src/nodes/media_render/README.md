# media_render

Render caller-supplied edits from named media streams, with synchronized audio, captions and supplied framing.

## What it does

Receives media as BEGIN/WRITE/END streams and processes it when the input object closes. Temporary files are private to that object and are released after processing, failure or cancellation cleanup. The node never calls account storage, fetches URLs, or keeps a persistent source cache. Connect downstream nodes to persist results. A video with no audio track receives a silent track so edits and programme audio effects remain usable. Invalid static edit specs fail at pipeline startup, before media upload.

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

`request` is a JSON object encoded as a string. `mode` selects the operation. `input_name` optionally selects the incoming media descriptor name. The defaults are `render`. A source must arrive on a media lane: a storage path alone is not input. Top-level `write_to`, `probe_to`, `status_to` and `report_to` are rejected. The request JSON, `mode` and the shape of `spec` are validated when the pipeline starts; an invalid request refuses to start rather than failing after input has been spooled.

### Render specification

`request.spec` is the render document. Supply `keep` as source-millisecond intervals and a non-empty `outputs` array, plus optional `media` metadata, `audio`, `subtitles`, `framing_plan` (with optional `framing_offset_ms`), and `mode` (`preview` or `export`). The default `request` has no specification, so the pipeline refuses to start until one is configured. `keep` intervals are rendered in time order regardless of the order given; overlapping intervals are rejected. Cuts are frame-aligned to the mastered audio timeline so picture and sound stay in sync across any number of intervals. Selection and framing decisions remain with the caller. `framing` is a per-output Boolean controlling whether that output applies `framing_plan`; any kept stretch the plan does not cover is rendered full frame and noted in the manifest `warnings`. Each output has a unique `key` and relative `file`; `key` is validated like a file name (no quotes, `:`, `;`, backslashes or control characters; aspect aliases such as `9:16` are allowed) and may not contain `/`. Use `container: "wav"` or `"mp3"` for audio outputs and a supported video container (default `"mp4"`) for video outputs.

With a `window`, burned-in captions and SRT/VTT sidecars run on the rendered slice's own clock (0 = `window[0]`) and `caption_lines` counts that slice. A `thumbnail.at_ms` past the end of the render is pulled back to the last frame with a warning. Silent material is not mastered: the `loudness.*` fields are `null` and a warning says so; the report is strict JSON. Mastering uses the measured loudness range when it is wider than 11 LU on both the clip and programme paths. Title and end cards use a system font file (macOS, Linux or Windows, or matplotlib's DejaVu); without one, `drawtext` relies on fontconfig, and a toolchain that cannot draw text renders the card blank with a warning.

`spec.source` identifies a received audio/video stream by name. It may be omitted only when there is exactly one audio/video input. Overlays, music and concatenated assets must also arrive as named streams in the same object; source references are resolved only in that temporary workspace. A filename or URL does not cause a download. Inputs named under `outputs/` are reserved and rejected. Relative input names may contain spaces, apostrophes and brackets; traversal, absolute paths, backslashes, colons and control characters are rejected. Output names additionally reject filtergraph delimiters.

`spec.write_to`, `probe_to`, `report_to` and `status_to` are rejected. Output names are validated relative names. Generated media is streamed through its matching lane, which must have a sink. Required sinks are checked when an object opens, before any input is spooled: each output's lane, the `image` lane when a thumbnail will be rendered (set `spec.thumbnail` to `false` to skip it), and a `text` or `answers` consumer for the manifest. `files` contains emitted names, not persisted paths. `artifacts` describes name, MIME and byte count; UTF-8 sidecars include their `text` there, preserving SRT/VTT/JSON content and names in the result manifest. Thumbnail and sidecar MIME types are fixed (`image/jpeg`, `application/x-subrip`, `text/vtt`, `text/plain`, `application/json`) rather than taken from the host's registry. The stock text sink persists this manifest as `.md`; it does not create individually named sidecar files.

FFmpeg failures are reported as `ffmpeg failed (<code>): <stderr tail>` with the scratch directory shown as `<scratch>`; the full command line goes to the job log only.

`part_ms` bounds intermediate video encodes; parts are scratch files and do not survive a request. Frame rounding follows the cumulative edited timeline across parts, including framed parts, so a part length that is not a whole number of frames does not accumulate audio/video drift. Supplied framing, captions, mutes, bleeps, multiple aspects, audio mastering and programme assembly remain render operations. Destination panel rectangles scale with the output canvas; source crop coordinates stay in source pixels, and captions follow the resized panel seam.

## Notes

### Stream lifecycle and limits

`ROCKETRIDE_MEDIA_FFMPEG_TIMEOUT` bounds each FFmpeg encode (default 3600 seconds, configurable from above 0 to 86400). Metadata subprocesses have a maximum 60-second timeout. Invalid timeout values fail explicitly.

Stream names and sizes are read from the engine's BEGIN descriptor `metadata` (`metadata.name` or `metadata.resource_name`, and `metadata.size`); a stream without a name takes the object's name. `max_input_mb` limits cumulative incoming bytes across all streams in an object (default 16384 MiB / 16 GiB, clamped to 1–1048576 MiB). It is enforced before writing each chunk, including when `size` is absent; declared sizes above the remaining budget fail at BEGIN. Non-negative integral sizes may be numbers or numeric strings; invalid or boolean sizes are ignored with a warning, while actual-byte limits remain enforced. This ingress limit does not bound decoded/intermediate output size. Empty and duplicate inputs fail; because a declared size may describe the source container rather than the extracted stream, a received/declared size mismatch is recorded in the manifest `warnings` instead of failing. At most 128 streams are accepted per object. This processor accepts multiple named streams for a source and its assets. Media ingress uses bounded stream chunks. Decoders, analysis and speech models have additional memory requirements; temporary disk usage scales with input and intermediate outputs. Abrupt process termination may leave scratch files for host cleanup.

No browser download/re-upload relay is required by the node contract. The stock `filestore_source` currently rejects saved files above 100 MiB; direct webhook uploads avoid that source limit. These nodes do not change the stock source or sink. Durable progress, recovery and output naming belong to pipeline/application orchestration.

Programme rendering fully renders one primary video output. Secondary video outputs are transcoded from it and inherit its framing and burned-in captions; set their `from` to the primary key. An independent secondary video request currently emits a warning rather than silently claiming its own framing/captions were applied.

### Verification

Tests are in `nodes/test/media_render`: stream lifecycle, isolation, path validation, real FFmpeg operations and live engine integration. The shipped `example.pipe` uses webhook → parse → this node → response and stock file-store sinks; configure each sink destination before running. The example connects only the video source lane; when adding several audio/video inputs, select the intended source with `input_name` or `spec.source`. This node does not load a speech model.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `media_render.captions` | `boolean` | **Allow burned-in captions** | `true` |
| `media_render.chunk_kb` | `number` | **Stream chunk size (KB)** | `1024` |
| `media_render.default.crf` | `number` | **Default x264 quality (lower = better)** | `28` |
| `media_render.default.long_edge` | `number` | **Default long edge in pixels (an output may state its own size)** | `960` |
| `media_render.default.preset` | `string` | **Default x264 speed preset** | `"ultrafast"` |
| `media_render.default.sidecars` | `boolean` | **Write SRT / VTT sidecars (unless the document says otherwise)** | `false` |
| `media_render.event_type` | `string` | **Name of the progress event this pipeline emits** | `"media_render"` |
| `media_render.export.crf` | `number` | **Default x264 quality (lower = better)** | `20` |
| `media_render.export.long_edge` | `number` | **Default long edge in pixels (an output may state its own size)** | `1920` |
| `media_render.export.preset` | `string` | **Default x264 speed preset** | `"veryfast"` |
| `media_render.export.sidecars` | `boolean` | **Write SRT / VTT sidecars (unless the document says otherwise)** | `true` |
| `media_render.fps` | `number` | **Default frames per second** | `30` |
| `media_render.max_input_mb` | `number` | **Maximum cumulative input per object (MiB)**<br/>Total incoming media bytes, including all assets. Clamped to 1–1048576 MiB; enforced even when stream size is undeclared. | `16384` |
| `media_render.part_ms` | `number` | **Length of one rendered part of a long timeline (ms)** | `300000` |
| `media_render.profile` | `string` | **Profile** | `"default"` |
| `media_render.request` | `string` | **Operation request (JSON)**<br/>JSON request with mode render and a spec object. All referenced sources must arrive as named media streams. | `"{}"` |

## Dependencies

- `av` `>=17,<19`
- `imageio-ffmpeg` `>=0.6,<0.7`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/media_render)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
