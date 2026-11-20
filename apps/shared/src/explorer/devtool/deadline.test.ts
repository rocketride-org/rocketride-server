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
// EXPLORER DEV TOOL — DEADLINES (an expired call is never executed, R2)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError, guardDeadline, readDeadline, stampDeadline } from './deadline';
import { MAX_TIMER_MS } from './timeouts';
import { manualNow } from './testing';

describe('stampDeadline', () => {
	it('stamps now + timeoutMs onto a COPY of the params', () => {
		const clock = manualNow(5_000);
		const params = { key: 'k1', cypher: 'MATCH (n) RETURN n' };
		const stamped = stampDeadline(params, 70_000, clock.now);
		assert.deepEqual(stamped, { key: 'k1', cypher: 'MATCH (n) RETURN n', deadlineAt: 75_000 });
		assert.equal('deadlineAt' in params, false, 'the caller object is untouched');
	});

	it('stamps missing params as an object holding only the deadline', () => {
		assert.deepEqual(stampDeadline(undefined, 10, () => 1), { deadlineAt: 11 });
	});

	it('refuses a missing, non-finite, zero, negative or over-2^31-1 timeout', () => {
		for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -5, MAX_TIMER_MS + 1, '100']) {
			assert.throws(() => stampDeadline({}, bad as unknown as number, () => 0), RangeError, String(bad));
		}
		assert.doesNotThrow(() => stampDeadline({}, MAX_TIMER_MS, () => 0));
	});
});

describe('readDeadline', () => {
	it('reads a finite deadlineAt and nothing else', () => {
		assert.equal(readDeadline({ deadlineAt: 12 }), 12);
		assert.equal(readDeadline({ deadlineAt: '12' }), null);
		assert.equal(readDeadline({ deadlineAt: Number.NaN }), null);
		assert.equal(readDeadline({}), null);
		assert.equal(readDeadline(undefined), null);
		assert.equal(readDeadline('x'), null);
	});
});

describe('guardDeadline', () => {
	it('runs a call delivered before (or exactly at) its deadline', async () => {
		const clock = manualNow(1_000);
		let ran = 0;
		const guarded = guardDeadline('t.read', async (params: { deadlineAt: number; n: number }) => { ran += 1; return params.n + 1; }, { now: clock.now });
		assert.equal(await guarded({ deadlineAt: 2_000, n: 1 }), 2);
		clock.set(2_000);
		assert.equal(await guarded({ deadlineAt: 2_000, n: 2 }), 3);
		assert.equal(ran, 2);
	});

	it('does NOT run a call delivered after its deadline, and says how late it was', async () => {
		const clock = manualNow(10_000);
		let ran = 0;
		const refused: DeadlineError[] = [];
		const guarded = guardDeadline('t.write', () => { ran += 1; return 'done'; }, { now: clock.now, onRefused: (e) => refused.push(e) });
		await assert.rejects(guarded({ deadlineAt: 9_000 }), (error: unknown) => {
			assert.ok(error instanceof DeadlineError);
			assert.equal(error.reason, 'expired');
			assert.equal(error.op, 't.write');
			assert.equal(error.lateMs, 1_000);
			return true;
		});
		assert.equal(ran, 0);
		assert.equal(refused.length, 1);
	});

	it('refuses a call that carries no deadlineAt as a protocol error (an event named like an op lands here)', async () => {
		let ran = 0;
		const guarded = guardDeadline('t.write', () => { ran += 1; }, { now: () => 0 });
		for (const params of [undefined, {}, { deadlineAt: 'soon' }, 'payload']) {
			await assert.rejects(guarded(params as unknown as { deadlineAt: number }), (error: unknown) => error instanceof DeadlineError && error.reason === 'missing');
		}
		assert.equal(ran, 0);
	});

	it('reports each accepted call before the handler runs', async () => {
		const order: string[] = [];
		const guarded = guardDeadline('t.read', () => { order.push('handler'); }, { now: () => 0, onAccepted: (op) => order.push(`accepted:${op}`) });
		await guarded({ deadlineAt: 1 });
		assert.deepEqual(order, ['accepted:t.read', 'handler']);
	});

	it('passes the handler its params unchanged, deadline included', async () => {
		const seen: unknown[] = [];
		const guarded = guardDeadline('t.read', (params: unknown) => { seen.push(params); }, { now: () => 0 });
		await guarded({ deadlineAt: 5, key: 'k' });
		assert.deepEqual(seen, [{ deadlineAt: 5, key: 'k' }]);
	});
});
