# video_composer

A RocketRide node that stitches a sequence of image frames into an MP4.

## What it does

Collects the image frames flowing through it and re-encodes them into a playable MP4
clip using **FFmpeg**.

Place it after any image-producing filter — for example `detect`, `pose_estimation`, or
`background_removal` — to turn that filter's annotated frames back into a video.

Output frame rate is set by `fps`, and quality by `crf` (lower is higher quality and a
larger file; 23 is FFmpeg's default).

Requires an FFmpeg binary available to the engine.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Frames to stitch, in arrival order |

### Fields

| Field | Type | Description |
|---|---|---|
| `fps` | number | Default 1.0. Output frame rate |
| `crf` | number | Default 23. FFmpeg quality (CRF); lower is higher quality |
| `profile` | string | Default `"standard"`. Output quality preset |
