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

test('queued, the second of two files created together sees what the first cached', async () => {
	// A model of handleFileCreated: look at the cache, then (after the read
	// and the write) add the file to it. What each handler SAW is recorded.
	const cache = new Set<string>();
	const seen: string[][] = [];
	const handleCreated = async (filePath: string): Promise<void> => {
		seen.push([...cache]);
		await tick(); // the read and the write of the real handler
		cache.add(filePath);
	};

	// Side by side, each handler looks at a cache that has neither file.
	await Promise.all([handleCreated(FILE), handleCreated(OTHER)]);
	assert.deepEqual(seen, [[], []]);

	// Queued, the second handler sees the file the first added.
	seen.length = 0;
	cache.clear();
	const queue = new SerialQueue();
	await Promise.all([queue.enqueue(() => handleCreated(FILE)), queue.enqueue(() => handleCreated(OTHER))]);
	assert.deepEqual(seen, [[], [FILE]]);
});
