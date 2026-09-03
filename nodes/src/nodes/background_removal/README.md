# background_removal (Background Removal)

## What it does

Separates foreground from background using **BiRefNet** (MIT). Image in, RGBA
cutout out: the alpha channel is straight (non-premultiplied), so downstream
nodes can re-composite the subject over any background without dark fringes.
Runs locally, no API key required.

**Lanes:**

| Lane in | Lane out | Description                                        |
| ------- | -------- | -------------------------------------------------- |
| `image` | `image`  | RGBA cutout PNG (straight alpha)                   |
| `image` | `text`   | JSON alpha stats (`mean_alpha`, `alpha_coverage_pct`) |

The alpha stats make a cheap downstream signal: coverage near 0% or 100% means
the matte found no clear subject (or the whole frame is subject).

## Profiles

| Profile             | Model         | When to pick it                                                       |
| ------------------- | ------------- | --------------------------------------------------------------------- |
| `birefnet-default`  | BiRefNet (1K) | Default. ~4GB VRAM, runs on most laptop GPUs.                          |
| `birefnet-hr`       | BiRefNet HR (2K) | Fine hair and detailed edges. ~11GB VRAM, workstation/datacenter GPUs. |

Both models are pinned to an exact commit sha (BiRefNet loads with
`trust_remote_code`, so the executed code is immutable).

## Devices and precision

Runs on CPU, Apple Silicon (MPS), and CUDA. BiRefNet's weights stay float32 on
all devices — its deformable-convolution kernel has no half-precision
implementation — so on CUDA speed comes from the TF32 tensor-core fast path
instead (~2.3x). On pre-Ampere NVIDIA cards TF32 is inert and inference is
plain fp32.

## Practical notes

- **Max input edge** caps the source resolution before inference; larger inputs
  are downscaled and the matte is restored to source resolution afterwards.
- If a frame fails, the node logs a warning and keeps the pipeline flowing
  rather than aborting the run.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
