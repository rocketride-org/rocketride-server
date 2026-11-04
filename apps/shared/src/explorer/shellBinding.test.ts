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

// =============================================================================
// EXPLORER — SHELL BINDING: identity changes in a MIRRORED realm (DA-R1-05)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointStore } from './connect/store';
import { fakeWorld, manualClock, row } from './connect/testing';
import { account, createFakeMirroredRealm, settle } from './devtool/testing';
import { createShellWatch, readTaskEvent } from './shellBinding';
import type { IShellWatchBus } from './shellBinding';
import { SINGLE_TOOLS_ROLE } from './types';
import { identityFromConnectResult } from './connect/identity';

describe('createShellWatch — a sign-out or an account switch resets the store in a mirrored realm', () => {
	it('the shell never emits login / logout / org events there; the root\'s account topic going null and then B arriving does it', async () => {
		const realm = createFakeMirroredRealm();
		realm.root.connect(account('user-a', 'org-1', 'team-1'));
		await settle();
		const world = fakeWorld([row({ ownerId: 'user-a', teamId: 'team-1' })]);
		const clock = manualClock();
		const store = createEndpointStore({ providers: new Set(['db_postgres']), roles: SINGLE_TOOLS_ROLE, tools: {}, clock });
		const bus = realm.cm as unknown as IShellWatchBus;
		const detach = store.attach(world.client, identityFromConnectResult(account('user-a', 'org-1', 'team-1')), createShellWatch(world.client, bus));
		await settle();
		realm.emit('shell:connected', undefined); // the first discovery, as a reconnect asks for it
		await clock.advance(1_000);
		assert.equal(store.getState().endpoints.length, 1, 'discovered under A');

		// Sign-out as the VS Code root reports it: status false, then a null account the realm manager IGNORES.
		realm.root.disconnect();
		await settle();
		await clock.advance(1_000);
		assert.deepEqual(realm.events.filter((event) => ['shell:login', 'shell:logout', 'shell:orgChanged'].includes(event)), [], 'no login / logout / org event ever fired in this realm');
		assert.equal(store.getState().endpoints.length, 0, 'the store was reset for "nobody"');

		// B signs in: the store resets for B and discovers B's runs.
		world.rows = [row({ ownerId: 'user-b', teamId: 'team-1' })];
		realm.root.connect(account('user-b', 'org-1', 'team-1'));
		await settle();
		await clock.advance(1_000);
		assert.equal(store.getState().endpoints.length, 1);
		assert.equal(store.getState().endpoints[0].ownerId, 'user-b', 'only B\'s runs');
		detach();
	});
});

describe('readTaskEvent — an apaevt_task message as the store reads it', () => {
	it('ignores anything that is not an apaevt_task event', () => {
		assert.equal(readTaskEvent(null), null);
		assert.equal(readTaskEvent('apaevt_task'), null);
		assert.equal(readTaskEvent({ event: 'apaevt_status_update', body: { state: 3, project_id: 'p1', source: 'ingest_1' } }), null);
	});

	it('names the task a begin or a restart started, and asks a restart for a re-probe', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', name: 'x.ingest_1.Ingest', projectId: 'p1', source: 'ingest_1', beginSeq: 4 } }), { reprobe: false, started: { projectId: 'p1', source: 'ingest_1' } });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'restart', projectId: 'p1', source: 'tools_1' } }), { reprobe: true, started: { projectId: 'p1', source: 'tools_1' } });
	});

	it('names the task an end stopped', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'end', projectId: 'p1', source: 'ingest_1', reason: 'user' } }), { reprobe: false, ended: { projectId: 'p1', source: 'ingest_1' } });
	});

	it('reads the stamped project_id when projectId is absent, and names no task when the body cannot say which', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', project_id: 'p2', source: 'chat_1' } }), { reprobe: false, started: { projectId: 'p2', source: 'chat_1' } });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', source: 'ingest_1' } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'begin', projectId: 'p1', source: '' } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'restart', projectId: 7, source: 'tools_1' } }), { reprobe: true });
	});

	it('only asks for a refresh on the running snapshot or a body it cannot read', () => {
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: { action: 'running', tasks: [{ projectId: 'p1', source: 'tools_1' }] } }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task' }), { reprobe: false });
		assert.deepEqual(readTaskEvent({ event: 'apaevt_task', body: 'begin' }), { reprobe: false });
	});
});
