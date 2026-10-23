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
// EXPLORER DEV TOOL — RETAINED STATE SIZE (T11: no bulk result is retained state)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertRetainedStateSize, guardRetainedState, jsonByteLength, MAX_RETAINED_STATE_BYTES, MAX_RETAINED_TOTAL_BYTES, RetainedStateTooLargeError, truncateLists } from './state';
import { createDevToolHarness, settle, shellProtocol } from './testing';

describe('jsonByteLength', () => {
	it('counts the UTF-8 bytes of the JSON text', () => {
		assert.equal(jsonByteLength({ a: 1 }), 7);
		assert.equal(jsonByteLength('é'), 4, 'two quotes and a two-byte character');
		assert.equal(jsonByteLength(['😀']), 8, 'brackets, quotes and a four-byte character');
		assert.equal(jsonByteLength(undefined), 0);
	});
});

describe('the retained-state cap', () => {
	it('is a documented 64 KiB per snapshot', () => {
		assert.equal(MAX_RETAINED_STATE_BYTES, 64 * 1024);
	});

	it('assertRetainedStateSize passes a small snapshot and refuses a bulk one', () => {
		assert.equal(assertRetainedStateSize('endpoints', { list: [1, 2, 3] }), jsonByteLength({ list: [1, 2, 3] }));
		const bulk = { rows: Array.from({ length: 20_000 }, (_, i) => [i, `row ${i}`]) };
		assert.throws(() => assertRetainedStateSize('rows', bulk), (error: unknown) => {
			assert.ok(error instanceof RetainedStateTooLargeError);
			assert.equal(error.topic, 'rows');
			assert.ok(error.bytes > MAX_RETAINED_STATE_BYTES);
			assert.equal(error.maxBytes, MAX_RETAINED_STATE_BYTES);
			return true;
		});
		assert.doesNotThrow(() => assertRetainedStateSize('rows', bulk, 10 * 1024 * 1024), 'the cap is a parameter');
	});
});

describe('guardRetainedState — a channel that refuses bulk state', () => {
	it('strict: publishes small snapshots and THROWS on a bulk one, which never reaches the wire (for tests)', async () => {
		const h = createDevToolHarness();
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 1_024, strict: true });
		channel.publishState('schemas', { k1: ['users'] });
		await settle();
		const writes = h.wire.length;
		assert.throws(() => channel.publishState('preview', { rows: 'x'.repeat(2_000) }), RetainedStateTooLargeError);
		await settle();
		assert.equal(h.wire.length, writes, 'nothing was published');
		const seen: unknown[] = [];
		channel.onState('schemas', (snapshot) => seen.push(snapshot));
		assert.deepEqual(seen, [{ k1: ['users'] }], 'the rest of the channel is the original');
	});

	it('a snapshot nothing can shrink is withheld and reported, never thrown', () => {
		const h = createDevToolHarness();
		const reported: RetainedStateTooLargeError[] = [];
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 10, onOversize: (error) => reported.push(error) });
		assert.doesNotThrow(() => channel.publishState('big', { text: 'more than ten bytes' }));
		assert.equal(reported.length, 1);
		assert.equal(reported[0].topic, 'big');
	});
});

describe('guardRetainedState — round 3: degrade, never withhold by default (CE-6)', () => {
	/** A realistic endpoint summary (the DA measured ~312 bytes each). */
	const endpoint = (i: number) => ({
		key: `k1|dev|user|u1|team-1|proj-${i}|tools=tools_1|db_${i}`, nodeId: `db_${i}`, nodeName: `Warehouse replica ${i}`,
		pipelineName: `nightly-etl-${i}`, provider: 'db_postgres', state: 'ready', dialect: 'postgres', readOnly: false,
	});

	it('an oversize list reaches the frames truncated, with an honest count, instead of leaving them on the stale list', async () => {
		const h = createDevToolHarness();
		const reported: RetainedStateTooLargeError[] = [];
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { onOversize: (error) => reported.push(error) });
		const frame = shellProtocol.createToolChannel(h.newFramePeer());
		let seen: { items: unknown[]; truncated?: Record<string, { kept: number; total: number }> } = { items: [] };
		frame.onState('endpoints', (snapshot) => { seen = snapshot as typeof seen; });
		await settle();
		channel.publishState('endpoints', { items: Array.from({ length: 10 }, (_, i) => endpoint(i)) });
		await settle();
		assert.equal(seen.items.length, 10);
		const total = Math.ceil(MAX_RETAINED_STATE_BYTES / jsonByteLength(endpoint(123))) + 50;
		assert.doesNotThrow(() => channel.publishState('endpoints', { items: Array.from({ length: total }, (_, i) => endpoint(i)) }));
		await settle();
		assert.ok(seen.items.length > 10, 'the frames moved on from the stale list');
		assert.ok(seen.truncated !== undefined, 'and are told it is truncated');
		assert.deepEqual(seen.truncated, { items: { kept: seen.items.length, total } });
		assert.ok(jsonByteLength(seen) <= MAX_RETAINED_STATE_BYTES);
		assert.equal(reported.length, 1, 'the lane is told too');
		assert.equal(reported[0].outcome, 'degraded');
		assert.deepEqual(h.violations, []);
	});

	it('a lane shrink() replaces the snapshot with its own bounded summary', async () => {
		const h = createDevToolHarness();
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), {
			maxBytes: 2_048,
			shrink: (topic, snapshot, info) => ({ count: (snapshot as { items: unknown[] }).items.length, sample: [], over: info.bytes > info.maxBytes, topic }),
		});
		const seen: unknown[] = [];
		channel.onState('endpoints', (snapshot) => seen.push(snapshot));
		channel.publishState('endpoints', { items: Array.from({ length: 100 }, (_, i) => endpoint(i)) });
		assert.deepEqual(seen, [{ count: 100, sample: [], over: true, topic: 'endpoints' }]);
	});

	it('withhold: true is the opt-in to refuse (the stale snapshot stays)', () => {
		const h = createDevToolHarness();
		const reported: RetainedStateTooLargeError[] = [];
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 1_024, withhold: true, onOversize: (error) => reported.push(error) });
		const seen: unknown[] = [];
		channel.onState('endpoints', (snapshot) => seen.push(snapshot));
		channel.publishState('endpoints', { items: [endpoint(1)] });
		channel.publishState('endpoints', { items: Array.from({ length: 100 }, (_, i) => endpoint(i)) });
		assert.equal(seen.length, 1);
		assert.equal(reported[0].outcome, 'withheld');
	});

	it('enforces a TOTAL budget across topics (the whole map is republished on every publish) and reports the sizes', () => {
		assert.equal(MAX_RETAINED_TOTAL_BYTES, 128 * 1024);
		const h = createDevToolHarness();
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 10_000, maxTotalBytes: 15_000 });
		const list = (n: number) => ({ items: Array.from({ length: n }, (_, i) => endpoint(i)) });
		const n = Math.floor(9_000 / jsonByteLength(endpoint(1)));
		channel.publishState('a', list(n));
		const seen: Array<{ items: unknown[]; truncated?: unknown }> = [];
		channel.onState('b', (snapshot) => seen.push(snapshot as { items: unknown[] }));
		channel.publishState('b', list(n));
		const sizes = channel.retainedBytes();
		assert.ok(sizes.total <= 15_000, `total ${sizes.total}`);
		assert.ok(seen[0].items.length < n && seen[0].truncated !== undefined, 'b was cut to what the total leaves');
		channel.publishState('a', list(1));
		channel.publishState('b', list(n));
		assert.equal(seen.at(-1)?.items.length, n, 'a smaller a frees the budget for b');
		assert.equal(channel.retainedBytes().byTopic.b, jsonByteLength(list(n)));
	});
});

describe('truncateLists — the default shrink', () => {
	it('cuts the largest list properties to fit, recording kept and total; a top-level list keeps a prefix', () => {
		const snapshot = { title: 'x', items: Array.from({ length: 50 }, (_, i) => `item-${i}`), tags: ['a', 'b'] };
		const out = truncateLists(snapshot, 200);
		assert.ok(out.truncated);
		const cut = out.snapshot as { items: string[]; tags: string[]; title: string; truncated: Record<string, { kept: number; total: number }> };
		assert.ok(jsonByteLength(cut) <= 200);
		assert.equal(cut.title, 'x');
		assert.deepEqual(cut.truncated.items, { kept: cut.items.length, total: 50 });
		assert.deepEqual(cut.items, snapshot.items.slice(0, cut.items.length));
		const list = truncateLists(Array.from({ length: 50 }, (_, i) => i), 30);
		assert.ok(list.truncated && jsonByteLength(list.snapshot) <= 30);
		assert.deepEqual(truncateLists({ text: 'x'.repeat(100) }, 20), { snapshot: { text: 'x'.repeat(100) }, truncated: false }, 'nothing to cut');
	});
});

