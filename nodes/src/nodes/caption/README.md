# caption

A RocketRide image-filter node that generates a natural-language caption for an image.

## What it does

Receives an image and runs **Florence-2 Base** (MIT) locally to produce a descriptive
caption on the text lane. Three granularities are exposed via `task`, from shortest to
longest: `caption` (the default), `detailed_caption`, and `more_detailed_caption`.

Runs on CPU, Apple Silicon (MPS), and CUDA with **no API key required** — inference is
local, so images never leave the host.

For object detection use the **Object Detection** (`detect`) node; for reading text in
an image use the **OCR** node. This node describes a scene, it does not localize or
transcribe.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source image (streamed) |
| `text` | output | The generated caption |

### Fields

| Field | Type | Description |
|---|---|---|
| `task` | string | Default `"caption"`. How detailed the caption should be — one of `caption`, `detailed_caption`, `more_detailed_caption` |
| `profile` | string | Default `"florence-base"`. Model variant to load |
