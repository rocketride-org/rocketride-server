// MIT License
//
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryChannel, TELEMETRY_BUFFER_MAX, TELEMETRY_STORAGE_KEY, TELEMETRY_TTL_MS, type FactStorage } from './telemetryChannel';

/** An in-memory sessionStorage stand-in shared by several channel instances (page loads of one tab). */
function fakeStorage(): FactStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => { data.set(k, v); },
		removeItem: (k) => { data.delete(k); },
	};
}

test('facts are held in order, get distinct ids, and are drained once', () => {
	const ch = new TelemetryChannel({ storage: null, now: () => 1000 });
	ch.report('auth:start', { register: true, from_path: '/' });
	ch.report('auth:complete', { is_new: true, source: 'shell' });
	assert.equal(ch.size, 2);
	const drained = ch.drain();
	assert.deepEqual(drained.map((f) => f.event), ['auth:start', 'auth:complete']);
	assert.deepEqual(drained[1].props, { is_new: true, source: 'shell' });
	assert.deepEqual(drained.map((f) => f.ts), [1000, 1000]);
	assert.notEqual(drained[0].id, drained[1].id, 'two facts in one millisecond are two facts');
	assert.equal(ch.size, 0);
	assert.deepEqual(ch.drain(), []);
});

test('props are copied, so later mutation of the caller object does not change the fact', () => {
	const ch = new TelemetryChannel({ storage: null });
	const props: Record<string, unknown> = { register: false };
	ch.report('auth:start', props);
	props.register = true;
	assert.equal(ch.drain()[0].props.register, false);
});

test('invalid event names are ignored, missing props become an empty bag, a bad ts falls back to now', () => {
	const ch = new TelemetryChannel({ storage: null, now: () => 5 });
	assert.equal(ch.report('', { a: 1 }), null, 'an ignored fact is reported as null');
	assert.equal(ch.report(undefined as unknown as string, { a: 1 }), null);
	const held = ch.report('x', undefined as unknown as Record<string, unknown>, Number.NaN);
	const out = ch.drain();
	assert.equal(out.length, 1);
	assert.deepEqual(out[0], { event: 'x', props: {}, ts: 5, id: '5-0' });
	assert.deepEqual(held, out[0], 'report returns the fact as held');
});

test('the hold is bounded; the oldest facts are dropped first', () => {
	const ch = new TelemetryChannel({ storage: null });
	for (let i = 0; i < TELEMETRY_BUFFER_MAX + 5; i++) ch.report('e', { i });
	const out = ch.drain();
	assert.equal(out.length, TELEMETRY_BUFFER_MAX);
	assert.equal(out[0].props.i, 5);
	assert.equal(out[out.length - 1].props.i, TELEMETRY_BUFFER_MAX + 4);
});

test('the mirror defaults to the tab\'s sessionStorage; a storage passed as null or undefined keeps the hold in memory', () => {
	const tab = fakeStorage();
	const before = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
	Reflect.set(globalThis, 'sessionStorage', tab);
	try {
		new TelemetryChannel({ storage: null }).report('a', {});
		new TelemetryChannel({ storage: undefined }).report('b', {});
		assert.equal(tab.data.has(TELEMETRY_STORAGE_KEY), false, 'an explicit null or undefined storage mirrors nothing');
		new TelemetryChannel({ now: () => 1000 }).report('c', {});
		assert.deepEqual(JSON.parse(tab.data.get(TELEMETRY_STORAGE_KEY)!).map((f: { event: string }) => f.event), ['c'], 'no storage option: the tab\'s sessionStorage');
	} finally {
		if (before) Object.defineProperty(globalThis, 'sessionStorage', before);
		else Reflect.deleteProperty(globalThis, 'sessionStorage');
	}
});

test('a held fact is mirrored to storage and drained once by a later page load', () => {
	const storage = fakeStorage();
	const first = new TelemetryChannel({ storage, now: () => 10_000 });
	first.report('auth:complete', { is_new: true, source: 'shell' });
	assert.ok(storage.data.has(TELEMETRY_STORAGE_KEY), 'mirrored at report time');
	// The page unloads without an app draining it; the next page load of the tab starts a new channel.
	const next = new TelemetryChannel({ storage, now: () => 10_000 + 60_000 });
	const out = next.drain();
	assert.deepEqual(out, [{ event: 'auth:complete', props: { is_new: true, source: 'shell' }, ts: 10_000, id: '7ps-0' }]);
	assert.equal(storage.data.has(TELEMETRY_STORAGE_KEY), false, 'the mirror is cleared by the drain');
	assert.deepEqual(next.drain(), [], 'a fact is handed over once');
});

test('clear drops the held facts and the mirror without handing them over (a sign-out)', () => {
	const storage = fakeStorage();
	const earlier = new TelemetryChannel({ storage, now: () => 20_000 });
	earlier.report('auth:start', { register: false, auto: false });
	const channel = new TelemetryChannel({ storage, now: () => 30_000 });
	channel.report('auth:complete', { is_new: false, waitlisted: false, source: 'shell' });
	channel.clear();
	assert.equal(storage.data.has(TELEMETRY_STORAGE_KEY), false, 'the mirror is removed');
	assert.deepEqual(channel.drain(), [], 'nothing inherited or held is handed over');
	assert.deepEqual(new TelemetryChannel({ storage, now: () => 40_000 }).drain(), [], 'a later page load of the tab inherits nothing');
});

test('the drain hands over the mirror first, then this page load, each fact once', () => {
	const storage = fakeStorage();
	const earlier = new TelemetryChannel({ storage, now: () => 1 });
	earlier.report('auth:start', { register: false });
	const ch = new TelemetryChannel({ storage, now: () => 2 });
	ch.report('auth:complete', { is_new: false });
	ch.report('auth:start', { register: true }, 3);
	assert.deepEqual(ch.drain().map((f) => [f.event, f.ts]), [['auth:start', 1], ['auth:complete', 2], ['auth:start', 3]]);
	assert.deepEqual(ch.drain(), []);
	assert.deepEqual(new TelemetryChannel({ storage, now: () => 4 }).drain(), [], 'nothing is left for a later page load');
});

test('mirrored facts older than the TTL, or from a clock far ahead, are discarded', () => {
	const storage = fakeStorage();
	const old = new TelemetryChannel({ storage, now: () => 1_000_000 });
	old.report('auth:complete', { is_new: true });
	const ahead = new TelemetryChannel({ storage, now: () => 1_000_000 + TELEMETRY_TTL_MS + 5 * 60_000 });
	ahead.report('auth:start', { register: true });
	const atExpiry = new TelemetryChannel({ storage, now: () => 1_000_000 + TELEMETRY_TTL_MS + 1 });
	assert.deepEqual(atExpiry.drain().map((f) => f.event), [], 'the old fact expired and the future one is not trusted');
});

test('an in-memory fact past the TTL is not handed over either', () => {
	let now = 0;
	const ch = new TelemetryChannel({ storage: null, now: () => now });
	ch.report('auth:complete', { is_new: true });
	now = TELEMETRY_TTL_MS + 1;
	assert.deepEqual(ch.drain(), []);
});

test('a corrupt mirror and a throwing storage are tolerated; the in-memory hold still works', () => {
	const corrupt = fakeStorage();
	corrupt.setItem(TELEMETRY_STORAGE_KEY, '{not json');
	const ch = new TelemetryChannel({ storage: corrupt });
	ch.report('auth:start', { register: true });
	assert.equal(ch.drain().length, 1);
	corrupt.setItem(TELEMETRY_STORAGE_KEY, JSON.stringify([{ event: 3 }, null, 'x', { event: 'ok', props: null, ts: 50 }]));
	const out = new TelemetryChannel({ storage: corrupt, now: () => 60 }).drain();
	assert.deepEqual(out.map((f) => [f.event, f.props, f.ts]), [['ok', {}, 50]]);
	assert.equal(typeof out[0].id, 'string', 'a mirrored fact without an id gets one');
	const throwing: FactStorage = {
		getItem: () => { throw new Error('denied'); },
		setItem: () => { throw new Error('denied'); },
		removeItem: () => { throw new Error('denied'); },
	};
	const ch2 = new TelemetryChannel({ storage: throwing });
	ch2.report('auth:complete', { is_new: false });
	assert.equal(ch2.drain().length, 1);
});

test('the hold is bounded as a whole across page loads', () => {
	const storage = fakeStorage();
	const a = new TelemetryChannel({ storage, now: () => 1 });
	for (let i = 0; i < 20; i++) a.report('e', { i });
	const b = new TelemetryChannel({ storage, now: () => 2 });
	for (let i = 20; i < 40; i++) b.report('e', { i });
	assert.equal(JSON.parse(storage.data.get(TELEMETRY_STORAGE_KEY)!).length, TELEMETRY_BUFFER_MAX, 'the mirror never grows past the bound');
	const out = b.drain();
	assert.equal(out.length, TELEMETRY_BUFFER_MAX);
	assert.equal(out[0].props.i, 40 - TELEMETRY_BUFFER_MAX, 'the oldest facts of the earlier page load were dropped');
	assert.equal(out[out.length - 1].props.i, 39);
});
