---

title: Run Logs (client.log)
---

# Run Logs — `client.log`

Every task writes one continuous JSONL event log per
`projectId.source.runKind` — a **continuum** in which individual runs are
chapter markers. The `client.log` namespace reads it: chapters for the
activity timeline, ranged event reads, raw segment fetches, deletion, and
the **DVR session** (`open_event_stream`) that powers live monitoring and
replay with one API.

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    client = RocketRideClient(host='localhost', port=5565)
    await client.connect()

    # The stream's chapters (runs): begin/end/outcome per run.
    timeline = await client.log.chapters('proj-1', 'chat_1', 'dev')
    for chapter in timeline['chapters']:
        print(chapter['beginTime'], chapter.get('outcome'))

    # Ranged event read over the continuum (paged).
    page = await client.log.read('proj-1', 'chat_1', 'dev', from_seq=0, types=['output'])
    for event in page['events']:
        print(event['body'].get('output', ''), end='')

    # The DVR session — live + replay through one surface.
    session = client.log.open_event_stream('proj-1', 'chat_1', 'dev')
    await session.seek('live')
    status = await session.get_status()  # state as of the position
    console = await session.get_console(500)  # exactly what the console showed
    traces = await session.get_traces(50)  # in-flight + last 50 closed
    await session.play(None, 0, lambda item: print(item['event']['event']))

    # Drill into one trace by its PERMANENT identity — the begin event's
    # continuum seq (slot ids recycle; beginSeq never does). A fresh or
    # all-in-flight stream may have no closed traces yet.
    if traces['closed']:
        detail = await session.get_trace(traces['closed'][0]['beginSeq'])

    session.pause()
    session.close_event_stream()
    await client.disconnect()


asyncio.run(main())
```

## Event shape

Every event carries the continuum stamps in its **body** — the only place
they exist: `body['eventTime']` (epoch seconds, stamped once at engine
ingress) and `body['logSeq']` (catalog-seeded — a fresh stream starts at 1
and continues from the recorded `lastSeq + 1` across runs and restarts;
strictly monotonic) — identical live and on replay, beside the
`project_id`/`source` identity. The DAP envelope's own `seq` is
per-connection protocol bookkeeping and says nothing about the continuum.
Legacy segments that carried the stamps at the header are canonicalized
into the body at decode, so consumers read one shape.

## Methods

| Method | Purpose |
| --- | --- |
| `chapters(project_id, source, run_kind)` | Runs (tracks) + segment spans + stream extents |
| `read(project_id, source, run_kind, ...)` | Ranged event read: `from_seq`/`to_seq`, `from_time`/`to_time`, `types`, paging via `nextSeq` cursor |
| `segment(project_id, source, run_kind, segment_id, ...)` | Raw whole-line-aligned segment bytes (bulk replay path) |
| `delete(project_id, source, run_kind, ...)` | Drop history: `before_time` or everything |
| `open_event_stream(project_id, source, run_kind)` | The DVR session (below) |

## The DVR session

`open_event_stream()` returns a `LogEventStream` mirroring the TypeScript
SDK session (`seek`, `play`, `pause`, `get_status`, `get_traces`,
`get_trace`, `get_console`, `ingest_live`, `close_event_stream`).
Seed-then-stream protocol: `seek(pos)` positions the session, the `get_*`
calls answer as of that position, and `play(pos, speed, cb)` delivers
events strictly after the seed watermark, paced by `speed` (0 = flat-out,
1 = real time, 10 = 10x). Playing from a past position auto-pins to live
on catching the wall clock — replay flows into live with no seam.

`get_trace(begin_seq)` resolves a trace by its begin event's continuum
seq. It fails when the seq has fallen below the retention horizon, or when
no trace-begin event exists at that seq — a recycled slot id or a client
fold's document counter is NOT a trace identity.

`get_traces(n)` errors when `n > 50` — the session exposes all in-flight
traces plus a sliding window of the 50 most recently closed; any older
trace is still reachable by seeking to a position inside its lifetime.
