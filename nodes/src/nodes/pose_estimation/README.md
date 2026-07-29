# pose_estimation

A RocketRide image-filter node that estimates human body pose per frame.

## What it does

Runs top-down human pose estimation using **RTMPose** (Apache-2.0) through the `rtmlib`
ONNX wrapper. **RTMDet-nano** performs person detection first, then RTMPose predicts
**17 COCO keypoints** for each person crop.

Accepts an image or a document and emits an annotated frame, with the per-person
keypoint array attached to the document's metadata.

Top-down means cost scales with the number of people in frame; `max_persons` bounds
that work.

---

## Configuration

### Lanes

| Lane | Direction | Description |
|------|-----------|-------------|
| `image` | input | Source frame or document |
| `image` | output | Annotated frame; keypoint array attached to document metadata |

### Fields

| Field | Type | Description |
|---|---|---|
| `profile` | string | Default `"rtmpose-medium"`. RTMPose model variant |
| `threshold` | number | Default 0.3. Minimum keypoint score to keep a joint |
| `max_persons` | number | Default 20. Maximum persons processed per frame |
