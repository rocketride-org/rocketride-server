---
title: Run Logs
sidebar_position: 8
---

# Run Logs — `client.log`

Every task writes a **run log**: one continuous JSONL event stream per task
identity (`projectId` + `source`, plus the scope: a `teamId` addresses that
team's DEPLOY continuum — [deploy runs](/clients/typescript/deploy) log into the
team's tree, readable by any teammate with monitor rights — while omitting it
addresses your own dev stream; there is no run-kind argument). Individual runs are
**chapters** (tracks) inside the stream — there are no per-run log files. The log
survives disconnects and server restarts, powers replay of past runs through the
same panels that render live monitoring, and is retained on a ring (last ~1 GB)
plus a history age (7 days dev / 30 days deploy).

Streams are addressed by the plain identity tuple — never by task token (tokens
are credentials and appear nowhere in the log system).

## The DVR session — `openEventStream()`

Opens a **DVR session** over one source continuum — the recommended way to consume
a run log. The session thinks in *positions* on the timeline; storage details
(segments, keyframes, deltas) are invisible and every event it delivers is fully
reconstructed.

The protocol is **seed-then-stream**: `seek(pos)` positions the session, the
`get*()` calls seed your panels with state *as of* that position, and
`play(pos, speed, cb)` streams events strictly *after* what the seeds covered — no
gap, no duplicate. Speed `0` delivers as fast as possible, `1` is real time, `10`
is 10×. Playing from a past position auto-pins to live on catching the wall clock;
live is just the position pinned to now (`seek('live')`), not a separate mode.

```typescript
const stream = { projectId: 'proj-1', source: 'chat_1' };
const session = client.log.openEventStream(stream);

// Canonical startup: position, seed the panels, then roll.
await session.seek('live');
const status = await session.getStatus();           // state as of the position
const consoleLines = await session.getConsole(500); // exactly what the console showed
const traces = await session.getTraces(50);         // all in-flight + last 50 closed
await session.play(undefined, 0, ({ event }) => fold(event));

// Replay a past run at 10x from its beginning.
const [first] = await session.getChapters();
await session.play(first.beginTime, 10, ({ event }) => fold(event));

// Drill into one trace (a call tree; fetched sparsely from exactly
// the segments that contain it).
const detail = await session.getTrace(traces.closed[0].beginSeq);

session.pause();            // freeze the position
session.closeEventStream(); // dispose
```

`getTraces(n)` errors when `n > 50` — the session exposes all in-flight traces
plus a sliding window of the 50 most recently closed; any older trace is still
reachable by seeking to a position inside its lifetime. `getTrace(traceId)`
resolves a trace by its begin event's continuum seq (pass the chapter's
`beginSeq` value) — the permanent identity (slot
ids recycle; `beginSeq` never does). Hosts that own a live subscription feed
arriving events to the session via `ingestLive(event)`; while pinned, arrival
paces delivery.

## `chapters()`

Returns the stream's timeline in one small read: each run's begin/end date-time,
starting sequence number and outcome, the activity spans for the timeline bar, the
retained window, and the retention horizon.

```typescript
// Own dev stream; add teamId: 'team-prod' to read a team's deploy continuum.
const stream = { projectId: 'proj-1', source: 'chat_1' };
const timeline = await client.log.chapters(stream);
for (const track of timeline.chapters) {
	console.log(track.beginTime, track.endTime, track.outcome);
}
```

## `read()`

Ranged, paged event read over the continuum. Range forms: a sequence range
(`fromSeq`/`toSeq`), a time range (`fromTime`/`toTime`, omit `toTime` for "to
now"), or time-to-segment (`fromTime` + `toSegment`). Responses are paged
(`maxEvents`/`maxBytes`, server-clamped): when `nextSeq` is present, pass it back
as `cursor` to continue. `types` filters event types server-side; a
`truncatedAtSeq` field means the request reached below the retention horizon.

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

Every event carries the continuum stamps in its **body** — the only place they
exist: `body.eventTime` (epoch seconds, stamped once at engine ingress) and
`body.logSeq` (catalog-seeded — a fresh stream starts at 1 and continues from the
recorded `lastSeq + 1` across runs and restarts; strictly monotonic) — identical
live and on replay. The DAP envelope's own `seq` is per-connection protocol
bookkeeping and says nothing about the continuum.

## `segment()`

Fetches one segment's raw JSONL bytes, chunked by byte offset — the bulk replay
path. The server hands over the immutable segment content as-is, in
**whole-line-aligned chunks** (every response ends on a newline, so each chunk
parses standalone). Repeat with the returned `nextOffset` until `final`. The
segment table comes from `chapters()`.

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

Prefer `segment()` over paged `read()` when consuming whole runs (replay, export);
use `read()` for filtered or narrow ranged queries.

## `delete()`

Destructive. `beforeTime` drops segments wholly older than the cutoff (chapters
trimmed, horizon advanced); `all` removes the entire stream including its control
file.

```typescript
await client.log.delete(stream, { beforeTime: Date.now() / 1000 - 86400 });
await client.log.delete(stream, { all: true });
```

## Wire surface and permissions

All methods use the single `rrext_log` DAP command, dispatched by a `subcommand`
argument (`chapters`, `read`, `segment`, `delete`). Reads require `task.monitor`;
`delete` requires `task.control`. The scope the request addresses picks whose
streams those rights are resolved against: without `teamId` you access your OWN
dev streams; with `teamId` the permission is checked against the TARGET team —
membership is the read/write right. `openEventStream()` is client-side
composition: it issues `chapters` and `segment` calls under the hood and
registers a live monitor subscription while open (released by
`closeEventStream()`) — it adds no wire surface of its own.
