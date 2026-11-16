# messaging

The Supabase Messaging service of the `supabase` node: agent tools that send Supabase Realtime broadcast messages and work with Supabase Queues. Pick it when an agent should notify live app users or hand work to background workers through a Supabase project.

## About Supabase

Supabase is a hosted backend platform built on PostgreSQL. Realtime pushes messages to connected browsers and apps over channels. Queues is a durable message queue inside the project's database, built on the pgmq extension, where each message is read by one worker at a time.

## What it does

The service has no data lanes; it is used only as an agent tool. `broadcast` sends one message to every client subscribed to a Realtime channel, through Supabase's REST broadcast endpoint, so no websocket is opened. The queue tools add, read, take, archive and delete queue messages through the `pgmq_public` functions that Supabase exposes over its API. It connects with the Project URL and a secret key.

## As a tool

Tool names are the bare function names below; an agent sees each one as `<component-id>.<function>`. Messages from the node name a function `supabase_messaging.<function>`, for example `supabase_messaging.queue_read`. A call above the node's **Access level** is refused with a message naming the level to set. Every function here needs `write`, so a node left at the default `read` level offers the agent no tools at all: set **Access level** to `write` to turn them on.

| Function | Description |
|---|---|
| `broadcast` | Send one Realtime broadcast message (`channel`, `event`, optional `payload` object, optional `private`, default false). Returns `ok`, `channel`, `event`, `private`. Needs `write`. |
| `queue_send` | Add a message (`queue`, `message` as any JSON value, optional `delay_seconds`, default 0; above **Max send delay** it is refused, not lowered). Returns `queue` and `message_id`. Needs `write`. |
| `queue_read` | Read up to `count` messages (default 1) and hide them from other readers for `visibility_seconds` (default 30; above **Max visibility timeout** it is refused, not lowered). Returns `queue`, `messages`, `count`, and `count_capped_to` when `count` was above the cap. A message whose body is above **Max payload size** comes back with `message` null, `message_bytes` and `message_omitted: true`, so the agent can still archive or delete it by `msg_id`. Needs `write`. |
| `queue_pop` | Take the next message and delete it in the same step (`queue`). Returns `queue` and `message`, or `message` null when the queue is empty. Needs `write`. |
| `queue_archive` | Move a message to the queue's archive (`queue`, `message_id`). Returns `queue`, `message_id`, `ok`. Needs `write`. |
| `queue_delete` | Delete a message for good (`queue`, `message_id`). Returns `queue`, `message_id`, `ok`. Needs `write`. |

`queue_read` needs `write`, not `read`: reading a message hides it from every other reader until its visibility timeout ends, so it changes what other workers see. A message that is read and then neither deleted nor archived is delivered again after `visibility_seconds`. `queue_pop` is the one-step choice when a failed job does not need a retry.

Each message in `messages` (and `message` from `queue_pop`) has `msg_id`, `read_ct` (how many times it was read), `enqueued_at`, `vt` (when it becomes visible again) and `message` (the body). Message bodies are returned as they were sent; only the node's own secret key, if it appears in a body, is replaced with `***`.

`queue_archive` and `queue_delete` return `ok: false` when no message with that id is in the queue.

`broadcast` returns once Supabase accepts the message. It does not confirm that any client received it.

Queue names are 1 to 47 letters, digits, `_` or `-`. Channel and event names are at most 255 characters. Bad arguments are refused before any call to Supabase.

## Configuration

Paste the **Project URL** and a **Secret key** and set **Access level** to `write`; the other fields are safety limits with working defaults.

### Access level

At the default `read` the node offers the agent no tools: none is listed, and a call is refused. This is on purpose, so a new node cannot send or take messages until someone chooses to allow it. Set `write` to turn the tools on. The canvas tile says "Tools need write or admin", and a node started at `read` writes one warning to the job log saying it offers no tools. `admin` allows the same tools as `write` here.

### Limits

- **Max messages per read** (default 100, 1 to 1000): the most messages one `queue_read` returns. A larger `count` is cut to this number and the answer says so in `count_capped_to`.
- **Max visibility timeout (s)** (default 3600, 1 to 86400): the longest `visibility_seconds` an agent may ask for; a larger value is refused, not lowered, because a shorter timeout would hand the messages to other readers while the agent still works on them. When this is below 30, it is also the default.
- **Max send delay (s)** (default 3600, 1 to 604800): the longest `delay_seconds` for `queue_send`; a larger value is refused, not lowered, because a shorter delay would deliver the message earlier than asked. (A `count` above **Max messages per read** is lowered instead, and the answer says so in `count_capped_to`: fewer messages is safe.)
- **Max payload size (KB)** (default 256, 1 to 3072): the largest `broadcast` payload or queue message, measured as JSON. A larger one is refused before it is sent. `queue_read` also leaves out any message body above this size that another producer wrote (it returns the message's `msg_id` and size instead); `queue_pop` returns the body whole, because the message is already deleted. Supabase has its own Realtime message size limit per plan (256 KB on Free).

## Authentication

Use a secret key (`sb_secret_...`) from Project Settings -> API Keys. Publishable and anon keys are refused at start-up. The secret key bypasses row-level security, so the access level on the node is the guard.

## Notes

### Turning on Queues for the API

The queue tools call the `pgmq_public` schema, which exists only after a project owner turns on **Expose Queues via PostgREST** (Integrations -> Queues -> Settings). Until then every queue tool fails with a message that says to turn it on. Self-hosted Supabase must also add `pgmq_public` to its exposed schemas.

Each queue must also give the `service_role` role Select, Insert, Update and Delete (the queue's settings in the dashboard); without them the tools fail with a permission message that says so. A queue that does not exist fails with "Queue ... does not exist". Create queues in the dashboard (Integrations -> Queues -> Create queue).

### Private channels

`private: true` sends on a private Realtime channel. Clients must be authorized for that channel (Realtime authorization policies) to receive it.

## Upstream docs

- [Realtime Broadcast](https://supabase.com/docs/guides/realtime/broadcast)
- [Supabase Queues](https://supabase.com/docs/guides/queues)
- [Queues API (pgmq_public)](https://supabase.com/docs/guides/queues/api)
- [API keys](https://supabase.com/docs/guides/api/api-keys)
