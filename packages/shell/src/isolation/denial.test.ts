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
// DENIAL TESTS — T29
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { rehydrateError } from '../connection/errorWire';
import type { IWireEnvelope, IWireError } from '../connection/errorWire';
import { CapabilityDeniedError } from './capabilityDenied';
import { ENTRY_A, makeRoot } from './__test__/fixtures';
import { clientRequest, dap, settle } from './__test__/realm';
import { assertDenied, assertDeniedOp, brief, denialOf, startRun } from './__test__/util';

const ALLOWED_FIELDS = ['code', 'op', 'command', 'subcommand', 'capability'];

test('T29 denials are values with no stack and allowlisted fields; backstop denials keep the request id', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const A = t.open(ENTRY_A);
	const engine = t.cm.engine;

	// A denied client.request resolves to a hand-built envelope.
	const envelope = (await clientRequest(A, dap('rrext_services', {}))) as IWireEnvelope;
	assertDenied(envelope, ['capability', 'unknown_op'], 'rrext_services');
	const wire = (envelope as { error: IWireError }).error;
	assert.equal(wire.__rrerr, true);
	assert.equal(typeof wire.message, 'string');
	assert.ok(!('stack' in wire) || wire.stack === undefined, 'a denial carries no stack');
	for (const k of Object.keys(wire.fields)) assert.ok(ALLOWED_FIELDS.includes(k), `unexpected denial field ${k}`);
	const err = rehydrateError(wire);
	assert.ok(err instanceof CapabilityDeniedError, 'rehydrateError must rebuild a CapabilityDeniedError');
	assert.equal((err as CapabilityDeniedError).code, wire.fields.code);

	// An engine failure response is data; a thrown engine error loses its stack and extra fields.
	const run = await startRun(A);
	engine.fail('terminate', 'boom');
	const failed = (await clientRequest(A, dap('terminate', { token: run.token }))) as { ok: boolean; value?: { success?: boolean; message?: string } };
	assert.equal(failed.ok, true);
	assert.equal(failed.value?.message, 'boom');
	const thrown = new Error('engine blew up');
	thrown.name = 'DAPException';
	Object.assign(thrown, { code: 'E1', dapResult: { token: 'x' }, internalPath: '/srv/engine' });
	engine.throwNext('rrext_ping', thrown);
	const out = (await clientRequest(A, dap('rrext_ping'))) as IWireEnvelope;
	const d = denialOf(out);
	assert.ok(d, `an engine exception must arrive as an error envelope, got ${brief(out)}`);
	const w2 = (out as { error: IWireError }).error;
	assert.ok(!('stack' in w2) || w2.stack === undefined, `a thrown engine error must lose its stack, got ${brief(w2.stack)}`);
	for (const k of Object.keys(w2.fields)) assert.ok(ALLOWED_FIELDS.includes(k), `engine error field ${k} must be dropped`);

	// A denied emitOp is dropped and logged without its value.
	const SECRET = 'SECRETVALUE-123';
	A.emit('shell.setPref', { partition: 'app:other', key: 'k', value: SECRET });
	await settle();
	assert.equal(t.cm.opsEmitted.filter((o) => o.op === 'shell.setPref').length, 0, 'a foreign-partition setPref must be dropped');
	assert.ok(
		t.logs.some((l) => l.includes('shell.setPref')),
		`the drop must be logged, logs: ${brief(t.logs)}`
	);
	assert.ok(!t.logs.some((l) => l.includes(SECRET)), 'the log must never contain the value');
});

test('T29 an outbound backstop denial answers the same request id with an error, not a timeout', async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const R = t.open(ENTRY_A, { raw: true });
	const started = await R.rawRequest('client.request', { message: dap('execute', { pipeline: { components: [], source: 'chat_1' }, args: [], ttl: 60 }) });
	const token = String(((started?.result as { value?: { body?: { token?: string } } }).value?.body ?? {}).token);
	t.cm.engine.setStatus({ status: t.cm.sessionToken });
	const response = await R.rawRequest('client.request', { message: dap('rrext_get_task_status', { token }) });
	assert.ok(response, 'the root must answer the request id');
	assert.equal(response.ok, false, `a response carrying the session token must be denied, got ${brief(response)}`);
	assert.ok(String(response.error).startsWith('RR_DENIED:'), `expected RR_DENIED, got ${brief(response.error)}`);
	await assertDeniedOp(Promise.reject(new Error(String(response.error))), 'credential', 'the backstop denial');
});
