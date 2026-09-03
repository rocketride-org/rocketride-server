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
import { createSerialQueue } from '../shared/util/serialQueue';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('a second task does not start until the first finishes', async () => {
	const queue = createSerialQueue();
	const events: string[] = [];

	// The slow task is submitted first, so a queue that did not serialize would
	// let the fast one enter and leave while the slow one was still running.
	const slow = queue(async () => {
		events.push('slow:enter');
		await tick(20);
		events.push('slow:exit');
	});
	const fast = queue(async () => {
		events.push('fast:enter');
		events.push('fast:exit');
	});

	await Promise.all([slow, fast]);
	assert.deepEqual(events, ['slow:enter', 'slow:exit', 'fast:enter', 'fast:exit']);
});

test('a shared flag set and cleared inside the task is never cleared early', async () => {
	// Mirrors ConfigManager.isBatchApplying: each task sets the flag on entry and
	// clears it on exit. Overlap would leave a task running with the flag false.
	const queue = createSerialQueue();
	let busy = false;
	let observedOverlap = false;

	const job = () =>
		queue(async () => {
			if (busy) observedOverlap = true;
			busy = true;
			await tick(5);
			if (!busy) observedOverlap = true;
			busy = false;
		});

	await Promise.all([job(), job(), job()]);
	assert.equal(observedOverlap, false);
	assert.equal(busy, false);
});

test('tasks run in submission order', async () => {
	const queue = createSerialQueue();
	const order: number[] = [];

	// Descending delays: without ordering, 3 would finish first.
	await Promise.all([
		queue(async () => {
			await tick(15);
			order.push(1);
		}),
		queue(async () => {
			await tick(10);
			order.push(2);
		}),
		queue(async () => {
			await tick(0);
			order.push(3);
		}),
	]);

	assert.deepEqual(order, [1, 2, 3]);
});

test('a rejected task does not stop the queue', async () => {
	const queue = createSerialQueue();
	const ran: string[] = [];

	const failing = queue(async () => {
		ran.push('first');
		throw new Error('write failed');
	});

	const after = queue(async () => {
		ran.push('second');
		return 'ok';
	});

	await assert.rejects(failing, /write failed/);
	assert.equal(await after, 'ok');
	assert.deepEqual(ran, ['first', 'second']);
});

test('a rejection reaches only its own caller', async () => {
	const queue = createSerialQueue();

	const failing = queue(async () => {
		throw new Error('boom');
	});
	const sibling = queue(async () => 42);

	await assert.rejects(failing, /boom/);
	assert.equal(await sibling, 42);
});

test('a task submitted after the queue drained still runs', async () => {
	const queue = createSerialQueue();

	assert.equal(await queue(async () => 'a'), 'a');
	assert.equal(await queue(async () => 'b'), 'b');
});

test('the task result is returned to its caller', async () => {
	const queue = createSerialQueue();
	const [a, b] = await Promise.all([queue(async () => ({ shadowedKeys: ['x'] })), queue(async () => ({ shadowedKeys: [] }))]);

	assert.deepEqual(a, { shadowedKeys: ['x'] });
	assert.deepEqual(b, { shadowedKeys: [] });
});

test('a synchronously throwing task is delivered as a rejection, not a crash', async () => {
	const queue = createSerialQueue();

	const thrown = queue((() => {
		throw new Error('sync boom');
	}) as () => Promise<never>);

	await assert.rejects(thrown, /sync boom/);
	// Queue survives it.
	assert.equal(await queue(async () => 'still works'), 'still works');
});
