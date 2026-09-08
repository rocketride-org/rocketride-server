# frame_grabber

A RocketRide filter node that extracts still frames from streamed video and passes them downstream as images, documents, or a timing table.

## What it does

Receives video on its `video` input lane and extracts still frames using one of three modes: fixed interval (the default), scene transition detection, or keyframe (I-frame) selection. Each extracted frame is emitted as a PNG image together with its frame number and presentation timestamp.

Extraction is performed by FFmpeg, spawned as a subprocess via the `imageio-ffmpeg` bundled binary, so no host `ffmpeg` installation is required on the machine running the engine. Video bytes are piped to FFmpeg's stdin, a mode-specific `select` or `fps` video filter picks the frames, and complete PNG images are parsed back from the `image2pipe` output stream. Frame numbers and timestamps are derived from FFmpeg's `showinfo` filter.

Each output lane is produced only when a downstream node is listening on it, so unused outputs cost nothing at runtime.

---

## Modes

The active mode is selected by `grabber.profile` (default: `interval`). Timestamps on all output lanes are relative to the start of the video; the configured start time is factored back into FFmpeg's relative output.

### Interval (default)

Extracts frames at a fixed time interval using FFmpeg's `fps` filter. The configured interval in seconds is converted to `fps = 1 / interval` at startup; a zero or negative interval raises an error.

| Field                       | services.json key          | Type / Default | Description                             |
|-----------------------------|----------------------------|----------------|-----------------------------------------|
| Interval (seconds)          | `grabber.second.interval`  | number / `5`   | Seconds between extracted frames.       |
| Start time (seconds)        | `grabber.start_time`       | number / `0`   | Where to begin extraction (0 = start).  |
| Duration (seconds)          | `grabber.duration`         | number / `0`   | How long to extract (0 = full video).   |

### Transition

Extracts a frame whenever the scene changes by more than a pixel-change threshold, using FFmpeg's `select='gt(scene,<percent>)'` filter.

| Field                       | services.json key          | Type / Default       | Description                                                                                         |
|-----------------------------|----------------------------|----------------------|-----------------------------------------------------------------------------------------------------|
| Percentage change           | `grabber.percent`          | number / `0.4` (40%) | Pixel-change threshold that triggers extraction; selectable from 10% to 100% in steps of 10%.       |
| Minimum scene gap (seconds) | `grabber.min_scene_gap`    | number / `0`         | Minimum time between extracted frames; reduces burst detections in high-motion segments. 0 = off.   |
| Start time (seconds)        | `grabber.start_time`       | number / `0`         | Where to begin extraction (0 = start).                                                              |
| Duration (seconds)          | `grabber.duration`         | number / `0`         | How long to extract (0 = full video).                                                               |
| Maximum frames              | `grabber.max_frames`       | number / `0`         | Cap on total frames extracted (0 = unlimited).                                                      |

### Keyframe

Extracts only video keyframes (I-frames) using FFmpeg's `select='eq(pict_type,I)'` filter.

| Field                       | services.json key          | Type / Default | Description                                    |
|-----------------------------|----------------------------|----------------|------------------------------------------------|
| Start time (seconds)        | `grabber.start_time`       | number / `0`   | Where to begin extraction (0 = start).         |
| Duration (seconds)          | `grabber.duration`         | number / `0`   | How long to extract (0 = full video).          |
| Maximum frames              | `grabber.max_frames`       | number / `0`   | Cap on total frames extracted (0 = unlimited). |

---

## Configuration

### Lanes

Input lane: `video`. Output lanes:

| Lane out    | Description                                                                                                                                       |
|-------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `image`     | Each extracted frame streamed as a raw `image/png` payload.                                                                                       |
| `table`     | One markdown table per object, written as the object closes: columns `Frame`, `Seconds`, `Time Stamp` (formatted as `HH:MM:SS.ss`). `Frame` counts the object's frames, so an object carrying several videos yields one table numbered straight through. |
| `documents` | One document per frame: `type: "Image"`, base64-encoded PNG as content, with `chunkId` counting the object's frames, `frame_number` (the frame's position in its own video), `time_stamp` (seconds), and a `source` object carrying the originating video's media detail (see Source provenance below) in the metadata. |

### Fields

The `grabber.profile` field selects the active mode and controls which sub-fields are shown in the UI.

| Field | Type | Description |
|---|---|---|
| `percent` | number | Default 0.4.  |
| `interval` | number | Default 5.  |
| `start_time` | number | Default 0.  |
| `duration` | number | Default 0.  |
| `max_frames` | number | Default 0.  |
| `min_scene_gap` | number | Default 0. Minimum time gap between extracted frames. Helps reduce burst detections in high-motion segments. Set to 0 to disable. |
| `profile` | string | Default "interval".  |

Each profile has a title defined in `preconfig.profiles`: "Extract video frames at intervals" (interval), "Extract video frames at scene transitions" (transition), and "Extract video frames at keyframes" (key). The `transition` profile also sets `percent` to `0.4` as a profile-level default.

### Watermark

When `grabber.watermark` is set to `Add watermark`, each extracted frame is stamped with a text label before it is emitted on every output lane. The label is white text with a black outline (legible on any background) at a font size scaled to the frame height.

| Field | services.json key | Default | Description |
|---|---|---|---|
| Watermark extracted frames | `grabber.watermark` | `no` | Enable the watermark; the fields below appear only when enabled. |
| Watermark position | `grabber.watermark_location` | `bottom_right` | Corner for the label (top/bottom × left/right). |
| Include file name | `grabber.watermark_filename` | `yes` | Add the source file name (from the stream descriptor). |
| Include timestamp | `grabber.watermark_timestamp` | `yes` | Add the frame timestamp (`HH:MM:SS.ss`). |

The file name comes from the stream descriptor attached to the video on `BEGIN`; when it is unavailable the label falls back to the timestamp alone.

### Source provenance

Every extracted frame carries a backlink to the video it came from. The frame's own metadata already identifies the source object (`objectId`, `parent`); a nested `source` object adds the video's media detail that the frame itself does not have:

`source`: `source_mime`, `duration`, `fps`, `width`, `height`, `resource_name`, `container_mime`, `size`, `stream_index`.

- On the `documents` lane the `source` object is attached to each frame document's metadata.
- On the `image` lane the same detail (plus `origin: extracted`) is sent as the frame's stream-descriptor enrichment on `BEGIN`, so the raw image stream is self-describing too.

`stream_index` distinguishes frames from different videos embedded in one source (e.g. two clips in one presentation). The block is omitted entirely when the incoming video carried no stream descriptor.

Each frame document is also given a human-readable `metadata.name` of the form `<video-stem>.frame<N>.png` (e.g. `BBC - Tear down this wall.frame0.png`), where `<video-stem>` is the source video's file name without extension and `N` counts the object's frames — the same number as `chunkId`, so an object carrying several videos is numbered straight through and no two frames share a name. Omitted when the source has no name.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `grabber.duration` | `number` | **Duration  (in seconds) for frame extraction (0=end of video)** | `0` |
| `grabber.max_frames` | `number` | **Maximum number of frames to extract (0=unlimited)** | `0` |
| `grabber.min_scene_gap` | `number` | **Minimum gap between scenes (seconds)**<br/>Minimum time gap between extracted frames. Helps reduce burst detections in high-motion segments. Set to 0 to disable. | `0` |
| `grabber.percent` | `number` | **Percentage change for frame** | `0.4` |
| `grabber.profile` | `string` | **Frame grabber mode** | `"interval"` |
| `grabber.second.interval` | `number` | **Interval (in seconds) between frames** | `5` |
| `grabber.start_time` | `number` | **Start time (in seconds) for frame extraction (0=beginning)** | `0` |
| `grabber.watermark` | `string` | **Watermark extracted frames** | `"no"` |
| `grabber.watermark_filename` | `string` | **Include file name** | `"yes"` |
| `grabber.watermark_location` | `string` | **Watermark position** | `"bottom_right"` |
| `grabber.watermark_timestamp` | `string` | **Include timestamp** | `"yes"` |

## Dependencies

- `Pillow` `>=10.1.0 # ImageFont.load_default(size=)`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/frame_grabber)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
