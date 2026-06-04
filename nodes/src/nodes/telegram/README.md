# telegram

A Telegram Bot source node that receives messages from users via the Telegram Bot API and feeds them into a pipeline.

## What it does

This is a `source` node (`telegram://`) that connects to a bot created with @BotFather and listens for incoming messages. It supports text messages and media files — images, audio, voice, video, and documents — downloading each file (up to Telegram's 20 MB bot limit) and routing it to the matching pipeline lane. Pipeline responses are automatically sent back as replies to the originating chat.

It uses `_source` as its internal input and emits to these output lanes:

| Telegram message | Output lane |
| ---------------- | ----------- |
| Text             | `text`      |
| Photo            | `image`     |
| Audio / voice    | `audio`     |
| Video            | `video`     |
| Document (PDF, Word, etc.) | `tags` |

Updates can be delivered by **polling** (works anywhere without a public URL) or **webhook** (requires a public HTTPS endpoint that Telegram POSTs updates to).

## Setup

A Telegram bot token from @BotFather is required (e.g. `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`). It is stored as a secure field. For webhook mode you also need a public HTTPS URL.

## Configuration

| Field                | Default     | Description                                                                                  |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `telegram.botToken`  | *(required)* | Telegram bot token from @BotFather. Secure / encrypted at rest.                              |
| `telegram.mode`      | `polling`   | `polling` (no public URL needed) or `webhook` (requires a public HTTPS endpoint).            |
| `telegram.webhookUrl` | *(optional)* | Public HTTPS URL Telegram POSTs updates to (e.g. `https://your-server.com/telegram/webhook`). Required for `webhook` mode. |
