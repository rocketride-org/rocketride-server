# Run Log

Every task writes a **run log**: one continuous JSONL event stream per task
identity (`projectId` + `source`, plus the scope: a `teamId` addresses that
team's DEPLOY continuum — deploy runs log into the team's tree, readable by
any teammate with monitor rights — while omitting it addresses your own dev
stream; there is no run-kind argument). Individual runs are **chapters**
(tracks) inside the stream — there are no per-run log files. The log survives
disconnects and server restarts, powers replay of past runs through the same
panels that render live monitoring, and is retained on a ring (last ~1 GB) plus
a history age (7 days dev / 30 days deploy).

Streams are addressed by the plain identity tuple — never by task token
(tokens are credentials and appear nowhere in the log system).

## **openEventStream()**

Opens a **DVR session** over one source continuum — the recommended way to
consume a run log. The session thinks in *positions* on the timeline;
storage details (segments, keyframes, deltas) are invisible and every event
it delivers is fully reconstructed.

The protocol is **seed-then-stream**: `seek(pos)` positions the session,
the `get*()` calls seed your panels with state *as of* that position, and
`play(pos, speed, cb)` streams events strictly *after* what the seeds
covered — no gap, no duplicate. Speed `0` delivers as fast as possible,
`1` is real time, `10` is 10×. Playing from a past position auto-pins to
live on catching the wall clock; live is just the position pinned to now
(`seek('live')`), not a separate mode.

The stream identity carries the scope: omit `teamId` to open your OWN
development stream; pass `teamId` to open that team's DEPLOY continuum,
which requires `task.monitor` membership on the TARGET team (see
[API Endpoints](#api-endpoints)).

```typescript
const session = client.log.openEventStream(stream);

// Canonical startup: position, seed the panels, then roll.
await session.seek('live');
const status = await session.getStatus();          // state as of the position
const consoleLines = await session.getConsole(500); // exactly what the console showed
const traces = await session.getTraces(50);         // all in-flight + last 50 closed
await session.play(undefined, 0, ({ event }) => fold(event));

// Replay a past run at 10x from its beginning.
const [first] = await session.getChapters();
await session.play(first.beginTime, 10, ({ event }) => fold(event));

// Drill into one trace (a call tree; fetched sparsely from exactly
// the segments that contain it).
const detail = await session.getTrace(traces.closed[0].beginSeq);

session.pause();               // freeze the position
session.closeEventStream();    // dispose
```

```python
# Own dev stream; pass team_id='team-prod' for a team's deploy continuum.
session = client.log.open_event_stream('proj-1', 'chat_1')

await session.seek('live')
status = await session.get_status()
console_lines = await session.get_console(500)
traces = await session.get_traces(50)
await session.play(None, 0, lambda item: fold(item['event']))

chapters = await session.get_chapters()
await session.play(chapters[0]['beginTime'], 10, lambda item: fold(item['event']))

detail = await session.get_trace(traces['closed'][0]['beginSeq'])

session.pause()
session.close_event_stream()
```

`getTraces(n)` errors when `n > 50` — the session exposes all in-flight
traces plus a sliding window of the 50 most recently closed; any older
trace is still reachable by seeking to a position inside its lifetime.
Hosts that own a live subscription feed arriving events to the session via
`ingestLive(event)`; while pinned, arrival paces delivery.

## **chapters()**

Returns the stream's timeline in one small read: each run's begin/end
date-time, starting sequence number and outcome, the activity spans for the
timeline bar, the retained window, and the retention horizon.

```typescript
// Own dev stream; add teamId: 'team-prod' to read a team's deploy continuum.
const stream = { projectId: 'proj-1', source: 'chat_1' };
const timeline = await client.log.chapters(stream);
for (const track of timeline.chapters) {
	console.log(track.beginTime, track.endTime, track.outcome);
}
```

```python
timeline = await client.log.chapters('proj-1', 'chat_1')
for track in timeline['chapters']:
    print(track['beginTime'], track.get('endTime'), track.get('outcome'))
```

## **read()**

Ranged, paged event read over the continuum. Range forms:

| Form | Arguments |
| --- | --- |
| Sequence range | `fromSeq` / `toSeq` |
| Time range | `fromTime` / `toTime` (omit `toTime` for "to now") |
| Time to segment | `fromTime` + `toSegment` |

Responses are paged (`maxEvents` / `maxBytes`, server-clamped): when `nextSeq`
is present, pass it back as `cursor` to continue. `types` filters event types
server-side (e.g. `['output']` for a text log view). A `truncatedAtSeq` field
means the request reached below the retention horizon.

```typescript
let cursor: number | undefined;
do {
	const page = await client.log.read(stream, { fromSeq: 0, cursor, types: ['output'] });
	for (const event of page.events) {
		process.stdout.write(String(event.body?.output ?? ''));
	}
	cursor = page.nextSeq;
} while (cursor !== undefined);
```

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

Every event carries the continuum stamps in its **body** — the only place
they exist: `body.eventTime` (epoch seconds, stamped once at engine
ingress) and `body.logSeq` (catalog-seeded — a fresh stream starts at 1
and continues from the recorded `lastSeq + 1` across runs and restarts;
strictly monotonic) — identical live and on replay. The DAP envelope's own
`seq` is per-connection protocol bookkeeping and says nothing about the
continuum. Legacy segments that carried the stamps at the header are
canonicalized into the body at decode, so consumers read one shape.

## **segment()**

Fetches one segment's raw JSONL bytes, chunked by byte offset — the bulk
replay path. The server does no line scanning, filtering, or parsing: it
hands over the immutable segment content as-is, in **whole-line-aligned
chunks** (every response ends on a newline, so each chunk parses standalone).
Repeat with the returned `nextOffset` until `final`. The segment table (ids
and time extents) comes from `chapters()`; the active segment is served up to
its current length, with the live subscription covering growth past that.

```typescript
let offset = 0;
for (;;) {
	const chunk = await client.log.segment(stream, 0, { offset });
	for (const line of chunk.data.split('\n')) {
		if (line.trim()) handleEvent(JSON.parse(line));
	}
	if (chunk.final) break;
	offset = chunk.nextOffset!;
}
```

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

Prefer `segment()` over paged `read()` when consuming whole runs (replay,
export): it is strictly cheaper server-side per byte. Use `read()` for
filtered or narrow ranged queries.

## **delete()**

Destructive. `beforeTime` drops segments wholly older than the cutoff
(chapters trimmed, horizon advanced); `all` removes the entire stream
including its control file.

```typescript
await client.log.delete(stream, { beforeTime: Date.now() / 1000 - 86400 });
await client.log.delete(stream, { all: true });
```

```python
await client.log.delete('proj-1', 'chat_1', before_time=time.time() - 86400)
await client.log.delete('proj-1', 'chat_1', all=True)
```

## **API Endpoints**

These methods communicate via the RocketRide DAP protocol over WebSocket using
the single `rrext_log` command, dispatched by a `subcommand` argument:

| Method | DAP Command | `subcommand` |
| --- | --- | --- |
| `chapters()` | `rrext_log` | `chapters` |
| `read()` | `rrext_log` | `read` |
| `segment()` | `rrext_log` | `segment` |
| `delete()` | `rrext_log` | `delete` |

Reads require `task.monitor`; `delete` requires `task.control`. The scope
the request addresses picks whose streams those rights are resolved
against: without `teamId` you access your OWN dev streams; with `teamId`
you access that team's deploy continua, and the permission is checked
against the TARGET team — membership is the read/write right (a foreign or
unknown team reads the same as a permission miss).

`openEventStream()` is client-side composition: the session it returns
issues `chapters` and `segment` calls under the hood and reconstructs the
event stream locally — it adds no wire surface of its own.

## **Related Methods**

- [`use()`](./use) - Run a pipeline (its events are what the log records)
- [`deploy`](./deploy) - Server-side scheduled deployments (the `deploy` run kind)
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Live status of a running pipeline
