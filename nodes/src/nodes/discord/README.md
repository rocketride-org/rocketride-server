# discord

A RocketRide source node that connects a Discord bot to your pipeline, routing incoming messages and attachments to typed lanes and posting the pipeline's answer back to Discord.

## What it does

A `source` node (`discord://`) that authenticates with a bot you create in the Discord Developer Portal and listens for messages over the Discord Gateway. Text is routed to the `text` lane; image, audio, video, and document attachments are each downloaded (up to a configurable size limit) and routed to the matching lane by MIME type. The pipeline's first non-empty answer is sent back to the originating channel — as a reply, a channel message, or in a thread — with all mentions suppressed so model output can never ping anyone.

The node uses **discord.py** to maintain a resilient Gateway connection with automatic heartbeating, resume, and reconnect. Attachments are downloaded through discord.py's `Attachment.read()` (which uses `aiohttp` transitively; it is not a direct dependency).

## Lanes

The node is a pipeline source: its `_source` lane emits one object per message and per attachment, routed by type.

| Lane in | Lane out | Description |
|---|---|---|
| `_source` | `text` | Message text, written as plain text. |
| `_source` | `image` | Image attachments, downloaded and routed with MIME type (e.g. `image/png`). |
| `_source` | `audio` | Audio attachments, downloaded with MIME type (e.g. `audio/mpeg`). |
| `_source` | `video` | Video attachments, downloaded with MIME type (e.g. `video/mp4`). |
| `_source` | `tags` | Documents (PDF, Word, archive, and so on), downloaded as tagged stream data; connect a Parser node downstream. |

Entry URLs are `discord://<channel_id>/<message_id>` for text and `discord://<channel_id>/<attachment_id>` for attachments.

## Configuration

See the **Schema** section below for the full field list, types, and defaults. Notes on the fields that shape behavior:

### replyMode

How the first answer is posted back: `reply` (a native reply to the message with no author ping — the default), `thread` (a single reused "Pipeline Response" thread on the message), or `channel` (a plain channel message). Answers longer than Discord's 2000-character limit are split on sentence and line boundaries across multiple messages, and all outbound content suppresses user, role, `@here`, and `@everyone` mentions.

### requireMention

When `true`, the bot only processes messages in which it is directly @mentioned; `@everyone` and `@here` do not count. Useful in high-traffic channels. When `false` (default) it processes every message that passes the allowlists.

### guildIds / channelIds

Server and channel allowlists. When non-empty, only messages from the listed guild/channel IDs are processed; leave both empty to listen everywhere the bot has access. IDs are matched as strings.

### maxAttachmentBytes

Attachments larger than this (default 25 MB) are skipped without being downloaded; the reported size is checked before the file is fetched.

### ignoreBots / sendResponses / showTyping

`ignoreBots` (default `true`) drops messages from other bots to prevent loops; the bot never processes its own messages regardless. `sendResponses` (default `true`), when set to `false`, still ingests every message into the pipeline but posts nothing back. `showTyping` (default `true`) shows a typing indicator while the pipeline runs.

The node tile shows connection status (pending or connected), and the monitor panel shows only the last 6 characters of the token so you can confirm which bot is connected without exposing the secret.

## Authentication

This node requires a Discord bot token. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications):

1. Open **Applications** and click **New Application**.
2. Name it and click **Create**.
3. Go to **Bot** and click **Add Bot**.
4. Under **TOKEN**, click **Copy** to get the bot token (keep it secret).
5. Enable **Message Content Intent** under **Privileged Gateway Intents**.
6. Add the bot to your servers with the OAuth2 URL generator (`bot` scope plus the permissions listed under Notes).

Paste the token into the `discord.botToken` field. A missing token, an invalid token, or a missing Message Content Intent fails the source with an actionable status rather than idling silently.

## Notes

### Prerequisites

- **Message Content Intent** must be enabled in the Developer Portal (`Bot > Privileged Gateway Intents`); without it `message.content` arrives empty. The node fails fast if the intent is missing.
- The bot needs **View Channels / Read Messages**, **Send Messages**, and **Read Message History** in the channels it serves. Apply them via the OAuth2 URL generator or per role/channel.
- For `thread` reply mode, the bot additionally needs **Create Public Threads** and **Send Messages in Threads**. In a DM or a channel that cannot host a thread, the node falls back to a plain reply.

### Message handling and replies

- The first non-empty pipeline answer — text first, then attachments in order — is posted back; if the pipeline produces no answer, nothing is sent.
- A message may carry up to 10 attachments. Every attachment is downloaded and routed into the pipeline (each counted independently); only the first non-empty answer is used for the reply.
- Long answers are chunked at Discord's 2000-character limit on sentence and line boundaries.
- Outbound content uses a restrictive allowed-mentions policy, so answer text cannot ping users, roles, `@here`, or `@everyone`.

### Attachments and MIME detection

- Each attachment's reported size is checked against `maxAttachmentBytes` before download; oversized files are skipped with a debug log.
- Files are routed by MIME type: the node uses Discord's reported `content_type` first (lowercased, with any `; charset=...` parameters stripped) and falls back to the file extension (e.g. `.pdf` maps to `application/pdf`); anything unrecognized defaults to `application/octet-stream` and flows to the `tags` lane.

### Reliability and limits

- **Rate limits**: discord.py handles Discord 429 responses internally (honoring `Retry-After` with backoff); the node keeps a defensive extra retry for any `RateLimited` it surfaces.
- **Lifecycle**: a terminal Gateway failure (invalid credentials, missing intent, or an unexpected disconnect) fails the source promptly; a successful start runs until the engine shuts the subprocess down.
- **No backfill**: the Gateway is push-based, so messages sent while the node is offline are not redelivered.
- **No edit/delete handling**: only `MESSAGE_CREATE` events are processed.
- **Byte accounting**: processed message and file sizes are reported via `monitorCompleted()` / `monitorFailed()`.

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
