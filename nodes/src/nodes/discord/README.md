# discord

A configurable, bidirectional Discord I/O source that routes messages, attachments, and optional reaction events into a pipeline and can post pipeline answers back to Discord.

## What it does

A `source` node (`discord://`) that authenticates with a bot you create in the Discord Developer Portal and listens for messages over the Discord Gateway. Text is routed to the `text` lane; image, audio, video, and document attachments are each downloaded (up to a configurable size limit) and routed to the matching lane by MIME type. The pipeline's first non-empty answer is sent back to the originating channel — as a reply, a channel message, or in a thread. Mentions are suppressed by default; explicit user and role allowlists can selectively enable them, while `@everyone` and `@here` always remain disabled. Every emitted object carries Discord message metadata and a correlation ID so downstream branches can store, evaluate, or merge related content without bot-specific logic.

The node uses **discord.py** to maintain a resilient Gateway connection with automatic heartbeating, resume, and reconnect. Attachments are downloaded through discord.py's `Attachment.read()` (which uses `aiohttp` transitively; it is not a direct dependency).

## Lanes

The node is a pipeline source: its `_source` lane emits one object per message and per attachment, routed by type.

| Lane in | Lane out | Description |
|---|---|---|
| `_source` | `text` | Message text and configured text-like attachments, written as plain text. |
| `_source` | `image` | Image attachments, downloaded and routed with MIME type (e.g. `image/png`). |
| `_source` | `audio` | Audio attachments, downloaded with MIME type (e.g. `audio/mpeg`). |
| `_source` | `video` | Video attachments, downloaded with MIME type (e.g. `video/mp4`). |
| `_source` | `tags` | Documents (PDF, Word, archive, and so on), downloaded as tagged stream data; connect a Parser node downstream. |

Entry URLs are `discord://<channel_id>/<message_id>` for text and `discord://<channel_id>/<message_id>/<attachment_id>` for attachments. Text objects are named with the message ID; attachment objects use `<message_id>:<index>`. Metadata includes message/channel/thread/guild/author IDs, mentions, reply reference, attachment summaries, and `correlationId`, `groupIndex`, and `groupSize` fields shared by all objects from one message. Member display names and role IDs are opt-in.

## Configuration

See the **Schema** section below for the full field list, types, and defaults. Notes on the fields that shape behavior:

### replyMode

How the first answer is posted back: `reply` (a native reply to the message with no author ping — the default), `thread` (a single reused thread on the message), or `channel` (a plain channel message). `threadName` accepts `{content}`, `threadNameMaxLength` limits the resolved name (Discord accepts 1 to 100 characters, so a value outside that range is clamped to it), and `threadAutoArchiveMinutes` sets Discord's archive duration for threads the node creates — Discord accepts only `60`, `1440`, `4320`, and `10080`, so the field offers just those plus `0`; `0` (the default) or any other value that still reaches the node is omitted and the channel's own default applies, with a debug line for an unsupported non-zero value. `{content}` resolves to the message text, or — for a message that carries only files — the first attachment's filename, before the length cap is applied; with neither, the name falls back to `Pipeline Response`. If the thread cannot be created (usually a missing **Create Public Threads** permission) the failure is logged and that chunk, plus the rest of the answer, is posted as a plain reply with destination `reply`, so a permission gap costs the thread rather than the whole answer.

Answers longer than Discord's 2000-character limit are split on sentence and line boundaries; fenced code blocks are closed and reopened across message boundaries. With `numberChunks` enabled, a reply that needs more than one message ends each one with `*(2/3)*` so a reader sees the order; the label is paid for by the split, so every chunk still fits the 2000-character limit, and a reply that fits in one message is never labelled.

### requireMention

When `true`, the bot only processes messages in which it is directly @mentioned; `@everyone` and `@here` do not count. Useful in high-traffic channels. When `false` (default) it processes every message that passes the allowlists.

`requireMentionChannelIds` applies that gate only in selected channels. Both it and `channelIds` recognize a thread's parent channel ID. `allowedBotIds` permits selected bot accounts through while `ignoreBots` remains enabled; the Discord bot still never processes its own messages.

### guildIds / channelIds

Server and channel allowlists. When non-empty, only messages from the listed guild/channel IDs are processed; leave both empty to listen everywhere the bot has access. IDs are matched as strings. Direct messages are answered only while both lists are empty; setting either one stops DMs. Setting `guildIds` is recommended in production, together with turning off **Public Bot** (see Authentication), because with it empty the bot answers in any server it is added to.

### Attachments and events

`textAttachmentExtensions` and `textAttachmentMaxChars` control which attachments are decoded as UTF-8 and sent through the text lane; once any extension is listed, any `text/*` MIME is also treated as text, and with the list empty (the default) every attachment is routed as a binary object. `mergeAttachments` (default `false`) makes a message that carries text plus attachments produce one answer that has seen everything — see below. `emitReactions`, `emitNoReply`, and `emitOutbound` add generic tagged event objects for inbound reaction changes, unanswered/error outcomes, and sent replies. With `emitOutbound` on, every posted answer produces an `outbound` event carrying the posted message IDs, the destination, the answer text and `complete`, which is `false` when a later chunk failed after earlier ones were posted (Discord then shows only part of the answer). When `sendResponses` is `false` and `emitOutbound` is on, an answer produces an `outbound` event with no message IDs and `destination: "suppressed"`, so shadow deployments can record what the bot would have said. An answer that was meant to be posted but could not be — every chunk failed, usually a missing **Send Messages** permission — produces no `outbound` event; with `emitNoReply` on it produces a `no_reply` with reason `send_failed` instead. Both flags are off by default. Every `no_reply` reason is clipped to 200 characters, because a reason built from an exception message would otherwise be unbounded. Every object the node opens (messages, attachments, and the `reaction`, `no_reply`, and `outbound` events) is also broadcast as an `apaevt_sse` event of type `discord` (`{schemaVersion: 1, eventType, metadata, ...payload}`), so a UI subscribed to `SSE` on the task can follow the conversation without reading pipeline traces. The broadcast is not live-only: the engine also writes every SSE body into the task's run log, so it is visible to every client monitoring the task and is kept in the run log afterwards.

### What message text is broadcast and stored

The node puts Discord message text into the `apaevt_sse` bodies, and therefore into the task's run log, in exactly three places:

- the question text, in the `text` field of each `message` event for the text lane (clipped at 2000 characters). With `mergeAttachments` on, a message that has no text of its own carries the merged question instead, which includes the folded text-file contents and what the pipeline found in the other attachments;
- the decoded contents of each text-like attachment (one `textAttachmentExtensions` selects), framed with its filename, in the `text` field of its own `message` event when `mergeAttachments` is off (clipped at 2000 characters);
- the answer text, in the `text` field of each `outbound` event (only when `emitOutbound` is on).

Binary attachments are never broadcast, only their MIME type and size. Every event's `metadata` also carries Discord IDs and attachment filenames, plus display names and role IDs when `includeMemberMetadata` is on, and a `no_reply` reason can quote an exception message. Operators need this list for their privacy notice: anyone who can monitor the task, and anyone who can read its run log, can read these messages.

### mergeAttachments

A Discord message is one question even when it carries files, so with `mergeAttachments` enabled the node answers it once. A text-like attachment (one `textAttachmentExtensions` selects) is no longer asked about on its own: its content is folded into the message text as a `Contents of attached file "<name>":` block (fenced, capped by `textAttachmentMaxChars`, with a `… (truncated)` line when the cap bites; a file that turns out to hold binary content — a NUL byte — is skipped). Image, audio, video, and other attachments still run first, each as its own lane object with the same metadata and `message` SSE event as before, and every non-empty answer they produce is folded into the question as a `What the pipeline found in the attached <image|audio|video|file> "<name>":` block. The single text pass that follows sees the user's words, the file contents, and what the other lanes made of the media, and its answer is the reply. A message that carries only files is prefixed with `The user shared the following file(s) with no message. Explain what each file is and what it does, and help them with it.` so the pipeline is given a task rather than a bare document. If the text pass produces nothing, the first non-empty attachment answer is posted instead.

`groupSize` then counts the objects the message actually produces: the text pass is index 0, the remaining attachments follow in attachment order from index 1, and folded text files no longer count. (The count is decided before the attachment objects are pushed, so in the one case where nothing is left to ask — no text, no text file, and no attachment answer — the objects already pushed carry a `groupSize` one higher than the objects that existed.)

With `mergeAttachments` off (the default) the node keeps its original behavior: the text and every attachment are asked independently and the first non-empty answer overall — text first, then attachments in order — is posted.

Reaction capture requires the reactions intent and covers human reactions only: a reaction whose user is the bot itself never produces a `reaction` event. Reactions are scoped exactly like messages: `guildIds`, `channelIds` (matching a thread's parent channel as well), and `ignoreBots`/`allowedBotIds` all apply, so a reaction from outside the node's scope is dropped rather than emitted. A reaction whose channel cannot be resolved is dropped while `channelIds` is set, because there is then no way to tell whether it is in scope; a reactor neither the payload nor the user cache knows is treated as a human. `includeMemberMetadata` adds display names and member/mentioned role IDs and requires the privileged members intent. `allowedMentionUserIds` and `allowedMentionRoleIds` are the only outbound mention exceptions; leaving them empty preserves suppress-all behavior. Both lists keep digit-only Discord IDs: any other entry is dropped with a debug line, because a single non-numeric entry would otherwise fail every outbound send and silence the bot entirely. An entry that is still an unresolved variable (`${NAME}` or `<REDACTED>`) is dropped too, with a warning in the task's warnings naming the field.

### maxAttachmentBytes

Attachments larger than this (default 25 MB, at most 100 MB) are skipped without being downloaded; the reported size is checked before the file is fetched. At most `maxConcurrentMessages` messages (default 4, 1 to 32) are processed at once, downloads included, so memory stays bounded; further messages wait their turn rather than being dropped.

### ignoreBots / sendResponses / showTyping

`ignoreBots` (default `true`) drops messages from other bots to prevent loops; the bot never processes its own messages regardless. `sendResponses` (default `true`), when set to `false`, still ingests every message into the pipeline but posts nothing back. `showTyping` (default `true`) shows a typing indicator while the pipeline runs.

The node tile shows whether a bot token is configured (`Token: configured` or `Token: missing`); it does not report whether the bot connected, which the task's status line does. The monitor panel shows only the last 6 characters of the token so you can confirm which bot is connected without exposing the secret.

## Authentication

This node requires a Discord bot token. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications):

1. Open **Applications** and click **New Application**.
2. Name it and click **Create**.
3. Go to **Bot** and click **Add Bot**.
4. Under **TOKEN**, click **Copy** to get the bot token (keep it secret).
5. Enable **Message Content Intent** under **Privileged Gateway Intents**. Also enable **Server Members Intent** when using member metadata.
6. Still under **Bot**, turn off **Public Bot** unless anyone should be able to add the bot to their own server. A new application is public by default.
7. Add the bot to your servers with the OAuth2 URL generator (`bot` scope plus the permissions listed under Notes).

Paste the token into the `discord.botToken` field. In production, also set `guildIds` to the servers the bot should serve: with it empty (the default) the bot answers in every server it is added to, and the node says so in the task's warnings at start. A missing token, an invalid token, or a missing Message Content Intent fails the source with an actionable status rather than idling silently.

## Notes

### Prerequisites

- **Message Content Intent** must be enabled in the Developer Portal (`Bot > Privileged Gateway Intents`); without it `message.content` arrives empty. The node fails fast if the intent is missing.
- The bot needs **View Channels / Read Messages**, **Send Messages**, and **Read Message History** in the channels it serves. Apply them via the OAuth2 URL generator or per role/channel.
- For `thread` reply mode, the bot additionally needs **Create Public Threads** and **Send Messages in Threads**. In a DM or a channel that cannot host a thread — or when creating the thread is refused — the node falls back to a plain reply.

### Message handling and replies

- Discord's own system notices (joins, pins, boosts, "started a thread") and messages with neither text nor attachments are dropped before any gate or pipeline work: there is nothing in them to answer.
- With `mergeAttachments` on, one answer is posted per message: the text pass that has seen the folded files and the other lanes' answers. With it off, the first non-empty pipeline answer — text first, then attachments in order — is posted back. Optional `no_reply` and `outbound` event objects make those outcomes observable downstream.
- A message may carry up to 10 attachments. Every attachment is downloaded and routed into the pipeline (each counted independently); a text-like attachment is folded into the text pass rather than routed on its own while merging is on.
- Long answers are chunked at Discord's 2000-character limit on sentence and line boundaries.
- Outbound content uses a restrictive allowed-mentions policy. Only configured user and role IDs can be pinged; `@here` and `@everyone` are never enabled.

### Attachments and MIME detection

- Each attachment's reported size is checked against `maxAttachmentBytes` before download; oversized files are skipped with a debug log.
- Files are routed by MIME type: the node uses Discord's reported `content_type` first (lowercased, with any `; charset=...` parameters stripped) and falls back to the file extension (e.g. `.pdf` maps to `application/pdf`); anything unrecognized defaults to `application/octet-stream` and flows to the `tags` lane.
- When `textAttachmentExtensions` lists any extension, those files and `text/*` MIME attachments are decoded with invalid UTF-8 ignored, capped by `textAttachmentMaxChars`, framed with their filename, and sent through the text lane — folded into the message's own text pass while `mergeAttachments` is on, or as their own object when it is off.

### Reliability and limits

- **Rate limits**: discord.py handles Discord 429 responses internally (honoring `Retry-After` with backoff); the node keeps a defensive extra retry for any `RateLimited` it surfaces.
- **Configuration errors**: a list setting that starts with `[` but is not valid JSON is reported in the task's warnings with the setting's name. In `guildIds`, `channelIds` or `requireMentionChannelIds` it fails the start instead, since the bot would otherwise answer nothing (or, for the mention list, answer without the mention). Only `ROCKETRIDE_*` server variables are resolved: an unset `${ROCKETRIDE_NAME}` reaches the node as literal text, and any other `${NAME}` as the literal `<REDACTED>`. Either one in `botToken`, `guildIds`, `channelIds`, or `requireMentionChannelIds` fails the start naming the problem (for example `Discord Bot: <field> uses the variable <NAME>, which is not set on this server (only ROCKETRIDE_* server variables are resolved)`), because it would match nothing (in `requireMentionChannelIds`, the mention gate would silently never apply). In `allowedBotIds`, `allowedMentionRoleIds`, or `allowedMentionUserIds` it produces a warning naming the field. JSON list items are trimmed and split on commas and whitespace, like a bare string.
- **Lifecycle**: a terminal Gateway failure (invalid credentials, missing intent, or an unexpected disconnect) fails the source promptly; a successful start runs until the engine shuts the subprocess down.
- **No edit/delete handling**: only `MESSAGE_CREATE` events are processed.
- **Byte accounting**: processed message and file sizes are reported via `monitorCompleted()` / `monitorFailed()`.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.source.parameters` |  | **Discord Bot Configuration** |  |
| `discord.allowedBotIds` | `array` | **Allowed Bot IDs**<br/>Bot user IDs allowed through when Ignore Bot Messages is enabled. | `[]` |
| `discord.allowedMentionRoleIds` | `array` | **Allowed Mention Role IDs**<br/>Role IDs that outbound pipeline responses may mention. | `[]` |
| `discord.allowedMentionUserIds` | `array` | **Allowed Mention User IDs**<br/>User IDs that outbound pipeline responses may mention. | `[]` |
| `discord.botToken` | `string` | **Bot Token**<br/>Discord bot token from the Developer Portal (keep this secret - do not share) |  |
| `discord.channelIds` | `array` | **Channel IDs**<br/>List of channel IDs to listen to. Leave empty to listen to all channels. |  |
| `discord.emitNoReply` | `boolean` | **Emit No Reply Events**<br/>Emit an event when processing produces no answer or raises an error. | `false` |
| `discord.emitOutbound` | `boolean` | **Emit Outbound Events**<br/>Emit an event after posting a pipeline response to Discord. | `false` |
| `discord.emitReactions` | `boolean` | **Emit Reactions**<br/>Emit raw reaction add and remove events into the pipeline. | `false` |
| `discord.guildIds` | `array` | **Server IDs (Guild IDs)**<br/>List of Discord server IDs to listen to. Leave empty to listen to all servers the bot is in. |  |
| `discord.ignoreBots` | `boolean` | **Ignore Bot Messages**<br/>If true (default), messages from other bots are ignored to prevent loops. | `true` |
| `discord.includeMemberMetadata` | `boolean` | **Include Member Metadata**<br/>Include display names and role IDs; requires the Discord members intent. | `false` |
| `discord.maxAttachmentBytes` | `number` | **Max Attachment Size (bytes)**<br/>Maximum size of attachments to download. Larger files are skipped. Default 25 MB. | `26214400` |
| `discord.mergeAttachments` | `boolean` | **Merge attachments into the question**<br/>When enabled, text-like files are folded into the message text and the answers the pipeline gives for image, audio, and video attachments are folded in as context before the text pass, so one reply covers everything. When disabled (the default), text and every attachment are asked separately and the first non-empty answer wins. | `false` |
| `discord.numberChunks` | `boolean` | **Number Reply Chunks**<br/>When an answer is too long for one Discord message, end each message with its position, for example (2/3). A reply that fits in one message is never labelled. | `false` |
| `discord.replyMode` | `string` | **Reply Mode**<br/>How the bot sends answers: 'channel' (post as normal message), 'reply' (reply to the message), or 'thread' (post in a thread). | `"reply"` |
| `discord.requireMention` | `boolean` | **Require @Mention**<br/>If true, the bot only responds when explicitly @mentioned. If false, responds to all messages. | `false` |
| `discord.requireMentionChannelIds` | `array` | **Require Mention Channel IDs**<br/>Channels (or thread parent channels) where a direct bot mention is always required. | `[]` |
| `discord.sendResponses` | `boolean` | **Send Responses**<br/>If true, the bot sends pipeline answers back to Discord. If false, only processes messages. | `true` |
| `discord.showTyping` | `boolean` | **Show Typing Indicator**<br/>If true, show a typing indicator while processing the pipeline. | `true` |
| `discord.textAttachmentExtensions` | `array` | **Text Attachment Extensions**<br/>Filename extensions decoded as UTF-8 and routed through the text lane, for example .pipe, .json, .log, .md, .txt, .csv, .yaml, .yml. Once any extension is listed, text/* files are decoded too. Empty (the default): every attachment is routed as a binary object. | `[]` |
| `discord.textAttachmentMaxChars` | `number` | **Text Attachment Max Characters**<br/>Maximum decoded characters folded into the text lane per attachment. | `12000` |
| `discord.threadAutoArchiveMinutes` | `number` | **Thread Auto Archive Minutes**<br/>Discord auto-archive duration, in minutes, for response threads the node creates. Discord accepts only 60, 1440, 4320 or 10080; 0 (the default) uses the channel's own default. | `0` |
| `discord.threadName` | `string` | **Thread Name**<br/>Name template for response threads. {content} is replaced with the triggering message text. | `"Pipeline Response"` |
| `discord.threadNameMaxLength` | `number` | **Thread Name Max Length**<br/>Maximum number of characters in a resolved response thread name. Discord accepts 1 to 100. | `90` |

## Dependencies

- `discord.py` `>=2.4.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/discord)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
