# telegram

A RocketRide source node that connects a Telegram bot to your pipeline, routing incoming messages to typed lanes and returning pipeline answers to the sender.

## What it does

A `source` node (`telegram://`) that authenticates with a bot you create via @BotFather and listens for incoming messages. It handles text and media alike: photos, audio, voice notes, video, and documents are each downloaded (up to Telegram's 20 MB bot file limit) and routed to the matching pipeline lane. The first answer produced by the pipeline is sent back to the originating chat via `sendMessage` automatically.

Talks to the Telegram Bot API directly over **aiohttp** with no Telegram SDK dependency. In webhook mode the incoming POST route is served by the node's built-in FastAPI web server.

Both new and edited messages are processed. Unsupported message types (stickers, locations, polls, and so on) are silently ignored.

---

## Configuration

### Lanes

The node is a pipeline source. Its `_source` lane emits to `text`, `image`, `audio`, `video`, and `tags`. Each Telegram message type maps to one output lane:

| Telegram message | Output lane | Notes |
|------------------|-------------|-------|
| Text | `text` | Written as plain text. |
| Photo | `image` | The largest available photo size is downloaded; MIME type `image/jpeg`. |
| Audio | `audio` | MIME type from the message, default `audio/mpeg`. |
| Voice note | `audio` | MIME type from the message, default `audio/ogg`. |
| Video | `video` | MIME type from the message, default `video/mp4`. |
| Document (PDF, Word, etc.) | `tags` | Written as tagged stream data; connect a Parser node downstream. |

Entry URLs are built as `telegram://<chat_id>/<uuid>` for text messages and `telegram://<chat_id>/<file_id>` for files.

### Fields

| Field | Type | Description |
|---|---|---|
| `botToken` | string | Telegram bot token from @BotFather (e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11) |
| `mode` | string | Default "polling". Polling works anywhere without a public URL. Webhook requires a public HTTPS endpoint. |
| `webhookUrl` | string | Public HTTPS URL Telegram will POST updates to (e.g. https://your-server.com/telegram/webhook). Required for webhook mode. |

The node tile in the UI shows the currently configured mode.

The monitor info panel shows the last 6 characters of the configured bot token so you can verify which bot is connected without exposing the full secret.

---

## Connection modes

### Polling

The default. The node long-polls the Telegram `getUpdates` API in a background task using a 30-second server-side timeout and a batch size of up to 100 updates. The offset is advanced after each processed update, so acknowledged messages are never re-delivered. On network or API errors the loop sleeps 5 seconds then retries. Any previously registered webhook is cleared at startup because Telegram refuses `getUpdates` while a webhook is active.

### Webhook

For production deployments with a public HTTPS endpoint. At startup the node registers `telegram.webhookUrl` with Telegram via `setWebhook` along with a freshly generated random secret token. Incoming POSTs are validated against the `X-Telegram-Bot-Api-Secret-Token` header; requests with a wrong or missing secret are rejected with HTTP 403. Each accepted update is handled concurrently as a background task. In-flight handlers are awaited during shutdown, and the webhook is deregistered via `deleteWebhook` when the pipeline stops.

The local POST route is derived from the path portion of `telegram.webhookUrl`, falling back to `/telegram/webhook` if the URL contains no path. Your reverse proxy or tunnel must forward that path to the node's web server port.

---

## Replies

After a message runs through the pipeline, the first answer in the pipeline response is sent back to the originating chat. Replies longer than Telegram's 4096-character limit are truncated with a trailing ellipsis (`...`). If the pipeline produces no answers, nothing is sent. Reply failures are logged via `debug()` and never crash the update handler.

---

## Limits & behavior notes

- **20 MB file cap** -- Telegram's Bot API limit for downloads. The node checks the size reported by `getFile` and skips larger files silently.
- **One answer per message** -- only the first pipeline answer is returned to the chat; additional answers are discarded.
- **Missing token** -- if `telegram.botToken` is empty the node reports `Telegram Bot: missing bot token` in the monitor and stays idle.
- **Byte accounting** -- processed message and file sizes are reported to the monitor as completed or failed bytes via `monitorCompleted` / `monitorFailed`.

---

## Authentication

This node requires a Telegram bot token. Create a bot by messaging @BotFather on Telegram and following the `/newbot` flow. Copy the token BotFather provides and paste it into the `telegram.botToken` field.

No additional OAuth or API key registration is needed beyond the bot token.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.source.parameters` |  | **Bot Configuration** |  |
| `telegram.botToken` | `string` | **Bot Token**<br/>Telegram bot token from @BotFather (e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11) |  |
| `telegram.mode` | `string` | **Connection Mode**<br/>Polling works anywhere without a public URL. Webhook requires a public HTTPS endpoint. | `"polling"` |
| `telegram.webhookUrl` | `string` | **Webhook URL**<br/>Public HTTPS URL Telegram will POST updates to (e.g. https://your-server.com/telegram/webhook). Required for webhook mode. |  |

## Dependencies

- `aiohttp` `>=3.13.5`
- `requests`
- `fastapi`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/telegram)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
