# detect (Object Detection)

## What it does

Per-frame object detection. Image in, bounding boxes + labels + centroids out
as JSON, plus an annotated frame on the image lane. Runs locally, no API key
required.

**Lanes:**

| Lane in | Lane out | Description                                            |
| ------- | -------- | ------------------------------------------------------ |
| `image` | `text`   | JSON array of detections `[{label, score, box, centroid}]` |
| `image` | `image`  | Annotated frame with bounding boxes + labels           |

## Profiles

| Profile        | Model              | When to pick it                                                          |
| -------------- | ------------------ | ------------------------------------------------------------------------ |
| `rfdetr`       | RF-DETR (Apache-2.0) | Default. Fast closed-set detector over the 80 COCO classes (person, car, dog, ...). No prompt needed. |
| `mmgdino`      | MM-Grounding-DINO (Apache-2.0/BSD-3) | Open-vocabulary: type a prompt to detect anything.       |
| `llmdet-tiny`  | LLMDet tiny (Apache-2.0) | Open-vocabulary with better zero-shot accuracy at tiny size.         |
| `llmdet-large` | LLMDet large (Apache-2.0) | Best zero-shot accuracy; slower, needs ~8GB VRAM.                   |

**Choosing between the open-vocab options:** LLMDet scores roughly double
MM-Grounding-DINO's zero-shot LVIS accuracy, with cleaner boxes and higher
confidence on distinct objects. MM-Grounding-DINO can still recall broad region
classes (e.g. "water") and UI/HUD elements better — A/B on your own data.
(LLMDet is architecturally MM-Grounding-DINO; only the checkpoint differs.)

## Practical guidance

- **Use as a cheap per-frame gate.** Detection is fast enough to run on every
  frame, so put it in front of heavier models (Describe, Segmentation) and only
  forward frames where something interesting appears.
- The detection **prompt** and **confidence threshold** are per-request, so one
  loaded model copy is shared regardless of the query or filter.
- Inputs are downscaled for inference; boxes are mapped back to source
  coordinates.
- For pixel masks instead of boxes, use **Segmentation**.

## Devices

Runs on CPU, Apple Silicon (MPS), and CUDA.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
