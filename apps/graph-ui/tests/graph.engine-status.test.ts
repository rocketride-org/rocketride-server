// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE ENGINE CONNECTION, WORDED HONESTLY: waiting is not disconnected
// =============================================================================
//
// A realm with no client yet (a VS Code webview before its root reports, a host that has not published
// `host:connection`) is WAITING; a client whose connection dropped is DISCONNECTED. The words differ, and the env says
// which. Also: the controller's real requests through a REAL realm client (RocketRideClientProxy over the shell bus)
// carry the timeouts the platform names, and a failure keeps its code.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createExplorerClient } from 'shared/explorer/devtool/engineClient';
import { createRealmClientHarness } from 'shared/explorer/devtool/testing';
import { toolTransportTimeoutMs } from 'shared/explorer/devtool/timeouts';
import { ENGINE_DISCONNECTED_TEXT, ENGINE_WAITING_TEXT, engineNotReadyText, truncationText, writeTruncationText } from '../src/graph/wording';
import { createLocalGraphEnv } from '../src/localEnv';
import { createDataVersions } from '../src/graph/dataVersion';
import { createPreviewStore } from '../src/graph/previews';
import { createSchemaStore } from '../src/graph/schemaStore';
import { makeGraphEndpointStore, makeGraphHistory } from '../src/adapters/explorer';
import { memoryPrefs } from '../src/env';
import { mountController, mountFrame, vscodeRealm, settle, signInVsCode, until } from './support/devtool';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

describe('the words for an engine that cannot be asked yet', () => {
	it('waiting and disconnected say different things; ready says nothing', () => {
		assert.equal(engineNotReadyText('waiting'), ENGINE_WAITING_TEXT);
		assert.equal(engineNotReadyText('disconnected'), ENGINE_DISCONNECTED_TEXT);
		assert.notEqual(ENGINE_WAITING_TEXT, ENGINE_DISCONNECTED_TEXT);
		assert.match(ENGINE_WAITING_TEXT, /^Waiting for the server connection/);
		assert.ok(!/not connected|disconnected/i.test(ENGINE_WAITING_TEXT), 'a wait is never worded as a lost connection');
		assert.equal(engineNotReadyText('ready'), null);
		assert.equal(engineNotReadyText(undefined), null);
	});

	it('a cut write-console result says the statement ran and is saved; a cut read does not claim that', () => {
		const cut = { truncated: true, truncated_by: 'rows' as const, row_limit: 100, element_limit: 10_000, value_limit: 500_000 };
		assert.match(writeTruncationText(cut) ?? '', /^The statement ran and its writes are saved; only part of its result is shown\. Limit reached at 100 rows/);
		assert.ok(!/writes are saved/.test(truncationText(cut) ?? ''));
		assert.equal(writeTruncationText({ ...cut, truncated: false, truncated_by: null }), null);
		assert.match(read('components/RunSurface.tsx'), /mode === 'write' \? writeTruncationText\(result\)/);
	});

	it('the sidebar list, the landing and the run surface use them (no hand-written "not connected")', () => {
		assert.match(read('GraphSidebar.tsx'), /engineNotReadyText\(env\.engine\)/);
		assert.match(read('views/ConnectionsView.tsx'), /engineNotReadyText\(env\.engine\)/);
		assert.match(read('components/RunSurface.tsx'), /engineNotReadyText\(env\.engine\)/);
	});

	it('a local env says why it is not ready: no client yet is waiting, a dropped one is disconnected, the default follows `ready`', () => {
		const stores = { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), schemas: createSchemaStore(), dataVersions: createDataVersions(), history: makeGraphHistory(0), previews: createPreviewStore() };
		const make = (over: Partial<Parameters<typeof createLocalGraphEnv>[0]>) => createLocalGraphEnv({ mount: 'app', ready: false, client: null, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: () => undefined, prefs: memoryPrefs(), historyPrivacyNote: '', ...over });
		assert.equal(make({ engine: 'waiting' }).engine, 'waiting');
		assert.equal(make({ engine: 'disconnected' }).engine, 'disconnected');
		assert.equal(make({}).engine, 'disconnected');
		assert.equal(make({ ready: true }).engine, 'ready');
	});

	it('a frame says waiting until the host has spoken, then disconnected or ready', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await settle();
		assert.equal(frame.env(false, true).engine, 'waiting');
		assert.equal(frame.env(false, false).engine, 'disconnected');
		assert.equal(frame.env(true).engine, 'ready');
		assert.equal(frame.env(true).ready, true);
		frame.dispose();
		mounted.controller.dispose();
	});

	it('the sidebar env follows the controller\'s engine status: waiting, ready, then disconnected after the root drops', async () => {
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.equal(mounted.controller.engineStatus.get(), 'waiting');
		let seen = 0;
		const off = mounted.controller.engineStatus.subscribe(() => { seen += 1; });
		signInVsCode(engine.realm);
		await until(() => mounted.controller.engineStatus.get() === 'ready', 'ready');
		assert.equal(mounted.controller.env('ready').ready, true);
		engine.realm.root.disconnect();
		await until(() => mounted.controller.engineStatus.get() === 'disconnected', 'disconnected');
		assert.equal(mounted.controller.env(mounted.controller.engineStatus.get()).engine, 'disconnected');
		assert.ok(seen >= 2, 'the sidebar is told of each change');
		off();
		mounted.controller.dispose();
	});
});

describe('through a REAL realm client (RocketRideClientProxy over the shell bus)', () => {
	it('a tool request asks the bus for its SDK timeout plus the proxy slack, and a server failure keeps its code', async () => {
		const realm = createRealmClientHarness();
		const client = createExplorerClient(() => realm.client as never);
		realm.onRequest((message) => {
			const tool = (message as { arguments?: { tool?: string } }).arguments?.tool;
			if (tool === 'boom') throw Object.assign(new Error('Task is stopped'), { code: 'TASK_STOPPED' });
			return { body: { result: { rows: [] } } };
		});
		await client.tool({ token: 't', tool: 'read_query', input: { cypher: 'RETURN 1' }, timeout: 20_000 });
		const sent = realm.transport.find((entry) => entry.op === 'client.request');
		assert.ok(sent, 'the request crossed the bus');
		assert.equal(sent.timeoutMs, toolTransportTimeoutMs(20_000));
		await assert.rejects(client.tool({ token: 't', tool: 'boom', timeout: 20_000 }), (error: unknown) => (error as { code?: string }).code === 'TASK_STOPPED');
	});
});
