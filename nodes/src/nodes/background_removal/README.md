# background_removal

A RocketRide image-filter node that separates foreground from background and emits an RGBA cutout.

## What it does

Receives an image stream and runs **BiRefNet** (MIT) to produce an alpha matte, then
composites an RGBA cutout with a **straight (non-premultiplied) alpha** channel, so
downstream nodes can re-composite over any background without dark fringes.

Per frame the node emits on two lanes:

- `image` — the RGBA cutout as PNG
- `text` — JSON alpha statistics (`mean_alpha`, `alpha_coverage_pct`)

Before inference the source is downscaled so its long edge is at most `maxEdge`, which
bounds memory use; the alpha matte is then restored to the original resolution for
compositing. `maxEdge` is clamped to 256–4096 (default 1024) regardless of what is
configured.

Two profiles ship: the default 1K BiRefNet, and a 2K high-resolution variant for fine
hair and detailed edges. The model runs on CPU, Apple Silicon (MPS), or CUDA. Local
inference serializes GPU access behind a shared device lock; when the engine is started
with `--modelserver`, inference is dispatched to the model server instead.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source image (streamed) |
| `image` | output | RGBA cutout PNG, straight alpha |
| `text` | output | JSON alpha stats: `mean_alpha`, `alpha_coverage_pct` |

### Fields

| Field | Type | Description |
|---|---|---|
| `model` | string | HuggingFace model identifier for background removal (overrides the profile) |
| `maxEdge` | number | Default 1024, clamped to 256–4096. Downscale source so the long edge is at most this value before inference |
| `profile` | string | Default `"birefnet-default"`. BiRefNet variant — default is 1K, HR is 2K for finer edges |
