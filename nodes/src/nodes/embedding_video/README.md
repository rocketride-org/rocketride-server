# embedding_video

Generates vector embeddings from video by extracting and encoding frames.

## What it does

Extracts frames from a video at a configurable interval and encodes each one with a vision model such as CLIP, turning the video's visual features into numerical representations. The resulting embeddings capture the semantic and structural characteristics of the video, enabling similarity search, clustering, and integration into multimodal RAG workflows. Runs on the model server and is GPU-accelerated when available.

**Lanes:**

| Lane in | Lane out    | Description                                          |
| ------- | ----------- | --------------------------------------------------- |
| `video` | `documents` | Embed extracted video frames into document objects  |

Output documents carry an `embedding` vector, ready for ingestion into a vector store.

## Configuration

| Field            | Default | Description                                                       |
| ---------------- | ------- | ---------------------------------------------------------------- |
| Model            | *(see profiles)* | Hugging Face vision model used for frame embedding.     |
| Interval         | `5`     | Seconds between extracted frames.                                |
| Maximum frames   | `50`    | Cap on total frames extracted (`0` = unlimited).                 |
| Start time       | `0`     | Start offset in seconds for frame extraction (`0` = beginning).  |
| Duration         | `0`     | Duration in seconds to extract (`0` = end of video).             |
| Max video size (MB) | `500`| Reject videos larger than this size.                             |

## Profiles

| Profile                | Model                          | Notes                                 |
| ---------------------- | ------------------------------ | ------------------------------------- |
| OpenAI 16×16 _(default)_ | `openai/clip-vit-base-patch16` | Good performance, lower memory        |
| OpenAI 32×32           | `openai/clip-vit-base-patch32` | Lower performance, better recognition |
| Google 16×16           | `google/vit-base-patch16-224`  | Fast, accurate, general-purpose       |
| Custom                 | _(user-specified)_             | Any Hugging Face vision model         |
