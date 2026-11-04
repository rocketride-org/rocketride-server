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
// SQL-UI — THE CONNECTION'S SAFETY LEVEL IS ENFORCED BY THE CONTROLLER (D6-SQL-1)
// =============================================================================
//
// The level was enforced only by the document's own prompt: a direct
// `sql.execute` of `DROP TABLE` reached the node at level `every`, and a
// direct `sql.setConnectionSafety` to `off` was stored. Now the authority
// layer (the controller in a dev tool, the core in the full app) does it:
//
//   - a statement that asks at the connection's level (the same classifier
//     the document uses) is refused unless the call says the document's own
//     confirmation flow ran (`confirmed`); an apply likewise;
//   - a LOWER level is accepted only with a one-time ticket the controller
//     issued for that connection and that level (`sql.requestSafetyDowngrade`),
//     which the document asks for only after its downgrade dialog; a plain
//     `sql.setConnectionSafety` or a saved record that lowers it is refused.
//
// This is a guard against unconfirmed and forged operations, not a database
// security boundary: classification is a check on statement text, and a
// document that sets `confirmed` itself is trusted as the user's own.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { getSavedConnections } from '../src/connect';
import { safetyLevelOf } from '../src/connect/savedConnections';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { createSqlCore } from '../src/sqlCore';
import { taskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import { PIPELINE, postgres, rig, toolRequests } from './devtoolRig';
import type { IRig } from './devtoolRig';

const STRICT = { ...PIPELINE, safety: 'every' as const };
const OFF = { ...PIPELINE, safety: 'off' as const };

/** A frame op, as a forged or plain caller sends it. */
function op(r: IRig, name: string, params: Record<string, unknown>) {
	const timeoutMs = (SQL_OP_TIMEOUT_MS as Record<string, number>)[name] ?? 60_000;
	return (r.frame.caller as unknown as { callReply(op: string, params: unknown, opts: { timeoutMs: number }): Promise<unknown> }).callReply(name, params, { timeoutMs });
}

const executed = (r: IRig, before = 0): number => toolRequests(r.engine, 'execute').length - before;
const levelOf = (): string => safetyLevelOf(getSavedConnections().find((c) => c.id === 'c-pipe'));
const refused = (error: unknown): boolean => error instanceof ExplorerToolError && error.kind === 'invalid';

describe('execute: a statement that asks at the connection\'s level is refused unless confirmed', () => {
	it('level every: an unconfirmed DROP TABLE is refused and never reaches the node; confirmed, it runs', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			await assert.rejects(op(r, 'sql.execute', { connId: 'c-pipe', sql: 'DROP TABLE orders' }), refused);
			assert.equal(executed(r), 0, 'nothing reached the node');
			await op(r, 'sql.execute', { connId: 'c-pipe', sql: 'DROP TABLE orders', confirmed: true });
			assert.equal(executed(r), 1);
		} finally {
			r.dispose();
		}
	});

	it('level risky (the default): an unconfirmed DELETE with no WHERE is refused; a read is not asked about', async () => {
		const r = await rig({ tool: postgres });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			await assert.rejects(op(r, 'sql.execute', { connId: 'c-pipe', sql: 'DELETE FROM orders' }), refused);
			assert.equal(executed(r), 0);
			await op(r, 'sql.execute', { connId: 'c-pipe', sql: 'SELECT * FROM orders', idempotent: true });
			assert.equal(executed(r), 1, 'a read runs without a confirmation');
		} finally {
			r.dispose();
		}
	});

	it('level off: nothing asks', async () => {
		const r = await rig({ saved: [OFF], tool: postgres });
		try {
			await r.env.resolveEndpoint(OFF);
			await op(r, 'sql.execute', { connId: 'c-pipe', sql: 'DROP TABLE orders' });
			assert.equal(executed(r), 1);
		} finally {
			r.dispose();
		}
	});

	it('an apply whose statements ask is refused unless confirmed, before any transaction is begun', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			const statements = [{ sql: 'DELETE FROM orders WHERE id = $1', params: [5], expect: 1 }];
			await assert.rejects(op(r, 'sql.applyBatch', { connId: 'c-pipe', owner: r.frame.owner(), statements, atomic: true }), refused);
			assert.equal(toolRequests(r.engine, 'begin').length, 0, 'no transaction was begun');
			await op(r, 'sql.applyBatch', { connId: 'c-pipe', owner: r.frame.owner(), statements, atomic: true, confirmed: true });
			assert.equal(toolRequests(r.engine, 'begin').length, 1);
		} finally {
			r.dispose();
		}
	});
});

describe('a lower safety level needs a ticket the controller issued', () => {
	it('a plain sql.setConnectionSafety to a lower level is refused and the stored level is unchanged; a higher one is accepted', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			await until(() => getSavedConnections().length === 1, 'the list');
			await assert.rejects(op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'off', owner: r.frame.owner() }), refused);
			assert.equal(levelOf(), 'every');
			await assert.rejects(op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'risky', owner: r.frame.owner() }), refused);
			assert.equal(levelOf(), 'every');
		} finally {
			r.dispose();
		}
	});

	it('raising needs no ticket', async () => {
		const r = await rig({ tool: postgres });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			await op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'every', owner: r.frame.owner() });
			assert.equal(levelOf(), 'every');
		} finally {
			r.dispose();
		}
	});

	it('with a ticket for that connection and level it is accepted, once; the ticket cannot be reused or used for another level below it', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			const owner = r.frame.owner();
			const issued = await op(r, 'sql.requestSafetyDowngrade', { connId: 'c-pipe', safety: 'risky', owner }) as { ticket: string };
			assert.equal(typeof issued.ticket, 'string');
			// Not for a deeper downgrade than the one asked for.
			await assert.rejects(op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'off', owner, ticket: issued.ticket }), refused);
			assert.equal(levelOf(), 'every');
			// A refused attempt (the wrong level) leaves the ticket; a right one spends it.
			const again = await op(r, 'sql.requestSafetyDowngrade', { connId: 'c-pipe', safety: 'risky', owner }) as { ticket: string };
			await op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'risky', owner, ticket: again.ticket });
			assert.equal(levelOf(), 'risky');
			await op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'every', owner });
			await assert.rejects(op(r, 'sql.setConnectionSafety', { connId: 'c-pipe', safety: 'risky', owner, ticket: again.ticket }), refused);
			assert.equal(levelOf(), 'every', 'a spent ticket does nothing');
		} finally {
			r.dispose();
		}
	});

	it('a ticket is bound to the account and the connection, and a request that is not a downgrade gets none', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			const owner = r.frame.owner();
			await assert.rejects(op(r, 'sql.requestSafetyDowngrade', { connId: 'c-pipe', safety: 'every', owner }), refused);
			await assert.rejects(op(r, 'sql.requestSafetyDowngrade', { connId: 'c-pipe', safety: 'off', owner: 'someone-else|org|team' }), (error: unknown) => (error as { kind?: string }).kind === 'stale');
			await assert.rejects(op(r, 'sql.requestSafetyDowngrade', { connId: 'nope', safety: 'off', owner }), refused);
		} finally {
			r.dispose();
		}
	});

	it('a saved record that lowers the level is refused without a ticket (the editor cannot be a way around it); with one it is saved; a new connection may start at any level', async () => {
		const r = await rig({ saved: [STRICT], tool: postgres });
		try {
			await r.env.resolveEndpoint(STRICT);
			const owner = r.frame.owner();
			await assert.rejects(op(r, 'sql.saveConnection', { connection: { ...PIPELINE, name: 'Renamed', safety: 'off' }, owner }), refused);
			assert.equal(levelOf(), 'every');
			assert.equal(getSavedConnections().find((c) => c.id === 'c-pipe')?.name, 'Orders', 'nothing of the record changed');
			const issued = await op(r, 'sql.requestSafetyDowngrade', { connId: 'c-pipe', safety: 'off', owner }) as { ticket: string };
			await op(r, 'sql.saveConnection', { connection: { ...PIPELINE, name: 'Renamed', safety: 'off' }, owner, safetyTicket: issued.ticket });
			assert.equal(levelOf(), 'off');
			await op(r, 'sql.saveConnection', { connection: { ...PIPELINE, id: 'c-new', name: 'Fresh', safety: 'off' }, owner });
			assert.equal(getSavedConnections().some((c) => c.id === 'c-new'), true);
		} finally {
			r.dispose();
		}
	});
});

describe('a downgrade ticket expires', () => {
	it('a ticket used after its 5-minute lifetime is refused and changes nothing; one used just inside it is accepted', async () => {
		const engine = scriptedClientRealm(engineScript([STRICT], [taskRow('p1')], postgres));
		let now = 1_000_000;
		const core = createSqlCore({ ...engine.source, mode: 'app', focusTarget: null, now: () => now });
		engine.realm.login(USER);
		try {
			await until(() => core.identity.get().known, 'the identity');
			await until(() => getSavedConnections().length === 1, 'the list');
			const stale = await core.issueSafetyTicket('c-pipe', 'risky');
			now += 5 * 60_000 + 1;
			await assert.rejects(core.setConnectionSafety('c-pipe', 'risky', undefined, stale), (error: unknown) => error instanceof ExplorerToolError && error.code === 'safety-downgrade-unconfirmed');
			assert.equal(levelOf(), 'every', 'the expired ticket changed nothing');
			const fresh = await core.issueSafetyTicket('c-pipe', 'risky');
			now += 5 * 60_000 - 1;
			await core.setConnectionSafety('c-pipe', 'risky', undefined, fresh);
			assert.equal(levelOf(), 'risky', 'just inside the lifetime it is accepted');
		} finally {
			core.dispose();
		}
	});
});
