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
// EXPLORER DEV TOOL — A REAL REALM CLIENT OVER THE SHELL BUS (integration)
// =============================================================================
//
// What runs for real: the realm's RocketRideClientProxy (the client
// `useShellConnection().client` is in a mirrored realm), the shell's op bus, the
// root's `registerClientOps`, errorWire, the channel and busPeer. What is
// pretended: only the socket (testing.ts createRealmClientHarness). The
// adapter, the controller and the frame run through it exactly as production
// does, so a vocabulary the root no longer serves (the retired `client.getTasks`
// family) fails HERE, not in a realm nobody tested.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ToolOpMap, ToolOpSpec } from 'shell';
import { manualClock } from '../connect/testing';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createExplorerClient, createPrefsFs } from './engineClient';
import type { IRealmClient } from './engineClient';
import { createFrameCaller } from './frame';
import { createFsPrefs, historyPrefsPath, PREFS_FILE_VERSION, PREFS_LOAD_ATTEMPTS } from './prefs';
import { toReply } from './reply';
import type { Reply } from './reply';
import { PROXY_BUS_SLACK_MS, UNBOUNDED_TOOL_TIMEOUT_MS } from './timeouts';
import { createDevToolHarness, createRealmClientHarness, settle, shellProtocol } from './testing';

/** The real SDK, loaded as the shell's own sources load it (the shared runner stubs it for everything else). */
const sdk = createRequire(path.resolve(__dirname, '../../../../../packages/shell/src/connection/realmClient.cjs'))('rocketride') as {
	AuthenticationException: new (result: Record<string, unknown>) => Error;
};

/** The only ops a realm's client may put on the root bus. */
const ROOT_VOCABULARY = new Set(['client.request', 'client.addMonitor', 'client.removeMonitor']);

/** The store subcommand of a DAP message the fake socket received. */
const subcommand = (message: { arguments?: Record<string, unknown> }): unknown => message.arguments?.subcommand;

/** A fake engine answering what the SDK methods ask (as DAP response bodies). */
function engine(h: ReturnType<typeof createRealmClientHarness>, files: Record<string, unknown> = {}): { puts: Array<{ path: string; value: unknown }> } {
	const puts: Array<{ path: string; value: unknown }> = [];
	h.onRequest((message) => {
		const args = message.arguments ?? {};
		switch (message.command) {
			case 'rrext_get_tasks': return { body: { tasks: [{ token: 'tk-1', name: 'Pipeline A' }] } };
			case 'rrext_list_tasks': return { body: { rows: [{ id: 'tk-1' }], total: 1 } };
			case 'rrext_get_pipeline': return { body: { pipeline: { components: [] } } };
			case 'rrext_process': return { body: { result: { rows: [[1]], tool: args.tool } } };
			case 'rrext_store': {
				const sub = subcommand(message);
				if (sub === 'fs_stat') return { body: { exists: String(args.path) in files } };
				if (sub === 'fs_get_json') return { body: { value: files[String(args.path)] } };
				if (sub === 'fs_put_json') { puts.push({ path: String(args.path), value: args.value }); return { body: {} }; }
				return { body: {} };
			}
			default: return { body: {} };
		}
	});
	return { puts };
}

describe('case 1 — every call the adapter makes rides the root\'s ONE request op', () => {
	it('discovery, tools, file store and monitors all work, and the root bus sees only the surviving vocabulary', async () => {
		const h = createRealmClientHarness();
		engine(h, { '@/User/x.json': { a: 1 } });
		const explorer = createExplorerClient(() => h.client as unknown as IRealmClient);
		const fs = createPrefsFs(() => h.client as unknown as IRealmClient);

		assert.deepEqual(await explorer.getTasks(), [{ token: 'tk-1', name: 'Pipeline A' }]);
		assert.deepEqual(await explorer.listTasks?.({ page_size: 5 }), { rows: [{ id: 'tk-1' }], total: 1 });
		assert.deepEqual(await explorer.getTaskPipeline('tk-1'), { components: [] });
		assert.deepEqual(await explorer.tool({ token: 'tk-1', tool: 'get_schema', nodeId: 'db_1', timeout: 9_000 }), { rows: [[1]], tool: 'get_schema' });
		assert.deepEqual(await fs.fsStat('@/User/x.json'), { exists: true });
		assert.deepEqual(await fs.fsStat('@/User/missing.json'), { exists: false });
		assert.deepEqual(await fs.fsReadJson('@/User/x.json'), { a: 1 });
		await fs.fsMkdir('@/User');
		await fs.fsWriteJson('@/User/y.json', { b: 2 });
		await explorer.addMonitor?.({ token: '*' }, ['task']);
		await explorer.removeMonitor?.({ token: '*' }, ['task']);

		assert.ok(h.rootOps.length >= 11);
		for (const op of h.rootOps) assert.ok(ROOT_VOCABULARY.has(op), `the realm client put '${op}' on the root bus`);
		assert.deepEqual(h.monitors.map((m) => m.op), ['add', 'remove'], 'monitors go to the root, which owns their refcount');
		const stat = h.socket.find((s) => subcommand(s.message) === 'fs_stat');
		assert.ok(stat, 'the DAP message was built by the SDK, in the realm, from its own code');
	});
});

describe('case 2 — SDK errors cross the bus with their class and code', () => {
	it('an AuthenticationException with a code reaches the adapter\'s caller as the same class, untouched', async () => {
		const h = createRealmClientHarness();
		h.onRequest(() => { throw new sdk.AuthenticationException({ message: 'Session expired', code: 'AUTH_EXPIRED' }); });
		const explorer = createExplorerClient(() => h.client as unknown as IRealmClient);
		await assert.rejects(explorer.tool({ token: 'tk', tool: 'get_data', timeout: 1_000 }), (error: unknown) => {
			assert.ok(error instanceof sdk.AuthenticationException, 'subclass identity survives the JSON hop');
			assert.equal((error as { code?: string }).code, 'AUTH_EXPIRED');
			return true;
		});
	});
});

describe('case 3 — timeouts: the SDK\'s for tool, an application deadline for the rest', () => {
	it('tool({timeout}) reaches the socket as that timeout, and the proxy asks the bus for it plus its slack (pins PROXY_BUS_SLACK_MS)', async () => {
		const h = createRealmClientHarness();
		engine(h);
		const explorer = createExplorerClient(() => h.client as unknown as IRealmClient);
		await explorer.tool({ token: 'tk', tool: 'get_data', timeout: 21_000 });
		assert.equal(h.socket.at(-1)?.timeout, 21_000);
		assert.equal(h.transport.at(-1)?.timeoutMs, 21_000 + PROXY_BUS_SLACK_MS);
	});

	it('an unbounded tool call is bounded by the 24 h cap (a timeout-less proxy request would be cut by the 120 s bus default)', async () => {
		const h = createRealmClientHarness();
		engine(h);
		await createExplorerClient(() => h.client as unknown as IRealmClient).tool({ token: 'tk', tool: 'execute' });
		assert.equal(h.socket.at(-1)?.timeout, UNBOUNDED_TOOL_TIMEOUT_MS);
		assert.equal(h.transport.at(-1)?.timeoutMs, UNBOUNDED_TOOL_TIMEOUT_MS + PROXY_BUS_SLACK_MS);
	});

	it('a request with no SDK timeout (fsStat) that the root never answers is given up on by its deadline, not cancelled', async () => {
		const h = createRealmClientHarness();
		let release: (value: unknown) => void = () => undefined;
		h.onRequest(() => new Promise((resolve) => { release = resolve; }));
		const fs = createPrefsFs(() => h.client as unknown as IRealmClient, 40);
		await assert.rejects(fs.fsStat('@/User/x.json'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /not cancelled/.test(error.message));
		assert.equal(h.socket.length, 1, 'the request WAS sent; the caller just stopped waiting');
		release({ body: { exists: false } }); // the late answer is swallowed (and frees the bus's own 120 s timer)
		await settle();
	});
});

describe('case 4 — frame -> channel -> controller -> adapter -> realm client -> bus -> socket', () => {
	interface RealmOps extends ToolOpMap {
		'r.tool': ToolOpSpec<IDeadline & { tool: string }, Reply<unknown>>;
	}

	/** A controller serving `r.tool` through the adapter over `getClient`, and a frame caller. */
	function lane(getClient: () => IRealmClient | null) {
		const t = createDevToolHarness('tool.realm', { json: true });
		t.setHostConnection(true);
		const explorer = createExplorerClient(getClient);
		const hostChannel = shellProtocol.createToolChannel(t.sidebarPeer);
		const mount = () => attachController<RealmOps>({
			channel: hostChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'r.tool': ({ tool }) => toReply(() => explorer.tool({ token: 'tk', tool, timeout: 5_000 }), { tool }) },
		});
		const caller = createFrameCaller<RealmOps>({ channel: shellProtocol.createToolChannel(t.newFramePeer()), createToolOpClient: shellProtocol.createToolOpClient });
		return { t, mount, caller };
	}

	it('a call made before the controller mounts is held, sent once it is ready, and answered through the real client', async () => {
		const h = createRealmClientHarness();
		engine(h);
		const { t, mount, caller } = lane(() => h.client as unknown as IRealmClient);
		await settle();
		const call = caller.callReply('r.tool', { tool: 'get_schema' }, { timeoutMs: 8_000 });
		await settle();
		const posted = () => t.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'call').length;
		assert.equal(posted(), 0, 'nothing posted while the controller is not ready');
		const attached = mount();
		assert.deepEqual(await call, { rows: [[1]], tool: 'get_schema' });
		assert.equal(posted(), 1);
		assert.ok(h.rootOps.every((op) => ROOT_VOCABULARY.has(op)));
		assert.deepEqual(t.violations, [], 'everything crossed as JSON');
		caller.dispose();
		attached.dispose();
	});

	it('a realm with no client yet answers kind unavailable (nothing reached the socket); once the client exists the same op works', async () => {
		const h = createRealmClientHarness();
		engine(h);
		let current: IRealmClient | null = null;
		const { mount, caller } = lane(() => current);
		const attached = mount();
		await settle();
		await assert.rejects(caller.callReply('r.tool', { tool: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(h.socket.length, 0);
		current = h.client as unknown as IRealmClient;
		assert.deepEqual(await caller.callReply('r.tool', { tool: 'y' }, { timeoutMs: 5_000 }), { rows: [[1]], tool: 'y' });
		caller.dispose();
		attached.dispose();
	});

	it('an SDK error code survives all the way to the frame\'s ExplorerToolError', async () => {
		const h = createRealmClientHarness();
		h.onRequest(() => { throw new sdk.AuthenticationException({ message: 'Session expired', code: 'AUTH_EXPIRED' }); });
		const { mount, caller } = lane(() => h.client as unknown as IRealmClient);
		const attached = mount();
		await settle();
		await assert.rejects(caller.callReply('r.tool', { tool: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.code, 'AUTH_EXPIRED');
			assert.equal(error.tool, 'x');
			return true;
		});
		caller.dispose();
		attached.dispose();
	});

	it('a root whose socket is down refuses with the root\'s own error, which the frame reads as unavailable', async () => {
		const h = createRealmClientHarness();
		engine(h);
		h.setSocketUp(false);
		const { mount, caller } = lane(() => h.client as unknown as IRealmClient);
		const attached = mount();
		await settle();
		await assert.rejects(caller.callReply('r.tool', { tool: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		caller.dispose();
		attached.dispose();
	});
});

describe('case 5 — history prefs over the real client: a missing file is first run; a failed read never writes', () => {
	const PATH = historyPrefsPath('graph');
	const OWNER = 'user-a|org-1|team-1';

	it('fsStat exists:false is the only first-run signal: a later write creates the file', async () => {
		const h = createRealmClientHarness();
		const { puts } = engine(h);
		const clock = manualClock();
		const prefs = createFsPrefs({ fs: createPrefsFs(() => h.client as unknown as IRealmClient), path: PATH, owner: OWNER, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
		assert.equal(await prefs.load(), 'ready');
		prefs.setPref('graph.history', { k1: [] });
		await prefs.flush();
		assert.equal(puts.length, 1);
		assert.equal(puts[0].path, PATH);
		assert.equal((puts[0].value as { version: number }).version, PREFS_FILE_VERSION);
	});

	it('a file that exists but cannot be read is never written over (the request failure is not a missing file)', async () => {
		const h = createRealmClientHarness();
		const puts: unknown[] = [];
		h.onRequest((message) => {
			const sub = subcommand(message);
			if (sub === 'fs_stat') return { body: { exists: true } };
			if (sub === 'fs_put_json') { puts.push(message.arguments); return { body: {} }; }
			throw new Error('storage backend unavailable');
		});
		const clock = manualClock();
		const errors: string[] = [];
		const prefs = createFsPrefs({ fs: createPrefsFs(() => h.client as unknown as IRealmClient), path: PATH, owner: OWNER, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, onError: (_error, phase) => errors.push(phase) });
		const loading = prefs.load();
		for (let i = 0; i < PREFS_LOAD_ATTEMPTS; i += 1) {
			await settle();
			await clock.advance(3_000);
		}
		assert.equal(await loading, 'failed');
		prefs.setPref('graph.history', { k1: [{ id: 'new' }] });
		await prefs.flush();
		await clock.advance(60_000);
		await settle();
		assert.deepEqual(puts, [], 'nothing was ever written');
		assert.deepEqual(errors, ['load']);
	});

	it('no client yet counts as a failed request, not as a missing file', async () => {
		const clock = manualClock();
		const prefs = createFsPrefs({ fs: createPrefsFs(() => null), path: PATH, owner: OWNER, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
		const loading = prefs.load();
		for (let i = 0; i < PREFS_LOAD_ATTEMPTS; i += 1) {
			await settle();
			await clock.advance(3_000);
		}
		assert.equal(await loading, 'failed');
	});
});
