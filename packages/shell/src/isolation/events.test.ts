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

// =============================================================================
// EVENT TESTS — T49 (matching on the pinned shapes) and T111 (gated delivery by ownership)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ENTRY_A, ENTRY_B, GRANT_A, GRANT_B, makeRoot } from './__test__/fixtures';
import type { FakeEventKind } from './__test__/fakeEngine';
import { assertNoReal, clientEvents, lastRun } from './__test__/n1';
import { settle } from './__test__/realm';
import { brief, startRun } from './__test__/util';

const SRC = 'chat_1';

/** The engine event name each kind carries. */
const NAMES: Record<'status' | 'flow' | 'trace' | 'sse', string> = { status: 'apaevt_status_update', flow: 'apaevt_flow', trace: 'apaevt_trace', sse: 'apaevt_sse' };

test('T49 events are matched on body.project_id for the pinned shapes; foreign and unstamped events are dropped and counted', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A, { grant: GRANT_A });
	const B = t.open(ENTRY_B, { grant: GRANT_B });
	const runA = await startRun(A);
	const realA = lastRun(t.cm);
	await startRun(B);

	await tt.test('status, flow, trace and data-pipe SSE events of the own run reach exactly that realm, once', async () => {
		for (const kind of ['status', 'flow', 'trace', 'sse'] as const) {
			const a = clientEvents(A).length;
			const b = clientEvents(B).length;
			t.cm.emitEngineEvent(t.cm.engine.event(kind, { project_id: realA.projectId, source: SRC, pipe_id: 1 }));
			await settle();
			const gotA = clientEvents(A).slice(a);
			assert.equal(gotA.length, 1, `${kind}: exactly one client.event must reach realm A, got ${gotA.length}`);
			assert.equal(gotA[0].event, NAMES[kind], `${kind}: the event name is kept`);
			assert.equal((gotA[0].body as Record<string, unknown>).project_id, runA.projectId, `${kind}: body.project_id is the alias`);
			assert.equal(clientEvents(B).length - b, 0, `${kind}: realm B must receive nothing`);
		}
		assertNoReal(A, t.cm);
		assertNoReal(B, t.cm);
	});

	await tt.test('a foreign project_id, or none, reaches no realm and is counted as dropped', async () => {
		const stats = t.root.__stats;
		assert.equal(typeof stats, 'function', 'the root must expose __stats() for tests');
		const droppedBefore = t.root.__stats!().eventsDropped;
		const a = clientEvents(A).length;
		const b = clientEvents(B).length;
		let sent = 0;
		for (const kind of ['status', 'flow', 'trace', 'sse', 'task', 'dashboard'] as FakeEventKind[]) {
			t.cm.emitEngineEvent(t.cm.engine.event(kind, { project_id: randomUUID(), source: SRC }));
			const unstamped = t.cm.engine.event(kind, { source: SRC });
			delete (unstamped.body as Record<string, unknown>).project_id;
			t.cm.emitEngineEvent(unstamped);
			sent += 2;
		}
		await settle();
		assert.equal(clientEvents(A).length - a, 0, 'realm A receives no foreign or unstamped event');
		assert.equal(clientEvents(B).length - b, 0, 'realm B receives no foreign or unstamped event');
		assert.equal(t.root.__stats!().eventsDropped - droppedBefore, sent, `every unmatched event is counted: ${sent} sent`);
	});
});

test('T111 gated delivery is by ownership: only while attached, per realm, with no monitor needed, scrubbed', async (tt) => {
	await tt.test("realm A gets its run's events only while attached", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		const run = await startRun(A);
		const real = lastRun(t.cm);
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real.projectId, source: SRC, notes: ['hello'] }));
		await settle();
		assert.equal(clientEvents(A).length, 1, `an attached realm gets its owned run's event, got ${clientEvents(A).length}`);
		const body = clientEvents(A)[0].body as Record<string, unknown>;
		assert.equal(body.project_id, run.projectId, "the realm's alias");
		assert.equal(body.userId, GRANT_A.frame!.identity!.userId, "the grant's user alias");
		assertNoReal(A, t.cm);
		A.detach();
		const seen = A.received.length;
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real.projectId, source: SRC }));
		await settle();
		assert.equal(A.received.length, seen, `after detach nothing is delivered, got ${brief(A.received.slice(seen))}`);
	});

	await tt.test("two realms of one app each get only their own run's events", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A1 = t.open(ENTRY_A, { grant: GRANT_A, viewId: 'view-1' });
		const A2 = t.open(ENTRY_A, { grant: GRANT_A, viewId: 'view-2' });
		const run1 = await startRun(A1);
		const real1 = lastRun(t.cm);
		const run2 = await startRun(A2);
		const real2 = lastRun(t.cm);
		t.cm.emitEngineEvent(t.cm.engine.event('status', { project_id: real1.projectId, source: SRC }));
		t.cm.emitEngineEvent(t.cm.engine.event('flow', { project_id: real2.projectId, source: SRC }));
		t.cm.emitEngineEvent(t.cm.engine.event('trace', { project_id: real2.projectId, source: SRC }));
		await settle();
		const got1 = clientEvents(A1);
		const got2 = clientEvents(A2);
		assert.equal(got1.length, 1, `realm 1 gets its own run's one event, got ${got1.length}`);
		assert.equal(got2.length, 2, `realm 2 gets its own run's two events, got ${got2.length}`);
		assert.ok(
			got1.every((e) => (e.body as Record<string, unknown>).project_id === run1.projectId),
			'realm 1 sees its own alias only'
		);
		assert.ok(
			got2.every((e) => (e.body as Record<string, unknown>).project_id === run2.projectId),
			'realm 2 sees its own alias only'
		);
		assertNoReal(A1, t.cm);
		assertNoReal(A2, t.cm);
	});

	await tt.test("delivery needs no monitor: an owned run's events arrive without client.addMonitor", async () => {
		const t = makeRoot();
		tt.after(() => t.cleanup());
		const A = t.open(ENTRY_A, { grant: GRANT_A });
		await startRun(A);
		const real = lastRun(t.cm);
		assert.equal(t.cm.engine.monitorCalls.length, 0, 'the realm added no monitor');
		t.cm.emitEngineEvent(t.cm.engine.event('sse', { project_id: real.projectId, source: SRC, pipe_id: 3 }));
		await settle();
		assert.equal(clientEvents(A).length, 1, `delivery is by ownership, not by subscription, got ${clientEvents(A).length}`);
	});
});
