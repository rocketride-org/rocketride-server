# detect

A RocketRide image-filter node that finds objects in a frame and emits bounding boxes.

## What it does

Runs per-frame object detection and emits bounding boxes, labels, and centroids on the
text lane alongside an annotated frame on the image lane.

Two engines are available via `profile`:

- **RF-DETR** (Apache-2.0, default) — a fast **closed-set** detector over the 80 COCO
  classes (person, car, dog, and so on).
- **MM-Grounding-DINO** (Apache-2.0 / BSD-3) — the **open-vocabulary** option. Set
  `prompt` to detect anything you can name.

`prompt` accepts either a period- or comma-separated class list (`person . car . dog`)
or a described object (`red car`, `person in a hat`), and returns every matching region.
It matches objects and attributes, not spatial relationships.

Useful as a cheap per-frame gate in front of heavier models. For pixel-level masks use
the **Segmentation** (`detect_segment`) node instead.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source frame (streamed) |
| `image` | output | Annotated frame with boxes drawn |
| `text` | output | JSON detections: bounding boxes, labels, centroids |

### Fields

| Field | Type | Description |
|---|---|---|
| `threshold` | number | Default 0.3. Minimum confidence score (0.0–1.0) required to include a detection |
| `prompt` | string | Open-vocabulary prompt. Only used by the MM-Grounding-DINO profile |
| `profile` | string | Default `"rfdetr"`. Detector engine to load |
