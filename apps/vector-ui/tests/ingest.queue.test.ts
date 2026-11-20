// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// ingest.queue — the upload queue's lifecycle around the happy path
// =============================================================================
//
// Counting after an upload, stores that cannot be probed, sends that never
// start, drops that overlap, identity changes in the middle of an upload,
// and two connections uploading files of the same name at once.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import type { ISendFile } from 'shared/explorer';
import { objectIdForPath } from '../src/vector/objectId';
import { FAILED_SENTENCE, uploadLabel } from '../src/vector/uploads';
import type { DropCandidate } from '../src/vector/uploads';
import { NOT_STORED_SENTENCE, RECOUNT_DELAYS_MS, createIngestQueue } from '../src/ingest/ingestQueue';
import type { IngestDeps } from '../src/ingest/ingestQueue';
import { createNameLocks } from '../src/ingest/nameLocks';
import type { CallOutcome } from '../src/chat/toolCalls';
import type { IUploadEvent } from '../src/contract/types';

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

/**
 * Plain fake dependencies: nothing stored, every upload completes, 2 chunks each.
 *
 * @param overrides - Fields to replace.
 * @returns The deps and what they saw.
 */
function fakeDeps(overrides: Partial<IngestDeps> = {}): { deps: IngestDeps; sent: string[][]; changed: string[][]; announced: string[]; tools: string[]; slept: number[] } {
	const sent: string[][] = [];
	const changed: string[][] = [];
	const announced: string[] = [];
	const tools: string[] = [];
	const slept: number[] = [];
	const deps: IngestDeps = {
		canProbe: true,
		canCount: true,
		async callTool(tool, input): Promise<CallOutcome> {
			tools.push(tool);
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			const id = (input.object_ids as string[])[0];
			return { ok: true, value: { success: true, items: [{ objectId: id, chunks: 2 }] } };
		},
		async sendFiles(files: ISendFile[]) {
			sent.push(files.map((file) => String(file.objinfo?.name)));
			return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0 }));
		},
		onDocumentsChanged(ids) {
			changed.push([...ids]);
		},
		announce(message) {
			announced.push(message);
		},
		async sleep(ms) {
			slept.push(ms);
		},
		locks: createNameLocks(),
		...overrides,
	};
	return { deps, sent, changed, announced, tools, slept };
}

test('queue: a finished upload is counted and the console is told which documents changed', async () => {
	const fake = fakeDeps();
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md')]);
	await queue.idle();
	assert.deepEqual(fake.changed, [[objectIdForPath('a.md'), objectIdForPath('b.md')]]);
	assert.deepEqual(
		queue.getState().rows.map((row) => uploadLabel(row)),
		['2 chunks added', '2 chunks added']
	);
	assert.ok(fake.announced.includes('a.md: 2 chunks added'));
	assert.equal(queue.getState().busy, false);
});

test('queue: a completed upload the store never lists is not added, after the recounts, and says why', async () => {
	let documentsCalls = 0;
	const fake = fakeDeps({
		async callTool(tool): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			documentsCalls += 1;
			return { ok: true, value: { success: true, items: [] } };
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('broken.pdf')]);
	await queue.idle();
	assert.equal(documentsCalls, RECOUNT_DELAYS_MS.length + 1, 'one look, then one per recount');
	assert.deepEqual(fake.slept, [...RECOUNT_DELAYS_MS]);
	assert.ok(RECOUNT_DELAYS_MS.reduce((a, b) => a + b, 0) >= 4_000, 'a store that lists a little late still gets a few seconds');
	const row = queue.getState().rows[0];
	// A completed upload the store lists no chunk of was not added: never a 'done' row that promises it will appear.
	assert.equal(row.status, 'failed');
	assert.equal(row.chunks, null);
	assert.equal(uploadLabel(row), NOT_STORED_SENTENCE);
	assert.match(NOT_STORED_SENTENCE, /^Not added: the pipeline stored no chunks for this file\./);
	assert.doesNotMatch(uploadLabel(row), /yet|in a moment/);
	assert.ok(fake.announced.includes(`broken.pdf: ${NOT_STORED_SENTENCE}`));
	// The pipeline ran, so the console still refreshes what it shows.
	assert.deepEqual(fake.changed, [[objectIdForPath('broken.pdf')]]);
	assert.equal(queue.getState().busy, false);
});

test('queue: a document the store lists only on a recount is counted like any other', async () => {
	let documentsCalls = 0;
	const fake = fakeDeps({
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			documentsCalls += 1;
			const id = (input.object_ids as string[])[0];
			return { ok: true, value: { success: true, items: documentsCalls < RECOUNT_DELAYS_MS.length + 1 ? [] : [{ objectId: id, chunks: 3 }] } };
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('late.md')]);
	await queue.idle();
	assert.deepEqual(fake.slept, [...RECOUNT_DELAYS_MS]);
	const row = queue.getState().rows[0];
	assert.equal(row.status, 'done');
	assert.equal(uploadLabel(row), '3 chunks added');
});

test('queue: zero chunks, an uncountable store and a failed count each read as what they are', async () => {
	const answers: Record<string, CallOutcome> = {
		[objectIdForPath('empty.pdf')]: { ok: true, value: { success: true, items: [{ objectId: objectIdForPath('empty.pdf'), chunks: 0 }] } },
		[objectIdForPath('pine.md')]: { ok: true, value: { success: true, items: [{ objectId: objectIdForPath('pine.md'), chunks: null }] } },
		[objectIdForPath('err.md')]: { ok: false, code: 'STORE_ERROR', message: 'OperationalError: the store did not answer', kind: null, error: null },
	};
	const fake = fakeDeps({
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			return answers[(input.object_ids as string[])[0]];
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('empty.pdf'), candidate('pine.md'), candidate('err.md')]);
	await queue.idle();
	assert.deepEqual(
		queue.getState().rows.map((row) => uploadLabel(row)),
		['No chunks were stored: the file may have no text the parser can read.', 'Added. This store does not report chunk counts.', 'Added. The chunk count could not be read: OperationalError: the store did not answer']
	);
});

test('queue: a store that cannot be probed asks once per drop before sending', async () => {
	const fake = fakeDeps({ canProbe: false });
	const queue = createIngestQueue(fake.deps);
	const drop = queue.addDrop([candidate('x.md'), candidate('y.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	const confirm = queue.getState().confirm;
	assert.equal(confirm?.items.length, 2);
	assert.ok(confirm?.message.some((line) => /x\.md: could not check \(this store cannot look documents up\)/.test(line)));
	assert.ok(!fake.tools.includes('chunks'));
	queue.answerConfirm(true);
	await drop;
	await queue.idle();
	assert.deepEqual(fake.sent, [['x.md', 'y.md']]);
});

test('queue: a probe that fails is a question, never a silent overwrite', async () => {
	const fake = fakeDeps({
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: null, message: 'chunks reported a failure', kind: 'store', error: new ExplorerToolError({ kind: 'store', tool: 'chunks', message: 'chunks reported a failure' }) };
			return { ok: true, value: { success: true, items: [{ objectId: (input.object_ids as string[])[0], chunks: 1 }] } };
		},
	});
	const queue = createIngestQueue(fake.deps);
	const drop = queue.addDrop([candidate('q.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	assert.equal(queue.getState().confirm?.confirmLabel, 'Send anyway');
	assert.equal(fake.sent.length, 0);
	queue.answerConfirm(false);
	await drop;
	await queue.idle();
	assert.equal(fake.sent.length, 0);
	assert.equal(queue.getState().rows[0].status, 'cancelled');
});

test('queue: a send that never starts fails every file of the call with the reason', async () => {
	const fake = fakeDeps({
		async sendFiles() {
			throw new ExplorerToolError({ kind: 'unavailable', tool: 'sendFiles', message: "No running ingest source for pipeline 'Vector demo'. Start it and retry." });
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.md')]);
	await queue.idle();
	for (const row of queue.getState().rows) {
		assert.equal(row.status, 'failed');
		assert.equal(row.message, "Not sent: this pipeline's Ingest source is not running. Start its dropper source and try again.");
	}
	assert.deepEqual(fake.changed, []);
});

test('queue: refused files get a row and an announcement; traversal notes are shown', async () => {
	const fake = fakeDeps();
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('ok.md'), candidate('bad.exe')], { skipped: ['x/.DS_Store', 'x/Thumbs.db'], errors: ['Could not read x/broken.pdf.'], truncated: true });
	await queue.idle();
	const rows = queue.getState().rows;
	assert.deepEqual(
		rows.map((row) => [row.path, row.status]),
		[
			['ok.md', 'done'],
			['bad.exe', 'refused'],
		]
	);
	assert.match(uploadLabel(rows[1]), /\.exe files are not supported/);
	assert.ok(fake.announced.includes('1 file was not added; the list says why.'));
	assert.deepEqual(queue.getState().notes, ['Skipped 2 hidden or system files.', 'Could not read x/broken.pdf.', 'More than 1,000 files were dropped; only the first 1,000 were read.']);
});

test('queue: a drop with no file to add but something to say shows and announces it', async () => {
	const fake = fakeDeps();
	const queue = createIngestQueue(fake.deps);
	const sentence = '2 dropped items could not be read as files. Use Add files or Add folder for them.';
	await queue.addDrop([], { errors: [sentence] });
	await queue.idle();
	assert.deepEqual(queue.getState().rows, []);
	assert.deepEqual(queue.getState().notes, [sentence]);
	assert.ok(fake.announced.includes(sentence));
	assert.deepEqual(fake.sent, []);
});

test('queue: a second drop of a path still being added is refused; drops are handled in order', async () => {
	const gate = deferred<void>();
	const fake = fakeDeps({
		async sendFiles(files: ISendFile[]) {
			await gate.promise;
			return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: 1, file_size: 1, upload_time: 0 }));
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('slow.md')]);
	await queue.addDrop([candidate('slow.md'), candidate('other.md')]);
	const rows = queue.getState().rows;
	assert.deepEqual(
		rows.map((row) => [row.path, row.status]),
		[
			['slow.md', 'queued'],
			['slow.md', 'refused'],
			['other.md', 'queued'],
		]
	);
	assert.match(rows[1].message ?? '', /already being added/);
	gate.resolve();
	await queue.idle();
	assert.deepEqual(
		queue.getState().rows.map((row) => row.status),
		['done', 'refused', 'done']
	);
});

test('queue: dispose in the middle of an upload forgets everything and ignores the late result', async () => {
	const gate = deferred<void>();
	const fake = fakeDeps({
		async sendFiles(files: ISendFile[]) {
			await gate.promise;
			return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: 1, file_size: 1, upload_time: 0 }));
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md')]);
	queue.dispose();
	assert.deepEqual(queue.getState().rows, []);
	gate.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(queue.getState().rows, []);
	assert.deepEqual(fake.changed, []);
	assert.equal(fake.tools.filter((tool) => tool === 'list_documents').length, 0);
	queue.handleEvent({ action: 'write', filepath: 'a.md', bytes_sent: 1, file_size: 1, upload_time: 0 });
	assert.deepEqual(queue.getState().rows, []);
	await queue.addDrop([candidate('b.md')]);
	assert.deepEqual(queue.getState().rows, []);
});

test("queue: another app's events for a file of the same name do not decide the row; the result sendFiles returns does", async () => {
	const started = deferred<void>();
	const gate = deferred<void>();
	const fake = fakeDeps({
		async sendFiles(files: ISendFile[]) {
			started.resolve();
			await gate.promise;
			return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0.1 }));
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('x/report.pdf', 100)]);
	await started.promise;
	// The shell's event stream is shared by every app, and names a file by its base name only.
	queue.handleEvent({ action: 'write', filepath: 'report.pdf', bytes_sent: 900, file_size: 999, upload_time: 0 });
	assert.equal(queue.getState().rows[0].bytesSent, 0, 'a file of another size is another file');
	queue.handleEvent({ action: 'error', filepath: 'report.pdf', bytes_sent: 3, file_size: 100, upload_time: 0, error: 'another app: pipe error' });
	assert.notEqual(queue.getState().rows[0].status, 'failed');
	gate.resolve();
	await queue.idle();
	const row = queue.getState().rows[0];
	assert.equal(row.status, 'done');
	assert.equal(uploadLabel(row), '2 chunks added');
	assert.equal(row.detail, null);
	assert.deepEqual(fake.changed, [[objectIdForPath('x/report.pdf')]]);
});

test('queue: the chunk count and the change report use the objectId the engine reports for the upload', async () => {
	const engineId = '00000000-0000-5000-8000-000000000002';
	const counted: string[] = [];
	const fake = fakeDeps({
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			const id = (input.object_ids as string[])[0];
			counted.push(id);
			return { ok: true, value: { success: true, items: [{ objectId: id, chunks: 4 }] } };
		},
		async sendFiles(files: ISendFile[]) {
			return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0.1, result: { objectId: engineId } }));
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md')]);
	await queue.idle();
	assert.deepEqual(counted, [engineId]);
	assert.deepEqual(fake.changed, [[engineId]]);
	const row = queue.getState().rows[0];
	assert.equal(uploadLabel(row), '4 chunks added');
	assert.equal(row.objectId, engineId);
	assert.match(row.detail ?? '', /the console expected/);
});

test("queue: another app's error words never show on a row in flight; the result brings this file's own", async () => {
	const started = deferred<void>();
	const gate = deferred<boolean>();
	const fake = fakeDeps({
		async sendFiles(files: ISendFile[]) {
			started.resolve();
			const fails = await gate.promise;
			return files.map((file) => (fails ? { action: 'error', filepath: file.file.name, bytes_sent: 0, file_size: file.file.size, upload_time: 0.1, error: 'Pipe closed with an error' } : { action: 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0.1 }));
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('x/report.pdf', 100)]);
	await started.promise;
	queue.handleEvent({ action: 'write', filepath: 'report.pdf', bytes_sent: 40, file_size: 100, upload_time: 0 });
	const before = queue.getState().rows[0];
	// Another app's report.pdf of the same size fails while this one is still sending.
	queue.handleEvent({ action: 'error', filepath: 'report.pdf', bytes_sent: 3, file_size: 100, upload_time: 0, error: 'another app: pipe error' });
	queue.handleEvent({ action: 'error', filepath: 'report.pdf', error: 'another app: no size' } as unknown as IUploadEvent);
	assert.equal(queue.getState().rows[0], before, 'an error event changes nothing on the row');
	assert.equal(queue.getState().rows[0].detail, null);
	assert.equal(uploadLabel(queue.getState().rows[0]), 'Uploading… 40%');
	// This file's own failure: the words come with the result sendFiles returns.
	gate.resolve(true);
	await queue.idle();
	const row = queue.getState().rows[0];
	assert.equal(row.status, 'failed');
	assert.equal(uploadLabel(row), FAILED_SENTENCE);
	assert.equal(row.detail, 'Pipe closed with an error');
	assert.deepEqual(fake.changed, []);
});

test('queue: dispose while the replace question is open sends nothing', async () => {
	const fake = fakeDeps({ canProbe: false });
	const queue = createIngestQueue(fake.deps);
	const drop = queue.addDrop([candidate('a.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.dispose();
	await drop;
	assert.equal(fake.sent.length, 0);
	assert.equal(queue.getState().confirm, null);
});

test('queue: clearFinished keeps only rows still in progress', async () => {
	const fake = fakeDeps();
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('a.md'), candidate('b.exe')]);
	await queue.idle();
	assert.equal(queue.getState().drops.length, 1);
	queue.clearFinished();
	assert.deepEqual(queue.getState().rows, []);
	assert.deepEqual(queue.getState().notes, []);
	assert.deepEqual(queue.getState().drops, []);
});

test('queue: a replacing file whose chunk count cannot be read says it replaced, not added', async () => {
	const stored = objectIdForPath('report.pdf');
	const fake = fakeDeps({
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return input.object_id === stored ? { ok: true, value: { success: true, items: [{ chunkId: 0 }], total: 9 } } : { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			const id = (input.object_ids as string[])[0];
			if (id === stored) return { ok: false, code: 'STORE_ERROR', message: 'the store did not answer', kind: null, error: null };
			return { ok: true, value: { success: true, items: [{ objectId: id, chunks: null }] } };
		},
	});
	const queue = createIngestQueue(fake.deps);
	const drop = queue.addDrop([candidate('report.pdf'), candidate('fresh.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.answerConfirm(true);
	await drop;
	await queue.idle();
	assert.deepEqual(
		queue.getState().rows.map((row) => [row.path, row.replaces === true, uploadLabel(row)]),
		[
			['report.pdf', true, 'Replaced. The chunk count could not be read: the store did not answer'],
			['fresh.md', false, 'Added. This store does not report chunk counts.'],
		]
	);
});

test('queue: the drop of a store that answers late starts at the drop and ends with its last count', async () => {
	let clock = 50_000;
	const fake = fakeDeps({
		now: () => clock,
		async sleep(ms) {
			clock += ms;
		},
		async callTool(tool, input): Promise<CallOutcome> {
			if (tool === 'chunks') return { ok: false, code: 'NOT_FOUND', message: 'not stored', kind: null, error: null };
			const id = (input.object_ids as string[])[0];
			// Listed only at the second recount.
			return { ok: true, value: { success: true, items: clock >= 50_000 + RECOUNT_DELAYS_MS[0] + RECOUNT_DELAYS_MS[1] ? [{ objectId: id, chunks: 2 }] : [] } };
		},
	});
	const queue = createIngestQueue(fake.deps);
	await queue.addDrop([candidate('late.md')]);
	await queue.idle();
	const drop = queue.getState().drops[0];
	assert.equal(drop.startedAt, 50_000);
	assert.equal(drop.finishedAt, 50_000 + RECOUNT_DELAYS_MS[0] + RECOUNT_DELAYS_MS[1]);
	assert.deepEqual(drop.rowIds, [queue.getState().rows[0].id]);
});

test('queue: a drop that waits behind another one\'s question is timed from when it was dropped', async () => {
	let clock = 10_000;
	const fake = fakeDeps({ canProbe: false, now: () => clock });
	const queue = createIngestQueue(fake.deps);
	const first = queue.addDrop([candidate('one.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	clock = 12_000;
	const second = queue.addDrop([candidate('two.md')]);
	clock = 30_000;
	queue.answerConfirm(true);
	await first;
	await queue.waitFor((state) => state.rows.some((row) => row.path === 'one.md' && row.status === 'done'));
	await queue.waitFor((state) => state.confirm !== null);
	clock = 31_000;
	queue.answerConfirm(true);
	await second;
	await queue.idle();
	assert.deepEqual(
		queue.getState().drops.map((drop) => [drop.startedAt, drop.finishedAt]),
		[
			[10_000, 30_000],
			[12_000, 31_000],
		]
	);
});

test('name locks: two connections sending report.pdf take turns; different names run side by side', async () => {
	const locks = createNameLocks();
	const order: string[] = [];
	const gates = { a: deferred<void>(), b: deferred<void>() };
	const queueFor = (label: 'a' | 'b'): ReturnType<typeof createIngestQueue> =>
		createIngestQueue(
			fakeDeps({
				locks,
				async sendFiles(files: ISendFile[]) {
					order.push(`${label}:start:${files.map((file) => file.file.name).join(',')}`);
					await gates[label].promise;
					order.push(`${label}:end`);
					return files.map((file) => ({ action: 'complete', filepath: file.file.name, bytes_sent: 1, file_size: 1, upload_time: 0 }));
				},
			}).deps
		);
	const a = queueFor('a');
	const b = queueFor('b');
	await a.addDrop([candidate('x/report.pdf')]);
	await b.addDrop([candidate('y/report.pdf')]);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(order, ['a:start:report.pdf']);
	assert.deepEqual(locks.held(), ['report.pdf']);
	gates.b.resolve();
	gates.a.resolve();
	await a.idle();
	await b.idle();
	assert.deepEqual(order, ['a:start:report.pdf', 'a:end', 'b:start:report.pdf', 'b:end']);
	assert.deepEqual(locks.held(), []);

	const free = createNameLocks();
	const first = await free.acquire(['one.md']);
	let secondGranted = false;
	void free.acquire(['two.md']).then(() => {
		secondGranted = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(secondGranted, true);
	first();
	first();
	assert.deepEqual(free.held(), ['two.md']);
});
