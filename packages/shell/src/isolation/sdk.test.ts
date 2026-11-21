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
// SDK THROUGH THE ROOT — T8
// =============================================================================
//
// The real `RocketRideClientProxy` over a realm bus, every call with the SDK's
// defaults (so `undefined` keys arrive). The first test is a control: it must
// succeed against the pass-through and against the gate. The second checks the
// normalised shapes and only runs once the gate exists.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { RocketRideClientProxy } from '../connection/RocketRideClientProxy';
import { rowFor } from './capabilities';
import { ENTRY_A, makeRoot, refAppKey } from './__test__/fixtures';
import type { ITestRoot } from './__test__/fixtures';
import type { IOpenedRealm } from './__test__/realm';

const IMPLEMENTED = ((): boolean => {
	try {
		rowFor('client.request', 'execute');
		return true;
	} catch (err) {
		return !/not implemented/.test(String((err as Error).message));
	}
})();

async function driveSdk(_t: ITestRoot, realm: IOpenedRealm): Promise<{ token: string; projectId: string; pipeId: number }> {
	const key = refAppKey(ENTRY_A.id);
	const p = (name: string): string => `apps/${key}/${name}`;
	// The shell realm is a browser: the SDK has no process.env there. In Node it copies every
	// environment variable and `use()` then ships the ROCKETRIDE_* ones as `execute.env`, which the
	// gate refuses (schema) on any runner that exports them. An empty `env` is the browser's
	// view; every other SDK default stays as shipped.
	const client = new RocketRideClientProxy({ request: (op, params, timeoutMs) => realm.bus.request(op, params, timeoutMs === undefined ? undefined : { timeoutMs }) }, { env: {} });

	const run = await client.use({ pipeline: { components: [], source: 'chat_1', project_id: 'caller-chosen' } as never, source: 'chat_1', ttl: 60 });
	const token = run.token;
	const projectId = String(run.projectId);
	await client.getTaskStatus(token);
	await client.getTaskPipeline(token);
	await client.restart({ token, projectId, source: 'chat_1', pipeline: { components: [], source: 'chat_1' } });
	await client.getTaskToken({ projectId, source: 'chat_1' });
	await client.addMonitor({ token }, ['summary']);
	const pipe = await client.pipe(token).then((d) => d.open());
	await client.setEvents(token, ['summary'], pipe.pipeId);
	await pipe.write(new Uint8Array([1, 2, 3]));
	await pipe.close();

	const r = await client.fsOpen(p('r.bin'), 'r');
	await client.fsRead(r.handle, 0, 4);
	const w = await client.fsOpen(p('w.bin'), 'w');
	await client.fsWrite(w.handle, new Uint8Array(4));
	await client.fsClose(w.handle, 'w');
	await client.fsClose(r.handle, 'r');
	await client.fsDelete(p('x'));
	await client.fsListDir(p('d'));
	await client.fsMkdir(p('d'));
	await client.fsRmdir(p('d'));
	await client.fsStat(p('x'));
	await client.fsRename(p('a'), p('b'));
	await client.fsReadJson(p('j.json'));
	await client.fsWriteJson(p('j.json'), { a: 1 });
	await client.terminate(token);
	return { token, projectId, pipeId: Number(pipe.pipeId) };
}

test('T8 the real SDK client works through the root with its defaults', async (tt) => {
	// A runner that exports ROCKETRIDE_* (CI does) must not change what the browser-shaped client sends.
	const saved = { uri: process.env.ROCKETRIDE_URI, key: process.env.ROCKETRIDE_APIKEY };
	process.env.ROCKETRIDE_URI = 'http://runner.invalid';
	process.env.ROCKETRIDE_APIKEY = 'runner-key';
	tt.after(() => {
		for (const [name, value] of [['ROCKETRIDE_URI', saved.uri], ['ROCKETRIDE_APIKEY', saved.key]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const realm = t.open(ENTRY_A);
	await driveSdk(t, realm);

	const seen = new Set(t.cm.engine.received.map((r) => `${r.message.command}${r.message.arguments?.subcommand ? `:${r.message.arguments.subcommand}` : ''}`));
	for (const want of ['execute', 'rrext_get_task_status', 'rrext_get_pipeline', 'restart', 'rrext_get_token', 'rrext_monitor', 'rrext_process:open', 'rrext_process:write', 'rrext_process:close', 'terminate', 'rrext_store:fs_open', 'rrext_store:fs_read', 'rrext_store:fs_write', 'rrext_store:fs_close', 'rrext_store:fs_delete', 'rrext_store:fs_list_dir', 'rrext_store:fs_mkdir', 'rrext_store:fs_rmdir', 'rrext_store:fs_stat', 'rrext_store:fs_rename', 'rrext_store:fs_get_json', 'rrext_store:fs_put_json']) {
		assert.ok(seen.has(want), `the engine never received ${want}`);
	}
	assert.ok(
		t.cm.engine.monitorCalls.some((c) => c.kind === 'add'),
		'addMonitor must reach the engine client'
	);
});

test('T8 normalised shapes reach the engine', { skip: !IMPLEMENTED }, async (tt) => {
	const t = makeRoot();
	tt.after(() => t.cleanup());
	const realm = t.open(ENTRY_A);
	await driveSdk(t, realm);
	const engine = t.cm.engine;
	const real = engine.runs[0];
	const first = (command: string, sub?: string) => engine.received.find((r) => r.message.command === command && (sub === undefined || r.message.arguments?.subcommand === sub))!.message;

	const exec = first('execute');
	assert.match(String((exec.arguments?.pipeline as { project_id?: string }).project_id), new RegExp(`^rrapp\\.${refAppKey(ENTRY_A.id)}\\.[0-9a-f-]{36}$`));
	assert.deepEqual(exec.arguments?.args, []);
	for (const command of ['terminate', 'rrext_get_task_status', 'rrext_get_pipeline', 'restart', 'rrext_monitor']) {
		const m = first(command);
		assert.equal((m.arguments as { token?: string }).token, real.token, `${command}: real token in arguments.token`);
		assert.ok(!('token' in m), `${command}: no top-level token`);
	}
	assert.equal(first('rrext_get_token').arguments?.projectId, real.projectId, 'rrext_get_token carries the real project');
	assert.equal(engine.received.find((r) => r.message.command === 'rrext_get_task_status')!.timeout, 15_000);
	assert.equal(engine.monitorCalls[0].key.token, real.token);
	assert.ok(!('provider' in (first('rrext_process', 'open').arguments ?? {})), 'undefined provider key is dropped');
	assert.ok(first('rrext_store', 'fs_write').arguments?.data instanceof Uint8Array, 'fs_write data reaches the engine as bytes');
});
