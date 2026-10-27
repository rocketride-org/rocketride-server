// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL ENV SEAM (R14, T12): one VectorEnv, LOCAL for the full app and the
// controller; every view reaches the engine through it
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { IEndpointStore, IExplorerEndpoint } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { createConnectionRegistry } from '../src/adapters/connections';
import { makeVectorEndpointStore } from '../src/adapters/explorer';
import { buildConsoleModel } from '../src/vector/consoleModel';
import { DEFAULT_LIMITS } from '../src/vector/results';
import { sessionQueryHistory } from '../src/adapters/queryHistory';
import { DEVTOOL_CHAT_NOTE, DEVTOOL_HISTORY_NOTE, DEVTOOL_UPLOADS_NOTE, NO_CHANNELS, devToolConsoleModel, liveEndpoint } from '../src/env';
import type { IVectorEnv } from '../src/env';
import { createLocalVectorEnv } from '../src/localEnv';
import { fixture } from './support/fixtures';
import { vectorWorld } from './support/vectorWorld';

const SRC = path.resolve(__dirname, '..', 'src');
/** Source without comments. */
const code = (rel: string): string =>
	fs
		.readFileSync(path.join(SRC, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/\s\/\/.*$/gm, '');

/** Every .ts/.tsx file under src, relative. */
function allSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(SRC, full).split(path.sep).join('/'));
		}
	};
	walk(SRC);
	return out.sort();
}

const NO_ACTIVE = { get: () => null, subscribe: () => () => undefined };

/** A LOCAL env over a fresh store and a fake engine, discovered once. */
async function localEnv(over: Parameters<typeof vectorWorld>[0] = {}) {
	const world = vectorWorld(over);
	const clock = manualClock();
	const store: IEndpointStore = makeVectorEndpointStore({ clock, debounceMs: 0 });
	const registry = createConnectionRegistry();
	const opened: Array<{ kind: string; key: string; objectId?: string; chunkId?: number }> = [];
	const env: IVectorEnv = createLocalVectorEnv({
		ready: true,
		client: world.client,
		store,
		registry,
		queryHistory: sessionQueryHistory(DEVTOOL_HISTORY_NOTE),
		activeConnection: NO_ACTIVE,
		openConsole: (endpoint) => opened.push({ kind: 'console', key: endpoint.key }),
		openDocument: (endpoint, objectId, _path, chunkId) => opened.push({ kind: 'document', key: endpoint.key, objectId, ...(chunkId === undefined ? {} : { chunkId }) }),
	});
	const refreshing = env.refresh();
	await clock.advance(0);
	await refreshing;
	await clock.settle();
	return { world, clock, store, registry, env, opened };
}

describe('T12 - the LOCAL env does what the full app did, over its own store and client', () => {
	it('discovers, probes, reads through the anchor session, and hands out the role channels', async () => {
		const { world, env, clock } = await localEnv();
		assert.equal(env.kind, 'local');
		assert.equal(env.ready, true);
		assert.equal(env.degraded, null, 'nothing degrades in the full app');
		const state = env.endpoints.get();
		assert.equal(state.endpoints.length, 1, 'the store node the Tools source controls');
		assert.equal(state.omitted, 0);
		assert.equal(env.endpoints.get(), env.endpoints.get(), 'a stable snapshot between changes');
		const endpoint = state.endpoints[0];
		await clock.settle();
		assert.equal(env.endpoints.get().probes[endpoint.key]?.ok, true, 'probed at discovery');
		const probe = await env.probe(endpoint.key);
		assert.equal(probe?.ok, true);
		const channels = env.channels(endpoint);
		assert.ok(channels.tools && channels.chat && channels.ingest, 'all three sources run');
		assert.equal(env.channels(endpoint).tools, channels.tools, 'the store hands out the same channel again');
		const before = world.calls.length;
		await env.session(endpoint)?.invoke('stats', { mode: 'full' }, { nodeId: endpoint.nodeId });
		assert.deepEqual(world.calls.slice(before).map((c) => c.tool), ['stats']);
	});

	it('the connection objects call through the env: the console controller reads and probes through its link', async () => {
		const { world, env, clock, registry } = await localEnv();
		const endpoint = env.endpoints.get().endpoints[0];
		const entry = env.connection(endpoint, DEFAULT_LIMITS);
		assert.equal(env.connection(endpoint, DEFAULT_LIMITS), entry, 'one entry per key');
		assert.equal(env.existingConnection(endpoint.key), entry);
		assert.equal(registry.existing(endpoint.key), entry, 'kept in the mount\'s own registry');
		const before = world.calls.length;
		entry.controller.documentsChanged();
		await clock.settle();
		const tools = world.calls.slice(before).map((c) => c.tool);
		assert.ok(tools.includes('stats') && tools.includes('list_documents'), `the controller read the store (${tools.join(', ')})`);
		assert.ok(tools.includes('dialect'), 'and probed it again through the env\'s store');
		entry.controller.dispose();
		registry.clear();
		assert.equal(registry.existing(endpoint.key), undefined);
	});

	it('the env opens documents the way the mount does; offline it has no session and no channels', async () => {
		const { env, store, registry, opened } = await localEnv();
		const endpoint = env.endpoints.get().endpoints[0];
		env.openConsole(endpoint);
		env.openDocument(endpoint, 'doc-1', 'a.md', 3);
		assert.deepEqual(opened, [{ kind: 'console', key: endpoint.key }, { kind: 'document', key: endpoint.key, objectId: 'doc-1', chunkId: 3 }]);
		const offline = createLocalVectorEnv({ ready: false, client: null, store, registry, queryHistory: sessionQueryHistory(DEVTOOL_HISTORY_NOTE), activeConnection: NO_ACTIVE, openConsole: () => undefined, openDocument: () => undefined });
		assert.equal(offline.ready, false);
		assert.equal(offline.session(endpoint), null);
		assert.deepEqual(offline.channels(endpoint), NO_CHANNELS);
		assert.equal(await offline.probe(endpoint.key), null, 'nothing was tested');
		const entry = offline.connection(endpoint, DEFAULT_LIMITS);
		entry.controller.refresh();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(entry.controller.getState().stats.error?.headline ?? '', /Not connected to the server/, 'a call made while offline says so and reaches no session');
		registry.clear();
	});

	it('the console model is served as is in the full app', async () => {
		const { env } = await localEnv();
		const endpoint = env.endpoints.get().endpoints[0];
		const model = buildConsoleModel(endpoint, env.endpoints.get().probes[endpoint.key], null);
		assert.equal(env.consoleModel(model), model);
	});
});

describe('the connection registries are per mount', () => {
	it('two registries never share an entry; clearing one disposes its controllers, resets its selections and forgets them', () => {
		const endpoint = { key: 'k-one', nodeId: 'store_1', roles: {}, components: [] } as unknown as IExplorerEndpoint;
		const a = createConnectionRegistry();
		const b = createConnectionRegistry();
		const inA = a.entry(endpoint, null, DEFAULT_LIMITS, manualClock());
		const inB = b.entry(endpoint, null, DEFAULT_LIMITS, manualClock());
		assert.notEqual(inA, inB);
		assert.equal(a.count(), 1);
		inA.selection.selectDocument({ objectId: 'doc-1', path: 'a.md' });
		a.clear();
		assert.equal(a.count(), 0);
		assert.equal(inA.selection.getState().document, null, 'the selection was reset');
		assert.equal(b.existing('k-one'), inB, 'the other registry kept its entry');
		b.clear();
	});
});

describe('R11 inputs - what a dev-tool mount cannot serve is switched off in the model, with the reason', () => {
	it('chat and uploads are off with the dev-tool notes; everything else is the model as built', () => {
		const endpoint = { key: 'k', nodeId: 'store_1', roles: { tools: { source: 'tools_1' }, chat: { source: 'chat_1' }, ingest: { source: 'ingest_1' } }, components: [{ id: 'tools_1', provider: 'tools' }], readOnly: false, state: 'ready', provider: 'postgres', pipelineName: 'p' } as unknown as IExplorerEndpoint;
		const model = buildConsoleModel(endpoint, { ok: true, info: fixture('dialect_pgvector'), dialect: 'vector' }, null);
		assert.equal(model.chat.enabled, true, 'the premise: the full app could chat');
		assert.equal(model.ingest.enabled, true, 'and upload');
		const served = devToolConsoleModel(model);
		assert.deepEqual(served.chat, { enabled: false, reason: DEVTOOL_CHAT_NOTE });
		assert.deepEqual(served.ingest, { enabled: false, reason: DEVTOOL_UPLOADS_NOTE });
		assert.deepEqual({ ...served, chat: model.chat, ingest: model.ingest }, model, 'nothing else changes');
		assert.equal(devToolConsoleModel(served), devToolConsoleModel(served), 'idempotent');
		for (const note of [DEVTOOL_CHAT_NOTE, DEVTOOL_UPLOADS_NOTE]) {
			assert.match(note, /not available in the dev-tool mount/);
			assert.match(note, /Open Vector Explorer as an app to use it\.$/);
		}
	});

	it('a document whose connection discovery no longer lists reads as stopped; one still listed is the live record', () => {
		const opened = { key: 'k', state: 'ready' } as unknown as IExplorerEndpoint;
		const live = { key: 'k', state: 'ready', nodeName: 'live' } as unknown as IExplorerEndpoint;
		assert.equal(liveEndpoint(opened, { status: 'ready', endpoints: [live] }), live);
		assert.equal(liveEndpoint(opened, { status: 'ready', endpoints: [] }).state, 'stopped');
		assert.equal(liveEndpoint(opened, { status: 'loading', endpoints: [] }), opened, 'not yet known: as opened');
	});
});

describe('R14 - every view reaches the engine through the env', () => {
	it('the console, the landing and the remove dialog host read useVectorEnv(), never the shell connection, the store singleton or the app\'s documents', () => {
		for (const file of ['views/ConsoleView.tsx', 'views/ConnectionsView.tsx', 'components/RemoveDialogHost.tsx']) {
			const text = code(file);
			assert.doesNotMatch(text, /useShellConnection|vectorEndpoints|useActiveConnection\(/, `${file} still reaches past the env`);
			assert.match(text, /useVectorEnv\(\)/, `${file} reads the env`);
		}
		const consoleView = code('views/ConsoleView.tsx');
		assert.doesNotMatch(consoleView, /getDocs|from '\.\.\/docs'|from '\.\/ConnectionsView'/, 'the console opens documents through the env');
		assert.match(consoleView, /showConsole: \(\) => env\.openConsole\(entry\.ctx\.endpoint\),/);
		assert.match(consoleView, /env\.openDocument\(entry\.ctx\.endpoint, objectId, row\?\.path \?\? null, chunkId\)/);
	});

	it('only the two LOCAL mount roots read the shell connection: the full app and the dev-tool sidebar (the controller)', () => {
		const users = allSources().filter((f) => /\buseShellConnection\(\)/.test(code(f)));
		assert.deepEqual(users, ['VectorApp.tsx', 'VectorDevToolSidebar.tsx']);
	});

	it('the full app provides the LOCAL env over its own store, registry and client, around everything it renders', () => {
		const app = code('VectorApp.tsx');
		assert.match(app, /createLocalVectorEnv\(\{ ready: client !== null && isConnected, client, store: vectorEndpoints, registry: appConnections,/);
		assert.match(app, /<VectorEnvProvider value=\{env\}>/);
		assert.match(app, /const \{ entry, model, channels \} = useConnection\(endpoint\);/, 'a document tab too');
	});

	it('the env seam is pure where it must be: its types and the LOCAL env import no shell value and no React', () => {
		for (const file of ['env.ts', 'localEnv.ts']) {
			const text = code(file);
			assert.doesNotMatch(text, /^import (?!type )[^;]*from 'shell';/m, `${file} imports a shell value`);
			assert.doesNotMatch(text, /from 'react'/, `${file} imports React`);
			assert.doesNotMatch(text, /from 'shared\/explorer\/react'/, file);
		}
		assert.match(code('envContext.tsx'), /createContext<IVectorEnv \| null>\(null\)/, 'the React context lives in its own file');
	});
});
