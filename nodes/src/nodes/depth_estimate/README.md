# depth_estimate

A RocketRide image-filter node that estimates per-pixel depth from a single image.

## What it does

Runs **Depth Anything V2 Small** (Apache-2.0) for monocular depth estimation and emits
a colorized depth map on the image lane, where **red is near and blue is far**. Depth
statistics (min, max, mean) are emitted as JSON on the text lane.

Pair this with the **Object Detection** (`detect`) node to get a rough distance to each
detected object.

Before inference the input is downscaled so its long edge is at most `maxEdge`, which
bounds memory use; the dense output is restored to the original resolution afterward.
Runs on CPU, Apple Silicon (MPS), and CUDA.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source image (streamed) |
| `image` | output | Colorized depth map (red = near, blue = far) |
| `text` | output | JSON depth statistics: min, max, mean |

### Fields

| Field | Type | Description |
|---|---|---|
| `maxEdge` | number | Default 1024. Downscale input so the long edge is at most this value before inference |
| `profile` | string | Default `"v2-small"`. Depth Anything V2 variant to load |
