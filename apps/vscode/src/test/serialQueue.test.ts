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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { SerialQueue } from '../shared/util/serialQueue';
import { decidePipeFile, readPipeProjectId } from '../shared/util/pipeFileDecision';
import type { KnownPipeFile, PipeFileDecision } from '../shared/util/pipeFileDecision';

/** A promise the test settles by hand, so nothing here depends on timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Lets every microtask that is ready run (a macrotask turn). */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test('jobs run one at a time, in the order they were added', async () => {
	const queue = new SerialQueue();
	const events: string[] = [];
	const firstDone = deferred();

	const first = queue.enqueue(async () => {
		events.push('first:start');
		await firstDone.promise;
		events.push('first:end');
		return 1;
	});
	const second = queue.enqueue(() => {
		events.push('second');
		return 2;
	});

	// The second job was added while the first was pending: it must not start.
	await tick();
	assert.deepEqual(events, ['first:start']);

	firstDone.resolve();
	assert.deepEqual(await Promise.all([first, second]), [1, 2]);
	assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('a failed job neither stops the queue nor loses its failure', async () => {
	const queue = new SerialQueue();
	const rejected = queue.enqueue(() => Promise.reject(new Error('rejected')));
	const threw = queue.enqueue(() => {
		throw new Error('threw');
	});
	const after = queue.enqueue(() => 'ran');

	await assert.rejects(rejected, /rejected/);
	await assert.rejects(threw, /threw/);
	assert.equal(await after, 'ran');
});

// --- why the watcher queues created files (#2466) ---------------------------

const FILE = '/ws/pipelines/a.pipe';
const OTHER = '/ws/pipelines/b.pipe';
const ID = '11111111-1111-4111-8111-111111111111';

test('queued, the second of two files created together is judged against the first', async () => {
	// A model of handleFileCreated: judge the file against the cache, then
	// parse the file into the cache. Both files already carry the same id, as
	// after a checkout or a copied folder.
	const disk = new Map<string, string>([
		[FILE, JSON.stringify({ components: [], project_id: ID })],
		[OTHER, JSON.stringify({ components: [], project_id: ID })],
	]);
	const cache = new Map<string, KnownPipeFile>();
	const decisions: PipeFileDecision[] = [];
	const handleCreated = async (filePath: string): Promise<void> => {
		const text = disk.get(filePath) ?? '';
		decisions.push(decidePipeFile({ event: 'created', filePath, text, known: [...cache.values()] }));
		await tick(); // the read and the write of the real handler
		cache.set(filePath, { filePath, projectId: readPipeProjectId(text) ?? undefined });
	};

	// Side by side, each handler judges a cache that has neither file: the
	// shared id passes twice and nothing re-judges afterwards.
	await Promise.all([handleCreated(FILE), handleCreated(OTHER)]);
	assert.deepEqual(decisions, [
		{ kind: 'leave', reason: 'id-ok' },
		{ kind: 'leave', reason: 'id-ok' },
	]);

	// Queued, the second handler sees the file the first added.
	decisions.length = 0;
	cache.clear();
	const queue = new SerialQueue();
	await Promise.all([queue.enqueue(() => handleCreated(FILE)), queue.enqueue(() => handleCreated(OTHER))]);
	assert.deepEqual(decisions, [
		{ kind: 'leave', reason: 'id-ok' },
		{ kind: 'ask-duplicate', projectId: ID, otherPath: FILE },
	]);
});
