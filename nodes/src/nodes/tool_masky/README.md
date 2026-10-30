# tool_masky

A RocketRide node for Masky AI avatars. It works as an agent tool over the Masky API and as a pipeline step that turns text into a talking head, a scene clip, an image or a live-conversation turn.

## About Masky

Masky is the third-party AI avatar platform this node invokes over its REST API at `https://masky.ai/api`. An avatar combines a face, a voice and a personality; Masky renders it as audio, a lip-synced talking head or a scene video, generates and edits images, and hosts live conversations with an avatar. Renders are billed in Masky credits.

## What it does

The node has two roles. Bound to an agent, it exposes 29 Masky functions under the `masky` namespace (26 by default, because the three delete tools need `allowDelete`). Placed in a pipeline, it runs one configured action on each non-empty text record (empty or whitespace-only records do nothing). For talking head, scene video and image it renders, waits, downloads the finished file and streams it downstream, so the output outlives Masky's signed URL. For live it sends the record as turns of a live conversation and writes only a receipt. Choose it over `cloud_tts` when the voice should belong to an avatar or come with a face, and over `video_composer` when the clip itself must be generated rather than stitched from existing frames.

Every paid call is estimated first and refused before any request when the estimate exceeds **Max Credits per Call**. The node is marked experimental.

## Lanes

Each text record runs the configured **Pipeline Action**. Talking head writes `video` or `audio`, scene video writes `video`, image writes `image`, and every action writes one JSON receipt on `text`. Live writes only the receipt. Media streams declare their byte count on BEGIN.

| Lane in | Lane out | Description |
|---|---|---|
| `text` | `video` | Talking head or scene clip, downloaded from Masky. |
| `text` | `audio` | Voice-only talking head, downloaded from Masky. |
| `text` | `image` | Generated or edited image, downloaded from Masky. |
| `text` | `text` | One JSON receipt per record (job id, status, media details, estimated and charged credits). |
| `questions` | `video` | Question text, handled as `text`. |
| `questions` | `audio` | Question text, handled as `text`. |
| `questions` | `image` | Question text, handled as `text`. |
| `questions` | `text` | One JSON receipt per record. |
| `answers` | `video` | Answer text, handled as `text`. |
| `answers` | `audio` | Answer text, handled as `text`. |
| `answers` | `image` | Answer text, handled as `text`. |
| `answers` | `text` | One JSON receipt per record. |

The incoming text is not passed through. Empty records are skipped without a request.

## As a tool

The server name defaults to `masky`, registering the functions below as `masky.<function>`. Agent calls ignore **Pipeline Action** and its settings: an argument a call leaves out takes the default documented below (720p draft, 5 s, 24 fps, 16:9, literal text mode, default engines, private share), never a pipeline setting. Default Avatar, Language, the cost cap and the timeouts do apply to agent calls. Default Look applies only to `speak` and `create_conversation`; `generate_video`, `set_stream_identity` and `set_conversation_look` use a look only when the call passes one. Render functions return a receipt: `{generation_id, kind, status: queued|running|done|failed, media: {mime, url?, url_expires_at?}, estimated_credits, credits_charged, elapsed_sec, warnings, error?}`. With **Include Media URLs in Tool Results** off, `url` and `url_expires_at` are removed from every result.

| Function | Description |
|---|---|
| `masky.list_avatars` | Lists your avatars, optionally with public ones. |
| `masky.get_avatar` | Gets one avatar with its looks. |
| `masky.create_avatar` | Creates a new avatar. |
| `masky.rename_avatar` | Renames one of your avatars. |
| `masky.train_avatar` | Starts Gem training for an avatar. |
| `masky.set_avatar_public` | Makes an avatar public or private. Making it public needs `allowPublicSharing`. |
| `masky.get_stream_identity` | Reads the account's stream identity. |
| `masky.set_stream_identity` | Sets or clears the account's stream identity. |
| `masky.list_voices` | Lists preset and custom voices. |
| `masky.set_avatar_voice` | Attaches a voice to an avatar. |
| `masky.list_looks` | Lists an avatar's looks. |
| `masky.add_look` | Registers a new look from a public image URL. |
| `masky.speak` | Renders speech as a talking-head video or audio. |
| `masky.generate_video` | Renders a scene video. |
| `masky.generate_image` | Generates an image. |
| `masky.edit_image` | Edits or composes images. |
| `masky.get_generation` | Checks a render by job id. |
| `masky.estimate_cost` | Estimates a render's credits; makes no render request. |
| `masky.create_conversation` | Starts a live conversation. |
| `masky.set_conversation_visibility` | Makes a conversation public or private. Making it public needs `allowPublicSharing`. |
| `masky.send_turn` | Sends one turn into a live conversation. |
| `masky.get_turns` | Reads a conversation's turns. |
| `masky.set_conversation_look` | Changes the look a conversation shows. |
| `masky.delete_conversation` | Deletes a conversation and its turns. Only available when `allowDelete` is enabled. |
| `masky.delete_turn` | Soft-deletes one turn. Only available when `allowDelete` is enabled. |
| `masky.restore_turn` | Restores a soft-deleted turn. |
| `masky.bind_agent` | Binds an external agent to an avatar over Nostr. |
| `masky.get_binding` | Reads an avatar's agent binding. |
| `masky.unbind_agent` | Removes an avatar's agent binding. Only available when `allowDelete` is enabled. |

### `masky.list_avatars`

Optional `include_public` (default false) adds other users' public avatars after your own, without duplicates; optional `query` keeps avatars whose name or handle contains it, ignoring case. Returns `{avatars: [{avatar_id, name, handle, voice_id, public, own, image_url?}], count}`; `image_url` appears only with Include Media URLs on. An avatar with a null `voice_id` cannot speak until a voice is attached.

### `masky.get_avatar`

Pass exactly one of `avatar_id`, `handle` or `twitch_name`. Returns the avatar's `avatar_id`, `name`, `handle`, `voice_id`, `personality`, `public`, `own` and `image_url?`, plus `looks: [{look_id, is_primary, created_at, url?}]`. Masky has no lookup by id, so an id is matched against your avatars and then the public ones.

### `masky.create_avatar`

Required `name` (up to 80 characters) and `image_url` (a public http(s) face image). Optional `personality` (up to 4,000 characters), `voice_id`, `knowledge_urls` (up to 10 public URLs) and `public` (default false). Masky has no edit endpoint, so every call creates another avatar. Returns `{avatar_id, name, voice_id, public}`.

### `masky.rename_avatar`

Required `avatar_id` (one of your avatars) and `name` (1 to 80 characters, checked before the request). An avatar whose name is locked to a linked Twitch account is refused with "This avatar's name is locked to its linked Twitch account; change it on Twitch or masky.ai." Read-only mode blocks it. The endpoint comes from Masky's answers to our questions and isn't in the published OpenAPI spec yet. Returns `{avatar_id, name}`.

### `masky.train_avatar`

Required `avatar_id`. Starts Masky "Gem" training from the avatar's personality and knowledge URLs. Masky reports only "trained or queued", so progress cannot be polled. Returns `{avatar_id, status: requested, note}`.

### `masky.set_avatar_public`

Required `avatar_id` and `public` (true or false). Public avatars can be rendered by other Masky users. Returns `{avatar_id, public}`.

### `masky.get_stream_identity`

No arguments. The stream identity is the one avatar and look used for stream overlays; it is set per account, not per avatar. Returns `{stream_identity: null or {avatar_id, look_id, display_name, voice_id, updated_at, url?}}`.

### `masky.set_stream_identity`

Pass `avatar_id` (one of your avatars) with an optional `look_id` or `look_url`, or `clear: true` on its own to remove the identity. Returns the stored stream identity, or null once cleared.

### `masky.list_voices`

Optional `query` keeps voices whose name contains it, ignoring case; optional `include_custom` (default true) controls whether the account's custom voices are listed with the presets. Returns `{voices: [{voice_id, name, kind: preset|custom}], count}`.

### `masky.set_avatar_voice`

Required `avatar_id` and `voice_id` (from `list_voices`). Returns `{ok, avatar_id, voice_id}`.

### `masky.list_looks`

Required `avatar_id`. A look is a registered still image the avatar renders with. Returns `{avatar_id, looks: [{look_id, is_primary, created_at, url?}], count}`. See [Looks and job ids](#looks-and-job-ids).

### `masky.add_look`

Required `avatar_id` and `image_url` (a public http(s) image up to 12 MB; Masky has no upload). Returns `{avatar_id, look_id, url?}`.

### `masky.speak`

Required `text`, up to 500 characters. Optional `avatar_id` (defaults to **Default Avatar**), `output` (`video` for a lip-synced talking head, the default, or `audio`), `look_id` or `look_url`, `language`, `text_mode` (`literal` or `personality`) and `wait_for_completion` (default false). The estimate uses Masky's billing formula: seconds estimated from the text as `max(1, round(characters / 15))`, times the rate, plus 0.001 for the text step. With `text_mode` `personality` Masky bills the rewritten line, whose length is unknown, so the estimate assumes the full 500 characters (0.8755 credits for a video, which passes the default 1.0 cap; a lower cap refuses it). Returns a receipt with `spoken_text`, `share_url` and `reused`. Without waiting, the receipt is `queued`, unless Masky answers at once (for example a reused identical request), when it is `done`; check a queued job with `get_generation`. A video job whose video fails but whose audio rendered returns `failed` with the audio attached as media.

### `masky.generate_video`

Required `prompt`, up to 2,000 characters. Scene video is not lip-synced; use `speak` for a talking head. Optional:

- `image_url` (a public image to animate) or `look_id`/`look_url` (needs `avatar_id`), plus `last_frame_image_url` for the closing frame.
- `speech_text` (up to 300 characters, spoken in the avatar's voice; needs a voiced avatar and sets the length) or `audio_url`.
- `duration_sec` (1 to 20, default 5), `resolution` (`720p` or `1080p`), `fps` (24 or 48), `aspect_ratio`, `seed`, `draft`, `silent`, `expand_prompt` and `share` (`private` or `public`).
- `wait_for_completion` (default false). Renders take up to about three minutes.

Returns a receipt with `share_url`.

### `masky.generate_image`

Required `prompt`, up to 2,000 characters. Optional `engine` (`default` or `ideogram`, about 3× the price) and `aspect_ratio`. Images return immediately with status `done`.

### `masky.edit_image`

Required `prompt` (the instruction) and at least one image: `image_url` and/or `images`, up to 5 public http(s) URLs in total, for example to combine references. Optional `engine` (`default` or `qwen`, about 3× the price; `qwen` takes at most 2 images) and `aspect_ratio`. Returns immediately.

### `masky.get_generation`

Required `generation_id`, as returned by a render (`speak:...`, `video:...`, `image:...`). A raw Masky id also works with `kind`. Optional `wait_for_completion`. Image results exist only for the current run; see [Looks and job ids](#looks-and-job-ids).

### `masky.estimate_cost`

Required `kind`: `speak`, `video`, `image` or `turn`, plus that call's parameters (speak: `text`, `output`, `text_mode`; video: `duration_sec`, `resolution`, `draft`, `speech_text`, `audio_url`; image: `engine`, and `image_url` for an edit; turn: `text`, `mode`, `output`, `reinterpret`). Makes no render request; it may read Masky's free pricing once per run. Returns `{kind, estimated_credits, basis, price_table_date, verified, cap, within_cap}`.

### `masky.create_conversation`

Optional `avatar_id` and `look_id` or `look_url`. Starts a live conversation that viewers can follow on a share page and a live page, for example as an OBS overlay. New conversations are private. Returns `{conversation_slug, conversation_id, share_url, live_url?}`; `live_url` carries a viewer token, so treat it as private.

### `masky.set_conversation_visibility`

Pass `slug` or `conversation_id`, plus required `public` (true or false). Returns `{conversation_slug, conversation_id, public}`.

### `masky.send_turn`

Pass `slug` or `conversation_id`, plus required `text` (up to 500 characters). Optional:

- `mode`: `chat` (the avatar answers, the default) or `speak` (it says the text).
- `output`: `audio` (the default) or `video`.
- `reinterpret`: speak mode only; lets the avatar rewrite the text in its own voice.
- `wait_for_agent`: wait until the turn renders. Waiting needs the slug (or a conversation created in this run); with only an unknown `conversation_id`, the result says it did not wait.

Turns are charged after they render, with the same formula as `speak`. Chat and reinterpreted turns are estimated as if the avatar writes 500 characters, because their length is unknown (0.8755 credits for a video turn, 0.0505 for audio). `credits_charged` is null for now: Masky's turn record shows 0 even after the charge lands, so the node does not pass that on. Returns `{turn_id, role, status, user_text, avatar_text, media, share_url, created_at, credits_charged, estimated_credits, conversation_slug, warnings?}`.

### `masky.get_turns`

Required `slug`. Optional `since` (a `turn_id`, or a `createdAt` value in epoch milliseconds written as digits; only later turns are returned) and `limit` (1 to 100, default 20, newest last). Returns `{conversation_slug, turns, count}`.

### `masky.set_conversation_look`

Pass `slug` or `conversation_id`, plus `look_id` or `look_url`. Optional `avatar_id` when the conversation was not created in this run. Returns `{ok, look_id}`.

### `masky.delete_conversation`

Required `conversation_id`. Deletes the conversation and all its turns; deleted conversations can't be recovered. Only available when **Allow deletion** (`allowDelete`) is enabled. The endpoint comes from Masky's answers to our questions and isn't in the published OpenAPI spec yet. Returns `{conversation_id, deleted: true}`.

### `masky.delete_turn`

Required `conversation_id` and `turn_id`. A soft delete: `restore_turn` brings the turn back. Only available when **Allow deletion** is enabled. The node does not offer Masky's permanent purge. The endpoint comes from Masky's answers and isn't in the published spec yet. Returns `{conversation_id, turn_id, deleted: true, restorable: true}`.

### `masky.restore_turn`

Required `conversation_id` and `turn_id`. Restores a turn removed with `delete_turn`. It is a write, so read-only mode blocks it, but it does not need **Allow deletion**. The endpoint comes from Masky's answers and isn't in the published spec yet. Returns `{conversation_id, turn_id, restored: true}`.

### `masky.bind_agent`

Required `avatar_id`, `pubkey` (a 64-character lowercase hex Nostr key) and `relay` (a `wss://` URL). Optional `timeout_sec` (5 to 120), `fallback` (`gemini` or `fail`), `enabled`, `kind` (the Nostr event kind, default 9391) and `extra_tags`. Masky then publishes each conversation turn to the relay for the agent to answer; this function only stores the binding, and running the agent is up to you. Returns `{avatar_id, agent_binding}`.

### `masky.get_binding`

Required `avatar_id`. Returns `{avatar_id, agent_binding}`, where `agent_binding` is null when none is set.

### `masky.unbind_agent`

Required `avatar_id`. Only available when **Allow deletion** (`allowDelete`) is enabled; otherwise it is hidden from the agent and a direct call is refused. Returns `{avatar_id, agent_binding: null}`.

## Configuration

Supply the API key, choose the pipeline action, and set the defaults used when a call or record names no avatar or look.

### Pipeline Action

**Pipeline Action** decides what the node does with each record in a pipeline: `talking_head` (the default), `scene_video`, `image` or `live`. The panel shows only the chosen action's settings:

- **Talking head:** Output (video or audio) and Text Mode. The record must be 500 characters or fewer. Estimates follow Masky's billing formula, so any talking-head video up to 500 characters (at most 0.8755 credits) passes the default 1.0 cap.
- **Scene video:** Quality, Aspect Ratio, Frame Rate, Duration, Seed, Silent, Expand Prompt, Share Page, Source Image URL and Speech Line. The record is the prompt, up to 2,000 characters.
- **Image:** Generation Engine, Edit Engine and Source Image URL. The record is the prompt, or the edit instruction when a source image is set.
- **Live:** Conversation, Turn Mode, Turn Output and Wait for Each Turn.

### Max Credits per Call

A cost guard. A render whose estimate exceeds this value is refused before any request reaches Masky, with a message naming the estimate and the cap. It applies per tool call, and per record in a pipeline: a live record split into several turns is checked as one total. The default is 1.0 credit; 0 turns the guard off. Scene-video estimates use Masky's live pricing, read once per run, but never a rate below the dated price table. A request that Masky answers with a server error is not resent, because the job may already have started and resending could charge twice.

### Read-only mode

When **Read-only mode** (`readOnly`) is `true`, every agent tool that changes or spends anything is dropped from the published set: the agent does not see it in `tool.query`, and invoking it anyway is refused before any request with "This operation is not permitted: the node is configured in read-only mode". That covers creating, training, renaming and attaching voices to avatars, adding looks, setting the stream identity, every render (`speak`, `generate_video`, `generate_image`, `edit_image`), live conversations and turns, visibility changes, agent binding, and deletes and restores. Listing and reading stay available: `list_avatars`, `get_avatar`, `get_stream_identity`, `list_voices`, `list_looks`, `get_generation`, `estimate_cost`, `get_turns` and `get_binding`.

Read-only mode applies to agent tools only. It does not affect the **Pipeline Action**, because a pipeline step that cannot render has no purpose. The default is `false`, so a freshly added node can spend credits; turn read-only mode on explicitly for agents that should only inspect the account.

### Allow deletion

Destructive: enable **Allow deletion** (`allowDelete`) only when the agent is trusted to delete Masky conversations, turns and agent bindings. Deleted conversations can't be recovered. It is off by default, and it is required even when read-only mode is off: without it, the delete tools are hidden from the agent and a direct call is refused with a message naming `allowDelete`.

### Allow public sharing

**Allow public sharing** (`allowPublicSharing`) is off by default. When off, anything that makes content public is refused before any request: `set_avatar_public` with `public: true`, `set_conversation_visibility` with `public: true`, `create_avatar` with `public: true`, `generate_video` with `share: public`, and the scene_video action with **Share Page** set to Public. Making something private is never gated.

### Include Media URLs in Tool Results

On by default. Turn it off on any node bound to an agent: results then carry job ids only, so signed media URLs never enter the model's context. Pipeline receipts always include URLs.

### Default Avatar and Default Look

**Default Avatar** takes an avatar id or `@handle` and is used whenever a call or record names no avatar; talking head and live need one. **Default Look** takes a `look_id` or a look URL; blank uses the avatar's primary image. It is used by `speak` and `create_conversation`, by the talking_head action, and by the live action only when the node creates a new conversation; with an existing **Conversation** slug, that conversation keeps its own look. Scene video uses a look only when one is passed.

### Aspect Ratio

Scene video accepts Masky's seven ratios: `16:9` (the default), `9:16`, `4:3`, `3:4`, `3:2`, `2:3` and `1:1`. Use `9:16` for vertical short-form clips and `1:1` for square feeds.

### Source Image URL

Masky reads images only from public `http(s)` URLs; it has no upload. Scene video animates the image, and Image edits it using the incoming text as the instruction.

### Speech Line

Scene video only: up to 300 characters spoken in the Default Avatar's voice. When set, it decides the clip's length and Duration is ignored. It is not lip-synced.

### Conversation

Live only: an existing conversation slug (`c-..`). Blank creates one conversation per pipeline run and reuses it for every record. Each record is split at sentence boundaries into turns of at most 500 characters.

## Authentication

Provide a Masky API key (`mky_...`) from <https://masky.ai/developer> in **API Key**. If the field is blank, the node reads `ROCKETRIDE_MASKY_KEY` from the engine host's environment; in a pipeline file you can also write `"apikey": "${ROCKETRIDE_MASKY_KEY}"`, which resolves from the server's environment and your stored secrets. The node does not start without a key, never logs it, and clears it when the pipeline ends.

## Notes

### Why outputs are downloaded

Masky's media links are signed and expire after about an hour. The pipeline step downloads each finished file and streams the bytes downstream, to `objstore` or `tool_filesystem` for example, so the copy you keep never expires. Tool results only return the link and its expiry.

### Looks and job ids

A look's `look_id` is Masky's asset id. The avatar's primary profile image has none, so the node derives one from a hash of the image URL. Job ids carry their kind (`speak:<id>`, `video:<id>`, `image:<id>`) because Masky polls each kind at a different endpoint. Image results are returned immediately and can't be looked up later: an `image:` id resolves only within the run that created it.

### Cost and speed

- **Talking head and audio:** Masky bills on estimated seconds from the text, not on the rendered length: `max(1, round(characters / 15))` seconds at 0.0265 credits per second for a talking head (0.0015 for voice-only audio), plus 0.001 for the text step. The node's estimates use the same formula, so they match the charge for literal text; a 223-character line was estimated as 15 s and charged 0.3985. In personality mode Masky bills the rewritten line. Rendering takes about 3× the clip length (46 s for that clip).
- **Scene video:** a 720p draft 5 s clip rendered as 5.04 s (1280×704) in 53 s and cost 0.0756. Masky bills the rendered length, which runs one frame past the request, so scene-video estimates add 0.1 s. Scene video renders at about 10× the clip length, against about 3× for talking heads, so set **Render Timeout** with that in mind.
- **Images:** a default-engine image cost 0.005 and returned in about 3.5 s.
- **Live turns:** each rendered turn is charged with the same formula as speech; a speak-mode audio turn finished in about 14 s. Masky's turn record currently shows 0 for the charge (a Masky bug), so receipts report `credits_charged` as null; the real charge is in the credit ledger on masky.ai.
- **Failed video with audio:** when a talking-head video fails but its audio rendered, Masky charges only the audio.

### Live conversations

New conversations start private; use `set_conversation_visibility` to change that. If Masky rejects a turn outright, the pipeline step raises an error and sends no further turns from that record, even with **Wait for Each Turn** off; waiting only changes whether the node also waits for each accepted turn to finish rendering. With **Wait for Each Turn** on, if Masky accepts a turn but returns no turn id to poll, that turn is recorded as `sent`, the record's remaining turns are still sent, and the receipt's `warnings` say which turn could not be confirmed. With waiting off, nothing is polled, so every turn is recorded as `sent` and no warning is added.

### What can be deleted

Masky can delete conversations and their turns (a turn delete is soft and can be restored). It has no delete for avatars, looks or generations, so remove test avatars, looks and renders on masky.ai.

### Not supported

- Tribes and donations exist in Masky's API and are planned follow-ups.
- Making a RocketRide agent the avatar's brain needs a long-running Nostr relay listener and is not part of this node; `bind_agent` only stores the binding.
- The binding test endpoint accepts only a masky.ai login session, not an API key, so there is no `test_binding`.
- There is no OAuth sign-in (the canvas OAuth widgets support only Google, Microsoft and Slack) and no source mode, because Masky cannot push events into RocketRide.

### Manual checks

The automated tests make no paid calls. To check renders by hand:

1. Start a pipeline `webhook → tool_masky → response` (one response per output lane) with a Default Avatar set.
2. Send one short line with talking_head, then with image, scene_video (720p draft, 5 s) and live.
3. Each check costs well under one credit at those settings. Compare each receipt's `size_bytes` with the bytes received.

## Upstream docs

- [Masky developer portal](https://masky.ai/developer)
- [Masky OpenAPI specification](https://masky.ai/api/docs/masky-openapi.json)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
