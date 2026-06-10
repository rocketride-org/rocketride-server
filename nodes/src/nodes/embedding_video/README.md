# embedding_video

Turns video into searchable vectors by sampling and encoding its frames.

## What it does

It pulls frames from a video at an interval you choose and runs each through a vision model like CLIP, converting what's on screen into numbers. Those embeddings capture the video's semantic and structural features, so you can run similarity search, cluster videos, or feed them into multimodal RAG workflows. It runs on the model server and uses the GPU when one is available.

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
