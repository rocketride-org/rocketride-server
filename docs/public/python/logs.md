---
title: Run Logs
sidebar_position: 8
---

# Run Logs — `client.log`

Every task writes a **run log**: one continuous JSONL event stream per task
identity (`project_id` + `source`, plus the scope: a `team_id` addresses that
team's DEPLOY continuum — [deploy runs](/clients/python/deploy) log into the
team's tree, readable by any teammate with monitor rights — while omitting it
addresses your own dev stream; there is no run-kind argument). Individual runs are
**chapters** (tracks) inside the stream — there are no per-run log files. The log
survives disconnects and server restarts, powers replay of past runs through the
same panels that render live monitoring, and is retained on a ring (last ~1 GB)
plus a history age (7 days dev / 30 days deploy).

Streams are addressed by the plain identity tuple — never by task token (tokens
are credentials and appear nowhere in the log system).

## The DVR session — `open_event_stream()`

Opens a **DVR session** over one source continuum — the recommended way to consume
a run log. The session thinks in *positions* on the timeline; storage details
(segments, keyframes, deltas) are invisible and every event it delivers is fully
reconstructed.

The protocol is **seed-then-stream**: `seek(pos)` positions the session, the
`get_*()` calls seed your panels with state *as of* that position, and
`play(pos, speed, cb)` streams events strictly *after* what the seeds covered — no
gap, no duplicate. Speed `0` delivers as fast as possible, `1` is real time, `10`
is 10×. Playing from a past position auto-pins to live on catching the wall clock;
live is just the position pinned to now (`seek('live')`), not a separate mode.

```python
# Own dev stream; pass team_id='team-prod' for a team's deploy continuum.
session = client.log.open_event_stream('proj-1', 'chat_1')

# Canonical startup: position, seed the panels, then roll.
await session.seek('live')
status = await session.get_status()          # state as of the position
console_lines = await session.get_console(500)  # exactly what the console showed
traces = await session.get_traces(50)        # all in-flight + last 50 closed
await session.play(None, 0, lambda item: fold(item['event']))

# Replay a past run at 10x from its beginning.
chapters = await session.get_chapters()
await session.play(chapters[0]['beginTime'], 10, lambda item: fold(item['event']))

# Drill into one trace (a call tree; fetched sparsely from exactly
# the segments that contain it).
detail = await session.get_trace(traces['closed'][0]['beginSeq'])

session.pause()             # freeze the position
session.close_event_stream()  # dispose
```

`get_traces(n)` errors when `n > 50` — the session exposes all in-flight traces
plus a sliding window of the 50 most recently closed; any older trace is still
reachable by seeking to a position inside its lifetime. `get_trace(trace_id)`
resolves a trace by its begin event's continuum seq (pass the chapter's
`beginSeq` value) — the permanent identity (slot
ids recycle; `beginSeq` never does). Hosts that own a live subscription feed
arriving events to the session via `ingest_live(event)`; while pinned, arrival
paces delivery.

## `chapters()`

Returns the stream's timeline in one small read: each run's begin/end date-time,
starting sequence number and outcome, the activity spans for the timeline bar, the
retained window, and the retention horizon.

```python
timeline = await client.log.chapters('proj-1', 'chat_1')
for track in timeline['chapters']:
    print(track['beginTime'], track.get('endTime'), track.get('outcome'))
```

## `read()`

Ranged, paged event read over the continuum. Range forms: a sequence range
(`from_seq`/`to_seq`), a time range (`from_time`/`to_time`, omit `to_time` for "to
now"), or time-to-segment (`from_time` + `to_segment`). Responses are paged
(`max_events`/`max_bytes`, server-clamped): when `nextSeq` is present, pass it back
as `cursor` to continue. `types` filters event types server-side; a
`truncatedAtSeq` field means the request reached below the retention horizon.

```python
cursor = None
while True:
    page = await client.log.read('proj-1', 'chat_1', from_seq=0, cursor=cursor, types=['output'])
    for event in page['events']:
        print(event['body'].get('output', ''), end='')
    cursor = page.get('nextSeq')
    if cursor is None:
        break
```

Every event carries the continuum stamps in its **body** — the only place they
exist: `body['eventTime']` (epoch seconds, stamped once at engine ingress) and
`body['logSeq']` (catalog-seeded — a fresh stream starts at 1 and continues from
the recorded `lastSeq + 1` across runs and restarts; strictly monotonic) —
identical live and on replay. The DAP envelope's own `seq` is per-connection
protocol bookkeeping and says nothing about the continuum.

## `segment()`

Fetches one segment's raw JSONL bytes, chunked by byte offset — the bulk replay
path. The server hands over the immutable segment content as-is, in
**whole-line-aligned chunks** (every response ends on a newline, so each chunk
parses standalone). Repeat with the returned `nextOffset` until `final`. The
segment table comes from `chapters()`.

```python
offset = 0
while True:
    chunk = await client.log.segment('proj-1', 'chat_1', 0, offset=offset)
    for line in chunk['data'].splitlines():
        if line.strip():
            handle_event(json.loads(line))
    if chunk['final']:
        break
    offset = chunk['nextOffset']
```

Prefer `segment()` over paged `read()` when consuming whole runs (replay, export);
use `read()` for filtered or narrow ranged queries.

## `delete()`

Destructive. `before_time` drops segments wholly older than the cutoff (chapters
trimmed, horizon advanced); `all` removes the entire stream including its control
file.

```python
await client.log.delete('proj-1', 'chat_1', before_time=time.time() - 86400)
await client.log.delete('proj-1', 'chat_1', all=True)
```

## Wire surface and permissions

All methods use the single `rrext_log` DAP command, dispatched by a `subcommand`
argument (`chapters`, `read`, `segment`, `delete`). Reads require `task.monitor`;
`delete` requires `task.control`. The scope the request addresses picks whose
streams those rights are resolved against: without `team_id` you access your OWN
dev streams; with `team_id` the permission is checked against the TARGET team —
membership is the read/write right. `open_event_stream()` is client-side
composition: it issues `chapters` and `segment` calls under the hood and
registers a live `rrext_monitor` subscription while open — it adds no wire
surface of its own.
