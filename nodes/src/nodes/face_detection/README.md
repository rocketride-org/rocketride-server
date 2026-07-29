# face_detection

A RocketRide image-filter node that detects faces and optional alignment keypoints.

## What it does

Runs per-frame face detection using **MediaPipe BlazeFace** (Apache-2.0) and emits
axis-aligned bounding boxes for every detected face.

When `emit_landmarks` is on (the default) each face also carries 6 coarse,
alignment-grade keypoints: `right_eye`, `left_eye`, `nose_tip`, `mouth_center`,
`right_ear_tragion`, `left_ear_tragion`.

Fast enough to use as a face-presence gate ahead of heavier models, or to drive
face-aware framing and cropping. These are coarse alignment keypoints — this is not a
dense facial-landmark or face-recognition node.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source frame (streamed) |
| `image` | output | Annotated frame |
| `text` | output | JSON faces: bounding boxes and, optionally, 6 keypoints each |

### Fields

| Field | Type | Description |
|---|---|---|
| `profile` | string | Default `"short"`. BlazeFace model variant |
| `threshold` | number | Default 0.5. Minimum confidence score to include a face |
| `emit_landmarks` | boolean | Default true. Emit the 6 alignment keypoints per face |
