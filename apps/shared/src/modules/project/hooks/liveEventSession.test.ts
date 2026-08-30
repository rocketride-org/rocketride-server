// =============================================================================
// Unit tests: the in-memory live-edge session.
//
// These pin the regression from PR #1661, which rewired every accumulating pane
// (Trace, Errors, Status, Tokens, Flow, Log, Analyze) to read through a
// host-injected DVR session obtained via `openEventStream` — a prop no host in
// this repo binds. `useTaskEvents.ingestLive` then dropped every live event
// (`const target = sessionRef.current; if (!target) return;`) and the panes
// rendered their empty states mid-run, silently.
//
// The contract that matters to `useTaskEvents.deliver`: it is a pure append —
// no sort, no dedupe — so a view must hand each event over EXACTLY ONCE, oldest
// first, across repeated `play` calls.
//
// Run via `shared:test` (node --import tsx --test), matching the package convention.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveEventSession, createLiveEventStore, LIVE_BUFFER_CAP } from './liveEventSession';
import type { TaskEventMessage } from './useTaskEvents';

// --- helpers -----------------------------------------------------------------

let seq = 0;

const evt = (event: string, body: Record<string, unknown> = {}): TaskEventMessage => {
	seq += 1;
	return { event, body: { eventTime: 1000 + seq, logSeq: seq, ...body } };
};

const flow = (op: string, pipe: number, extra: Record<string, unknown> = {}): TaskEventMessage => evt('apaevt_flow', { op, id: pipe, ...extra });

/** Collect everything a view delivers. */
const collector = () => {
	const seen: TaskEventMessage[] = [];
	return { seen, sink: (item: { event: TaskEventMessage }) => seen.push(item.event) };
};

// --- delivery ----------------------------------------------------------------

test('play delivers buffered events oldest first', async () => {
	const session = createLiveEventSession();
	const a = evt('apaevt_flow');
	const b = evt('apaevt_flow');
	session.ingestLive(a);
	session.ingestLive(b);

	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);

	assert.deepEqual(
		seen.map((m) => m.body.logSeq),
		[a.body.logSeq, b.body.logSeq]
	);
});

test('each event is delivered exactly once across repeated play calls', async () => {
	const session = createLiveEventSession();
	session.ingestLive(evt('apaevt_flow'));

	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);
	await session.play(undefined, 0, sink);
	await session.play(undefined, 0, sink);

	assert.equal(seen.length, 1, 'a replayed watermark would duplicate rows in the fold');
});

test('events arriving while playing reach the sink immediately', async () => {
	const session = createLiveEventSession();
	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);

	session.ingestLive(evt('apaevt_flow'));
	session.ingestLive(evt('apaevt_flow'));

	assert.equal(seen.length, 2, 'live arrivals must not wait for the next play() nudge');
});

test('pause stops delivery and play resumes from the watermark', async () => {
	const session = createLiveEventSession();
	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);

	session.ingestLive(evt('apaevt_flow'));
	session.pause();
	session.ingestLive(evt('apaevt_flow'));
	assert.equal(seen.length, 1, 'paused view must not receive');

	await session.play(undefined, 0, sink);
	assert.equal(seen.length, 2, 'resuming delivers exactly the missed event');
});

// --- seeking -----------------------------------------------------------------

test("seek('live') treats everything observed as delivered", async () => {
	const session = createLiveEventSession();
	session.ingestLive(evt('apaevt_flow'));
	session.ingestLive(evt('apaevt_flow'));

	await session.seek('live');
	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);

	assert.deepEqual(seen, []);
});

test('numeric seek rewinds to the first event at or after the position', async () => {
	const session = createLiveEventSession();
	const first = evt('apaevt_flow');
	const second = evt('apaevt_flow');
	session.ingestLive(first);
	session.ingestLive(second);
	await session.seek('live');

	await session.seek(second.body.eventTime);
	const { seen, sink } = collector();
	await session.play(undefined, 0, sink);

	assert.deepEqual(
		seen.map((m) => m.body.logSeq),
		[second.body.logSeq]
	);
});

// --- status ------------------------------------------------------------------

test('getStatus returns null before any snapshot', async () => {
	assert.equal(await createLiveEventSession().getStatus(), null);
});

test('getStatus returns the most recent snapshot at the live edge', async () => {
	const session = createLiveEventSession();
	session.ingestLive(evt('apaevt_status', { objects: 1 }));
	session.ingestLive(evt('apaevt_flow'));
	session.ingestLive(evt('apaevt_status_update', { objects: 7 }));

	await session.seek('live');
	const status = await session.getStatus();
	assert.equal(status?.objects, 7);
});

test('getStatus is bounded by the session position, not the live edge', async () => {
	const session = createLiveEventSession();
	const early = evt('apaevt_status', { objects: 1 });
	const later = evt('apaevt_status_update', { objects: 7 });
	session.ingestLive(early);
	session.ingestLive(evt('apaevt_flow'));
	session.ingestLive(later);

	// Rewind to just after the early snapshot: the status seeded for a replayed
	// run must be the one in force back then, not the current one.
	await session.seek(Number(later.body.eventTime));
	assert.equal((await session.getStatus())?.objects, 1);

	await session.seek(Number(early.body.eventTime));
	assert.equal(await session.getStatus(), null);
});

// --- trace detail ------------------------------------------------------------

test('getTrace returns one request keyed by its begin seq', async () => {
	const session = createLiveEventSession();
	const begin = flow('begin', 1);
	session.ingestLive(begin);
	session.ingestLive(flow('enter', 1, { component: 'llm' }));
	session.ingestLive(flow('leave', 1, { component: 'llm' }));
	session.ingestLive(flow('end', 1));

	const { events } = await session.getTrace(begin.body.logSeq);
	assert.deepEqual(
		events.map((m) => m.body.op),
		['begin', 'enter', 'leave', 'end']
	);
});

test('getTrace ignores other pipe slots', async () => {
	const session = createLiveEventSession();
	const begin = flow('begin', 1);
	session.ingestLive(begin);
	session.ingestLive(flow('enter', 2, { component: 'other' }));
	session.ingestLive(flow('end', 1));

	const { events } = await session.getTrace(begin.body.logSeq);
	assert.deepEqual(
		events.map((m) => m.body.id),
		[1, 1]
	);
});

test('getTrace stops at the next request reusing the same slot', async () => {
	const session = createLiveEventSession();
	const begin = flow('begin', 1);
	session.ingestLive(begin);
	session.ingestLive(flow('enter', 1, { component: 'llm' }));
	// No `end` — the slot is recycled by the next request.
	session.ingestLive(flow('begin', 1));
	session.ingestLive(flow('enter', 1, { component: 'later' }));

	const { events } = await session.getTrace(begin.body.logSeq);
	assert.equal(events.length, 2, 'a pipe id is a slot, not an identity');
});

test('getTrace returns nothing for an unknown id', async () => {
	const session = createLiveEventSession();
	session.ingestLive(flow('begin', 1));
	assert.deepEqual((await session.getTrace(999_999)).events, []);
});

// --- buffer cap --------------------------------------------------------------

test('the buffer evicts oldest first and reports what was dropped', () => {
	const session = createLiveEventSession();
	assert.equal(session.truncatedBefore, null);

	for (let i = 0; i < LIVE_BUFFER_CAP + 1; i++) session.ingestLive(evt('apaevt_flow'));

	assert.ok(session.size <= LIVE_BUFFER_CAP, `size ${session.size} exceeded the cap`);
	assert.ok(typeof session.truncatedBefore === 'number', 'coverage loss must be reported, not silent');
});

// --- store / views -----------------------------------------------------------

test('a second view sees events ingested through the first', async () => {
	const store = createLiveEventStore();
	const pane = store.open();
	const walker = store.open();

	pane.ingestLive(evt('apaevt_flow'));

	const { seen, sink } = collector();
	await walker.play(undefined, 0, sink);
	assert.equal(seen.length, 1, 'the export walker must see what the pane recorded');
});

test('views keep independent watermarks', async () => {
	const store = createLiveEventStore();
	const pane = store.open();
	const walker = store.open();

	pane.ingestLive(evt('apaevt_flow'));

	const paneSink = collector();
	await pane.play(undefined, 0, paneSink.sink);
	assert.equal(paneSink.seen.length, 1);

	// The walker has consumed nothing yet, so it still owes the same event.
	const walkerSink = collector();
	await walker.play(undefined, 0, walkerSink.sink);
	assert.equal(walkerSink.seen.length, 1, 'one view draining must not advance another');
});

test('closing one view leaves siblings working', async () => {
	const store = createLiveEventStore();
	const pane = store.open();
	const walker = store.open();
	pane.ingestLive(evt('apaevt_flow'));

	walker.closeEventStream();

	const { seen, sink } = collector();
	await pane.play(undefined, 0, sink);
	assert.equal(seen.length, 1, 'the surviving view keeps the buffer');
});

test('a closed view stops accepting events', () => {
	const store = createLiveEventStore();
	const view = store.open();
	view.closeEventStream();
	view.ingestLive(evt('apaevt_flow'));
	assert.equal(store.size, 0);
});
