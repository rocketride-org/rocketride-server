---
title: Frame Grabber
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Frame Grabber - RocketRide Documentation</title>
</head>

## What it does

Extracts still frames from video using one of three modes: fixed interval, scene transition, or keyframe.

**Lanes:**

| Lane in | Lane out    | Description                                                                       |
| ------- | ----------- | --------------------------------------------------------------------------------- |
| `video` | `image`     | Extracted frames as raw image data                                                |
| `video` | `table`     | Frame index, timestamp (seconds), and formatted time per frame                    |
| `video` | `documents` | Frames as base64-encoded image documents with frame number and timestamp metadata |

## Profiles

### Interval _(default)_

Extract frames at a fixed time interval.

| Field                | Default | Description                          |
| -------------------- | ------- | ------------------------------------ |
| Interval (seconds)   | `5`     | Time between extracted frames        |
| Start time (seconds) | `0`     | Where to begin extraction            |
| Duration (seconds)   | `0`     | How long to extract (0 = full video) |

### Transition

Extract frames when the scene changes by a threshold amount.

| Field                | Default  | Description                                                     |
| -------------------- | -------- | --------------------------------------------------------------- |
| Percentage change    | `40%`    | Pixel change threshold to trigger extraction (10–100%)          |
| Minimum scene gap    | disabled | Minimum seconds between extractions — prevents burst detections |
| Start time (seconds) | `0`      | Where to begin extraction                                       |
| Duration (seconds)   | `0`      | How long to extract (0 = full video)                            |
| Max frames           | `0`      | Cap on total frames extracted (0 = unlimited)                   |

### Keyframe

Extract at video keyframes (I-frames).

| Field                | Default | Description                                   |
| -------------------- | ------- | --------------------------------------------- |
| Start time (seconds) | `0`     | Where to begin extraction                     |
| Duration (seconds)   | `0`     | How long to extract (0 = full video)          |
| Max frames           | `0`     | Cap on total frames extracted (0 = unlimited) |
