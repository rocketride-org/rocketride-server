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
// SQL-UI — THE WRITE PATH, THROUGH THE CONTROLLER (authority layer) END TO END
// =============================================================================
//
// Cases a reviewer asks about when rows are edited, each pinned where it lives:
//
//   controller (here)   a later statement fails (a foreign-key violation): the
//                       transaction rolls back, nothing after it is sent, and
//                       the database's words come back verbatim; a statement
//                       that matches no row (a stale snapshot) rolls back; a
//                       commit that may have run is `unknown` and is never
//                       sent again; two applies are two transactions (the
//                       controller never merges or replays one);
//   pure statements     quoted identifiers, bound values, NULLs, missing and
//                       lossy keys, composite keys: rowEdits.test.ts;
//   staging model       edits merging, FK links, rollback leaving edits
//                       staged: rowEdits.test.ts, recordDrawer.test.ts;
//   views (patterns)    Apply and Confirm are disabled while an apply runs,
//                       and the table and its total are read again after a
//                       write that ran or may have run.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { PIPELINE, postgres, rig, toolRequests } from './devtoolRig';

const SRC = path.resolve(__dirname, '..', 'src');
const FK_TEXT = 'ERROR: insert or update on table "orders" violates foreign key constraint "orders_customer_fk"';

const EDITS = [
	{ sql: 'UPDATE "orders" SET "status" = $1 WHERE "order_id" = $2', params: ['paid', 5], expect: 1 },
	{ sql: 'UPDATE "orders" SET "customer_id" = $1 WHERE "order_id" = $2', params: [999, 6], expect: 1 },
];

/** A postgres node whose tool answers are scripted per tool. */
function node(over: Record<string, (input: Record<string, unknown> | undefined) => unknown>) {
	return (params: { tool: string; input?: Record<string, unknown> }): unknown => {
		const mine = over[params.tool];
		if (mine) return mine(params.input);
		if (params.tool === 'dialect') return { dialect: 'postgres' };
		if (params.tool === 'begin') return { session_id: 'tx-1' };
		if (params.tool === 'commit' || params.tool === 'rollback') return { ok: true };
		if (params.tool === 'execute') return { rows: [], affected_rows: 1 };
		return postgres(params);
	};
}

/** Apply through the frame, as a document does. */
function apply(r: Awaited<ReturnType<typeof rig>>, statements: typeof EDITS, atomic = true) {
	return r.frame.caller.callReply('sql.applyBatch', { connId: 'c-pipe', owner: r.frame.owner(), statements, atomic }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.applyBatch'] });
}

describe('write path: a later statement fails', () => {
	it('a foreign-key violation on the second statement rolls the first back: no commit, nothing after, the database\'s words verbatim', async () => {
		let executes = 0;
		const r = await rig({ tool: node({ execute: () => { executes += 1; if (executes === 2) throw new Error(FK_TEXT); return { rows: [], affected_rows: 1 }; } }) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const result = await apply(r, EDITS);
			assert.equal(result.failure?.message.includes(FK_TEXT), true, 'the database said no, in its own words');
			assert.equal(result.failure?.committed, 0, 'nothing is committed');
			assert.equal(result.failure?.rollbackConfirmed, true);
			assert.deepEqual(['begin', 'commit', 'rollback'].map((tool) => toolRequests(r.engine, tool).length), [1, 0, 1]);
			assert.equal(toolRequests(r.engine, 'execute').length, 2, 'both statements were sent once; none after the failure');
		} finally {
			r.dispose();
		}
	});

	it('a stale row snapshot (the statement matched no row) rolls everything back, and is not committed', async () => {
		let executes = 0;
		const r = await rig({ tool: node({ execute: () => { executes += 1; return { rows: [], affected_rows: executes === 2 ? 0 : 1 }; } }) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const result = await apply(r, EDITS);
			assert.ok(result.failure !== null, 'the changed-by-someone-else row fails the apply');
			assert.equal(result.failure?.committed, 0);
			assert.equal(toolRequests(r.engine, 'commit').length, 0);
			assert.equal(toolRequests(r.engine, 'rollback').length, 1);
		} finally {
			r.dispose();
		}
	});
});

describe('write path: an outcome that may have run is never sent again', () => {
	it('a commit that timed out is `unknown`; commit and begin were each sent once, and nothing is retried', async () => {
		const r = await rig({ tool: node({
			commit: () => { throw new ExplorerToolError({ kind: 'timeout', tool: 'commit', message: 'Stopped waiting for commit after 60 s.' }); },
			rollback: () => { throw new Error('unknown or expired transaction session: tx-1'); },
		}) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const result = await apply(r, EDITS);
			assert.equal(result.failure?.unknown, true);
			await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
			assert.deepEqual(['begin', 'commit'].map((tool) => toolRequests(r.engine, tool).length), [1, 1], 'no automatic retry');
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('two applies are two transactions: the controller never merges, dedupes or replays one', async () => {
		const r = await rig({ tool: node({}) });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			await apply(r, EDITS);
			await apply(r, EDITS);
			assert.deepEqual(['begin', 'commit'].map((tool) => toolRequests(r.engine, tool).length), [2, 2]);
		} finally {
			r.dispose();
		}
	});
});

describe('write path: the views', () => {
	const view = fs.readFileSync(path.join(SRC, 'views', 'TableDataView.tsx'), 'utf8');

	it('Apply and its confirmation are disabled while an apply runs (a duplicate click sends nothing)', () => {
		assert.match(view, /if \(applying\) return 'An apply is running\.';/);
		assert.match(view, /confirmDisabled=\{applying\}/);
		assert.match(view, /disabled=\{editGate !== null \|\| applying\}/);
	});

	it('after a write that ran or may have run, the open row is dropped and the page and its total are read again', () => {
		assert.match(view, /setOpenRow\(null\);\s*setWriteEpoch\(\(n\) => n \+ 1\);/);
		assert.match(view, /result\.failure === null \|\| settled > 0 \|\| result\.failure\.unknown/);
	});

	it('a thrown apply that may have run keeps the edits staged and blocks Apply until Review SQL', () => {
		assert.match(view, /setUncertain\('blocked'\)/);
		assert.match(view, /They stay staged: open Review SQL before you apply again\./);
	});
});
