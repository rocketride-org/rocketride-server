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

import { ReloadingCache, isUnderNodeModules } from '../shared/util/reloadingCache';
import { SerialQueue } from '../shared/util/serialQueue';

/** A promise the test settles by hand, so nothing here depends on timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

/** Lets every settled promise run its continuations. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Whether `promise` settles within one flush: a hang fails the test instead of stalling the run. */
const settlesNow = (promise: Promise<void>): Promise<boolean> =>
	Promise.race([promise.then(() => true), flush().then(() => false)]);

function seeded(): ReloadingCache<string> {
	const cache = new ReloadingCache<string>();
	cache.write('a.pipe', 'a1');
	cache.write('b.pipe', 'b1');
	return cache;
}

test('a delete recorded during a reload stays deleted after the swap', () => {
	const cache = seeded();
	const seq = cache.beginReload();
	cache.write('b.pipe', null); // the user deleted b.pipe while the reload was parsing
	assert.equal(cache.entries.has('b.pipe'), false);

	assert.equal(cache.finishReload(seq, new Map([['a.pipe', 'a2'], ['b.pipe', 'b-from-disk']])), true);

	assert.deepEqual([...cache.entries], [['a.pipe', 'a2']]);
});

test('a change recorded during a reload wins over the reload\'s own parse', () => {
	const cache = seeded();
	const seq = cache.beginReload();
	cache.write('a.pipe', 'a-changed'); // the change handler parsed the new contents

	assert.equal(cache.finishReload(seq, new Map([['a.pipe', 'a-stale'], ['b.pipe', 'b1']])), true);

	assert.equal(cache.entries.get('a.pipe'), 'a-changed');
	assert.equal(cache.entries.get('b.pipe'), 'b1');
});

test('of two overlapping reloads only the newer installs its map', () => {
	const cache = seeded();
	const first = cache.beginReload();
	const second = cache.beginReload();

	assert.equal(cache.finishReload(first, new Map([['old.pipe', 'x']])), false);
	assert.deepEqual([...cache.entries.keys()], ['a.pipe', 'b.pipe']); // untouched by the superseded one

	assert.equal(cache.finishReload(second, new Map([['new.pipe', 'y']])), true);
	assert.deepEqual([...cache.entries.keys()], ['new.pipe']);
});

test('writes made during a superseded reload reach the newer one, not the older', () => {
	const cache = seeded();
	const first = cache.beginReload();
	const second = cache.beginReload();
	cache.write('c.pipe', 'c1'); // created while both were parsing

	cache.finishReload(first, new Map());
	assert.equal(cache.finishReload(second, new Map([['a.pipe', 'a2']])), true);

	assert.deepEqual([...cache.entries], [['a.pipe', 'a2'], ['c.pipe', 'c1']]);
});

test('a created-file job queued behind a superseded initial load runs against the newer reload\'s map', async () => {
	// The case from review: the initial load runs first on the created-file
	// queue; a services update starts a second load outside the queue; the
	// initial load finishes stale. The queued created file must not be judged
	// against the empty map the constructor left behind.
	const cache = new ReloadingCache<string>();
	const queue = new SerialQueue();
	const initialParsing = deferred();
	const seen: string[][] = [];

	// In the provider the initial load begins inside its queued job, on the
	// first microtask; here it begins outside the job only so the order is
	// certain: initial begun, superseded by an unqueued load, created file
	// queued behind.
	const first = cache.beginReload();
	const initialLoad = queue.enqueue(async () => {
		await initialParsing.promise;
		if (!cache.finishReload(first, new Map([['a.pipe', 'a1']]))) await cache.settled();
	});
	const second = cache.beginReload(); // the services update, outside the queue
	const createdFile = queue.enqueue(() => {
		seen.push([...cache.entries.keys()]);
	});

	initialParsing.resolve(); // the initial load finishes, superseded
	await flush();
	assert.deepEqual(seen, [], 'the created file waited for a map to be installed');

	assert.equal(cache.finishReload(second, new Map([['a.pipe', 'a1'], ['b.pipe', 'b1']])), true);
	await Promise.all([initialLoad, createdFile]);
	assert.deepEqual(seen, [['a.pipe', 'b.pipe']]);
});

test('a failed newest reload installs nothing and releases whoever waits on it', async () => {
	const cache = seeded();
	const first = cache.beginReload();
	const second = cache.beginReload();
	assert.equal(cache.finishReload(first, new Map()), false);
	const waiting = cache.settled();

	assert.equal(cache.finishReload(second, undefined), false); // findFiles threw
	assert.equal(await settlesNow(waiting), true); // released rather than hanging the queue

	assert.deepEqual([...cache.entries.keys()], ['a.pipe', 'b.pipe']); // the previous map stands
});

test('settled resolves at once when no reload is in flight, and a reload begun later does not capture it', async () => {
	const cache = seeded();
	const seq = cache.beginReload();
	cache.finishReload(seq, new Map());
	const idle = cache.settled();
	cache.beginReload(); // begun after the call: the earlier promise owes nothing to it
	assert.equal(await settlesNow(idle), true);
});

test('a superseded load that fails still holds the queue until the newer reload installs', async () => {
	// The provider's catch path: finishReload(seq, undefined), await settled(), rethrow.
	const cache = new ReloadingCache<string>();
	const queue = new SerialQueue();
	const scanning = deferred();
	const seen: string[][] = [];

	const first = cache.beginReload();
	const initialLoad = queue.enqueue(async () => {
		await scanning.promise;
		cache.finishReload(first, undefined); // findFiles threw while a newer load was in flight
		await cache.settled();
		throw new Error('scan failed');
	});
	initialLoad.catch(() => undefined);
	const second = cache.beginReload();
	const createdFile = queue.enqueue(() => {
		seen.push([...cache.entries.keys()]);
	});

	scanning.resolve();
	await flush();
	assert.deepEqual(seen, [], 'the created file waited although the initial load failed');

	cache.finishReload(second, new Map([['a.pipe', 'a1']]));
	await createdFile;
	assert.deepEqual(seen, [['a.pipe']]);
});

test('finishing an unknown reload number installs nothing and touches nothing', () => {
	const cache = seeded();
	assert.equal(cache.finishReload(0, new Map([['x.pipe', 'x']])), false);
	assert.equal(cache.finishReload(99, new Map([['x.pipe', 'x']])), false);
	const seq = cache.beginReload();
	assert.equal(cache.finishReload(seq + 1, new Map()), false); // not the one in flight
	assert.equal(cache.finishReload(seq, new Map([['y.pipe', 'y']])), true); // the real one still installs
	assert.deepEqual([...cache.entries.keys()], ['y.pipe']);
});

test('a write made before a reload began is not replayed over that reload\'s parse', () => {
	const cache = seeded();
	cache.write('a.pipe', 'a-before'); // the reload's scan will read this state from disk itself
	const seq = cache.beginReload();
	assert.equal(cache.finishReload(seq, new Map([['a.pipe', 'a-scanned']])), true);
	assert.equal(cache.entries.get('a.pipe'), 'a-scanned');
});

test('a write recorded against the older of two reloads is not replayed over the newer one', () => {
	// The newer reload's scan runs after that write and reads the disk state it
	// produced, so replaying it would only shadow a fresher parse.
	const cache = seeded();
	const first = cache.beginReload();
	cache.write('a.pipe', 'a-early');
	const second = cache.beginReload();
	cache.finishReload(first, new Map());
	assert.equal(cache.finishReload(second, new Map([['a.pipe', 'a-rescanned']])), true);
	assert.equal(cache.entries.get('a.pipe'), 'a-rescanned');
});

test('three overlapping reloads: the newest installs and both older waiters are released together', async () => {
	const cache = seeded();
	const first = cache.beginReload();
	const second = cache.beginReload();
	const third = cache.beginReload();
	assert.equal(cache.finishReload(second, new Map([['two.pipe', '2']])), false); // out of order is fine
	assert.equal(cache.finishReload(first, new Map([['one.pipe', '1']])), false);
	const waitFirst = cache.settled();
	const waitSecond = cache.settled();
	assert.equal(await settlesNow(waitFirst), false); // still in flight

	assert.equal(cache.finishReload(third, new Map([['three.pipe', '3']])), true);
	assert.deepEqual([await settlesNow(waitFirst), await settlesNow(waitSecond)], [true, true]);
	assert.deepEqual([...cache.entries.keys()], ['three.pipe']);
});

test('a stale finish never installs and does not disturb the reload in flight', () => {
	const cache = seeded();
	const first = cache.beginReload();
	const second = cache.beginReload();
	assert.equal(cache.finishReload(first, new Map([['z.pipe', 'z']])), false);
	assert.equal(cache.finishReload(first, new Map([['z.pipe', 'z']])), false); // repeated, still stale
	cache.write('d.pipe', 'd1');
	assert.equal(cache.finishReload(second, new Map()), true);
	assert.deepEqual([...cache.entries], [['d.pipe', 'd1']]);
});

test('node_modules is recognised as a whole path segment only, on either separator', () => {
	assert.equal(isUnderNodeModules('/w/node_modules/pkg/x.pipe'), true);
	assert.equal(isUnderNodeModules('C:\\w\\node_modules\\pkg\\x.pipe'), true);
	assert.equal(isUnderNodeModules('/w/node_modules'), true);
	assert.equal(isUnderNodeModules('/w/node_modules_old/x.pipe'), false);
	assert.equal(isUnderNodeModules('/w/my-node_modules/x.pipe'), false);
	assert.equal(isUnderNodeModules('/w/src/x.pipe'), false);
});
