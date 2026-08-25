# frame_grabber

A RocketRide video node that extracts selected still frames from an incoming
video stream and sends them downstream as PNG images, image documents, or a
frame-timestamp table. Choose it when later pipeline stages need individual
frames rather than the original video stream.

## About Pillow

Pillow is an image library that frame_grabber imports for optional watermark
rendering. It opens a selected frame, draws the watermark text, and encodes the
result as PNG.

## What it does

The node receives video on the `video` lane and selects frames in interval,
scene-transition, or keyframe mode. It can produce each selected frame as a
PNG image stream or as an image document; it can also collect frame numbers and
timestamps into a table when the video closes. Each output is generated only
when its corresponding downstream listener is present. Pick this node over a
single-image transform when a pipeline needs a controlled set of frames and
their timestamps from a video.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `video` | `image` | Emit each selected frame as an `image/png` stream. |
| `video` | `table` | Emit a Markdown table of selected frame numbers and timestamps when the video closes. |
| `video` | `documents` | Emit each selected frame as an image document with frame metadata. |

## Profiles

Default: **Extract video frames at intervals** (`interval`).

| Profile | Selection mode | Context |
| --- | --- | --- |
| `interval` **(default)** | Extract video frames at intervals | Shows the interval, start-time, duration, and watermark settings. |
| `transition` | Extract video frames at scene transitions | Shows the change percentage, minimum scene gap, time bounds, frame cap, and watermark settings. |
| `key` | Extract video frames at keyframes | Shows the time bounds, frame cap, and watermark settings. |

## Configuration

Start by selecting the frame-grabber mode. The default interval profile is the
right starting point for regular sampling; use the other profiles only when
their selection criteria match the video. The generated schema below lists the
available fields and defaults.

### Frame grabber mode

**Frame grabber mode** selects `interval`, `transition`, or `key` and changes
which settings the configuration panel exposes. Keep the default `interval`
when frames should be sampled at a regular cadence. Choose `transition` when
scene changes should control selection, or `key` when keyframes are the desired
selection points. The transition profile supplies `0.4` as its configured
percentage default.

### Interval between frames

**Interval (in seconds) between frames** is available in interval mode and
defaults to `5`. At global initialization, the node converts this interval to
frames per second as `1 / interval`; it must therefore be greater than zero,
or startup raises a `ValueError`. Lower it for more frequent sampling and raise
it when fewer frames are sufficient.

### Percentage change for frame and minimum gap

In transition mode, **Percentage change for frame** defaults to `0.4` and can
be set from `0.1` to `1.0` in the configuration panel. Use a lower percentage
when smaller changes should select frames; use a higher percentage to require
a larger change. **Minimum gap between scenes** defaults to `0` (disabled) and
can be set from `0.5` to `5` seconds to reduce burst detections in
high-motion segments. Pair a nonzero gap with a low percentage when a busy
video would otherwise produce closely spaced selections.

### Extraction window and frame cap

**Start time** and **Duration** are available in every profile. Their default
of `0` starts at the beginning and continues to the end of the video,
respectively; set them to limit work to a relevant segment. **Maximum number of
frames** is available in transition and keyframe modes and defaults to `0` for
no limit. Set a cap when downstream storage or review must be bounded.

### Watermark

**Watermark extracted frames** is off by default. When enabled, the node draws
the selected filename and timestamp parts before sending the frame to any
output. Choose a corner with **Watermark position**; keep the default
bottom-right placement unless it covers important content. The filename and
timestamp switches both default to `yes`; turn either off when that part of the
label is unwanted. If both are off, the frame is returned unchanged even when
watermarking is enabled.

The timestamp is formatted as `HH:MM:SS.ss`. When the incoming descriptor
identifies media extracted from a container, the filename label is rendered as
`file @ container`; otherwise it uses the available file or container name.
Watermark rendering is best effort: if Pillow raises an exception, the node
logs the error and emits the original frame.

## Notes

### Output metadata

On the documents lane, every frame is emitted as a `Doc` with type `Image`,
base64-encoded PNG content, the frame number as `chunkId`, and its timestamp as
`time_stamp`. The node attaches source-video provenance and gives frames a
derived PNG name when a source descriptor is available.

On the image lane, each frame is a separate `image/png` stream. Its begin
payload includes the frame's byte size and, when available, its dimensions,
derived name, and nested source provenance.

### Table output

The table lane accumulates a row for every selected frame and writes one
Markdown table only when the video closes and at least one row was collected.
Its columns are `Frame`, `Seconds`, and `Time Stamp`.

## Upstream docs

- [Pillow documentation](https://pillow.readthedocs.io/)

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
