# discord

A RocketRide source node that connects a Discord bot to your pipeline, routing incoming messages to typed lanes and returning pipeline answers to the sender.

## What it does

A `source` node (`discord://`) that authenticates with a bot you create in the Discord Developer Portal and listens for incoming messages via the Discord Gateway. It handles text and media alike: images, audio, video, and documents are each downloaded (up to a configurable size limit) and routed to the matching pipeline lane. The pipeline answer produced is sent back to the originating channel, as a reply, or in a thread—depending on configuration.

The node uses **discord.py** to maintain a resilient Gateway connection with automatic heartbeating, resume, and reconnect logic. Attachments are downloaded through discord.py's `Attachment.read()` (which uses `aiohttp` under the hood; it is pulled in transitively by discord.py, not a direct dependency).

---

## Configuration

### Lanes

The node is a pipeline source. Its `_source` lane emits to `text`, `image`, `audio`, `video`, and `tags`. Each Discord message type maps to one output lane:

| Discord message | Output lane | Notes |
|-----------------|-------------|-------|
| Text | `text` | Written as plain text. |
| Image attachment | `image` | Downloaded and routed with MIME type (e.g., `image/png`). |
| Audio attachment | `audio` | Downloaded with MIME type (e.g., `audio/mpeg`). |
| Video attachment | `video` | Downloaded with MIME type (e.g., `video/mp4`). |
| Document (PDF, Word, archive, etc.) | `tags` | Downloaded as tagged stream data; connect a Parser node downstream. |

Entry URLs are built as `discord://<channel_id>/<message_id>` for text and `discord://<channel_id>/<attachment_id>` for files.

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `botToken` | string | (required) | Discord bot token from the Developer Portal (keep secret). |
| `guildIds` | array[string] | empty | List of server IDs to listen to. Empty = listen to all servers the bot is in. |
| `channelIds` | array[string] | empty | List of channel IDs to listen to. Empty = listen to all channels. |
| `ignoreBots` | boolean | true | If true, messages from other bots are ignored to prevent loops. |
| `requireMention` | boolean | false | If true, the bot only responds when explicitly @mentioned. If false, responds to all messages. |
| `replyMode` | string | `reply` | How answers post back: `channel` (normal message), `reply` (reply to message), or `thread` (in a thread). |
| `showTyping` | boolean | true | If true, show a typing indicator while processing the pipeline. |
| `maxAttachmentBytes` | number | 26214400 | Max attachment size to download (default 25 MB). Larger files are skipped. |
| `sendResponses` | boolean | true | If true, send pipeline answers back to Discord. If false, only process messages. |

The node tile in the UI shows the connection status (pending or connected).

The monitor info panel shows the last 6 characters of the configured bot token so you can verify which bot is connected without exposing the full secret.

---

## Connection

The node uses the Discord Gateway to receive real-time message events. The gateway connection is maintained by **discord.py** with automatic heartbeating, resume on network hiccups, and exponential backoff on reconnect.

### Prerequisites

**Message Content Intent**: Discord requires the bot to have the **Message Content Intent** enabled in the Developer Portal. Without this intent, the `message.content` field arrives empty. Enable it in `Bot > Intents > Message Content Intent`.

**Permissions**: The bot must have the following permissions in the channels it listens to:
- **Read Messages / View Channels**
- **Send Messages**
- **Read Message History** (for reply context, if needed)

Apply these via the OAuth2 URL generator or by setting them on the role/channel directly.

---

## Replies

After a message runs through the pipeline, the first answer in the pipeline response is sent back to Discord. Long answers are automatically chunked at Discord's 2000-character limit using intelligent sentence/line boundaries.

### Reply modes

- **`reply`**: The bot replies directly to the message, with optional mention. Uses Discord's native reply threading.
- **`thread`**: The bot creates a thread on the original message and posts the answer inside.
- **`channel`**: The bot posts as a normal channel message.

If the pipeline produces no answers, nothing is sent.

### Limits & behavior

- **2000 character limit**: Discord's per-message limit. Long answers are split into multiple messages.
- **Multiple attachments per message**: A message may carry up to 10 attachments. Every attachment is downloaded and routed into the pipeline; only the first non-empty pipeline answer (text first, then attachments in order) is sent back as the reply.
- **Attachment download limit**: Configurable via `maxAttachmentBytes`. Files exceeding this limit are skipped with a debug log entry.
- **One answer per message** (as sent): Only the first pipeline answer is returned to the channel; additional answers are discarded.
- **Missing token**: If `botToken` is empty, the node reports `Discord Bot: missing bot token` in the monitor and stays idle.
- **Bot-loop prevention**: If `ignoreBots` is true (default), messages from other bots are ignored.
- **Typing indicator**: Shown during pipeline processing if `showTyping` is true. Improves UX for long-running pipelines.

---

## Attachments

### Download flow

1. User sends a message with attachments.
2. The node receives the `MESSAGE_CREATE` event from the Gateway.
3. For each attachment, the node checks its size against `maxAttachmentBytes`.
4. If under the limit, the node downloads the file from the Discord CDN via discord.py's `Attachment.read()`.
5. The file is routed to the appropriate lane (image, audio, video, or tags based on MIME type).
6. On failure (network, size, or permission), the attachment is skipped with a debug log and `monitorFailed()` call.

### MIME type detection

The node uses Discord's reported `content_type` first (with any parameters such as `; charset=utf-8` stripped), and falls back to guessing from the file extension (e.g., `.pdf` → `application/pdf`) when no content type is reported. Anything unrecognized defaults to `application/octet-stream`.

---

## Mentions & gating

### Mention requirement

If `requireMention` is true, the bot only processes messages in which it is explicitly @mentioned. Useful for high-traffic channels where you want to avoid processing every message.

### Guild & channel allowlists

- **`guildIds`**: If non-empty, the node only processes messages in these servers.
- **`channelIds`**: If non-empty, the node only processes messages in these channels.

Leave both empty to listen to all servers and channels the bot has access to.

---

## Limits & reliability

- **Rate-limit handling**: discord.py handles Discord 429 (Too Many Requests) responses internally, honoring `Retry-After` with automatic backoff and retry. The node keeps a defensive extra retry for any `RateLimited` the library surfaces.
- **No backfill on downtime**: The Gateway is push-based. Messages sent while the node is offline are not redelivered.
- **No edit/delete handling**: Only `MESSAGE_CREATE` events are processed. Edits and deletes are ignored.
- **Byte accounting**: Processed message and file sizes are reported to the monitor via `monitorCompleted()` / `monitorFailed()`.

---

## Authentication

This node requires a Discord bot token. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications):

1. Go to **Applications** and click **New Application**.
2. Name it and click **Create**.
3. Go to the **Bot** section and click **Add Bot**.
4. Under **TOKEN**, click **Copy** to get your bot token (keep it secret!).
5. Enable **Message Content Intent** under **Privileged Gateway Intents**.
6. Add the bot to your servers via the OAuth2 URL generator (select `bot` scope + permissions above).

Paste the token into the `discord.botToken` field.

---

## Error handling

- **Missing token**: Node reports status and stays idle.
- **Gateway connection failure**: discord.py automatically reconnects with exponential backoff.
- **Attachment download failure**: Logged via `debug()`, entry is skipped, byte count reported via `monitorFailed()`.
- **Rate limit**: 429 responses are handled by discord.py internally (honoring `Retry-After` with backoff/retry); a defensive extra retry covers any `RateLimited` the library surfaces.
- **Pipeline processing error**: Logged via `debug()`, message processing continues for other messages.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.source.parameters` |  | **Discord Bot Configuration** |  |
| `discord.botToken` | `string` | **Bot Token**<br/>Discord bot token from the Developer Portal (keep this secret - do not share) |  |
| `discord.guildIds` | `array` | **Server IDs (Guild IDs)**<br/>List of Discord server IDs to listen to. Leave empty to listen to all servers the bot is in. |  |
| `discord.channelIds` | `array` | **Channel IDs**<br/>List of channel IDs to listen to. Leave empty to listen to all channels. |  |
| `discord.ignoreBots` | `boolean` | **Ignore Bot Messages**<br/>If true (default), messages from other bots are ignored to prevent loops. | `true` |
| `discord.requireMention` | `boolean` | **Require @Mention**<br/>If true, the bot only responds when explicitly @mentioned. If false, responds to all messages. | `false` |
| `discord.replyMode` | `string` | **Reply Mode**<br/>How the bot sends answers: 'channel' (post as normal message), 'reply' (reply to the message), or 'thread' (post in a thread). | `"reply"` |
| `discord.showTyping` | `boolean` | **Show Typing Indicator**<br/>If true, show a typing indicator while processing the pipeline. | `true` |
| `discord.maxAttachmentBytes` | `number` | **Max Attachment Size (bytes)**<br/>Maximum size of attachments to download. Larger files are skipped. Default 25 MB. | `26214400` |
| `discord.sendResponses` | `boolean` | **Send Responses**<br/>If true, the bot sends pipeline answers back to Discord. If false, only processes messages. | `true` |

## Dependencies

- `discord.py` `>=2.4.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/discord)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
