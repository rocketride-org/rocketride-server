# Video Player

Local-only (`nosaas`) sink node that plays a video stream in a window with optional burned-in subtitles.

## Inputs

| Lane        | Purpose                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `video`     | Encoded video stream (mp4/mkv/…) — buffered to a temp file and played                                                              |
| `documents` | Timed subtitle segments (`Doc.page_content` + `metadata.time_stamp` [+ `metadata.time_stamp_end`]) — rendered as synchronized cues |
| `text`      | Plain subtitle text — displayed as a single cue for the entire video (fallback when no `documents` are wired)                      |

No outputs. The node blocks the pipeline instance until the playback window is closed (press `q` or `Esc`, or let the video finish).

## How subtitles are rendered

Subtitles arriving on the `documents` lane are written to a temporary SRT file and fed to ffmpeg's `subtitles` video filter via `ffpyplayer`. This burns the subtitle text directly into decoded frames, so sync is frame-accurate and governed by the PTS stream — no custom overlay code.

If `metadata.time_stamp_end` is missing for a segment (older transcribe output), the node falls back to `start + 2s` per cue.

## Example pipeline

### Translated subtitles

```
source[video] ──→ Transcribe ──→ Google Translate ──→ Video Player
      └──────────────────────────────────────────────────→ (same video input)
```

- `Transcribe.documents` → `Google Translate.documents` → `Video Player.documents`
- `source.video` → `Video Player.video`

The video plays once all inputs have arrived, so upstream processing (transcription + translation) finishes first.

### No-translate subtitles

```
source[video] ──→ Transcribe ──→ Video Player
      └──────────────────────────→ (same video input)
```

## Requirements

- `ffpyplayer` (bundles ffmpeg via imageio_ffmpeg)
- `opencv-python` (used as the display window)
- A desktop environment with a display available at runtime (hence `nosaas`)

## Controls

- `q` or `Esc` — quit playback

## Limitations (MVP)

- No pause / seek / speed controls.
- Single video stream per instance (first stream wins if multiple arrive).
- Subtitle styling is ffmpeg's default (white text, black outline).
