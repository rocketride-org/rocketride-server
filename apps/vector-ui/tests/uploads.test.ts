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
// uploads — what a drop sends, in which order, and how progress is attributed
// =============================================================================
//
// The drop zone checks paths and caps in the browser, asks the store whether
// each path is already stored (the `chunks` probe on the objectId the engine
// will derive), and sends through the ingest source. Upload progress events
// are keyed by the file's base name only, so files sharing a base name are
// sent one at a time: every event then belongs to the single file of that
// name in flight. The app never sends an objectId; the engine derives it.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer';
import type { IUploadEvent } from '../src/contract/types';
import type { ISendFile } from 'shared/explorer';
import { objectIdForPath } from '../src/vector/objectId';
import { ALLOWED_EXTENSIONS, CANCELLED_SENTENCE, FAILED_SENTENCE, FINISHED, UPLOAD_LIMITS, UPLOAD_ORIGIN, applyFinalResult, applyUploadEvent, batchForSend, chunkCountMessage, classifyProbe, mimeTypeFor, normaliseFolderPrefix, normaliseRelPath, planDrop, replaceQuestion, sendFilesPayload, uploadLabel } from '../src/vector/uploads';
import type { DropCandidate, PlannedUpload, UploadRow } from '../src/vector/uploads';
import { createIngestQueue } from '../src/ingest/ingestQueue';
import type { IngestDeps } from '../src/ingest/ingestQueue';
import { createNameLocks } from '../src/ingest/nameLocks';
import type { CallOutcome } from '../src/chat/toolCalls';

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

const MB = 1024 * 1024;

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
 * A fake file.
 *
 * @param name - Base name.
 * @param size - Bytes.
 * @returns Something File-shaped.
 */
function fakeFile(name: string, size = 1000): File {
	return { name, size, type: '' } as unknown as File;
}

/**
 * A drop candidate.
 *
 * @param relPath - Path in the drop.
 * @param size - Bytes.
 * @returns The candidate.
 */
function candidate(relPath: string, size = 1000): DropCandidate {
	return { file: fakeFile(relPath.slice(relPath.lastIndexOf('/') + 1), size), relPath };
}

// -----------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------

test('normaliseRelPath: NFC, control and bidi characters stripped, backslashes as folders', () => {
	assert.deepEqual(normaliseRelPath('Uploaded/nai\u0308ve.pdf'), { ok: true, path: 'Uploaded/naïve.pdf' });
	assert.deepEqual(normaliseRelPath('a\u0007b\u202Ec.md'), { ok: true, path: 'abc.md' });
	assert.deepEqual(normaliseRelPath('\u200Fx\u2066y.txt'), { ok: true, path: 'xy.txt' });
	assert.deepEqual(normaliseRelPath('folder\\sub\\file.md'), { ok: true, path: 'folder/sub/file.md' });
	assert.deepEqual(normaliseRelPath('a//b/./c.md'), { ok: true, path: 'a/b/c.md' });
	assert.deepEqual(normaliseRelPath('C:/demo/x.md'), { ok: true, path: 'C:/demo/x.md' });
});

test('normaliseRelPath: ".." segments and a leading "/" are refused', () => {
	for (const bad of ['../etc/passwd.txt', 'a/../b.md', 'a/..', '/abs/file.md', '\\abs\\file.md']) {
		const check = normaliseRelPath(bad);
		assert.equal(check.ok, false, bad);
	}
	assert.match((normaliseRelPath('a/../b.md') as { reason: string }).reason, /\.\./);
	assert.match((normaliseRelPath('/abs/file.md') as { reason: string }).reason, /start with/);
});

test('normaliseRelPath: every segment is at most 255 UTF-8 bytes', () => {
	assert.equal(normaliseRelPath(`${'x'.repeat(255)}/f.md`).ok, true);
	assert.equal(normaliseRelPath(`${'x'.repeat(256)}/f.md`).ok, false);
	// 86 three-byte characters = 258 bytes, although only 86 UTF-16 units.
	assert.equal(normaliseRelPath(`${'資'.repeat(86)}.md`).ok, false);
	assert.equal(normaliseRelPath(`${'資'.repeat(83)}.md`).ok, true);
});

test('normaliseRelPath: the "Store under folder" prefix goes in front, normalised the same way', () => {
	assert.deepEqual(normaliseRelPath('report.pdf', 'C:\\demo\\inbox\\'), { ok: true, path: 'C:/demo/inbox/report.pdf' });
	assert.deepEqual(normaliseFolderPrefix('  '), { ok: true, path: '' });
	assert.deepEqual(normaliseFolderPrefix('team/q3/'), { ok: true, path: 'team/q3' });
	assert.equal(normaliseFolderPrefix('/abs').ok, false);
	assert.equal(normaliseFolderPrefix('a/../b').ok, false);
	assert.equal(normaliseRelPath('x.md', '../up').ok, false);
});

test('mimeTypeFor and the allowlist', () => {
	assert.deepEqual([...ALLOWED_EXTENSIONS], ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'rtf', 'txt', 'md', 'csv', 'html', 'json']);
	assert.equal(mimeTypeFor('a.md'), 'text/markdown');
	assert.equal(mimeTypeFor('A.PDF'), 'application/pdf');
	assert.equal(mimeTypeFor('x.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
	assert.equal(mimeTypeFor('noext'), 'application/octet-stream');
});

// -----------------------------------------------------------------------------
// Planning a drop
// -----------------------------------------------------------------------------

test('planDrop: the caps — 20 files, 50 MB each, 200 MB per drop, allowlisted types, no empty files', () => {
	assert.deepEqual(UPLOAD_LIMITS, { maxFiles: 20, maxFileBytes: 50 * MB, maxDropBytes: 200 * MB, maxSegmentBytes: 255 });
	const many = planDrop(Array.from({ length: 22 }, (_, i) => candidate(`f${i}.txt`)));
	assert.equal(many.accepted.length, 20);
	assert.equal(many.refused.length, 2);
	assert.match(many.refused[0].reason, /20 files/);

	const plan = planDrop([candidate('big.pdf', 50 * MB + 1), candidate('ok.pdf', 50 * MB), candidate('evil.exe'), candidate('Shout.PDF'), candidate('empty.md', 0), candidate('noext')]);
	assert.deepEqual(
		plan.accepted.map((file) => file.path),
		['ok.pdf', 'Shout.PDF']
	);
	const reasons = Object.fromEntries(plan.refused.map((refusal) => [refusal.path, refusal.reason]));
	assert.match(reasons['big.pdf'], /50 MB/);
	assert.match(reasons['evil.exe'], /\.exe/);
	assert.match(reasons['empty.md'], /empty/);
	assert.match(reasons.noext, /type/);

	const heavy = planDrop([candidate('a.pdf', 50 * MB), candidate('b.pdf', 50 * MB), candidate('c.pdf', 50 * MB), candidate('d.pdf', 50 * MB), candidate('e.pdf', 1)]);
	assert.equal(heavy.accepted.length, 4);
	assert.match(heavy.refused[0].reason, /200 MB/);
});

test('planDrop: duplicate paths in one drop and paths already being added are refused before anything is sent', () => {
	const plan = planDrop([candidate('a/x.md'), candidate('a\\x.md'), candidate('b/x.md'), candidate('busy.md')], { inFlightPaths: new Set(['busy.md']) });
	assert.deepEqual(
		plan.accepted.map((file) => file.path),
		['a/x.md', 'b/x.md']
	);
	assert.deepEqual(
		plan.refused.map((refusal) => [refusal.path, /already/.test(refusal.reason)]),
		[
			['a/x.md', true],
			['busy.md', true],
		]
	);
});

test('planDrop: every accepted file carries the objectId the engine will derive, the event key and the mimetype', () => {
	const plan = planDrop([candidate('report.pdf'), candidate('notes.md')], { prefix: 'C:/demo/inbox' });
	assert.deepEqual(
		plan.accepted.map((file) => [file.path, file.name, file.objectId, file.mimetype]),
		[
			['C:/demo/inbox/report.pdf', 'report.pdf', objectIdForPath('C:/demo/inbox/report.pdf'), 'application/pdf'],
			['C:/demo/inbox/notes.md', 'notes.md', objectIdForPath('C:/demo/inbox/notes.md'), 'text/markdown'],
		]
	);
});

// -----------------------------------------------------------------------------
// Batching and payloads
// -----------------------------------------------------------------------------

test('batchForSend: unique base names go together (2 at a time); shared base names go one at a time, afterwards', () => {
	const plan = planDrop([candidate('a/report.pdf'), candidate('memo.docx'), candidate('b/report.pdf'), candidate('notes.md'), candidate('c/report.pdf')]);
	const units = batchForSend(plan.accepted);
	assert.deepEqual(
		units.map((unit) => [unit.maxConcurrent, unit.files.map((file) => file.path)]),
		[
			[2, ['memo.docx', 'notes.md']],
			[1, ['a/report.pdf']],
			[1, ['b/report.pdf']],
			[1, ['c/report.pdf']],
		]
	);
	assert.deepEqual(batchForSend([]), []);
});

test('sendFilesPayload: the name is the path, the origin is the console, and there is never an objectId', () => {
	const plan = planDrop([candidate('docs/a.md'), candidate('b.pdf')]);
	const payload = sendFilesPayload(batchForSend(plan.accepted)[0]);
	assert.deepEqual(
		payload.map((item) => [item.objinfo, item.mimetype]),
		[
			[{ name: 'docs/a.md', origin: UPLOAD_ORIGIN }, 'text/markdown'],
			[{ name: 'b.pdf', origin: UPLOAD_ORIGIN }, 'application/pdf'],
		]
	);
	assert.equal(UPLOAD_ORIGIN, 'vector-explorer');
	assert.doesNotMatch(JSON.stringify(payload.map((item) => item.objinfo)), /objectId/i);
});

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

/**
 * A fresh queued row for a planned file.
 *
 * @param file - The planned file.
 * @returns The row.
 */
function queuedRow(file: PlannedUpload): UploadRow {
	return { id: file.id, path: file.path, name: file.name, objectId: file.objectId, size: file.size, status: 'queued', bytesSent: 0, fileSize: file.size, chunks: null, existingChunks: null, message: null, detail: null };
}

test('applyUploadEvent: open, write, close and complete move a row forward; an error event changes nothing', () => {
	const events = fixture<{ events: IUploadEvent[] }>('upload_events.json').events;
	const plan = planDrop([candidate('memo_q3.docx', 22016), candidate('scan_unreadable.pdf', 4096)]);
	let memo = queuedRow(plan.accepted[0]);
	let scan = queuedRow(plan.accepted[1]);
	const labels: string[] = [];
	for (const event of events) {
		if (event.filepath === 'memo_q3.docx') {
			memo = applyUploadEvent(memo, event);
			labels.push(uploadLabel(memo));
		} else scan = applyUploadEvent(scan, event);
	}
	assert.deepEqual(labels, ['Uploading… 0%', 'Uploading… 33%', 'Uploading… 67%', 'Uploading… 100%', 'Processing…', 'Counting chunks…']);
	assert.equal(memo.status, 'counting');
	assert.equal(memo.bytesSent, 22016);
	// Every app in the shell sees upload events, keyed by base name only, so an
	// error event cannot finish a row or put its words on it: the row waits.
	assert.equal(scan.status, 'processing');
	assert.equal(scan.message, null);
	assert.equal(scan.detail, null);
	// The result sendFiles returns for the file decides, with its own words.
	const failed = applyFinalResult(scan, events[events.length - 1] as unknown as Record<string, unknown>);
	assert.equal(failed.status, 'failed');
	assert.equal(failed.message, FAILED_SENTENCE);
	assert.equal(failed.detail, 'Pipe closed with an error');
	assert.equal(FAILED_SENTENCE, "Failed. The engine did not return the reason; the pipeline's run log may. The document was not added.");
	// A row never moves backwards, and a finished row ignores late events.
	assert.equal(applyUploadEvent({ ...memo, status: 'processing' }, events[1]).status, 'processing');
	assert.equal(applyUploadEvent(failed, events[0]).status, 'failed');
});

test('applyFinalResult: the result sendFiles returns decides, whatever the events said', () => {
	const row: UploadRow = { ...queuedRow(planDrop([candidate('x/report.pdf', 100)]).accepted[0]), status: 'uploading' };
	// Another app in the shell failed its own report.pdf of the same size.
	const foreign = applyUploadEvent(row, { action: 'error', filepath: 'report.pdf', bytes_sent: 3, file_size: 100, upload_time: 0, error: 'another app: pipe error' });
	assert.equal(FINISHED.has(foreign.status), false);
	const done = applyFinalResult(foreign, { action: 'complete', filepath: 'report.pdf', bytes_sent: 100, file_size: 100, upload_time: 1 });
	assert.equal(done.status, 'counting');
	assert.equal(done.message, null);
	assert.equal(done.detail, null, "the other app's text is not this file's");
	const failed = applyFinalResult(foreign, { action: 'error', filepath: 'report.pdf', bytes_sent: 3, file_size: 100, upload_time: 1, error: 'Pipe closed with an error' });
	assert.equal(failed.status, 'failed');
	assert.equal(failed.detail, 'Pipe closed with an error');
	// A failed result without a reason does not borrow an event's.
	const silent = applyFinalResult(foreign, { action: 'error', filepath: 'report.pdf', bytes_sent: 3, file_size: 100, upload_time: 1 });
	assert.equal(silent.status, 'failed');
	assert.equal(silent.detail, null);
	// No result at all is a failure.
	assert.equal(applyFinalResult(foreign, null).status, 'failed');
});

test('applyFinalResult: a completed upload is counted under the objectId the engine reports', () => {
	const script = fixture<{ events: IUploadEvent[] }>('upload_events.json');
	const planned = planDrop([candidate('memo_q3.docx', 22016)]).accepted[0];
	const row: UploadRow = { ...queuedRow(planned), status: 'processing' };
	// The fixture's completed upload reports the id the console derived: nothing to say.
	const complete = script.events.find((event) => event.action === 'complete') as unknown as Record<string, unknown>;
	const same = applyFinalResult(row, complete);
	assert.equal(same.objectId, planned.objectId);
	assert.equal(same.detail, null);
	// When the engine reports another id, that id is the stored document's, and the row says so.
	const engineId = '00000000-0000-5000-8000-000000000001';
	const differs = applyFinalResult(row, { ...complete, result: { objectId: engineId } });
	assert.equal(differs.status, 'counting');
	assert.equal(differs.objectId, engineId);
	assert.equal(differs.detail, `The engine stored this file under objectId ${engineId}; the console expected ${planned.objectId}.`);
	// Anything that is not an id is ignored.
	for (const result of [{}, { objectId: '' }, { objectId: 42 }, { objectId: 'a b' }, 'x', null]) {
		assert.equal(applyFinalResult(row, { ...complete, result }).objectId, planned.objectId, JSON.stringify(result));
	}
});

test("applyUploadEvent: an event whose file size is not this file's belongs to another file of the same name", () => {
	const row: UploadRow = { ...queuedRow(planDrop([candidate('x/report.pdf', 100)]).accepted[0]), status: 'uploading', bytesSent: 40 };
	assert.equal(applyUploadEvent(row, { action: 'write', filepath: 'report.pdf', bytes_sent: 900, file_size: 999, upload_time: 0 }), row);
	assert.equal(applyUploadEvent(row, { action: 'error', filepath: 'report.pdf', bytes_sent: 900, file_size: 999, upload_time: 0, error: 'x' }), row);
	assert.equal(applyUploadEvent(row, { action: 'write', filepath: 'report.pdf', bytes_sent: 60, file_size: 100, upload_time: 0 }).bytesSent, 60);
});

test('uploadLabel: the finished states', () => {
	const base = queuedRow(planDrop([candidate('a.md')]).accepted[0]);
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 7 }), '7 chunks added');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 1 }), '1 chunk added');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 0, message: 'No chunks were stored: the file may have no text the parser can read.' }), 'No chunks were stored: the file may have no text the parser can read.');
	assert.equal(uploadLabel({ ...base, status: 'cancelled', message: CANCELLED_SENTENCE }), 'Cancelled. Nothing was sent.');
	assert.equal(uploadLabel({ ...base, status: 'queued' }), 'Queued');
	assert.equal(uploadLabel({ ...base, status: 'checking' }), 'Checking…');
});

test('uploadLabel: a file that replaced a stored document says so, with the chunks stored for it', () => {
	const base = queuedRow(planDrop([candidate('report.pdf')]).accepted[0]);
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 7, replaces: true }), 'Replaced: 7 chunks stored');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 1, replaces: true }), 'Replaced: 1 chunk stored');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 1_250, replaces: true }), 'Replaced: 1,250 chunks stored');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: null, replaces: true }), 'Replaced');
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: 7, replaces: false }), '7 chunks added');
	// A row's own sentence still wins (zero chunks, an uncountable store).
	assert.equal(uploadLabel({ ...base, status: 'done', chunks: null, replaces: true, message: chunkCountMessage(null, true) }), 'Replaced. This store does not report chunk counts.');
	assert.equal(chunkCountMessage(null), 'Added. This store does not report chunk counts.');
	assert.equal(chunkCountMessage(0, true), 'No chunks were stored: the file may have no text the parser can read.');
	assert.equal(chunkCountMessage(4, true), null);
});

// -----------------------------------------------------------------------------
// The collision probe
// -----------------------------------------------------------------------------

test('classifyProbe: success means stored, NOT_FOUND means new, anything else is unknown', () => {
	assert.deepEqual(classifyProbe({ ok: true, value: fixture('chunks_exists_probe.json') }), { state: 'exists', chunks: 19 });
	const notFound = fixture<Record<string, unknown>>('chunks_not_found.json');
	assert.deepEqual(classifyProbe({ ok: false, code: 'NOT_FOUND', message: String(notFound.error), kind: null, error: notFound }), { state: 'absent' });
	assert.deepEqual(classifyProbe({ ok: false, code: 'NOT_FOUND', message: 'x', kind: 'raised', error: new Error('x') }), { state: 'absent' });
	const store = classifyProbe({ ok: false, code: null, message: 'The store did not answer', kind: 'store', error: new ExplorerToolError({ kind: 'store', tool: 'chunks', message: 'The store did not answer' }) });
	assert.deepEqual(store, { state: 'unknown', reason: 'The store did not answer' });
	assert.equal(classifyProbe({ ok: false, code: 'UNSUPPORTED', message: 'chunks is not supported', kind: null, error: null }).state, 'unknown');
});

test('replaceQuestion: one stored file asks with the exact sentence; several are listed', () => {
	const one = replaceQuestion([{ rowId: 'r1', path: 'report.pdf', state: 'exists', chunks: 19 }]);
	assert.equal(one.message[0], "Replace existing 'report.pdf' (19 chunks)? The old chunks are removed when the new file is stored.");
	assert.equal(one.confirmLabel, 'Replace document');
	assert.equal(one.cancelLabel, 'Cancel');
	const several = replaceQuestion([
		{ rowId: 'r1', path: 'a.md', state: 'exists', chunks: 2 },
		{ rowId: 'r2', path: 'b.md', state: 'exists', chunks: null },
		{ rowId: 'r3', path: 'c.md', state: 'unknown', reason: 'The store did not answer' },
	]);
	assert.equal(several.title, 'Replace 3 documents?');
	assert.equal(several.confirmLabel, 'Replace documents');
	assert.ok(several.message.some((line) => line === 'a.md (2 chunks)'));
	assert.ok(several.message.some((line) => line === 'b.md'));
	assert.ok(several.message.some((line) => /c\.md: could not check \(The store did not answer\)/.test(line)));
	const unknown = replaceQuestion([{ rowId: 'r1', path: 'x.md', state: 'unknown', reason: 'no chunks tool' }]);
	assert.equal(unknown.confirmLabel, 'Send anyway');
	assert.match(unknown.message[0], /Could not check whether 'x\.md' is already stored \(no chunks tool\)\. If it is, the new file replaces it\./);
});

// -----------------------------------------------------------------------------
// The queue: probe first, never an objectId, one file per shared base name
// -----------------------------------------------------------------------------

interface Harness {
	deps: IngestDeps;
	calls: Array<{ tool: string; input: Record<string, unknown> }>;
	sends: Array<{ files: ISendFile[]; maxConcurrent: number; startedAfter: number }>;
	changed: string[][];
	announced: string[];
	log: string[];
}

/**
 * Fake dependencies: a store that knows some objectIds, and an ingest lane
 * that runs the given script (streaming events) while a send is in flight.
 *
 * @param options - stored objectIds -> chunk counts; counts after upload; the in-flight script; paths whose upload fails.
 * @returns The harness.
 */
function harness(options: { stored?: Record<string, number>; counts?: Record<string, number>; events?: (files: ISendFile[]) => Promise<void>; fail?: Set<string> } = {}): Harness {
	const calls: Harness['calls'] = [];
	const sends: Harness['sends'] = [];
	const changed: string[][] = [];
	const announced: string[] = [];
	const log: string[] = [];
	let finishedSends = 0;
	const deps: IngestDeps = {
		canProbe: true,
		canCount: true,
		async callTool(tool, input): Promise<CallOutcome> {
			calls.push({ tool, input });
			log.push(`${tool}:${String(input.object_id ?? (input.object_ids as string[] | undefined)?.[0])}`);
			if (tool === 'chunks') {
				const id = String(input.object_id);
				const stored = options.stored?.[id];
				if (stored === undefined) return { ok: false, code: 'NOT_FOUND', message: 'No document', kind: null, error: { success: false, code: 'NOT_FOUND' } };
				return { ok: true, value: { success: true, items: [{ chunkId: 0 }], has_more: stored > 1, next_after: 0, total: stored } };
			}
			const id = (input.object_ids as string[])[0];
			const count = options.counts?.[id] ?? 3;
			return { ok: true, value: { success: true, items: [{ objectId: id, path: 'p', chunks: count }], next_cursor: null, total: 1 } };
		},
		async sendFiles(files, opts) {
			sends.push({ files, maxConcurrent: opts.maxConcurrent, startedAfter: finishedSends });
			log.push(`send:${files.map((file) => String(file.objinfo?.name)).join(',')}`);
			if (options.events) await options.events(files);
			finishedSends += 1;
			return files.map((file) => {
				const name = String(file.objinfo?.name);
				const failed = options.fail?.has(name);
				return { action: failed ? 'error' : 'complete', filepath: file.file.name, bytes_sent: file.file.size, file_size: file.file.size, upload_time: 0.1, ...(failed ? { error: 'Pipe closed with an error' } : {}) };
			});
		},
		onDocumentsChanged(objectIds) {
			changed.push([...objectIds]);
		},
		announce(message) {
			announced.push(message);
		},
		sleep: async () => undefined,
		locks: createNameLocks(),
	};
	return {
		deps,
		calls,
		sends,
		changed,
		announced,
		log,
	};
}

test('queue: every file is probed with chunks({object_id, limit: 1}) before anything is sent', async () => {
	const h = harness();
	const queue = createIngestQueue(h.deps);
	await queue.addDrop([candidate('docs/a.md'), candidate('b.pdf')]);
	await queue.idle();
	const probes = h.calls.filter((call) => call.tool === 'chunks');
	assert.deepEqual(
		probes.map((call) => call.input),
		[
			{ object_id: objectIdForPath('docs/a.md'), limit: 1 },
			{ object_id: objectIdForPath('b.pdf'), limit: 1 },
		]
	);
	const firstSend = h.log.findIndex((entry) => entry.startsWith('send:'));
	const lastProbe = h.log.map((entry) => entry.startsWith('chunks:')).lastIndexOf(true);
	assert.ok(firstSend > lastProbe, h.log.join(' | '));
	assert.deepEqual(
		queue.getState().rows.map((row) => [row.path, row.status, uploadLabel(row)]),
		[
			['docs/a.md', 'done', '3 chunks added'],
			['b.pdf', 'done', '3 chunks added'],
		]
	);
});

test('queue: never sends an objectId, in any field of any upload', async () => {
	const h = harness();
	const queue = createIngestQueue(h.deps);
	await queue.addDrop([candidate('docs/a.md'), candidate('x/report.pdf'), candidate('y/report.pdf')]);
	await queue.idle();
	assert.equal(h.sends.length, 3);
	const sent = JSON.stringify(h.sends.map((send) => send.files.map((file) => ({ objinfo: file.objinfo, mimetype: file.mimetype }))));
	assert.doesNotMatch(sent, /objectId|object_id/i);
	for (const id of [objectIdForPath('docs/a.md'), objectIdForPath('x/report.pdf')]) assert.ok(!sent.includes(id));
});

test('queue: a stored path asks before replacing; Cancel sends nothing for it', async () => {
	const stored = objectIdForPath('report.pdf');
	const h = harness({ stored: { [stored]: 19 } });
	const queue = createIngestQueue(h.deps);
	const drop = queue.addDrop([candidate('report.pdf'), candidate('new.md')]);
	await queue.waitFor((state) => state.confirm !== null);
	const confirm = queue.getState().confirm;
	assert.ok(confirm);
	assert.equal(confirm.message[0], "Replace existing 'report.pdf' (19 chunks)? The old chunks are removed when the new file is stored.");
	assert.equal(h.sends.length, 0, 'nothing is sent while the question is open');
	queue.answerConfirm(false);
	await drop;
	await queue.idle();
	assert.deepEqual(
		h.sends.flatMap((send) => send.files.map((file) => file.objinfo?.name)),
		['new.md']
	);
	const report = queue.getState().rows.find((row) => row.path === 'report.pdf');
	assert.equal(report?.status, 'cancelled');
	assert.equal(report?.message, CANCELLED_SENTENCE);
	assert.ok(h.announced.includes('Cancelled. Nothing was sent.'));
});

test('queue: Replace sends the stored path again', async () => {
	const h = harness({ stored: { [objectIdForPath('report.pdf')]: 19 } });
	const queue = createIngestQueue(h.deps);
	const drop = queue.addDrop([candidate('report.pdf')]);
	await queue.waitFor((state) => state.confirm !== null);
	queue.answerConfirm(true);
	await drop;
	await queue.idle();
	assert.deepEqual(
		h.sends.flatMap((send) => send.files.map((file) => file.objinfo?.name)),
		['report.pdf']
	);
	assert.equal(queue.getState().rows[0].status, 'done');
});

test('queue: a/report.pdf and b/report.pdf go out one after the other, and every progress event lands on the right row', async () => {
	const script = fixture<{ files: Array<{ relPath: string; size: number }>; events: IUploadEvent[] }>('upload_events_duplicate_basename.json');
	// The fixture's events, split per file (both are keyed 'report.pdf'; only the size tells them apart).
	const eventsOf = new Map<number, IUploadEvent[]>();
	for (const event of script.events) eventsOf.set(event.file_size, [...(eventsOf.get(event.file_size) ?? []), event]);
	const observations: Array<{ event: IUploadEvent; inFlight: number; a: UploadRow; b: UploadRow }> = [];
	let queueRef: ReturnType<typeof createIngestQueue> | null = null;
	const h = harness({
		async events(files) {
			// The engine streams the events of the file in flight, keyed by its base name only.
			for (const event of eventsOf.get(files[0].file.size) ?? []) {
				const queue = queueRef as ReturnType<typeof createIngestQueue>;
				queue.handleEvent(event);
				const rows = queue.getState().rows;
				const a = rows.find((row) => row.path === 'a/report.pdf') as UploadRow;
				const b = rows.find((row) => row.path === 'b/report.pdf') as UploadRow;
				observations.push({ event, inFlight: files.length, a, b });
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
	});
	const queue = createIngestQueue(h.deps);
	queueRef = queue;
	await queue.addDrop(script.files.map((file) => candidate(file.relPath, file.size)));
	await queue.idle();

	// Sequential: two calls of one file each, the second started after the first finished.
	assert.deepEqual(
		h.sends.map((send) => [send.maxConcurrent, send.files.map((file) => file.objinfo?.name), send.startedAfter]),
		[
			[1, ['a/report.pdf'], 0],
			[1, ['b/report.pdf'], 1],
		]
	);
	assert.equal(observations.length, script.events.length);
	for (const { event, inFlight, a, b } of observations) {
		assert.equal(inFlight, 1);
		const [mine, other] = event.file_size === 120000 ? [a, b] : [b, a];
		// The event moved the row of the file in flight ...
		assert.equal(mine.fileSize, event.file_size, `${event.action} ${event.bytes_sent}`);
		assert.equal(mine.bytesSent, event.bytes_sent, `${event.action} ${event.bytes_sent}`);
		// ... and left the other row alone.
		if (event.file_size === 120000) {
			assert.equal(other.status, 'queued');
			assert.equal(other.bytesSent, 0);
		} else {
			assert.equal(other.bytesSent, 120000);
			assert.equal(other.fileSize, 120000);
		}
	}
	assert.deepEqual(
		queue.getState().rows.map((row) => [row.path, row.status, row.bytesSent, row.fileSize]),
		[
			['a/report.pdf', 'done', 120000, 120000],
			['b/report.pdf', 'done', 64000, 64000],
		]
	);
});

test('queue: an event for a name not in flight is ignored', async () => {
	const h = harness();
	const queue = createIngestQueue(h.deps);
	await queue.addDrop([candidate('a.md')]);
	await queue.idle();
	const before = JSON.stringify(queue.getState().rows);
	queue.handleEvent({ action: 'write', filepath: 'a.md', bytes_sent: 1, file_size: 1000, upload_time: 0 });
	queue.handleEvent({ action: 'error', filepath: 'other.pdf', bytes_sent: 1, file_size: 1, upload_time: 0, error: 'x' });
	assert.equal(JSON.stringify(queue.getState().rows), before);
});

test('queue: a failed upload reads honestly and is not counted as added', async () => {
	const h = harness({ fail: new Set(['bad.pdf']) });
	const queue = createIngestQueue(h.deps);
	await queue.addDrop([candidate('bad.pdf'), candidate('good.md')]);
	await queue.idle();
	const rows = Object.fromEntries(queue.getState().rows.map((row) => [row.path, row]));
	assert.equal(rows['bad.pdf'].status, 'failed');
	assert.equal(uploadLabel(rows['bad.pdf']), FAILED_SENTENCE);
	assert.equal(rows['bad.pdf'].detail, 'Pipe closed with an error');
	assert.equal(rows['good.md'].status, 'done');
	assert.deepEqual(h.changed.flat(), [objectIdForPath('good.md')]);
	assert.ok(!h.calls.some((call) => call.tool === 'list_documents' && (call.input.object_ids as string[])[0] === objectIdForPath('bad.pdf')));
});
