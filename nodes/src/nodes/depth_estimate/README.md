# depth_estimate (Depth Estimation)

## What it does

Monocular depth estimation using **Depth Anything V2 Small** (Apache-2.0).
Image in, colorized depth map out (red = near, blue = far), plus per-frame
depth statistics as JSON on the text lane. Runs locally, no API key required.

**Lanes:**

| Lane in | Lane out | Description                                  |
| ------- | -------- | -------------------------------------------- |
| `image` | `image`  | Colorized depth map (red = near, blue = far) |
| `image` | `text`   | JSON depth stats (`min`, `max`, `mean`)      |

**Depth is relative, not metric.** Values are normalized within each frame —
useful for ordering ("what is closer than what") and rough distance ranking,
not for measuring meters. Pair with the **Object Detection** node to get rough
relative distance to detected objects.

## Profiles

| Profile    | Model                     | When to pick it                        |
| ---------- | ------------------------- | -------------------------------------- |
| `v2-small` | Depth Anything V2 Small   | The shipped profile; fast per-frame.   |

## Devices and precision

Runs on CPU, Apple Silicon (MPS), and CUDA. On CUDA the forward uses the TF32
tensor-core fast path (~1.2x, drift well below the visualization's noise
floor); on pre-Ampere NVIDIA cards TF32 is inert and inference is plain fp32.

## Practical notes

- **Max input edge** caps the source resolution; the model works at a fixed
  internal size (~518 px long edge) and the depth map is restored to the input
  resolution.
- The forward itself is ~10ms class work — cheap enough to run per frame in
  video pipelines.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
