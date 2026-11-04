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
// SQL-UI — EVENTS NEVER RUN OPS; EVERY MUTATING HANDLER CHECKS ITS OWN AUTHORITY
// =============================================================================
//
// The channel answers a plain event through the op registry when the event is
// named like an op, so a frame's event could otherwise run a mutating handler
// (and it is delivered twice: live, then through the retained slot). So:
//
//   - SQL's event names and op names are disjoint (`assertNoOpEventCollisions`);
//   - the controller is told its events, and refuses an event-delivered call
//     even when it carries a deadline;
//   - a mutating handler checks the caller's account itself, whatever the UI
//     showed.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoOpEventCollisions } from 'shared/explorer/devtool/controller';
import { settle } from 'shared/explorer/devtool/testing';
import { getSavedConnections } from '../src/connect';
import { SQL_EVENT_NAMES } from '../src/ops';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { until } from './realm';
import { PIPELINE, rig } from './devtoolRig';

/** The op names, read from the protocol file. */
const OPS = [...fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ops.ts'), 'utf8').matchAll(/'(sql\.[a-zA-Z]+)': ToolOpSpec/g)].map((m) => m[1] as string);

describe('SQL ops and events', () => {
	it('every op has a frame budget, and no event is named like an op', () => {
		assert.ok(OPS.length >= 15, 'the op list was read');
		assert.deepEqual([...OPS].sort(), Object.keys(SQL_OP_TIMEOUT_MS).sort(), 'every op has a frame timeout (and so a controller budget)');
		assert.deepEqual(assertNoOpEventCollisions(OPS, SQL_EVENT_NAMES), []);
	});

	it('a frame EVENT named like a mutating op runs nothing, even with a deadline and the right account', async () => {
		const refused: Array<{ reason?: string }> = [];
		const r = await rig({ onRefused: (error) => refused.push(error as { reason?: string }) });
		try {
			await until(() => getSavedConnections().length === 2, 'the saved list');
			const owner = r.frame.owner();
			const ahead = Date.now() + 60_000;
			const channel = r.frame.channel as unknown as { sendEvent(name: string, payload: unknown): void };
			channel.sendEvent('sql.deleteConnection', { connId: PIPELINE.id, owner, deadlineAt: ahead });
			channel.sendEvent('sql.saveConnection', { connection: { ...PIPELINE, id: 'evil', name: 'Evil' }, owner, deadlineAt: ahead });
			await settle();
			await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
			assert.ok(getSavedConnections().some((c) => c.id === PIPELINE.id), 'the delete event did not run');
			assert.equal(getSavedConnections().some((c) => c.id === 'evil'), false, 'the save event did not run');
		} finally {
			r.dispose();
		}
	});

	it('a mutating op from a frame of another account is refused by the handler itself', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the saved list');
			await assert.rejects(
				r.frame.caller.callReply('sql.deleteConnection', { connId: PIPELINE.id, owner: 'someone-else|org|team' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] }),
				(error: unknown) => (error as { kind?: string }).kind === 'stale',
			);
			assert.ok(getSavedConnections().some((c) => c.id === PIPELINE.id), 'nothing was deleted');
			await assert.rejects(
				r.frame.caller.callReply('sql.saveConnection', { connection: { ...PIPELINE, name: 'Hijack' }, owner: null }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] }),
				(error: unknown) => ['stale', 'unavailable'].includes((error as { kind?: string }).kind ?? ''),
			);
			assert.equal(getSavedConnections().find((c) => c.id === PIPELINE.id)?.name, PIPELINE.name, 'nothing was renamed');
		} finally {
			r.dispose();
		}
	});
});
