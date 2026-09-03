# detect_segment (Segmentation)

## What it does

Pixel-level segmentation. Image in (single frame or multi-frame via
`frame_grabber` documents), annotated overlay + Masks JSON out. Where **Object
Detection** gives boxes, this node gives per-pixel masks. Runs locally, no API
key required (the SAM 3 profile needs HuggingFace access to a gated repo).

**Lanes:**

| Lane in | Lane out | Description                                                        |
| ------- | -------- | ------------------------------------------------------------------ |
| `image` | `text`   | Masks JSON: instance list (COCO-RLE masks) or semantic class map   |
| `image` | `image`  | Annotated frame with translucent per-instance/class colored overlay |

## Profiles

| Profile                | Model                     | When to pick it                                                          |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `mask2former-instance` | Mask2Former instance (MIT) | Default. Closed-set instance masks over the 80 COCO classes — one mask per object. |
| `mask2former-semantic` | Mask2Former semantic (MIT) | Per-pixel class map over 150 ADE20K scene classes (sky, road, wall, ...). |
| `sam3`                 | SAM 3 (Meta SAM License)   | Open-vocabulary concept instances: type a prompt to segment anything. Gated HF repo. |

Pick **instance** when you need to count or track individual objects,
**semantic** when you need scene regions, and **SAM 3** when the thing you want
isn't in a fixed class list.

## Practical guidance

- The concept **prompt** and **confidence threshold** are per-request; one
  loaded model copy is shared across queries.
- **Max input edge** bounds the inference resolution; masks are restored to the
  source resolution afterwards, so downstream consumers always see masks in
  source coordinates.
- Instance masks ship as COCO-RLE (`{size, counts}`) — compact and decodable
  with `pycocotools`.
- Segmentation is heavier than detection. For a cheap per-frame gate use
  **Object Detection** first and segment only the frames that matter.

## Devices

Runs on CPU, Apple Silicon (MPS), and CUDA.

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
