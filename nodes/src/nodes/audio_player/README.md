---
title: Audio Player
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Audio Player - RocketRide Documentation</title>
</head>

## What it does

Plays audio through the system's default output device in real time. Accepts raw audio or video (audio track extracted). Terminal node — no output lanes.

**Lanes:** `audio` → _(speakers)_, `video` → _(speakers)_

:::note
Not available in SaaS deployments — local only.
:::

## Configuration

No configuration options. Fixed playback settings:

| Parameter   | Value     |
| ----------- | --------- |
| Sample rate | 44,100 Hz |
| Channels    | Stereo    |
| Format      | PCM int16 |
| Latency     | Low       |
