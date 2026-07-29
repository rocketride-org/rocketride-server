# detect_segment

A RocketRide image-filter node that produces pixel-level segmentation masks.

## What it does

Runs pixel-level segmentation with HuggingFace-native engines and emits an annotated
overlay on the image lane plus a Masks JSON payload on the text lane.

Two modes are available:

- **Mask2Former-instance** (MIT, default) — closed-set **instance** masks, one mask per
  detected object.
- **Mask2Former-semantic** (MIT) — a per-pixel **class map** over the whole frame.

Accepts a single frame or multiple frames (via `frame_grabber` documents). Input is
downscaled so its long edge is at most `maxEdge` before inference.

For bounding boxes only — which is considerably cheaper — use the **Object Detection**
(`detect`) node.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source frame, or multi-frame documents |
| `image` | output | Annotated overlay |
| `text` | output | Masks JSON |

### Fields

| Field | Type | Description |
|---|---|---|
| `mode` | string | Default `"instance"`. Instance masks or a semantic per-pixel class map |
| `engine` | string | Default `"mask2former-instance"`. Segmentation engine to load |
| `threshold` | number | Default 0.3. Minimum confidence score to include a mask |
| `maxEdge` | number | Default 1024. Downscale input so the long edge is at most this value before inference |
| `profile` | string | Default `"mask2former-instance"`. Model profile |
