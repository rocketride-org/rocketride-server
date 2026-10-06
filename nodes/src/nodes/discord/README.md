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
| `_source` | `tags` | Documents (PDF, Word, archive, and so on), downloaded as tagged stream data; connect a Parser node downstream. Also carries one JSON event object per `reaction`, `no_reply`, or `outbound` event while the matching `emitReactions`, `emitNoReply`, or `emitOutbound` setting is on, so a Parser on `tags` sees those events too. |

Entry URLs are `discord://<channel_id>/<message_id>` for text, `discord://<channel_id>/<message_id>/<attachment_id>` for attachments, and `discord://<channel_id>/<message_id>/<event_type>` for events. Text objects are named with the message ID; attachment objects use `<message_id>:<index>` and events `<message_id>:<event_type>`. Metadata includes message/channel/thread/guild/author IDs, mentions, reply reference, attachment summaries, and `correlationId`, `groupIndex`, and `groupSize` fields shared by all objects from one message. Member display names and role IDs are opt-in.

## Configuration

See the **Schema** section below for the full field list, types, and defaults. Notes on the fields that shape behavior:

The support-bot settings (from **Thread History Limit** to **Pipeline Timeout (seconds)** below) are all off by default, so the node stays a generic Discord I/O source; a support-style app turns on the ones it wants.

### Reply Mode

How the first answer is posted back: `reply` (a native reply to the message with no author ping — the default), `thread` (a single reused thread on the message), or `channel` (a plain channel message). `threadName` accepts `{content}`, `threadNameMaxLength` limits the resolved name (Discord accepts 1 to 100 characters, so a value outside that range is clamped to it), and `threadAutoArchiveMinutes` sets Discord's archive duration for threads the node creates — Discord accepts only `60`, `1440`, `4320`, and `10080`, so the field offers just those plus `0`; `0` (the default) or any other value that still reaches the node is omitted and the channel's own default applies, with a debug line for an unsupported non-zero value. `{content}` resolves to the message text, or — for a message that carries only files — the first attachment's filename, before the length cap is applied; with neither, the name falls back to `Pipeline Response`. If the thread cannot be created (usually a missing **Create Public Threads** permission) the failure is logged and that chunk, plus the rest of the answer, is posted as a plain reply with destination `reply`, so a permission gap costs the thread rather than the whole answer.

If the question is deleted before the answer is posted, nothing is posted in `reply` mode or in `thread` mode (the thread cannot be created on a deleted message, and its fallback is a reply too), and with `emitNoReply` on the outcome is a `no_reply` with reason `send_failed`. `channel` mode does not reference the question, so it still posts.

### Number Reply Chunks

Answers longer than Discord's 2000-character limit are split on sentence and line boundaries; fenced code blocks are closed and reopened across message boundaries. With `numberChunks` enabled, a reply that needs more than one message ends each one with `*(2/3)*` so a reader sees the order; the label is paid for by the split, so every chunk still fits the 2000-character limit, and a reply that fits in one message is never labelled.

### Require @Mention

When `true`, the bot only processes messages in which it is directly @mentioned; `@everyone` and `@here` do not count. Useful in high-traffic channels. When `false` (default) it processes every message that passes the allowlists.

`requireMentionChannelIds` applies that gate only in selected channels, and recognizes a thread's parent channel ID.

### Server IDs (Guild IDs) / Channel IDs

Server and channel allowlists. When non-empty, only messages from the listed guild/channel IDs are processed; leave both empty to listen everywhere the bot has access. IDs are matched as strings, and every entry must be a numeric Discord ID (see **Configuration errors** under Notes). `channelIds` recognizes a thread's parent channel ID. Direct messages are answered only while both lists are empty; setting either one stops DMs. Setting `guildIds` is recommended in production, together with turning off **Public Bot** (see Authentication), because with both lists empty the bot answers in any server it is added to.

### Ignore Bot Messages / Allowed Bot IDs

`ignoreBots` (default `true`) drops messages from other bots to prevent loops; the bot never processes its own messages regardless. `allowedBotIds` permits selected bot accounts through while `ignoreBots` remains enabled.

### Send Responses / Show Typing Indicator

`sendResponses` (default `true`), when set to `false`, still ingests every message into the pipeline but posts nothing back. `showTyping` (default `true`) shows a typing indicator while the pipeline runs.

### Max Attachment Size (bytes)

Attachments larger than this (default 25 MB, at most 100 MB; a larger value is clamped to 100 MB, and `0` or a negative value means the default) are skipped without being downloaded; the reported size is checked before the file is fetched.

### Max Concurrent Messages

At most `maxConcurrentMessages` messages (default 4, 1 to 32) are processed at once, downloads included, so memory stays bounded; further messages wait their turn rather than being dropped. The limit is shared by every server and channel the bot serves, so slow pipelines delay all of them, and a message waiting for its turn shows no typing indicator yet. Values above 8, the size of the node's own pool the pipeline calls run on (see **Pipeline Timeout (seconds)**), do not make more pipelines run in parallel.

### Text Attachment Extensions / Text Attachment Max Characters

`textAttachmentExtensions` and `textAttachmentMaxChars` control which attachments are decoded as text and sent through the text lane; once any extension is listed, any `text/*` MIME is also treated as text, and with the list empty (the default) every attachment is routed as a binary object. An extension may be written with or without its leading dot (`md` and `.md` both match `notes.md`), in any case.

### Merge attachments into the question

A Discord message is one question even when it carries files, so with `mergeAttachments` enabled the node answers it once. A text-like attachment (one `textAttachmentExtensions` selects) is no longer asked about on its own: its content is folded into the message text as a `Contents of attached file "<name>":` block (fenced, capped by `textAttachmentMaxChars`, with a `… (truncated)` line when the cap bites; a file that turns out to hold binary content — a NUL byte — is routed as a binary attachment instead, below). Image, audio, video, and other attachments still run first, each as its own lane object with the same metadata and `message` SSE event as before, and every non-empty answer they produce is folded into the question as a `What the pipeline found in the attached <image|audio|video|file> "<name>":` block. The single text pass that follows sees the user's words, the file contents, and what the other lanes made of the media, and its answer is the reply. A message that carries only files is prefixed with `The user shared the following file(s) with no message. Explain what each file is and what it does, and help them with it.` so the pipeline is given a task rather than a bare document. If the text pass produces nothing, the first non-empty attachment answer is posted instead.

`groupSize` then counts the objects the message actually produces: the text pass is index 0, the remaining attachments follow in attachment order from index 1, and folded text files no longer count. (The count is decided before the attachment objects are pushed, so in the one case where nothing is left to ask — no text, no text file, and no attachment answer — the objects already pushed carry a `groupSize` one higher than the objects that existed.)

With `mergeAttachments` off (the default) the node keeps its original behavior: the text and every attachment are asked independently and the first non-empty answer overall — text first, then attachments in order — is posted.

### Emit Reactions

`emitReactions` adds a `reaction` event object for every reaction added to or removed from a message. The reactions Gateway intent is not privileged, and the node turns it on itself when this setting is on, so nothing needs enabling in the Developer Portal. Reaction capture covers human reactions only: a reaction whose user is the bot itself — including the `feedbackEmojis` the node adds to its own answers — never produces a `reaction` event, so a subscriber does not read the affordance as a grade. Reactions are scoped exactly like messages: `guildIds`, `channelIds` (matching a thread's parent channel as well), and `ignoreBots`/`allowedBotIds` all apply, so a reaction from outside the node's scope is dropped rather than emitted. A reaction whose channel cannot be resolved is dropped while `channelIds` is set, because there is then no way to tell whether it is in scope; a reactor neither the payload nor the user cache knows is treated as a human. Reactions that arrive once shutdown has begun are dropped.

### Emit No Reply Events / Emit Outbound Events

`emitNoReply` and `emitOutbound` add event objects for unanswered/error outcomes and for sent replies. Both are off by default.

With `emitOutbound` on, every posted answer produces an `outbound` event carrying the posted message IDs, the destination, the answer text and `complete`, which is `false` when a later chunk failed after earlier ones were posted (Discord then shows only part of the answer). When **Feedback Reactions** applied any emojis, they are listed as `feedbackEmojis`. When `sendResponses` is `false` and `emitOutbound` is on, an answer produces an `outbound` event with no message IDs and `destination: "suppressed"`, so shadow deployments can record what the bot would have said. An answer that was meant to be posted but could not be — every chunk failed, usually a missing **Send Messages** permission or a deleted question — produces no `outbound` event.

With `emitNoReply` on, a message that ends without a posted answer produces a `no_reply` event whose `reason` is one of:

- `no_answer`: the pipeline produced no answer;
- `send_failed`: there was an answer, but every chunk failed to post;
- `shutdown`: shutdown began while the message waited for its turn, so it was never processed;
- `paused`: the message arrived in a thread paused by **Pause After Escalation**;
- `aimed_elsewhere`: **Ignore Messages Aimed At Others** skipped the message;
- `non_answer`: **Sanitize Replies** left nothing postable in the answer, on every retry;
- `model_error`: the answer (or a retry's) was recognised as an engine or model error (see **Error answers are never posted**);
- `timeout`: a pipeline run passed **Pipeline Timeout (seconds)**;
- any other value: the error message of the first pipeline or download error, or of an unexpected failure, clipped to 200 characters (a reason built from an exception message would otherwise be unbounded).

### Include Member Metadata

`includeMemberMetadata` adds display names and member/mentioned role IDs to the metadata and requires the privileged **Server Members Intent** (see Authentication).

### Allowed Mention User IDs / Allowed Mention Role IDs

`allowedMentionUserIds` and `allowedMentionRoleIds` are the only outbound mention exceptions; leaving them empty preserves suppress-all behavior. Both lists keep plain ASCII-digit Discord IDs: any other entry is dropped with a debug line, because a single non-numeric entry would otherwise fail every outbound send and silence the bot entirely. An entry that is still an unresolved variable (`${NAME}` or `<REDACTED>`) is dropped too, with a warning in the task's warnings naming the field.

### Backfill Limit

Disabled by default (`0`). `backfillLimit` processes the most recent N messages per configured channel (or, with no channel allowlist, every readable text channel in the allowed guilds), oldest first, at startup, through the same gates and processing path as live messages. A channel whose history cannot be read is logged with its ID and skipped, and the remaining channels are still replayed. On a restart, backfill skips what the bot already answered, judged from the window it fetched: a message that has a thread (in `thread` mode), a message one of the bot's messages in the window replies to, and, in `channel` mode, every message before the bot's latest post in that channel. The node also remembers the last 1000 message ids it handled, shared by the live path and backfill, so a message that arrives live while its channel is still waiting to be backfilled is answered once. That memory is in-process only: an unanswered message older than the window is not replayed, and one the bot answered in a way the window does not show (for example a reply that has scrolled out of it) can be answered again. Backfilled messages wait for a **Max Concurrent Messages** slot like any other, and once shutdown has begun none are processed.

### Thread History Limit / Thread History Max Characters

When a message arrives in a thread and `threadHistoryLimit` is greater than zero, the node fetches up to that many messages from before the one being answered — the limit counts earlier messages, so `threadHistoryLimit: 1` gives one line of context — drops system and empty ones, orders them oldest first (a thread the bot made from a message in `thread` mode opens with an empty starter message; the original question in the parent channel is shown in its place, and left out if it cannot be read), and renders one `<name>: <content>` line each — the bot's own messages under its display name, everyone else under their username. The text handed to the pipeline becomes `User's latest message: <content>` followed by `Earlier in this thread (oldest first, for context):` and the transcript; a transcript longer than `threadHistoryMaxChars` keeps its tail behind an `…` line. The `message` SSE event still carries the user's own words in `text` and reports the transcript size in `contextChars`. A failed history fetch is logged and the message is processed without context.

### Pause After Escalation / Escalation Markers

With `escalationPause` enabled, an answer posted into a thread that contains an escalation marker pauses that thread: further messages there are ignored until somebody writes an @mention of the bot in their message, which resumes it. Only a mention in the text counts: Discord's **Reply** (with its ping on, the default) notifies the bot without one, so replying "ok thanks" to the hand-off line keeps the thread paused. There is no role check: any member of the thread can resume it this way (and, with `ignoreAimedAtOthers` on, pause it by addressing somebody else). The effective markers are `escalationMarkers` plus a role mention for every id in `allowedMentionRoleIds` (a role the node may ping is the team it hands off to). Each `escalationMarkers` entry is one phrase, kept whole: spaces and commas inside it do not split it. The pause set is in-memory, so the first time this process sees a thread it reconstructs the state from the last 50 messages — a bot message with a marker pauses, a later message whose text mentions the bot resumes — and a skipped message emits a `no_reply` event with reason `paused`. If that history cannot be read the outcome is *unknown* rather than "not paused": the message in hand is answered, but the thread stays unreconciled so the next message tries again instead of being fixed as open for the life of the process.

While `escalationPause` is on, messages that arrive in the same thread are handled one at a time, so a follow-up that arrives while an escalating answer is still being produced is checked against the pause *after* that answer has been posted — otherwise both would be answered. Messages in different threads, and every message when the pause is off, are processed concurrently as before.

A message skipped as `paused` (or as `aimed_elsewhere`, below) is never ingested, so no `message` event describes it. Its `no_reply` payload therefore also carries `text` — the message content, clipped at 2000 characters, exactly as a `message` event would report it — so a team member's reply inside a paused thread is still recorded downstream. Every other `no_reply` reason keeps its `{reason}` payload, because the question it belongs to already has a `message` event.

### Team Mention Alias

`teamMentionAlias` makes the hand-off actually ping somebody. A prompt usually tells the agent to escalate by writing a literal team name, which Discord renders as plain text; when the alias is set and `allowedMentionRoleIds` is not empty, every case-insensitive occurrence of it in an answer (whitespace inside the alias matches any run of whitespace, so `@RocketRide team` matches across a line break) becomes `<@&id>` for the **first** allowed role id. The substitution is made only on the text that is finally posted, after reply hygiene, so leaked reasoning that merely names the team never pings it; the injected mention still pauses the thread, because escalation detection after the send sees it. In a scratchpad reply the alias counts as an escalation marker on the final hand-off line, so the hand-off line keeps it and it becomes the ping. It applies whether or not `sanitizeReplies` is on; the default (empty) leaves answers untouched.

### Ignore Messages Aimed At Others / Acknowledgement Emoji

With `ignoreAimedAtOthers` enabled, a message that mentions another user or any role, or replies to a message the bot did not write, is treated as somebody else's conversation: the node reacts with `ackEmoji` (when set), posts no answer, emits `no_reply` with reason `aimed_elsewhere` (with the message `text`, as for `paused`), and — when `escalationPause` is also on — pauses the thread it arrived in. A direct @mention of the bot always wins over this gate. A reply to the author's own earlier message (a common way to add details) is not aimed elsewhere unless it also mentions somebody else.

### Feedback Reactions / Feedback Emojis

With `feedbackReactions` enabled, the node adds each emoji in `feedbackEmojis` (default ✅ then ❌), in order, to the **last** posted chunk of an answer, so a reader grades it in one click. Each entry is one emoji, kept whole. Reactions are added only when the whole answer was posted: after a partial delivery (`complete` is `false`) the last posted chunk is not the end of the answer, so nothing is added. Failures are logged and never affect the reply; the emojis actually applied appear as `feedbackEmojis` on the `outbound` event.

### Sanitize Replies

With `sanitizeReplies` enabled, an answer wrapped in a `{"type": "final", "content": "..."}` envelope is unwrapped to its decoded content first (an envelope whose JSON escapes do not decode falls back to the raw captured string). Only an envelope that is the whole reply, or that ends a reply opening with a scratchpad label, is unwrapped; an answer that shows one as an example is left alone. The result is then trimmed to what follows the last `Final Answer:` that starts a line outside a code fence, so prose or a code sample that mentions the label is not cut; if it still opens with `Thought:`, `Action:`, `Action Input:`, `Observation:`, or `Reasoning:` it is leaked agent scratchpad rather than an answer, and it is replaced by a short hand-off line that keeps the escalation marker when its final line (the last non-empty line, when that line is not itself a `Thought:` or other reasoning line) carries one, or suppressed entirely (with a `no_reply` event, reason `non_answer`) when there is none. Sanitizing happens before chunking, so nothing partial is ever posted.

### Error answers are never posted

Whatever `sanitizeReplies` says, the node never relays an engine or model failure as an answer: a raw provider exception can carry account details, key fragments, or internal URLs. A reply is treated as an error when it:

- opens with the engine's `**LLM error**` prefix or the agent's `LLM error:` (bold or not, followed by `:`, `—`, `–`, or `-`);
- is only the sentence `An error occurred with the API.` (optionally after an exception name such as `ValueError:`);
- opens with `an error occurred with the <x> api`, a `chat.py:NN` / `agent.py:NN` engine frame, or `Traceback (most recent call last)`;
- opens with `_run failed` (or the engine's `agent base _run failed` log line);
- opens with `Exception:` or `Error:`;
- opens with a provider status such as `Error code: 429` (optionally after an exception name such as `RateLimitError:`, never after another word such as `Note:`).

Each code block is replaced by a placeholder line before these checks, so the text after a leading code block is not taken as the reply's opening, and every shape counts only where the reply opens with it, so an answer that quotes the user's error or traceback is still posted.

Such a reply is not posted and not retried: it is logged and reported as `no_reply` with reason `model_error`. A retry's answer is checked the same way, and an error there ends the retries. With `sanitizeReplies` off only this check runs: scratchpad is posted as the pipeline returned it, and nothing is retried.

### Retries on a non-answer

A pure-scratchpad answer is usually transient — the same question answers normally on a second run — so before giving up the node asks the text pass again, up to `nonAnswerRetries` times (default `1`, maximum `3`; `0` restores the suppress-immediately behavior). An **empty** answer (or one that is only whitespace) is retried the same way, unless the pipeline recorded a processing error for that message, in which case asking again would only repeat the failure. A retry re-runs the identical pipeline text, metadata, and thread context under a different object name (`<messageId>:retry1`), so a stateful prompt node does not mistake it for the object it already answered, and its `message` SSE event carries `retry: <n>` alongside `lane`, `text`, and `contextChars` (the original run carries no `retry` key). The first re-run whose sanitized answer is non-empty is posted; when every attempt is scratchpad the node emits `no_reply` with reason `non_answer`, and when every attempt is empty it keeps the reason it would have reported anyway (`no_answer`, or the processing error). Each attempt is its own pipeline object, so all of them count through the task's completed/failed totals. A message that carries only attachments has no text pass and is never retried. Retries apply only while `sanitizeReplies` is on.

### Pipeline Timeout (seconds)

By default a message waits for its pipeline as long as it takes. `pipelineTimeoutSeconds` (default `0`, off) gives up on a run that has not answered within that many seconds and emits `no_reply` with reason `timeout`; each run (the question, each attachment, each retry) gets the full limit. Pipeline runs use the node's own pool of 8 workers, separate from the one event emits use, so hung runs cannot hold up `no_reply`, `outbound`, or `reaction` events. The limit covers waiting for a free worker as well as the run, so with every worker busy a new message reports `timeout` rather than waiting. A timed-out run is not stopped: it keeps its worker until it finishes in the background, returns its pipe, and its answer is dropped, so enough hung runs leave no worker for new messages until they return.

## Authentication

This node requires a Discord bot token. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications):

1. Open **Applications** and click **New Application**.
2. Name it and click **Create**.
3. Under **Bot**, use **Reset Token** to reveal the bot token. It is shown once; keep it secret.
4. Enable **Message Content Intent** under **Privileged Gateway Intents**. Also enable **Server Members Intent** when using member metadata.
5. Still under **Bot**, turn off **Public Bot** unless anyone should be able to add the bot to their own server. A new application is public by default.
6. Add the bot to your servers with the OAuth2 URL generator (`bot` scope plus the permissions listed under Notes).

Paste the token into the `discord.botToken` field. In production, also set `guildIds` to the servers the bot should serve: with it and `channelIds` both empty (the default) the bot answers in every server it is added to, and the node says so in the task's warnings at start. A missing token, an invalid token, or a missing Message Content Intent fails the source with an actionable status rather than idling silently.

The node tile shows whether a bot token is configured (`Token: configured` or `Token: missing`); it does not report whether the bot connected, which the task's status line does. The monitor panel shows only the last 6 characters of the token so you can confirm which bot is connected without exposing the secret.

## Notes

### Prerequisites

- **Message Content Intent** must be enabled in the Developer Portal (`Bot > Privileged Gateway Intents`); without it `message.content` arrives empty. The node fails fast if the intent is missing.
- The bot needs **View Channels / Read Messages**, **Send Messages**, and **Read Message History** in the channels it serves. Apply them via the OAuth2 URL generator or per role/channel.
- For `thread` reply mode, the bot additionally needs **Create Public Threads** and **Send Messages in Threads**. In a DM or a channel that cannot host a thread — or when creating the thread is refused — the node falls back to a plain reply.
- The opt-in support-bot behaviors need **Add Reactions** (`ackEmoji`, `feedbackReactions`) and **Read Message History** (`threadHistoryLimit`, `escalationPause` reconstruction, `backfillLimit`). Missing either is logged and skipped rather than failing the message.

### Message handling and replies

- Discord's own system notices (joins, pins, boosts, "started a thread") and messages with neither text nor attachments are dropped before any gate or pipeline work: there is nothing in them to answer.
- With `mergeAttachments` on, one answer is posted per message: the text pass that has seen the folded files and the other lanes' answers. With it off, the first non-empty pipeline answer — text first, then attachments in order — is posted back. Optional `no_reply` and `outbound` event objects make those outcomes observable downstream.
- A message may carry up to 10 attachments. Every attachment is downloaded and routed into the pipeline (each counted independently); a text-like attachment is folded into the text pass rather than routed on its own while merging is on.
- Long answers are chunked at Discord's 2000-character limit on sentence and line boundaries.
- Outbound content uses a restrictive allowed-mentions policy. Only configured user and role IDs can be pinged; `@here` and `@everyone` are never enabled.

### What message text is broadcast and stored

Every object the node opens (messages, attachments, and the `reaction`, `no_reply`, and `outbound` events) is also broadcast as an `apaevt_sse` event of type `discord` (`{schemaVersion: 1, eventType, metadata, ...payload}`), so a UI subscribed to `SSE` on the task can follow the conversation without reading pipeline traces. The broadcast is not live-only: the engine also writes every SSE body into the task's run log, so it is visible to every client monitoring the task and is kept in the run log afterwards.

The node puts Discord message text into the `apaevt_sse` bodies, and therefore into the task's run log, in exactly four places:

- the question text, in the `text` field of each `message` event for the text lane (clipped at 2000 characters). With `mergeAttachments` on, a message that has no text of its own carries the merged question instead, which includes the folded text-file contents and what the pipeline found in the other attachments;
- the decoded contents of each text-like attachment (one `textAttachmentExtensions` selects), framed with its filename, in the `text` field of its own `message` event when `mergeAttachments` is off (clipped at 2000 characters);
- the answer text, in the `text` field of each `outbound` event (only when `emitOutbound` is on);
- the text of a message the node skipped, in the `text` field of its `no_reply` event (reasons `paused` and `aimed_elsewhere`, only when `emitNoReply` is on, clipped at 2000 characters). These are usually messages between people — a team member answering inside a paused thread, or users talking to each other — so conversations the bot does not take part in are broadcast and kept in the run log too.

Binary attachments are never broadcast, only their MIME type and size. Every event's `metadata` also carries Discord IDs and attachment filenames, plus display names and role IDs when `includeMemberMetadata` is on, and a `no_reply` reason can quote an exception message. Operators need this list for their privacy notice: anyone who can monitor the task, and anyone who can read its run log, can read these messages.

### Attachments and MIME detection

- Each attachment's reported size is checked against `maxAttachmentBytes` before download; oversized files are skipped with a debug log.
- Files are routed by MIME type: the node uses Discord's reported `content_type` first (lowercased, with any `; charset=...` parameters stripped) and falls back to the file extension: first the node's own table (e.g. `.pdf` maps to `application/pdf`), then Python's built-in `mimetypes` table (so `.avi` reaches the `video` lane, `.bmp` the `image` lane, and `.csv` is `text/csv`). The host's own MIME table (the Windows registry, `/etc/mime.types`) is never consulted, so a file routes the same way on every host; anything still unrecognized defaults to `application/octet-stream` and flows to the `tags` lane.
- When `textAttachmentExtensions` lists any extension, those files and `text/*` MIME attachments are decoded, capped by `textAttachmentMaxChars` (`0` means no limit), framed with their filename, and sent through the text lane — folded into the message's own text pass while `mergeAttachments` is on, or as their own object when it is off. Both paths decode the same way: a file that starts with a UTF-16 byte order mark (Windows Notepad "Unicode", PowerShell 5.1 redirects) is read as UTF-16, anything else as UTF-8 with a leading UTF-8 byte order mark dropped, and invalid bytes are ignored. A file whose decoded text still holds a NUL is binary content, not text, and is routed as a binary object on both paths.

### Reliability and limits

- **Rate limits**: discord.py handles Discord 429 responses internally (honoring `Retry-After` with backoff); the node keeps a defensive extra retry for any `RateLimited` it surfaces.
- **Configuration errors**: a list setting that starts with `[` but is not valid JSON is reported in the task's warnings with the setting's name. In `guildIds`, `channelIds` or `requireMentionChannelIds` it fails the start instead, since the bot would otherwise answer nothing (or, for the mention list, answer without the mention). Only `ROCKETRIDE_*` server variables are resolved: an unset `${ROCKETRIDE_NAME}` reaches the node as literal text, and any other `${NAME}` as the literal `<REDACTED>`. Either one in `botToken`, `guildIds`, `channelIds`, or `requireMentionChannelIds` fails the start naming the problem (for example `Discord Bot: <field> uses the variable <NAME>, which is not set on this server (only ROCKETRIDE_* server variables are resolved)`), because it would match nothing (in `requireMentionChannelIds`, the mention gate would silently never apply). In `allowedBotIds`, `allowedMentionRoleIds`, or `allowedMentionUserIds` it produces a warning naming the field. A set variable whose value is empty arrives as an empty string, so `guildIds`, `channelIds`, or `requireMentionChannelIds` given items that resolve to no IDs (for example `[""]`) also fails the start, instead of being read as an empty list that means "everywhere"; a list that is genuinely empty still means all. Any other entry in those three lists that is not a Discord ID, plain ASCII digits with at most 20 of them (a channel or server name, a pasted mention such as `<#123>`, or two IDs run together), fails the start too, naming the field and the entry; for a pasted mention the message gives the ID inside it. In `allowedBotIds` such an entry produces a warning instead. An entry that is not a mention is shown by at most its first 12 characters (followed by `…` when longer), so a token or secret pasted into a list by mistake is never shown in full in the task status or the logs. JSON list items are trimmed and split on commas and whitespace, like a bare string, except in `escalationMarkers` and `feedbackEmojis`, whose entries are phrases and emojis and are kept whole.
- **Lifecycle**: a terminal Gateway failure (invalid credentials, missing intent, or an unexpected disconnect) fails the source promptly; a successful start runs until the engine shuts the subprocess down.
- **No edit/delete handling**: only `MESSAGE_CREATE` events are processed.
- **Byte accounting**: processed message and file sizes are reported via `monitorCompleted()` / `monitorFailed()`.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `Pipe.source.parameters` |  | **Discord Bot Configuration** |  |
| `discord.ackEmoji` | `string` | **Acknowledgement Emoji**<br/>Emoji added to a message that is skipped as aimed at somebody else. Empty adds no reaction. | `""` |
| `discord.allowedBotIds` | `array` | **Allowed Bot IDs**<br/>Bot user IDs allowed through when Ignore Bot Messages is enabled. | `[]` |
| `discord.allowedMentionRoleIds` | `array` | **Allowed Mention Role IDs**<br/>Role IDs that outbound pipeline responses may mention. | `[]` |
| `discord.allowedMentionUserIds` | `array` | **Allowed Mention User IDs**<br/>User IDs that outbound pipeline responses may mention. | `[]` |
| `discord.backfillLimit` | `number` | **Backfill Limit**<br/>Most-recent messages to process per readable channel at startup. Zero disables backfill. | `0` |
| `discord.botToken` | `string` | **Bot Token**<br/>Discord bot token from the Developer Portal (keep this secret - do not share) |  |
| `discord.channelIds` | `array` | **Channel IDs**<br/>List of channel IDs to listen to. Leave empty to listen to all channels. | `[]` |
| `discord.emitNoReply` | `boolean` | **Emit No Reply Events**<br/>Emit an event when processing produces no answer or raises an error. The reason is no_answer, send_failed, shutdown, paused, aimed_elsewhere, non_answer, model_error or timeout; any other value is an error message clipped to 200 characters. | `false` |
| `discord.emitOutbound` | `boolean` | **Emit Outbound Events**<br/>Emit an event after posting a pipeline response to Discord. | `false` |
| `discord.emitReactions` | `boolean` | **Emit Reactions**<br/>Emit raw reaction add and remove events into the pipeline. | `false` |
| `discord.escalationMarkers` | `array` | **Escalation Markers**<br/>Text markers that mark an answer as escalated (for example a team role mention). Allowed Mention Role IDs are added automatically. | `[]` |
| `discord.escalationPause` | `boolean` | **Pause After Escalation**<br/>After an answer containing an escalation marker is posted into a thread, stay quiet in that thread until the bot is mentioned again. | `false` |
| `discord.feedbackEmojis` | `array` | **Feedback Emojis**<br/>Emojis added, in order, to the last posted answer chunk when Feedback Reactions is enabled. | `["✅","❌"]` |
| `discord.feedbackReactions` | `boolean` | **Feedback Reactions**<br/>Add feedback emojis to the last posted answer chunk so readers can grade it in one click. | `false` |
| `discord.guildIds` | `array` | **Server IDs (Guild IDs)**<br/>List of Discord server IDs to listen to. Leave empty to listen to all servers the bot is in. | `[]` |
| `discord.ignoreAimedAtOthers` | `boolean` | **Ignore Messages Aimed At Others**<br/>Skip messages that mention another user or role, or reply to a message the bot did not write, unless the bot is mentioned. | `false` |
| `discord.ignoreBots` | `boolean` | **Ignore Bot Messages**<br/>If true (default), messages from other bots are ignored to prevent loops. | `true` |
| `discord.includeMemberMetadata` | `boolean` | **Include Member Metadata**<br/>Include display names and role IDs; requires the Discord members intent. | `false` |
| `discord.maxAttachmentBytes` | `number` | **Max Attachment Size (bytes)**<br/>Maximum size of attachments to download. Larger files are skipped. Default 25 MB, at most 100 MB. | `26214400` |
| `discord.maxConcurrentMessages` | `number` | **Max Concurrent Messages**<br/>How many messages are processed at once. Further messages wait their turn; none are dropped. | `4` |
| `discord.mergeAttachments` | `boolean` | **Merge attachments into the question**<br/>When enabled, text-like files are folded into the message text and the answers the pipeline gives for image, audio, and video attachments are folded in as context before the text pass, so one reply covers everything. When disabled (the default), text and every attachment are asked separately and the first non-empty answer wins. | `false` |
| `discord.nonAnswerRetries` | `number` | **Retries on a non-answer**<br/>When Sanitize Replies strips the whole reply (the pipeline returned only agent scratchpad such as Thought: lines), re-run the text pass up to this many times before giving up. Zero never retries. | `1` |
| `discord.numberChunks` | `boolean` | **Number Reply Chunks**<br/>When an answer is too long for one Discord message, end each message with its position, for example (2/3). A reply that fits in one message is never labelled. | `false` |
| `discord.pipelineTimeoutSeconds` | `number` | **Pipeline Timeout (seconds)**<br/>Give up on a message whose pipeline has not answered after this many seconds and report a no_reply with reason timeout instead of posting. Each pipeline run (the question, each attachment, each retry) gets this long. The limit includes waiting for a free pipeline worker. The run itself is not stopped: it keeps its worker until it finishes in the background, and its late answer is dropped. Zero (default) waits as long as it takes. | `0` |
| `discord.replyMode` | `string` | **Reply Mode**<br/>How the bot sends answers: 'channel' (post as normal message), 'reply' (reply to the message), or 'thread' (post in a thread). | `"reply"` |
| `discord.requireMention` | `boolean` | **Require @Mention**<br/>If true, the bot only responds when explicitly @mentioned. If false, responds to all messages. | `false` |
| `discord.requireMentionChannelIds` | `array` | **Require Mention Channel IDs**<br/>Channels (or thread parent channels) where a direct bot mention is always required. | `[]` |
| `discord.sanitizeReplies` | `boolean` | **Sanitize Replies**<br/>Strip leaked agent reasoning (Thought / Action / Observation / Final Answer) from an answer before posting it. | `false` |
| `discord.sendResponses` | `boolean` | **Send Responses**<br/>If true, the bot sends pipeline answers back to Discord. If false, only processes messages. | `true` |
| `discord.showTyping` | `boolean` | **Show Typing Indicator**<br/>If true, show a typing indicator while processing the pipeline. | `true` |
| `discord.teamMentionAlias` | `string` | **Team Mention Alias**<br/>Literal team name the pipeline writes when it hands a question over, for example "@RocketRide team". Every occurrence is replaced with a real mention of the first role in Allowed Mention Role IDs, so the team is actually pinged. Empty leaves answers untouched. | `""` |
| `discord.textAttachmentExtensions` | `array` | **Text Attachment Extensions**<br/>Filename extensions decoded as text (UTF-8, or UTF-16 when the file starts with a UTF-16 byte order mark) and routed through the text lane, for example .pipe, .json, .log, .md, .txt, .csv, .yaml, .yml. Once any extension is listed, text/* files are decoded too. Empty (the default): every attachment is routed as a binary object. | `[]` |
| `discord.textAttachmentMaxChars` | `number` | **Text Attachment Max Characters**<br/>Maximum decoded characters folded into the text lane per attachment. 0 means no limit. | `12000` |
| `discord.threadAutoArchiveMinutes` | `number` | **Thread Auto Archive Minutes**<br/>Discord auto-archive duration, in minutes, for response threads the node creates. Discord accepts only 60, 1440, 4320 or 10080; 0 (the default) uses the channel's own default. | `0` |
| `discord.threadHistoryLimit` | `number` | **Thread History Limit**<br/>Prior thread messages fetched as conversation context for a message in a thread. Zero disables it. | `0` |
| `discord.threadHistoryMaxChars` | `number` | **Thread History Max Characters**<br/>Maximum characters of thread transcript passed as context; the oldest lines are dropped first. | `6000` |
| `discord.threadName` | `string` | **Thread Name**<br/>Name template for response threads. {content} is replaced with the triggering message text. | `"Pipeline Response"` |
| `discord.threadNameMaxLength` | `number` | **Thread Name Max Length**<br/>Maximum number of characters in a resolved response thread name. Discord accepts 1 to 100. | `90` |

## Dependencies

- `discord.py`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/discord)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
