// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// INGEST SUMMARY: what a drop became, and where its chunks landed
// =============================================================================
//
// Above the upload rows, one line per drop: "Drop of 12 files: 9 added
// (341 chunks) · 2 replaced (19 chunks) · 1 not added · 00:48", live while
// the drop runs and kept when Clear finished drops its rows. Once every file
// of the drop has finished, "Show new chunks on the map" hands the new
// documents' chunk keys to the map (actions.showOnMap(keys, 'document')),
// which pins at most limits.project_keys_max of them through `project`; the
// summary says "N of M new chunks placed" when the cap cut the list.
// =============================================================================

import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test as nodeTest } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IExplorerEndpoint, IRoleChannel, ISendFile } from 'shared/explorer';
import type { ConsoleActions, ConsoleModel, HighlightSource, IDialectResult, IUploadEvent, VectorChannels, VectorKey } from '../src/contract/types';
import type { CallOutcome } from '../src/chat/toolCalls';
import type { DropCandidate, IngestDrop, UploadRow } from '../src/vector/uploads';
import type { IngestDeps } from '../src/ingest/ingestQueue';

/** Most a test here may take: they await fakes, so a regression must fail, not hang the run. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Declare a test bounded by {@link TEST_TIMEOUT_MS}.
 *
 * @param name - What it checks.
 * @param fn - The test.
 */
function test(name: string, fn: () => void | Promise<void>): void {
	void nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

// ── Shell stand-ins (installed before any panel module loads) ────────────────

const h = React.createElement;
const shellStandIn = {
	// The shell's disabled modifier, so a test can tell a disabled button by its look.
	commonStyles: new Proxy({}, { get: (_target, key) => (key === 'buttonDisabled' ? { opacity: 0.5, cursor: 'default' } : {}) }),
	EmptyState: ({ title, description }: { title: string; description?: string }) => h('div', { 'data-empty-state': '' }, h('strong', null, title), description ? h('p', null, description) : null),
	ConfirmDialog: (props: { title: string; message: React.ReactNode }) => h('div', { role: 'dialog', 'aria-label': props.title }, props.message),
	useShellEvent: () => undefined,
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

const uploads = require('../src/vector/uploads') as typeof import('../src/vector/uploads');
const { NO_MAP_SENTENCE, NO_PLACING_SENTENCE, SHOW_NEW_LABEL, UNCOUNTED_SENTENCE, dropSummaryText, formatElapsed, newChunkKeys, placedSentence, settleDrops, showNewChunksReason, summariseDrop, uploadLabel } = uploads;
const { createIngestQueue } = require('../src/ingest/ingestQueue') as typeof import('../src/ingest/ingestQueue');
const { createNameLocks } = require('../src/ingest/nameLocks') as typeof import('../src/ingest/nameLocks');
const { objectIdForPath } = require('../src/vector/objectId') as typeof import('../src/vector/objectId');
const { showDropOnMap } = require('../src/ingest/useIngest') as typeof import('../src/ingest/useIngest');
const { UploadList } = require('../src/components/UploadList') as typeof import('../src/components/UploadList');
const { IngestPanel } = require('../src/components/IngestPanel') as typeof import('../src/components/IngestPanel');
const { chatSessionFor, ingestQueueFor, forgetChatAndIngest, heldConnections } = require('../src/chat/registry') as typeof import('../src/chat/registry');
const { connectionCaches } = require('../src/adapters/explorer') as typeof import('../src/adapters/explorer');
const { forgetConnections } = require('../src/vector/identityChange') as typeof import('../src/vector/identityChange');

// ── Fixtures and fakes ──────────────────────────────────────────────────────

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON.
 */
function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', name), 'utf8')) as T;
}

/**
 * An upload row.
 *
 * @param id - Row id.
 * @param rowPath - Stored path.
 * @param status - Where it is.
 * @param extra - Fields to replace.
 * @returns The row.
 */
function row(id: string, rowPath: string, status: UploadRow['status'], extra: Partial<UploadRow> = {}): UploadRow {
	return { id, path: rowPath, name: rowPath.slice(rowPath.lastIndexOf('/') + 1), objectId: `oid-${id}`, size: 100, status, bytesSent: 0, fileSize: 100, chunks: null, existingChunks: null, message: null, detail: null, ...extra };
}

/**
 * A drop over the given rows, all of them ended (as the queue records them).
 *
 * @param rows - Its rows.
 * @param startedAt - When it was dropped.
 * @param finishedAt - When its last file ended, or null.
 * @returns The drop.
 */
function dropOf(rows: readonly UploadRow[], startedAt: number, finishedAt: number | null): IngestDrop {
	const ended: Record<string, UploadRow> = {};
	for (const one of rows) if (uploads.FINISHED.has(one.status)) ended[one.id] = one;
	return { id: 'd1', startedAt, finishedAt, rowIds: rows.map((one) => one.id), ended, shown: null };
}

/**
 * A drop candidate.
 *
 * @param relPath - Path in the drop.
 * @param size - Bytes.
 * @returns The candidate.
 */
function candidate(relPath: string, size = 100): DropCandidate {
	return { file: { name: relPath.slice(relPath.lastIndexOf('/') + 1), size, type: '' } as unknown as File, relPath };
}

/** A promise and its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A clock the tests move by hand. */
interface Clock {
	at: number;
	now(): number;
}

/**
 * A manual clock.
 *
 * @param at - The start.
 * @returns The clock.
 */
function manualClock(at = 1_700_000_000_000): Clock {
	const clock: Clock = { at, now: () => clock.at };
	return clock;
}

/**
 * Fake queue dependencies: paths in `stored` are already stored, every upload
 * completes (unless its path is in `fail`), the store then counts `counts[path]`
 * (default 2) chunks, and each send moves the clock by `sendMs`.
 *
 * @param options - Stored paths, counts, failures, the clock and the send time.
 * @returns The deps and what they saw.
 */
function fakeDeps(options: { stored?: Record<string, number>; counts?: Record<string, number | null>; fail?: ReadonlySet<string>; clock?: Clock; sendMs?: number; events?: (files: ISendFile[]) => Promise<void>; canProbe?: boolean; sendResult?: (file: ISendFile) => Record<string, unknown> } = {}): { deps: IngestDeps; announced: string[] } {
	const announced: string[] = [];
	const pathOf = new Map<string, string>();
	const deps: IngestDeps = {
		canProbe: options.canProbe ?? true,
		canCount: true,
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') {
				const stored = Object.entries(options.stored ?? {}).find(([storedPath]) => objectIdForPath(storedPath) === input.object_id);
				if (stored === undefined) return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
				return { ok: true, value: { success: true, items: [{ chunkId: 0 }], total: stored[1] } };
			}
			const id = (input.object_ids as string[])[0];
			const stored = pathOf.get(id) ?? '';
			const count = options.counts && stored in options.counts ? options.counts[stored] : 2;
			return { ok: true, value: { success: true, items: [{ objectId: id, chunks: count }] } };
		},
		async sendFiles(files) {
			if (options.events) await options.events(files);
			if (options.clock) options.clock.at += options.sendMs ?? 0;
			return files.map((file) => {
				const name = String(file.objinfo?.name);
				if (options.sendResult) {
					const result = options.sendResult(file);
					const reported = (result.result as Record<string, unknown> | undefined)?.objectId;
					pathOf.set(typeof reported === 'string' ? reported : objectIdForPath(name), name);
					return result;
				}
				pathOf.set(objectIdForPath(name), name);
				const failed = options.fail?.has(name) ?? false;
				return { action: failed ? 'error' : 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0.1, ...(failed ? { error: 'Pipe closed with an error' } : {}) };
			});
		},
		onDocumentsChanged: () => undefined,
		announce(message) {
			announced.push(message);
		},
		sleep: async () => undefined,
		locks: createNameLocks(),
		...(options.clock ? { now: options.clock.now } : {}),
	};
	return { deps, announced };
}

/**
 * Actions that record what the summary asked of the console.
 *
 * @returns The actions and the calls.
 */
function recordingActions(): { actions: ConsoleActions; shown: Array<{ keys: VectorKey[]; source: HighlightSource }>; announced: string[] } {
	const shown: Array<{ keys: VectorKey[]; source: HighlightSource }> = [];
	const announced: string[] = [];
	const actions: ConsoleActions = {
		openDocument: () => undefined,
		showOnMap: (keys, source) => {
			shown.push({ keys: keys.map((key) => [key[0], key[1]] as VectorKey), source });
		},
		requestRemove: () => undefined,
		askAbout: () => undefined,
		documentsChanged: () => undefined,
		announce: (message) => {
			announced.push(message);
		},
	};
	return { actions, shown, announced };
}

/**
 * Render to static markup.
 *
 * @param element - The element.
 * @returns The markup.
 */
function render(element: React.ReactElement): string {
	return renderToStaticMarkup(element);
}

/**
 * The markup with HTML entities for quotes and ampersands decoded.
 *
 * @param html - The markup.
 * @returns Readable text.
 */
function decoded(html: string): string {
	return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/**
 * The text a reader sees: the markup without tags.
 *
 * @param html - The markup.
 * @returns Its text.
 */
function textOf(html: string): string {
	return decoded(html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ''));
}

// ── The sentence ────────────────────────────────────────────────────────────

test('summary: a finished drop of 12 files reads added, replaced and not added, with chunks and the time it took', () => {
	const added = [40, 40, 40, 40, 40, 40, 40, 40, 21].map((chunks, i) => row(`a${i}`, `docs/a${i}.md`, 'done', { chunks }));
	const replaced = [12, 7].map((chunks, i) => row(`r${i}`, `docs/r${i}.pdf`, 'done', { chunks, replaces: true }));
	const refused = row('x0', 'docs/x.exe', 'refused', { message: 'Not added: .exe files are not supported.' });
	const rows = [...added, ...replaced, refused];
	const summary = summariseDrop(dropOf(rows, 1_000_000, 1_048_300), [], 9_999_999);
	assert.equal(dropSummaryText(summary), 'Drop of 12 files: 9 added (341 chunks) · 2 replaced (19 chunks) · 1 not added · 00:48');
	assert.equal(summary.files, 12);
	assert.equal(summary.added, 9);
	assert.equal(summary.replaced, 2);
	assert.equal(summary.notAdded, 1);
	assert.equal(summary.finished, true);
	assert.equal(summary.newChunks, 360);
	assert.deepEqual(
		summary.newDocuments.map((doc) => [doc.objectId, doc.chunks]),
		[...added, ...replaced].map((one) => [one.objectId, one.chunks])
	);
});

test('summary: live while the drop runs — waiting, in progress, cancelled and failed rows, and the clock from the drop', () => {
	const rows = [
		row('u1', 'a.md', 'done', { chunks: 7 }),
		row('u2', 'b.md', 'uploading', { bytesSent: 40 }),
		row('u3', 'c.md', 'confirm'),
		row('u4', 'd.md', 'queued'),
		row('u5', 'e.md', 'cancelled', { message: 'Cancelled. Nothing was sent.' }),
		row('u6', 'f.md', 'failed', { message: 'Failed.' }),
	];
	const drop = dropOf(rows, 5_000, null);
	const summary = summariseDrop(drop, rows, 10_400);
	assert.equal(summary.finished, false);
	assert.equal(dropSummaryText(summary), 'Drop of 6 files: 1 added (7 chunks) · 1 not added · 1 cancelled · 1 waiting for your answer · 2 in progress · 00:05');
	// The rows in flight come from the live list, the ended ones from the drop's record.
	const later = rows.map((one) => (one.id === 'u2' ? { ...one, status: 'processing' as const } : one));
	assert.equal(summariseDrop(drop, later, 70_000).inProgress, 2);
	assert.equal(dropSummaryText(summariseDrop(drop, later, 70_000)).endsWith('· 01:05'), true);
});

test('summary: singulars, zero chunks, and counts the store did not report are never presented as counted', () => {
	assert.equal(dropSummaryText(summariseDrop(dropOf([row('u1', 'a.md', 'done', { chunks: 1 })], 0, 2_000), [], 0)), 'Drop of 1 file: 1 added (1 chunk) · 00:02');
	assert.equal(dropSummaryText(summariseDrop(dropOf([row('u1', 'a.pdf', 'done', { chunks: 0 })], 0, 1_000), [], 0)), 'Drop of 1 file: 1 added (0 chunks) · 00:01');
	const some = [row('u1', 'a.md', 'done', { chunks: 5 }), row('u2', 'b.md', 'done'), row('u3', 'c.md', 'done')];
	const partly = summariseDrop(dropOf(some, 0, 3_000), [], 0);
	assert.equal(dropSummaryText(partly), 'Drop of 3 files: 3 added (5 chunks; 2 not counted) · 00:03');
	assert.equal(partly.uncounted, 2);
	assert.equal(partly.newChunks, 5);
	assert.deepEqual(
		partly.newDocuments.map((doc) => doc.objectId),
		['oid-u1']
	);
	const none = summariseDrop(dropOf([row('u1', 'a.md', 'done'), row('u2', 'b.md', 'done', { replaces: true })], 0, 0), [], 0);
	assert.equal(dropSummaryText(none), 'Drop of 2 files: 1 added (chunks not counted) · 1 replaced (chunks not counted) · 00:00');
	assert.equal(none.newChunks, 0);
});

test('formatElapsed: minutes and seconds, hours when it takes that long, never negative', () => {
	assert.equal(formatElapsed(0), '00:00');
	assert.equal(formatElapsed(48_900), '00:48');
	assert.equal(formatElapsed(754_000), '12:34');
	assert.equal(formatElapsed(3_723_000), '1:02:03');
	assert.equal(formatElapsed(-5), '00:00');
	assert.equal(formatElapsed(Number.NaN), '00:00');
});

// ── Where the new chunks go ─────────────────────────────────────────────────

test('newChunkKeys: every new document gets its first chunk before any gets a second; the cap cuts the list, the total does not', () => {
	const docs = [
		{ objectId: 'A', path: 'a.md', chunks: 3 },
		{ objectId: 'B', path: 'b.md', chunks: 1 },
		{ objectId: 'C', path: 'c.md', chunks: 2 },
	];
	assert.deepEqual(newChunkKeys(docs, 4), {
		keys: [
			['A', 0],
			['B', 0],
			['C', 0],
			['A', 1],
		],
		total: 6,
	});
	assert.deepEqual(newChunkKeys(docs, 200).keys, [
		['A', 0],
		['B', 0],
		['C', 0],
		['A', 1],
		['C', 1],
		['A', 2],
	]);
	const many = [40, 40, 40, 40, 40, 40, 40, 40, 21].map((chunks, i) => ({ objectId: `d${i}`, path: `d${i}.md`, chunks }));
	const capped = newChunkKeys(many, 200);
	assert.equal(capped.total, 341);
	assert.equal(capped.keys.length, 200);
	assert.equal(new Set(capped.keys.map((key) => `${key[0]}#${key[1]}`)).size, 200, 'no key twice');
	assert.deepEqual(new Set(capped.keys.map((key) => key[0])), new Set(many.map((doc) => doc.objectId)), 'every document is placed');
	assert.deepEqual(newChunkKeys([], 200), { keys: [], total: 0 });
	assert.deepEqual(newChunkKeys(docs, 0).keys, []);
});

test('placedSentence and the reasons the map cannot show new chunks', () => {
	assert.equal(placedSentence(200, 341, 200), '200 of 341 new chunks placed: the map pins at most 200 chunks outside its sample.');
	assert.equal(placedSentence(6, 6, 200), null);
	assert.equal(showNewChunksReason({}), null);
	assert.equal(showNewChunksReason({ sample: true, project: true }), null);
	assert.equal(showNewChunksReason({ sample: false }), NO_MAP_SENTENCE);
	assert.equal(showNewChunksReason({ sample: true, project: false }), NO_PLACING_SENTENCE);
	assert.match(NO_MAP_SENTENCE, /cannot draw a map/);
	assert.match(NO_PLACING_SENTENCE, /Draw a new sample on the Map tab/);
	assert.equal(SHOW_NEW_LABEL, 'Show new chunks on the map');
});

test('settleDrops: a row is recorded as it ends, and the drop ends with its last row', () => {
	const rows = [row('u1', 'a.md', 'done', { chunks: 2 }), row('u2', 'b.md', 'uploading')];
	const drop: IngestDrop = { id: 'd1', startedAt: 0, finishedAt: null, rowIds: ['u1', 'u2'], ended: {}, shown: null };
	const first = settleDrops([drop], rows, 1_000);
	assert.deepEqual(Object.keys(first.drops[0].ended), ['u1']);
	assert.equal(first.drops[0].finishedAt, null);
	assert.deepEqual(first.finished, []);
	assert.equal(settleDrops(first.drops, rows, 1_500).drops[0], first.drops[0], 'nothing changed: the same drop');
	const done = rows.map((one) => (one.id === 'u2' ? { ...one, status: 'done' as const, chunks: 3 } : one));
	const second = settleDrops(first.drops, done, 4_000);
	assert.equal(second.drops[0].finishedAt, 4_000);
	assert.deepEqual(
		second.finished.map((one) => one.id),
		['d1']
	);
	assert.equal(settleDrops(second.drops, [], 9_000).drops[0], second.drops[0], 'a finished drop never changes');
});

// ── The queue keeps a summary per drop ──────────────────────────────────────

test('queue: a 3-file drop reports "3 added (6 chunks)" with its time, and says it once the drop is done', async () => {
	const clock = manualClock();
	const fake = fakeDeps({ clock, sendMs: 4_000 });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md'), candidate('c.md')]);
	await queue.idle();
	const state = queue.getState();
	assert.equal(state.drops.length, 1);
	const summary = summariseDrop(state.drops[0], state.rows, clock.at + 60_000);
	assert.equal(dropSummaryText(summary), 'Drop of 3 files: 3 added (6 chunks) · 00:04');
	assert.equal(state.drops[0].finishedAt, clock.at);
	assert.deepEqual(state.drops[0].rowIds, state.rows.map((one) => one.id));
	// The drop's line is said after its last file's own line, once.
	const said = fake.announced.filter((message) => message.startsWith('Drop of'));
	assert.deepEqual(said, ['Drop of 3 files: 3 added (6 chunks) · 00:04']);
	assert.ok(fake.announced.indexOf(said[0]) > fake.announced.indexOf('c.md: 2 chunks added'));
});

test('queue: a one-file drop is summarised but not announced twice (its row already said it)', async () => {
	const fake = fakeDeps({ clock: manualClock(), sendMs: 1_000 });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('only.md')]);
	await queue.idle();
	assert.equal(queue.getState().drops.length, 1);
	assert.ok(fake.announced.includes('only.md: 2 chunks added'));
	assert.ok(!fake.announced.some((message) => message.startsWith('Drop of')));
});

test('queue: duplicate base names — the summary matches the upload events and results, file by file', async () => {
	const script = fixture<{ files: Array<{ relPath: string; size: number }>; events: IUploadEvent[] }>('upload_events_duplicate_basename.json');
	const eventsOf = new Map<number, IUploadEvent[]>();
	for (const event of script.events) eventsOf.set(event.file_size, [...(eventsOf.get(event.file_size) ?? []), event]);
	let queueRef: ReturnType<typeof createIngestQueue> | null = null;
	const live: Array<{ size: number; line: string }> = [];
	const clock = manualClock();
	const fake = fakeDeps({
		clock,
		sendMs: 2_000,
		fail: new Set(['notes/memo.md']),
		counts: { 'a/report.pdf': 5, 'b/report.pdf': 4 },
		async events(files) {
			const queue = queueRef as ReturnType<typeof createIngestQueue>;
			for (const event of eventsOf.get(files[0].file.size) ?? []) {
				queue.handleEvent(event);
				const state = queue.getState();
				live.push({ size: event.file_size, line: dropSummaryText(summariseDrop(state.drops[0], state.rows, clock.at)) });
			}
		},
	});
	const queue = createIngestQueue(fake.deps);
	queueRef = queue;
	await queue.addDrop([...script.files.map((file) => candidate(file.relPath, file.size)), candidate('notes/memo.md', 10)]);
	await queue.idle();
	const state = queue.getState();
	assert.deepEqual(
		state.rows.map((one) => [one.path, one.status]),
		[
			['a/report.pdf', 'done'],
			['b/report.pdf', 'done'],
			['notes/memo.md', 'failed'],
		]
	);
	const summary = summariseDrop(state.drops[0], state.rows, clock.at);
	assert.equal(dropSummaryText(summary), 'Drop of 3 files: 2 added (9 chunks) · 1 not added · 00:06');
	assert.equal(summary.added, state.rows.filter((one) => one.status === 'done').length);
	assert.equal(summary.notAdded, state.rows.filter((one) => one.status === 'failed').length);
	assert.deepEqual(
		summary.newDocuments.map((doc) => [doc.path, doc.objectId, doc.chunks]),
		[
			['a/report.pdf', objectIdForPath('a/report.pdf'), 5],
			['b/report.pdf', objectIdForPath('b/report.pdf'), 4],
		]
	);
	// memo.md (a unique name) went first and failed; while the two report.pdf files were sent one after the
	// other, the line counted the one in flight as in progress, never as added before its result.
	assert.equal(live.length, script.events.length);
	for (const { size, line } of live) {
		if (size === 120000) assert.match(line, /^Drop of 3 files: 1 not added · 2 in progress · 00:02$/);
		else assert.match(line, /^Drop of 3 files: (1 added \(5 chunks\) · 1 not added · 1 in progress|1 not added · 2 in progress) · 00:04$/);
	}
});

test('queue: Replace counts as replaced and Cancel as cancelled; refused files are not added', async () => {
	const fake = fakeDeps({ stored: { 'report.pdf': 19, 'old.md': 4 }, counts: { 'report.pdf': 3, 'new.md': 6 } });
	const queue = createIngestQueue(fake.deps);
	const first = queue.addDrop([candidate('report.pdf'), candidate('new.md'), candidate('virus.exe')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.answerConfirm(true);
	await first;
	await queue.idle();
	const second = queue.addDrop([candidate('old.md'), candidate('fresh.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.answerConfirm(false);
	await second;
	await queue.idle();
	const state = queue.getState();
	assert.equal(state.drops.length, 2);
	assert.match(dropSummaryText(summariseDrop(state.drops[0], state.rows, 0)), /^Drop of 3 files: 1 added \(6 chunks\) · 1 replaced \(3 chunks\) · 1 not added · /);
	assert.match(dropSummaryText(summariseDrop(state.drops[1], state.rows, 0)), /^Drop of 2 files: 1 added \(2 chunks\) · 1 cancelled · /);
	const replaced = state.rows.find((one) => one.path === 'report.pdf') as UploadRow;
	assert.equal(replaced.replaces, true);
	assert.equal(uploadLabel(replaced), 'Replaced: 3 chunks stored');
	assert.equal(state.rows.find((one) => one.path === 'new.md')?.replaces ?? false, false);
	assert.equal(state.rows.find((one) => one.path === 'old.md')?.replaces ?? false, false, 'a cancelled replacement replaced nothing');
});

test('queue: a file the store could not check, sent anyway, counts as added (the store did not say it replaced anything)', async () => {
	const fake = fakeDeps({ canProbe: false });
	const queue = createIngestQueue(fake.deps);
	const drop = queue.addDrop([candidate('x.md'), candidate('y.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.answerConfirm(true);
	await drop;
	await queue.idle();
	const state = queue.getState();
	assert.match(dropSummaryText(summariseDrop(state.drops[0], state.rows, 0)), /^Drop of 2 files: 2 added \(4 chunks\) · /);
	assert.equal(uploadLabel(state.rows[0]), '2 chunks added');
});

test('queue: Clear finished removes finished drops and keeps a running drop whole, counting the rows it cleared', async () => {
	const gate = deferred<void>();
	let gated = false;
	const fake = fakeDeps();
	const sendFiles = fake.deps.sendFiles;
	fake.deps.sendFiles = async (files, options) => {
		if (gated) await gate.promise;
		return sendFiles(files, options);
	};
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('first.md')]);
	await queue.idle();
	gated = true;
	await queue.addDrop([candidate('bad.exe'), candidate('slow.md')]);
	await queue.waitFor((state) => state.rows.some((one) => one.path === 'slow.md' && one.status === 'queued'));
	queue.clearFinished();
	let state = queue.getState();
	assert.deepEqual(
		state.rows.map((one) => one.path),
		['slow.md']
	);
	assert.equal(state.drops.length, 1, 'the finished drop went with its rows');
	assert.match(dropSummaryText(summariseDrop(state.drops[0], state.rows, Date.now())), /^Drop of 2 files: 1 not added · 1 in progress · /);
	gate.resolve();
	await queue.idle();
	state = queue.getState();
	assert.match(dropSummaryText(summariseDrop(state.drops[0], state.rows, Date.now())), /^Drop of 2 files: 1 added \(2 chunks\) · 1 not added · /);
	queue.clearFinished();
	assert.deepEqual(queue.getState().drops, []);
});

test('queue: dispose forgets every drop; a drop with nothing to add records no drop', async () => {
	const fake = fakeDeps();
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([], { errors: ['2 dropped items could not be read as files.'] });
	await queue.idle();
	assert.deepEqual(queue.getState().drops, []);
	await queue.addDrop([candidate('a.md')]);
	await queue.idle();
	assert.equal(queue.getState().drops.length, 1);
	queue.dispose();
	assert.deepEqual(queue.getState().drops, []);
});

// ── "Show new chunks on the map" ────────────────────────────────────────────

test('show on map: the drop\'s new chunks go to the map as one document highlight, and the drop remembers it', async () => {
	const fake = fakeDeps({ counts: { 'a.md': 2, 'b.md': 1, 'c.md': 3 } });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md'), candidate('c.md')]);
	await queue.idle();
	const drop = queue.getState().drops[0];
	const rec = recordingActions();
	const shown = showDropOnMap(queue, drop.id, rec.actions, 200);
	assert.deepEqual(shown, { placed: 6, total: 6 });
	const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(objectIdForPath);
	assert.deepEqual(rec.shown, [
		{
			source: 'document',
			keys: [
				[a, 0],
				[b, 0],
				[c, 0],
				[a, 1],
				[c, 1],
				[c, 2],
			],
		},
	]);
	assert.deepEqual(rec.announced, ['Showing 6 new chunks on the map.']);
	assert.deepEqual(queue.getState().drops[0].shown, { placed: 6, total: 6 });
});

test('show on map: above the pin limit it sends at most the limit and says how many of how many were placed', async () => {
	const counts: Record<string, number> = {};
	const files = Array.from({ length: 9 }, (_, i) => `docs/part${i}.md`);
	files.forEach((file, i) => (counts[file] = i < 8 ? 40 : 21));
	const fake = fakeDeps({ counts });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop(files.map((file) => candidate(file)));
	await queue.idle();
	const rec = recordingActions();
	const shown = showDropOnMap(queue, queue.getState().drops[0].id, rec.actions, 200);
	assert.deepEqual(shown, { placed: 200, total: 341 });
	assert.equal(rec.shown[0].keys.length, 200);
	assert.ok(rec.shown[0].keys.length <= 200);
	assert.deepEqual(rec.announced, ['200 of 341 new chunks placed: the map pins at most 200 chunks outside its sample.']);
});

test('show on map: the keys use the objectId the engine reported; nothing is sent for a drop still running or unknown', async () => {
	const engineId = '00000000-0000-5000-8000-0000000000aa';
	const fake = fakeDeps({ sendResult: (file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: 1, file_size: 1, upload_time: 0, result: { objectId: engineId } }), counts: { 'e.md': 2 } });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('e.md')]);
	await queue.idle();
	const rec = recordingActions();
	showDropOnMap(queue, queue.getState().drops[0].id, rec.actions, 200);
	assert.deepEqual(rec.shown[0].keys, [
		[engineId, 0],
		[engineId, 1],
	]);

	const gate = deferred<void>();
	const slow = fakeDeps();
	const sendFiles = slow.deps.sendFiles;
	slow.deps.sendFiles = async (filesToSend, options) => {
		await gate.promise;
		return sendFiles(filesToSend, options);
	};
	const running = createIngestQueue(slow.deps);
	await running.addDrop([candidate('wait.md')]);
	const idle = recordingActions();
	assert.equal(showDropOnMap(running, running.getState().drops[0].id, idle.actions, 200), null);
	assert.equal(showDropOnMap(running, 'd-nope', idle.actions, 200), null);
	assert.deepEqual(idle.shown, []);
	gate.resolve();
	await running.idle();
});

test('show on map: a drop whose documents have no counted chunk sends nothing', async () => {
	const fake = fakeDeps({ counts: { 'n.md': null } });
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('n.md')]);
	await queue.idle();
	const rec = recordingActions();
	assert.equal(showDropOnMap(queue, queue.getState().drops[0].id, rec.actions, 200), null);
	assert.deepEqual(rec.shown, []);
});

// ── The list shows it ───────────────────────────────────────────────────────

const NOW = 1_700_000_100_000;
const doneRows = [row('u1', 'a.md', 'done', { chunks: 2 }), row('u2', 'b.md', 'done', { chunks: 2 }), row('u3', 'c.md', 'done', { chunks: 2 })];
const doneDrop = dropOf(doneRows, NOW - 10_000, NOW - 6_000);

test('UploadList: the drop summary sits above the rows, is built (no placeholder), and carries its counts', () => {
	const html = decoded(render(h(UploadList, { rows: doneRows, notes: [], onClearFinished: () => undefined, drops: [doneDrop], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	const at = html.search(/<[a-z]+[^>]*data-component="IngestSummary"/);
	assert.ok(at >= 0, 'the summary is mounted');
	assert.ok(at < html.indexOf('aria-label="Uploads"'), 'above the rows');
	assert.doesNotMatch(html, /data-placeholder/);
	assert.doesNotMatch(html, /Not built yet/);
	assert.match(html, /<div role="group" aria-label="Drop summary" data-component="IngestSummary"/);
	assert.match(textOf(html), /Drop of 3 files: 3 added \(6 chunks\) · 00:04/);
	// A segment never breaks inside: each one is kept on one line, the line breaks between them.
	assert.match(html, /<span style="white-space:nowrap">3 added \(6 chunks\)<\/span> · <span style="white-space:nowrap">00:04<\/span>/);
	assert.match(html, /data-drop="d1"/);
	assert.match(html, /data-finished="true"/);
	assert.match(html, /data-added="3"/);
	assert.match(html, /data-new-chunks="6"/);
	assert.match(html, /<button type="button"[^>]*>Show new chunks on the map<\/button>/);
	assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Show new chunks/);
	// The line is not a live region: the queue announces the drop once, the clock must not be read out every second.
	assert.doesNotMatch(html.slice(at, html.indexOf('aria-label="Uploads"')), /aria-live|role="status"/);
	assert.equal(render(h(UploadList, { rows: [], notes: [], onClearFinished: () => undefined, drops: [], now: NOW })), '');
});

test('UploadList: no button while the drop runs; the clock runs from the drop', () => {
	const rows = [row('u1', 'a.md', 'done', { chunks: 2 }), row('u2', 'b.md', 'processing')];
	const drop = dropOf(rows, NOW - 75_000, null);
	const html = decoded(render(h(UploadList, { rows, notes: [], onClearFinished: () => undefined, drops: [drop], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	assert.match(textOf(html), /Drop of 2 files: 1 added \(2 chunks\) · 1 in progress · 01:15/);
	assert.match(html, /data-finished="false"/);
	assert.doesNotMatch(html, /Show new chunks on the map/);
});

test('UploadList: the button is disabled with the reason when the map cannot place new chunks, or none was counted', () => {
	const html = decoded(render(h(UploadList, { rows: doneRows, notes: [], onClearFinished: () => undefined, drops: [doneDrop], onShowNew: () => undefined, showNewReason: NO_PLACING_SENTENCE, pinLimit: 200, now: NOW })));
	assert.match(html, /<button type="button"[^>]*disabled=""[^>]*aria-describedby="([^"]+)"[^>]*>Show new chunks on the map<\/button>/);
	assert.match(html, /<button type="button" style="[^"]*opacity:0\.5[^"]*"[^>]*disabled=""/, "the shell's disabled look, not only the attribute");
	const id = /aria-describedby="([^"]+)"/.exec(html)?.[1] ?? '';
	assert.ok(html.includes(`id="${id}"`), 'the reason is the description');
	assert.ok(html.includes(NO_PLACING_SENTENCE));

	const uncountedRows = [row('u1', 'a.md', 'done'), row('u2', 'b.md', 'done')];
	const uncounted = decoded(render(h(UploadList, { rows: uncountedRows, notes: [], onClearFinished: () => undefined, drops: [dropOf(uncountedRows, NOW - 1_000, NOW)], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	assert.match(uncounted, /<button type="button"[^>]*disabled=""[^>]*>Show new chunks on the map<\/button>/);
	assert.ok(uncounted.includes(UNCOUNTED_SENTENCE));

	// A drop that added nothing offers nothing to show.
	const refusedRows = [row('u1', 'x.exe', 'refused', { message: 'Not added.' })];
	const refused = decoded(render(h(UploadList, { rows: refusedRows, notes: [], onClearFinished: () => undefined, drops: [dropOf(refusedRows, NOW, NOW)], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	assert.match(textOf(refused), /Drop of 1 file: 1 not added · 00:00/);
	assert.doesNotMatch(refused, /Show new chunks/);
});

test('UploadList: after "Show new chunks", a capped drop says how many of how many were placed; a replaced document may keep its old place', () => {
	const rows = [row('u1', 'a.md', 'done', { chunks: 250 }), row('u2', 'b.md', 'done', { chunks: 91, replaces: true })];
	const drop: IngestDrop = { ...dropOf(rows, NOW - 48_000, NOW), shown: { placed: 200, total: 341 } };
	const html = decoded(render(h(UploadList, { rows, notes: [], onClearFinished: () => undefined, drops: [drop], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	assert.match(html, /200 of 341 new chunks placed: the map pins at most 200 chunks outside its sample\./);
	assert.match(html, /data-placed="200"/);
	assert.match(html, /data-total="341"/);
	assert.match(html, /Replaced documents the map already shows may keep their old place until the map draws a new sample\./);
	const uncapped = decoded(render(h(UploadList, { rows: doneRows, notes: [], onClearFinished: () => undefined, drops: [{ ...doneDrop, shown: { placed: 6, total: 6 } }], onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	assert.doesNotMatch(uncapped, /new chunks placed/);
	assert.doesNotMatch(uncapped, /old place/);
});

test('UploadList: the latest drop leads; earlier drops fold under a disclosure', () => {
	const older = [row('o1', 'old.md', 'done', { chunks: 4 })];
	const newer = [row('n1', 'new.md', 'uploading', { bytesSent: 10 })];
	const drops: IngestDrop[] = [
		{ ...dropOf(older, NOW - 90_000, NOW - 80_000), id: 'd1' },
		{ ...dropOf(newer, NOW - 3_000, null), id: 'd2' },
	];
	const html = decoded(render(h(UploadList, { rows: [...older, ...newer], notes: [], onClearFinished: () => undefined, drops, onShowNew: () => undefined, showNewReason: null, pinLimit: 200, now: NOW })));
	const latest = html.indexOf('data-drop="d2"');
	const earlier = html.indexOf('data-drop="d1"');
	assert.ok(latest >= 0 && earlier > latest, 'the latest drop first');
	assert.match(html, /<details[^>]*><summary>Earlier drops \(1\)<\/summary>/);
	assert.ok(html.indexOf('<details') < earlier, 'the earlier drop is inside the disclosure');
});

test('UploadList: without drops (older hosts) the rows render as before', () => {
	const html = render(h(UploadList, { rows: doneRows, notes: [], onClearFinished: () => undefined }));
	assert.match(html, /aria-label="Uploads"/);
	assert.doesNotMatch(html, /data-component="IngestSummary"/);
	assert.doesNotMatch(html, /Not built yet/);
});

// ── The panel wires it ──────────────────────────────────────────────────────

const dialect = fixture<IDialectResult>('dialect_pgvector.json');

/**
 * A console model for one connection.
 *
 * @param overrides - Fields to replace.
 * @returns The model.
 */
function model(overrides: Partial<ConsoleModel> = {}): ConsoleModel {
	return {
		connectionKey: 'summary-1',
		connection: { endpoint: { key: 'summary-1', anchorRole: 'tools', readOnly: false, nodeId: 'store_1', pipelineName: 'Vector demo' } as unknown as IExplorerEndpoint, dialect },
		nodes: { store: 'store_1', embed: 'embed_1', llm: 'llm_1', llmName: 'Local stub LLM' },
		collection: 'vx_demo_docs',
		stats: null,
		limits: dialect.limits,
		capabilities: dialect.capabilities,
		writes: { enabled: true, reason: null },
		ingest: { enabled: true, reason: null },
		chat: { enabled: true, reason: null },
		embed: { enabled: true, reason: null },
		readOnly: false,
		...overrides,
	};
}

/**
 * A channel that answers nothing (rendering never calls it).
 *
 * @param role - The role.
 * @returns The channel.
 */
function idleChannel(role: string): IRoleChannel {
	return { role, bound: true, sendFiles: async () => [], ask: async () => ({}), invoke: async <T>() => ({}) as T };
}

const channels: VectorChannels = { tools: idleChannel('tools'), chat: idleChannel('chat'), ingest: idleChannel('ingest') };

test("IngestPanel: the connection's drop summary is shown above its rows, with the map's reason when it cannot place chunks", async () => {
	forgetChatAndIngest();
	const fake = fakeDeps();
	const queue = ingestQueueFor('summary-1', fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md'), candidate('c.md')]);
	await queue.idle();
	const rec = recordingActions();
	const html = decoded(render(h(IngestPanel, { model: model(), channels, actions: rec.actions, alsoReaches: [] })));
	assert.match(textOf(html), /Drop of 3 files: 3 added \(6 chunks\) · /);
	assert.ok(html.indexOf('data-component="IngestSummary"') < html.indexOf('aria-label="Uploads"'));
	assert.match(html, /<button type="button"[^>]*>Show new chunks on the map<\/button>/);
	assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Show new chunks/);
	const noPlacing = decoded(render(h(IngestPanel, { model: model({ capabilities: { ...dialect.capabilities, project: false } }), channels, actions: rec.actions, alsoReaches: [] })));
	assert.ok(noPlacing.includes(NO_PLACING_SENTENCE));
	const noMap = decoded(render(h(IngestPanel, { model: model({ capabilities: { ...dialect.capabilities, sample: false } }), channels, actions: rec.actions, alsoReaches: [] })));
	assert.ok(noMap.includes(NO_MAP_SENTENCE));
	forgetChatAndIngest();
	assert.equal(ingestQueueFor('summary-1', fakeDeps().deps).getState().drops.length, 0, 'forgetting the connection forgets its drops');
	forgetChatAndIngest();
});

test("identity change: clearing the app's per-connection caches forgets every connection's drops, uploads and chat", async () => {
	forgetChatAndIngest();
	const queue = ingestQueueFor('identity-1', fakeDeps().deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md')]);
	await queue.idle();
	assert.equal(queue.getState().drops.length, 1);
	assert.equal(queue.getState().rows.length, 2);
	chatSessionFor('identity-2', { ask: async () => ({}), makeQuestion: (text) => text, now: () => 0, announce: () => undefined });
	assert.deepEqual(heldConnections(), ['identity-1', 'identity-2']);
	// The app's identity-change path (VectorApp.tsx): every registered per-connection cache is cleared.
	const { cleared } = forgetConnections(null, connectionCaches, () => null, { uri: 'connections', label: 'Connections' });
	assert.ok(cleared.includes('chat and ingest'), `cleared: ${cleared.join(', ')}`);
	assert.deepEqual(heldConnections(), [], 'nothing of the previous identity is kept');
	const after = ingestQueueFor('identity-1', fakeDeps().deps);
	assert.notEqual(after, queue, 'the same endpoint key gets a new queue');
	assert.equal(after.getState().drops.length, 0, "the previous identity's drops are gone");
	assert.equal(after.getState().rows.length, 0, "the previous identity's uploads are gone");
	forgetChatAndIngest();
});

test('wiring: the panel hands the summary its drops and the pin limit, and the hook places them with the connection\'s limit', () => {
	const code = (relative: string): string =>
		readFileSync(path.join(__dirname, '..', 'src', relative), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
	const panel = code(path.join('components', 'IngestPanel.tsx'));
	assert.match(panel, /drops=\{ingest\.state\.drops\}/);
	assert.match(panel, /onShowNew=\{ingest\.showNewChunks\}/);
	assert.match(panel, /showNewReason=\{showNewChunksReason\(model\.capabilities\)\}/);
	assert.match(panel, /pinLimit=\{model\.limits\.project_keys_max\}/);
	const hook = code(path.join('ingest', 'useIngest.ts'));
	assert.match(hook, /showDropOnMap\(queue, dropId, actions, model\.limits\.project_keys_max\)/);
	assert.match(hook, /actions\.showOnMap\(plan\.keys, 'document'\)/);
	// The summary never calls a tool itself: the map pins through its own `project` call.
	for (const file of [path.join('components', 'UploadList.tsx'), path.join('components', 'IngestPanel.tsx')]) assert.doesNotMatch(code(file), /callTool|'project'/, file);
});
