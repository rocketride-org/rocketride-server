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
// EXPLORER DEV TOOL — REPLY (tool failures are data across the op lane, R3)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from '../errors';
import { codedError } from '../connect/testing';
import { EXPLORER_ERROR_KINDS, asReply, fromReply, isLaneTimeoutText, isReply, replyOk, replying, toReply } from './reply';
import type { Reply } from './reply';
import { assertJsonSafe } from './testing';

/** What crosses the wire: a JSON round trip (VS Code webviews postMessage the reply). */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('toReply — the controller side', () => {
	it('wraps a value', async () => {
		const reply = await toReply(async () => ({ rows: [[1, 'a']] }));
		assert.deepEqual(reply, { ok: true, value: { rows: [[1, 'a']] } });
		assertJsonSafe(reply);
	});

	it('turns an ExplorerToolError into data with kind, code, tool and message intact', async () => {
		const original = new ExplorerToolError({ kind: 'raised', tool: 'execute', code: 'TASK_STOPPED', message: 'Task stopped\nThe pipeline was restarted' });
		const reply = await toReply(() => { throw original; });
		assert.deepEqual(reply, {
			ok: false,
			error: { kind: 'raised', code: 'TASK_STOPPED', tool: 'execute', message: 'Task stopped\nThe pipeline was restarted', detail: 'The pipeline was restarted' },
		});
		assertJsonSafe(reply);
	});

	it("classifies the op lane's own timeout text (toolOps.ts) as kind timeout, keeping the message", async () => {
		const message = "'graph.readQuery' did not answer within 70s; the controller may still be executing it.";
		const reply = await toReply(() => { throw new Error(message); });
		assert.deepEqual(reply, { ok: false, error: { kind: 'timeout', message } });
	});

	it("classifies the bus lane's timeout texts (local, bridged, routed) as kind timeout", async () => {
		for (const message of [
			"Op 'client.tool' timed out after 66000ms",
			"Op 'client.tool' timed out after 66000ms (bridged)",
			"Op 'client.getTasks' timed out after 30000ms (routed to VS Code host)",
		]) {
			const reply = await toReply(() => { throw new Error(message); }, { tool: 'get_schema' });
			assert.deepEqual(reply, { ok: false, error: { kind: 'timeout', message, tool: 'get_schema' } }, message);
		}
	});

	it('does not mistake prose that merely mentions a timeout for a lane timeout', () => {
		assert.equal(isLaneTimeoutText('The database said: statement timed out after 30000ms'), false);
		assert.equal(isLaneTimeoutText("ERROR: canceling statement due to statement timeout; 'x' did not answer within 5s"), false);
		assert.equal(isLaneTimeoutText("'sql.execute' did not answer within 12s; the controller may still be executing it."), true);
	});

	it('classifies the brokered not-connected text (clientOps.ts) as unavailable', async () => {
		const reply = await toReply(() => { throw new Error('Not connected to server'); });
		assert.deepEqual(reply, { ok: false, error: { kind: 'unavailable', message: 'Not connected to server' } });
	});

	it('keeps any other transport failure as raised with its message, and a code only when the SDK preserved one', async () => {
		const plain = await toReply(() => { throw new Error('Op failed at the root'); });
		assert.deepEqual(plain, { ok: false, error: { kind: 'raised', message: 'Op failed at the root' } });
		const coded = await toReply(() => { throw codedError('Permission denied for task.data', 'FORBIDDEN'); });
		assert.deepEqual(coded, { ok: false, error: { kind: 'raised', code: 'FORBIDDEN', message: 'Permission denied for task.data' } });
	});

	it('never invents a code from message text (R10)', async () => {
		const reply = await toReply(() => { throw new Error('TASK_STOPPED: the task is not running'); });
		assert.equal(reply.ok, false);
		assert.equal((reply as Extract<Reply<never>, { ok: false }>).error.code, undefined);
	});

	it('rethrows programming errors instead of turning them into data', async () => {
		for (const error of [new TypeError('x is not a function'), new ReferenceError('y is not defined'), new RangeError('bad length'), new SyntaxError('Unexpected token')]) {
			await assert.rejects(toReply(() => { throw error; }), (thrown) => thrown === error);
		}
	});

	it('names the tool it was told for a foreign failure, but never overrides the tool an ExplorerToolError names', async () => {
		const foreign = await toReply(() => { throw new Error('boom'); }, { tool: 'get_query' });
		assert.deepEqual(foreign, { ok: false, error: { kind: 'raised', message: 'boom', tool: 'get_query' } });
		const own = await toReply(() => { throw new ExplorerToolError({ kind: 'invalid', tool: 'get_data', message: 'bad' }); }, { tool: 'get_query' });
		assert.deepEqual(own, { ok: false, error: { kind: 'invalid', tool: 'get_data', message: 'bad' } });
	});

	it('keeps a finite retryAfterS the failure carries, and drops anything else', async () => {
		const limited = await toReply(() => { throw Object.assign(new Error('Too many requests'), { retryAfterS: 12 }); });
		assert.deepEqual(limited, { ok: false, error: { kind: 'raised', message: 'Too many requests', retryAfterS: 12 } });
		const junk = await toReply(() => { throw Object.assign(new Error('Too many requests'), { retryAfterS: Number.POSITIVE_INFINITY }); });
		assert.deepEqual(junk, { ok: false, error: { kind: 'raised', message: 'Too many requests' } });
	});

	it('a void op answers Reply<null>: undefined becomes null, so the reply survives JSON', async () => {
		const reply = await toReply(async () => { /* a void mutation: save, delete, historyEdit */ });
		assert.deepEqual(reply, { ok: true, value: null });
		assertJsonSafe(reply);
		assert.deepEqual(replyOk(undefined), { ok: true, value: null });
		assert.equal(fromReply(wire(reply)), null);
	});

	it('replying() turns a handler into a Reply-returning handler', async () => {
		const handler = replying(async ({ n }: { n: number }) => {
			if (n < 0) throw new ExplorerToolError({ kind: 'invalid', tool: 'get_data', message: 'negative' });
			return n * 2;
		});
		assert.deepEqual(await handler({ n: 2 }), { ok: true, value: 4 });
		assert.deepEqual(await handler({ n: -1 }), { ok: false, error: { kind: 'invalid', tool: 'get_data', message: 'negative' } });
	});
});

describe('asReply — what the controller makes of a handler result', () => {
	it('passes a Reply through (undefined value: null) and wraps anything else, a plain result with an `ok` field included', () => {
		assert.deepEqual(asReply({ ok: true, value: 3 }), { ok: true, value: 3 });
		assert.deepEqual(asReply({ ok: true, value: undefined }), { ok: true, value: null });
		const failed = { ok: false, error: { kind: 'invalid', message: 'bad' } };
		assert.equal(asReply(failed), failed);
		assert.deepEqual(asReply(undefined), { ok: true, value: null });
		assert.deepEqual(asReply([1]), { ok: true, value: [1] });
		// A probe result (connect/store IProbeResult) is data, not a Reply.
		const probe = { ok: true, info: { dialect: 'postgres' }, dialect: 'postgres' };
		assert.deepEqual(asReply(probe), { ok: true, value: probe });
		const failedProbe = { ok: false, info: null, dialect: null, error: { kind: 'timeout', message: 'slow' } };
		assert.deepEqual(asReply(failedProbe), { ok: true, value: failedProbe });
		assert.deepEqual(asReply({ ok: true }), { ok: true, value: { ok: true } });
	});

	it('the two reserved shapes, and the escape for a domain value that has one: return replyOk(value)', () => {
		const domain = { ok: true, value: 5 };
		assert.deepEqual(asReply(domain), { ok: true, value: 5 }, 'a bare {ok, value} is taken for a Reply (documented)');
		assert.deepEqual(asReply(replyOk(domain)), { ok: true, value: domain }, 'wrapped explicitly, it arrives whole');
		const record = { ok: false, error: { kind: 'raised', message: 'syntax error' } };
		assert.equal(asReply(record).ok, false, 'a bare {ok:false, error} is a failure (documented)');
		assert.deepEqual(asReply(replyOk(record)), { ok: true, value: record });
	});
});

describe('fromReply — the frame side', () => {
	it('returns the value of an ok reply', () => {
		assert.deepEqual(fromReply(wire(replyOk({ a: 1 }))), { a: 1 });
	});

	it('rebuilds a REAL ExplorerToolError equal to the original, for every kind, after a JSON round trip', async () => {
		for (const kind of EXPLORER_ERROR_KINDS) {
			const original = new ExplorerToolError({ kind, tool: 'get_schema', code: 'SOME_CODE', message: `Failed (${kind})\nDatabase said: no` });
			const reply = wire(await toReply(() => { throw original; }));
			assertJsonSafe(reply);
			assert.throws(() => fromReply(reply), (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError, 'a real ExplorerToolError');
				assert.deepEqual(error, original);
				assert.equal(error.kind, original.kind);
				assert.equal(error.code, original.code);
				assert.equal(error.tool, original.tool);
				assert.equal(error.message, original.message);
				assert.equal(error.headline, original.headline);
				assert.equal(error.detail, original.detail);
				return true;
			});
		}
	});

	it('names the op as the tool when the error names none', () => {
		assert.throws(() => fromReply({ ok: false, error: { kind: 'timeout', message: 'slow' } }, { tool: 'graph.readQuery' }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.tool, 'graph.readQuery');
			assert.equal(error.kind, 'timeout');
			return true;
		});
	});

	it("reads a success whose value was lost on the wire (an older controller's void op) as null", () => {
		assert.equal(fromReply(wire({ ok: true, value: undefined }) as unknown as Reply<null>), null);
	});

	it('carries retryAfterS onto the rebuilt error', () => {
		assert.throws(() => fromReply({ ok: false, error: { kind: 'raised', message: 'Too many requests', retryAfterS: 3 } }), (error: unknown) => {
			assert.equal((error as { retryAfterS?: number }).retryAfterS, 3);
			return true;
		});
	});

	it('throws a protocol error, never an ExplorerToolError, for something that is not a Reply', () => {
		// `{ ok: true }` is NOT here: it is a void success whose null value JSON dropped (see above).
		for (const bad of [undefined, null, 42, { ok: 'yes' }, { ok: false }, { ok: false, error: { kind: 'nope', message: 'x' } }, { ok: false, error: { kind: 'raised' } }]) {
			assert.throws(() => fromReply(bad as unknown as Reply<unknown>), (error: unknown) => error instanceof Error && !(error instanceof ExplorerToolError), JSON.stringify(bad));
		}
	});

	it('recognises a Reply', () => {
		assert.equal(isReply({ ok: true, value: 1 }), true);
		assert.equal(isReply({ ok: true, value: undefined }), true);
		assert.equal(isReply({ ok: false, error: { kind: 'stale', message: 'm' } }), true);
		assert.equal(isReply({ ok: false, error: { kind: 'stale' } }), false);
		assert.equal(isReply({ ok: true }), true, 'JSON drops an undefined value; the success is still a Reply');
		assert.equal(isReply('ok'), false);
	});
});
