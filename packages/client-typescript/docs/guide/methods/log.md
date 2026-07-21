# Run Log

Every task writes a **run log**: one continuous JSONL event stream per task
identity (`projectId` + `source` + `runKind`). Individual runs are **chapters**
(tracks) inside the stream — there are no per-run log files. The log survives
disconnects and server restarts, powers replay of past runs through the same
panels that render live monitoring, and is retained on a ring (last ~1 GB) plus
a history age (7 days dev / 30 days deploy).

Streams are addressed by the plain identity tuple — never by task token
(tokens are credentials and appear nowhere in the log system).

## **chapters()**

Returns the stream's timeline in one small read: each run's begin/end
date-time, starting sequence number and outcome, the activity spans for the
timeline bar, the retained window, and the retention horizon.

```typescript
const stream = { projectId: 'proj-1', source: 'chat_1', runKind: 'dev' as const };
const timeline = await client.log.chapters(stream);
for (const track of timeline.chapters) {
	console.log(track.beginTime, track.endTime, track.outcome);
}
```

```python
timeline = await client.log.chapters('proj-1', 'chat_1', 'dev')
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
    page = await client.log.read('proj-1', 'chat_1', 'dev', from_seq=0, cursor=cursor, types=['output'])
    for event in page['events']:
        print(event['body'].get('output', ''), end='')
    cursor = page.get('nextSeq')
    if cursor is None:
        break
```

Every event carries the server-stamped headers `eventTime` (epoch seconds,
stamped once at engine ingress) and `seq` (epoch-microsecond-seeded, strictly
monotonic across runs and restarts) — identical live and on replay.

## **delete()**

Destructive. `beforeTime` drops segments wholly older than the cutoff
(chapters trimmed, horizon advanced); `all` removes the entire stream
including its control file.

```typescript
await client.log.delete(stream, { beforeTime: Date.now() / 1000 - 86400 });
await client.log.delete(stream, { all: true });
```

```python
await client.log.delete('proj-1', 'chat_1', 'dev', before_time=time.time() - 86400)
await client.log.delete('proj-1', 'chat_1', 'dev', all=True)
```

## **API Endpoints**

These methods communicate via the RocketRide DAP protocol over WebSocket using
the single `rrext_log` command, dispatched by a `subcommand` argument:

| Method | DAP Command | `subcommand` |
| --- | --- | --- |
| `chapters()` | `rrext_log` | `chapters` |
| `read()` | `rrext_log` | `read` |
| `delete()` | `rrext_log` | `delete` |

Reads require `task.monitor`; `delete` requires `task.control`. All access is
scoped to the authenticated user's own streams.

## **Related Methods**

- [`use()`](./use) - Run a pipeline (its events are what the log records)
- [`deploy`](./deploy) - Server-side scheduled deployments (the `deploy` run kind)
- [`get_task_status()` / `getTaskStatus()`](./get-task-status) - Live status of a running pipeline
