// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL MOUNTS: the descriptor, frames without a client, docKey routing,
// the full app on the LOCAL env, the one wiring module, and what degrades
// (T1, T2, T9, T12, R6, R7, R11)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeWorld } from 'shared/explorer/connect/testing';
import { findToolFactoryImports, installHostGridBridge, tabulatorSetSort } from 'shared/explorer/devtool/testing';
import { makeGraphEndpointStore, makeGraphHistory } from '../src/adapters/explorer';
import { remoteSession } from '../src/devtool/frame';
import type { IGraphFrameOptions } from '../src/devtool/frame';
import { CONTROLLER_NOT_READY_TEXT, DOC_STATE_TEXT, LANDING_TEXT, UNKNOWN_DOCUMENT_DESCRIPTION, UNKNOWN_DOCUMENT_TITLE, connectionDocState, controllerNotReadyError, frameFailureText, isNotSent, missingConnectionText, showsControllerBanner } from '../src/devtool/frameText';
import type { ConnectionDocState, IDocGates } from '../src/devtool/frameText';
import { askQuestion } from '../src/graph/ask';
import { describeFailureOf } from '../src/graph/failures';
import { OP, docKeyFor, routeDocKey } from '../src/devtool/protocol';
import { APP_HISTORY_PRIVACY_NOTE, DEVTOOL_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../src/env';
import type { DocTarget } from '../src/env';
import { createDataVersions } from '../src/graph/dataVersion';
import { createPreviewStore } from '../src/graph/previews';
import { createSchemaStore } from '../src/graph/schemaStore';
import { COPY_BLOCKED_NOTE, GRID_NOTICE } from '../src/graph/wording';
import { chooseWorkerStrategy } from '../src/layout/workerStrategy';
import { ExplorerToolError } from 'shared/explorer';
import { createRegionClaims } from '../src/realmRegion';
import { createLocalGraphEnv } from '../src/localEnv';
import { graphRow, mountController, mountFrame, readOnlyNode, signInVsCode, until, vscodeRealm } from './support/devtool';

const APP = path.resolve(__dirname, '..');
const SRC = path.join(APP, 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source without comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/**
 * Every source file reachable from an entry through relative imports (the module graph of one mount).
 *
 * @param entry - The entry, relative to src.
 * @returns The files, relative to src.
 */
function reachable(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (rel: string): void => {
		if (seen.has(rel)) return;
		seen.add(rel);
		const text = read(rel);
		for (const match of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) {
			const base = path.join(path.dirname(rel), match[1]);
			const file = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((candidate) => fs.existsSync(path.join(SRC, candidate)));
			if (file) visit(file);
		}
	};
	visit(entry);
	return [...seen].sort();
}

/**
 * Every .ts/.tsx file under src.
 *
 * @returns Their paths (relative to src) and text.
 */
function allSources(): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) out.push({ path: path.relative(SRC, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
		}
	};
	walk(SRC);
	return out;
}

describe('T1 - the descriptor declares both dev-tool mounts; the manifest says devTool; the id is unchanged', () => {
	it('AppDescriptor exports devToolFrame and devToolSidebar beside app, under rocketride.graph', () => {
		const descriptor = code(read('AppDescriptor.ts'));
		assert.match(descriptor, /id: 'rocketride\.graph',/);
		assert.match(descriptor, /app: GraphApp,/);
		assert.match(descriptor, /devToolFrame: GraphDevTool,/);
		assert.match(descriptor, /devToolSidebar: GraphDevToolSidebar,/);
		assert.match(descriptor, /import \{ GraphDevTool \} from '\.\/GraphDevToolFrame';/);
		assert.match(descriptor, /import \{ GraphDevToolSidebar \} from '\.\/GraphDevToolSidebar';/);
		const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
		assert.equal(pkg.appManifest.id, 'rocketride.graph');
		assert.ok(pkg.appManifest.categories.includes('devTool'), 'the manifest category the hosts list dev tools by');
		assert.ok(pkg.appManifest.categories.includes('tools'));
		const config = fs.readFileSync(path.join(APP, 'rsbuild.config.mts'), 'utf8');
		assert.match(config, /'\.\/AppDescriptor': '\.\/src\/AppDescriptor\.ts'/, 'the module federation expose is still ./AppDescriptor');
	});

	it('the two mount components are real exports (the frame imported with a stand-in Worker: Monaco\'s environment extends it at load)', async () => {
		const g = globalThis as { Worker?: unknown };
		const had = 'Worker' in g;
		if (!had) g.Worker = class {};
		try {
			const frame = await import('../src/GraphDevToolFrame');
			const sidebar = await import('../src/GraphDevToolSidebar');
			assert.equal(typeof frame.GraphDevTool, 'function');
			assert.equal(typeof sidebar.GraphDevToolSidebar, 'function');
		} finally {
			if (!had) delete g.Worker;
		}
	});
});

describe('T2 - frames hold no client', () => {
	const FRAME_ENTRY = 'GraphDevToolFrame.tsx';

	it('no module a frame loads reaches for a client, the ConnectionManager, the workspace prefs or the app\'s singleton stores', () => {
		const files = reachable(FRAME_ENTRY);
		assert.ok(files.includes('devtool/frame.ts') && files.includes('components/RunSurface.tsx') && files.includes('views/WorkbenchView.tsx'), 'the premise: the walk reaches the frame code and its views');
		for (const forbidden of ['devtool/controller.ts', 'localEnv.ts', 'adapters/actions.ts', 'adapters/react.ts', 'GraphApp.tsx', 'GraphSidebar.tsx', 'docs.ts']) {
			assert.ok(!files.includes(forbidden), `a frame loads ${forbidden}`);
		}
		for (const file of files) {
			const text = code(read(file));
			assert.doesNotMatch(text, /useShellConnection|ConnectionManager|getClient\(|getBusExplorerClient|RocketRideClient|usePrefs|shared\/explorer\/react/, `${file} reaches for a client or the workspace prefs`);
			if (file === 'adapters/explorer.ts') continue;
			assert.doesNotMatch(text, /import\s*\{[^}]*\b(graphEndpoints|graphHistory|dataVersions|schemas|appPreviews|activeConnection)\b[^}]*\}\s*from\s*'[./]*adapters\/explorer'/, `${file} imports one of the app's own stores`);
		}
	});

	it('a frame is built without a client: its options have none, and it works with no client anywhere in its realm', async () => {
		// @ts-expect-error a frame takes no ConnectionManager
		const typed: IGraphFrameOptions = { cm: {} };
		void typed;
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const endpoint = frame.env(true).endpoints.get().endpoints[0];
		const before = engine.requests.length;
		await frame.env(true).session(endpoint)?.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 5 });
		const engineCalls = engine.requests.slice(before).filter((r) => r.op === 'client.tool');
		assert.equal(engineCalls.length, 1, 'the engine call was made by the CONTROLLER\'s realm, over its bus');
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T9 - docKey routing for every family', () => {
	it('undefined (VS Code) and \'\' (rocket-ui) are the landing; workbench: and write: route by key; anything else is not found', () => {
		const key = 'k1|dev|user|u1|team-1|proj-1|tools=tools_1|graph_1';
		assert.deepEqual(routeDocKey(undefined), { kind: 'landing' });
		assert.deepEqual(routeDocKey(''), { kind: 'landing' });
		assert.deepEqual(routeDocKey(null), { kind: 'landing' });
		assert.deepEqual(routeDocKey(`workbench:${key}`), { kind: 'workbench', key });
		assert.deepEqual(routeDocKey(`write:${key}`), { kind: 'write', key });
		for (const unknown of ['workbench:', 'write:', 'connections', 'edit:*new*', key, 'console:x']) assert.deepEqual(routeDocKey(unknown), { kind: 'unknown', docKey: unknown });
		assert.equal(docKeyFor('workbench', key), `workbench:${key}`);
		assert.equal(docKeyFor('write', key), `write:${key}`);
	});

	it('the frame renders each route: the landing, a connection document, or the not-found empty state', () => {
		const frame = code(read('GraphDevToolFrame.tsx'));
		// Rod's generic frame (F1): one EmptyState, no landing list; the connection list lives in the sidebar.
		assert.match(frame, /if \(route\.kind === 'landing'\) \{\s*return \(\s*<div style=\{styles\.center\}>\s*<EmptyState icon=\{<GraphIcon \/>\} title=\{LANDING_TEXT\.title\} description=\{LANDING_TEXT\.description\} \/>/);
		assert.doesNotMatch(frame, /ConnectionsView/, 'the frame no longer imports the full app\'s landing');
		assert.ok(!reachable('GraphDevToolFrame.tsx').includes('views/ConnectionsView.tsx'), 'no module a frame loads reaches it');
		assert.match(frame, /if \(route\.kind === 'unknown'\) \{[\s\S]*?title=\{UNKNOWN_DOCUMENT_TITLE\} description=\{UNKNOWN_DOCUMENT_DESCRIPTION\}/);
		assert.match(frame, /return <FrameConnectionDocument kind=\{route\.kind\} endpointKey=\{route\.key\} gates=\{gates\} \/>;/);
		assert.match(frame, /<FrameBody route=\{frame\.route\} gates=\{gates\} \/>/);
	});
});

describe('T12 - the full app (app:) runs on the LOCAL env', () => {
	it('GraphApp provides the LOCAL env over its own stores and the realm\'s bus client, to its tree AND to the sidebar the shell renders apart', () => {
		const app = code(read('GraphApp.tsx'));
		assert.match(app, /const APP_STORES: IGraphStores = \{ endpoints: graphEndpoints, schemas, dataVersions, history: graphHistory, previews: appPreviews \};/);
		assert.match(app, /getBusExplorerClient\(ConnectionManager\.getInstance\(\)\)/);
		assert.match(app, /createLocalGraphEnv\(\{ mount: 'app', ready: isConnected, client, stores: APP_STORES,/);
		assert.match(app, /<GraphEnvProvider value=\{env\}><GraphSidebar \/><\/GraphEnvProvider>/);
		assert.match(app, /historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE/);
	});

	it('names a connection the way #2625 does: listTasks\'s status name, else the source component\'s name; keys unchanged', async () => {
		// A pipeline started with use(name='Shop Graph') and no pipeline name: getTasks names it by its source id.
		const started = graphRow({ name: 'tools_1', pipeline: { project_id: 'proj-1', components: [{ id: 'tools_1', provider: 'tools', name: 'Tools' }, ...(graphRow().pipeline?.components ?? []).filter((c) => c.id !== 'tools_1')] } });
		const discover = async (listed: Record<string, unknown>[] | null) => {
			const world = fakeWorld([started], readOnlyNode);
			if (listed) world.client.listTasks = async () => ({ rows: listed, total: listed.length, page: 1, pageSize: 100 });
			const stores = { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), schemas: createSchemaStore(), dataVersions: createDataVersions(), history: makeGraphHistory(0), previews: createPreviewStore() };
			const env = createLocalGraphEnv({ mount: 'app', ready: true, client: world.client, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: () => undefined, prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
			await env.refresh();
			return env.endpoints.get().endpoints.map((e) => [e.key, e.pipelineName]);
		};
		// listTasks's row for that run, with the run's display id built the way the server builds it.
		const named = await discover([{ id: `${started.token.replace(/^tk_/, '').slice(0, 8)}.${started.source}`, name: 'Shop Graph.Tools', projectId: 'proj-1', source: 'tools_1', runKind: 'dev', completed: false, state: 3 }]);
		const fallback = await discover(null);
		assert.ok(named.length > 0);
		assert.deepEqual(named.map(([, name]) => name), named.map(() => 'Shop Graph.Tools'));
		assert.deepEqual(fallback.map(([, name]) => name), fallback.map(() => 'Tools'));
		assert.deepEqual(named.map(([key]) => key), fallback.map(([key]) => key), 'names only');
	});

	it('the LOCAL env does what the full app did: discovery, a counted write, history, previews taken once, documents', async () => {
		const world = fakeWorld([graphRow()], readOnlyNode);
		const stores = { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), schemas: createSchemaStore(), dataVersions: createDataVersions(), history: makeGraphHistory(0), previews: createPreviewStore() };
		const memory = memoryPrefs();
		stores.history.attachPrefs(memory, 'owner');
		const opened: DocTarget[] = [];
		const env = createLocalGraphEnv({ mount: 'app', ready: true, client: world.client, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: (t) => opened.push(t), prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
		await env.refresh();
		const endpoint = env.endpoints.get().endpoints[0];
		assert.ok(endpoint, 'discovered');
		assert.equal(env.endpoints.get().omitted, 0);
		assert.equal(env.endpoints.get(), env.endpoints.get(), 'a stable snapshot between changes');
		await env.countWrite(endpoint.key, async () => 'sent');
		assert.equal(env.dataVersions.get(endpoint.key), 1, 'the write is counted in the call');
		env.markAbandonedWrite(endpoint.key);
		assert.equal(env.dataVersions.get(endpoint.key), 2);
		env.history.record(endpoint.key, { id: 'a', at: 1, kind: 'read', cypher: 'RETURN 1', ms: 1, outcome: 'rows', rows: 1 } as never);
		assert.equal(env.history.view(endpoint.key).get().entries.length, 1);
		assert.equal(env.history.view(endpoint.key).get(), env.history.view(endpoint.key).get(), 'a stable view');
		env.previews.request({ endpointKey: endpoint.key, action: 'label-preview', name: 'Person' });
		const pending = env.previews.pending.get();
		assert.ok(pending);
		assert.equal(env.previews.consume(pending.nonce), true);
		assert.equal(env.previews.consume(pending.nonce), false);
		assert.equal(env.previews.pending.get(), null, 'a workbench that mounts later finds nothing');
		await env.loadSchema(endpoint.key);
		assert.ok(env.schemaLabels.get(endpoint.key).length > 0);
		assert.equal(env.schemaLabels.get(endpoint.key), env.schemaLabels.get(endpoint.key), 'stable labels');
		env.openDocument({ kind: 'connections' });
		assert.deepEqual(opened, [{ kind: 'connections' }]);
		assert.equal(env.session(endpoint)?.endpoint.key, endpoint.key);
		const offline = createLocalGraphEnv({ mount: 'app', ready: false, client: null, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: () => undefined, prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
		assert.equal(offline.session(endpoint), null, 'no session while not connected');
	});

	it('every view reaches the engine through the env: the six useShellConnection call sites are gone from the views', () => {
		for (const file of ['GraphSidebar.tsx', 'components/AskBar.tsx', 'components/RunSurface.tsx', 'views/ConnectionsView.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx', 'components/HistoryPanel.tsx']) {
			const text = code(read(file));
			assert.doesNotMatch(text, /useShellConnection|usePrefs|getDocs\(|graphEndpoints|graphHistory|workbenchRequests/, `${file} still reaches past the env`);
			assert.match(text, /useGraphEnv\(\)|useGraphEndpoints\(\)/, `${file} reads the env`);
		}
		const users = allSources().filter((f) => /\buseShellConnection\(\)/.test(code(f.text))).map((f) => f.path).sort();
		assert.deepEqual(users, ['GraphApp.tsx', 'GraphDevToolSidebar.tsx'], 'only the two LOCAL mount roots read the shell connection');
		const prefs = allSources().filter((f) => /\busePrefs\(\)/.test(code(f.text))).map((f) => f.path);
		assert.deepEqual(prefs, ['GraphApp.tsx'], 'only the full app reads the workspace prefs (a dev-tool mount would write into the host\'s bag)');
	});
});

describe('R6 - one wiring module; mounts built in effects', () => {
	it('createToolChannel, createToolOpServer and createToolController are imported from shell in ONE module', () => {
		assert.deepEqual(findToolFactoryImports(allSources()), ['devtool/wiring.ts']);
	});

	it('the sidebar builds its controller, and the frame its caller, in an effect with a disposing cleanup, never in a memo', () => {
		const sidebar = code(read('GraphDevToolSidebar.tsx'));
		assert.match(sidebar, /useEffect\(\(\) => \{[\s\S]*?const created = createGraphController\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(sidebar, /useMemo\(\(\) => createGraphController|peer\.subscribe/);
		const frame = code(read('GraphDevToolFrame.tsx'));
		assert.match(frame, /useEffect\(\(\) => \{[\s\S]*?const created: IGraphFrame = createGraphFrame\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(frame, /useMemo\(\(\) => createGraphFrame|peer\.subscribe/);
	});
});

describe('the dev-tool sidebar lists connections as Rod\'s rows; the full app keeps its menu', () => {
	const sidebar = (): string => code(read('GraphSidebar.tsx'));
	/** The JSX the sidebar renders in one mount: the devtool branch or the full app's. */
	const branch = (text: string, which: 'devtool' | 'app'): string => {
		const start = text.indexOf('{devtool ? (');
		const mid = text.indexOf(') : (', start);
		const end = text.indexOf(')}', mid);
		assert.ok(start > 0 && mid > start && end > mid, 'the premise: one devtool ? (...) : (...) switch');
		return which === 'devtool' ? text.slice(start, mid) : text.slice(mid, end);
	};

	it('under devtool: an uppercase "Connections" label with a Refresh header action, hand-built rows, and the list line; no SidebarMenu, no sectionLabel', () => {
		const devtool = branch(sidebar(), 'devtool');
		assert.match(devtool, /<span style=\{styles\.sectionLabel\}>Connections<\/span>/);
		// CE-7: aria-disabled, never `disabled`: a disabled button drops the keyboard focus to the page (and the cluster fades).
		assert.match(sidebar(), /const refreshBlocked = !isConnected \|\| status === 'loading';/);
		assert.match(devtool, /<button type="button" style=\{refreshBlocked \? styles\.headerActionBlocked : styles\.headerAction\} title="Refresh connections" aria-label="Refresh connections" aria-disabled=\{refreshBlocked\} onClick=\{[^\n]*\}>\s*<BxRefresh size=\{18\} \/>/);
		assert.doesNotMatch(devtool, /\sdisabled=\{/, 'focus stays on the action while discovery runs');
		assert.match(devtool, /<div style=\{styles\.headerActions\(paneHovered \|\| paneFocused\)\}>/, 'shown on hover and while focus is inside, so a keyboard reaches it');
		assert.match(devtool, /onClick=\{\(\) => \{ if \(!refreshBlocked\) void env\.refresh\(\); \}\}/, 'an activation while blocked does nothing');
		assert.match(sidebar(), /headerActionBlocked: \{ \.\.\.commonStyles\.paneHeaderButton, opacity: 0\.4, cursor: 'default' \} as CSSProperties/, 'and looks unavailable');
		assert.doesNotMatch(devtool, /<SidebarMenu|sectionLabel=/, 'the list is not a SidebarMenu (S2, S9)');
		assert.match(devtool, /\{line && <div style=\{line\.tone === 'error' \? styles\.error : styles\.empty\}/);
	});

	it('a row is Rod\'s anatomy: role button, tabIndex, Enter/Space, tooltip and accessible name with the state, an icon slot, and a dot plus a text suffix', () => {
		const devtool = branch(sidebar(), 'devtool');
		const row = devtool.slice(devtool.indexOf('<div\n'), devtool.indexOf('</div>', devtool.indexOf('<div\n')));
		for (const attr of [/role="button"/, /tabIndex=\{0\}/, /title=\{row\.tooltip\}/, /aria-label=\{row\.ariaLabel\}/, /onClick=\{\(\) => select\(e\.key\)\}/, /onKeyDown=\{\(event\) => \{ if \(event\.key === 'Enter' \|\| event\.key === ' '\) \{ event\.preventDefault\(\); select\(e\.key\); \} \}\}/]) {
			assert.match(row, attr);
		}
		assert.match(row, /<span style=\{styles\.rowIcon\(active\)\}><GraphIcon \/><\/span>/);
		assert.match(row, /<span style=\{styles\.rowLabel\}>\{row\.label\}<\/span>/);
		assert.match(row, /\{row\.status !== null && <span style=\{styles\.rowStatus\}>\{row\.status\}<\/span>\}/, 'the state in words, not colour alone');
		assert.match(row, /<span style=\{styles\.dot\(row\.variant\)\} aria-hidden="true" \/>/);
		assert.match(sidebar(), /dot: \(variant: IBadge\['variant'\]\): CSSProperties => panelStyles\.dot\(DOT_COLOR\[variant\]\)/);
	});

	it('the full app keeps its menu exactly: the "Connections" entry with its count, under "Graph Explorer"', () => {
		const app = branch(sidebar(), 'app');
		assert.match(app, /<SidebarMenu menu=\{menu\} activeId=\{activeKey \? '' : 'connections'\} onSelect=\{select\} sectionLabel="Graph Explorer" \/>/);
		assert.match(sidebar(), /const menu: ViewMenu = useMemo\(\(\) => \(\{ entries: \[\{ id: 'connections', label: 'Connections', icon: <GraphIcon \/>, \.\.\.\(endpoints\.length > 0 \? \{ count: endpoints\.length \} : \{\}\) \}\] \}\), \[endpoints\.length\]\);/);
	});

	it('the sidebar keeps its styles in `styles` (no inline style objects)', () => {
		assert.doesNotMatch(sidebar(), /style=\{\{/);
	});
});

describe('R7 - the sidebar opens documents only on a click', () => {
	it('GraphSidebar calls openDocument and previews.request from its click handlers only, never from an effect', () => {
		const sidebar = code(read('GraphSidebar.tsx'));
		const effects = [...sidebar.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
		assert.ok(effects.length > 0, 'the premise: the sidebar has effects');
		for (const effect of effects) assert.doesNotMatch(effect, /openDocument|previews\.request/);
		const select = sidebar.slice(sidebar.indexOf('const select = '), sidebar.indexOf('const open = '));
		assert.match(select, /env\.openDocument\(/);
	});
});

describe('one live region per realm (rocket-ui runs several Graph documents in one realm)', () => {
	it('the first mounted region is the one that speaks; when it unmounts the next takes over; none is left after the last', () => {
		const claims = createRegionClaims();
		const a = {};
		const b = {};
		const c = {};
		claims.claim(a);
		claims.claim(b);
		claims.claim(c);
		assert.equal(claims.owner(), a, 'exactly one region speaks');
		let changes = 0;
		const off = claims.subscribe(() => { changes += 1; });
		claims.release(a);
		assert.equal(claims.owner(), b, 'the next one takes over');
		claims.release(c);
		assert.equal(claims.owner(), b);
		claims.release(b);
		assert.equal(claims.owner(), null);
		claims.claim(a);
		claims.claim(a);
		claims.release(a);
		assert.equal(claims.owner(), null, 'a claim is per token, not counted twice');
		assert.ok(changes > 0);
		off();
	});

	it('every mount renders the realm\'s region, portalled to the page so a hidden tab cannot silence it', () => {
		for (const file of ['GraphDevToolFrame.tsx', 'GraphApp.tsx']) {
			const text = code(read(file));
			assert.match(text, /<RealmLiveRegion \/>/, `${file} renders the realm's region`);
			assert.doesNotMatch(text, /<LiveRegion \/>/, `${file} renders no region of its own`);
		}
		const region = code(read('components/RealmLiveRegion.tsx'));
		assert.match(region, /createPortal\(<LiveRegion \/>, document\.body\)/);
	});
});

describe('what a frame says when it cannot reach the controller', () => {
	it('a call that was never sent because no controller is up says to open the sidebar, not the op\'s name; a dropped call says nothing', () => {
		const notSent = new ExplorerToolError({ kind: 'timeout', tool: 'graph.refreshEndpoints', message: "'graph.refreshEndpoints' was not sent: the tool's controller did not become ready within 15s." });
		assert.equal(frameFailureText(notSent, false), CONTROLLER_NOT_READY_TEXT);
		assert.doesNotMatch(CONTROLLER_NOT_READY_TEXT, /graph\./);
		assert.equal(frameFailureText(new ExplorerToolError({ kind: 'stale', tool: 'x', message: 'dropped' }), true), null);
		assert.equal(frameFailureText(new ExplorerToolError({ kind: 'unavailable', tool: 'x', message: 'Not signed in.' }), true), 'Not signed in.');
	});

	it('the base caller\'s REAL "was not sent" failure (no controller became ready) reads as "open the sidebar" for Run and Ask too; a call that was sent keeps its own failure', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.controller.dispose();
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.connected.get() === true, 'the host connection reached the frame');
		const notSent = await frame.caller.callReply(OP.historyList, { key: 'k1|x' }, { timeoutMs: 30 }).then(() => null, (error: unknown) => error);
		assert.ok(isNotSent(notSent), `the premise: the base's own failure for a call no controller took (${String((notSent as Error)?.message)})`);
		assert.equal(frameFailureText(notSent, false), CONTROLLER_NOT_READY_TEXT);
		const endpoint = { key: 'k1|x', nodeName: 'People graph' } as never;
		const noController = remoteSession({ callReply: () => Promise.reject(notSent), controllerReady: () => false } as never, endpoint, () => null);
		for (const [tool, input] of [['read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 5 }], ['execute', { query: 'CREATE (n)', shape: 'graph' }], ['get_query', { question: 'q' }]] as const) {
			await assert.rejects(noController.invoke(tool, input), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.message === CONTROLLER_NOT_READY_TEXT && error.tool === tool, `${tool}: not sent, so it cannot have run`);
		}
		const lost = new ExplorerToolError({ kind: 'timeout', tool: 'graph.readQuery', message: "Lost the connection while 'graph.readQuery' was running. It may still have run; there is no way to cancel it from here." });
		const sent = remoteSession({ callReply: () => Promise.reject(lost), controllerReady: () => false } as never, endpoint, () => null);
		await assert.rejects(sent.invoke('read_query', { cypher: 'x', params: {}, limit: 5 }), (error: unknown) => error === lost, 'a call that was sent keeps "may still have run"');
		const ready = remoteSession({ callReply: () => Promise.reject(notSent), controllerReady: () => true } as never, endpoint, () => null);
		await assert.rejects(ready.invoke('read_query', { cypher: 'x', params: {}, limit: 5 }), (error: unknown) => error === notSent, 'with a controller up the failure is its own');
		frame.dispose();
	});

	it('Run and Ask describe a call no controller took as "open the sidebar", with no pipeline hint under it', async () => {
		const notice = describeFailureOf(CONTROLLER_NOT_READY_TEXT, controllerNotReadyError('read_query'), false);
		assert.equal(notice.headline, CONTROLLER_NOT_READY_TEXT);
		assert.equal(notice.hint, null, 'not "Start the pipeline": the pipeline is not the problem');
		const asked = await askQuestion('who?', () => Promise.reject(controllerNotReadyError('get_query')), 'no model');
		assert.ok(asked.kind === 'failed' && asked.headline === CONTROLLER_NOT_READY_TEXT && asked.hint === null, 'Ask says the same, not "unavailable for this pipeline"');
	});

	it('the frame mount keeps its styles in `styles` (no inline style objects)', () => {
		assert.doesNotMatch(code(read('GraphDevToolFrame.tsx')), /style=\{\{/);
	});

	it('a connection a document cannot find says why: no sidebar yet, still looking, left out of a capped list, or not listed', () => {
		// No sidebar yet is decided before the list is looked at (F13), and says to open the sidebar.
		assert.equal(connectionDocState({ host: true, summon: 'unanswered', signIn: 'pending', found: false, opened: false }), 'no-sidebar');
		assert.match(DOC_STATE_TEXT['no-sidebar'].title, /^Open the Graph Explorer sidebar to connect$/);
		assert.match(missingConnectionText('loading', 0).title, /Looking/);
		assert.match(missingConnectionText('ready', 12).description, /too many connections/);
		assert.match(missingConnectionText('ready', 0).description, /not running, or it belongs to another account/);
	});

	it('frame texts point at the sidebar, never at the removed Connections landing (Rod\'s wording)', () => {
		assert.deepEqual(LANDING_TEXT, { title: 'Graph Explorer', description: 'Open a connection from the sidebar. Connections are the graph nodes of your running pipelines.' });
		assert.equal(UNKNOWN_DOCUMENT_TITLE, 'Document not found');
		assert.equal(UNKNOWN_DOCUMENT_DESCRIPTION, 'This Graph Explorer document no longer exists. Pick a connection in the sidebar.');
		for (const text of [missingConnectionText('ready', 12), missingConnectionText('ready', 0)]) {
			assert.match(text.description, /Pick a connection in the sidebar\.$/);
			assert.doesNotMatch(text.description, /Open Connections/);
		}
		assert.match(missingConnectionText('ready', 1).description, /too many connections/);
	});

	it('CE-1: no module a frame loads opens the connection details as a drawer; they are an inline panel there', () => {
		const files = reachable('GraphDevToolFrame.tsx');
		assert.ok(files.includes('components/ConnectionDetailsPanel.tsx') && files.includes('components/ConnectionDetails.tsx'), 'the premise: the frame reaches the inline panel');
		assert.ok(!files.includes('components/ConnectionDrawer.tsx'), 'the drawer is the full app\'s');
		for (const file of files) assert.doesNotMatch(code(read(file)), /\bcontained\b/, `${file} anchors an overlay to a document`);
	});

	it('a frame document offers no "Open Connections" button: in a dev tool the sidebar is the list', () => {
		const frame = code(read('GraphDevToolFrame.tsx'));
		assert.doesNotMatch(frame, /Open Connections|kind: 'connections'|<Button/);
	});
});

describe('F13 - what a connection document shows: the first state that applies wins', () => {
	const base: IDocGates & { found: boolean; opened: boolean } = { host: true, summon: 'ready', signIn: 'signed-in', found: true, opened: false };
	const state = (over: Partial<typeof base>): ConnectionDocState => connectionDocState({ ...base, ...over });

	it('the order: host false, host unknown, summoning, unanswered, nobody signed in, then the list', () => {
		assert.equal(state({ host: false, summon: 'unanswered', signIn: 'nobody', found: false }), 'not-connected', '1. the host says it is not connected');
		assert.equal(state({ host: undefined, summon: 'unanswered', signIn: 'nobody', found: false }), 'waiting', '2. the host has not said yet: never "not connected"');
		assert.equal(state({ summon: 'summoning', signIn: 'nobody', found: false }), 'starting', '3. the controller is being summoned: quiet');
		assert.equal(state({ summon: 'unanswered', signIn: 'nobody', found: false }), 'no-sidebar', '4. nothing answered the summon');
		assert.equal(state({ signIn: 'nobody' }), 'sign-in', '5. the controller vouches for nobody: wait for sign-in, not "not connected"');
		assert.equal(state({ signIn: 'nobody', found: true, opened: true }), 'sign-in', 'even for a document that had opened');
		assert.equal(state({ signIn: 'pending', found: false }), 'missing', '6. pending says nothing about the account: the list decides');
		assert.equal(state({ signIn: 'pending', found: true }), 'open');
		assert.equal(state({}), 'open');
		assert.equal(state({ found: false }), 'missing');
	});

	it('a document that has opened stays on screen while its controller is summoned again (no unmount, so results survive); one that has not, waits', () => {
		assert.equal(state({ summon: 'summoning', opened: true }), 'open');
		assert.equal(state({ summon: 'unanswered', opened: true }), 'open');
		assert.equal(state({ summon: 'summoning', opened: true, found: false }), 'starting', 'only while its connection is still listed');
		assert.equal(state({ summon: 'summoning', opened: false }), 'starting');
		assert.equal(state({ summon: 'unanswered', opened: false }), 'no-sidebar');
		assert.equal(state({ host: false, opened: true }), 'not-connected', 'the host state still comes first');
	});

	it('CE-3: nobody signed in wins over that: an open document whose summon is in a gap waits for sign-in instead of showing the workbench again', () => {
		assert.equal(state({ summon: 'summoning', signIn: 'nobody', opened: true }), 'sign-in');
		assert.equal(state({ summon: 'unanswered', signIn: 'nobody', opened: true }), 'sign-in');
		assert.equal(state({ summon: 'summoning', signIn: 'pending', opened: true }), 'open', 'pending says nothing about the account: the document stays');
		assert.equal(state({ summon: 'unanswered', signIn: 'signed-in', opened: true }), 'open');
		assert.equal(state({ summon: 'summoning', signIn: 'nobody', opened: true, found: false }), 'starting', 'not on screen (its connection is not listed): the F13 order as for any document');
		assert.equal(state({ summon: 'summoning', signIn: 'nobody', opened: false }), 'starting', 'a document that never opened keeps the F13 order');
	});

	it('the controller banner shows on an open document only once the summon went unanswered, never while it is summoning', () => {
		assert.equal(showsControllerBanner('open', 'unanswered'), true);
		assert.equal(showsControllerBanner('open', 'summoning'), false);
		assert.equal(showsControllerBanner('open', 'ready'), false);
		for (const other of ['not-connected', 'waiting', 'starting', 'no-sidebar', 'sign-in', 'missing'] as const) assert.equal(showsControllerBanner(other, 'unanswered'), false, other);
	});

	it('each state says one short title and one sentence, in the F2 style', () => {
		assert.deepEqual(DOC_STATE_TEXT['not-connected'], { title: 'Not connected', description: 'Connect to a RocketRide server to open this document.' });
		assert.deepEqual(DOC_STATE_TEXT.waiting, { title: 'Waiting for the server connection…', description: 'This document opens once the host reports the server connection.' });
		assert.equal(DOC_STATE_TEXT.starting.title, 'Starting Graph Explorer…');
		assert.match(DOC_STATE_TEXT.starting.description, /^[^.]+\.$/, 'one sentence');
		assert.equal(DOC_STATE_TEXT['no-sidebar'].title, 'Open the Graph Explorer sidebar to connect');
		assert.deepEqual(DOC_STATE_TEXT['sign-in'], { title: 'Waiting for sign-in', description: 'Sign in to RocketRide to open this document.' });
		for (const [kind, text] of Object.entries(DOC_STATE_TEXT)) {
			assert.doesNotMatch(`${text.title} ${text.description}`, /graph\.|Open Connections/, `${kind} names an op or the removed landing`);
		}
		assert.doesNotMatch(`${DOC_STATE_TEXT['sign-in'].title} ${DOC_STATE_TEXT['sign-in'].description}`, /Not connected/);
	});

	it('the frame decides through connectionDocState, and the banner sits on the open document alone (not above every route)', () => {
		const frame = code(read('GraphDevToolFrame.tsx'));
		const doc = frame.slice(frame.indexOf('const FrameConnectionDocument'));
		assert.match(doc, /connectionDocState\(\{ host: gates\.host, summon: gates\.summon, signIn: gates\.signIn, found: endpoint !== null, opened: opened\.current \}\)/);
		assert.match(doc, /showsControllerBanner\(state, gates\.summon\) && \(/);
		// The "has opened" mark is written by an effect after a commit that showed the view, never during render.
		assert.match(doc, /useEffect\(\(\) => \{\s*if \(state === 'open'\) opened\.current = true;\s*\}, \[state\]\);/);
		assert.equal(doc.match(/opened\.current = true/g)?.length, 1, 'no write of the ref in the render path');
		const root = frame.slice(frame.indexOf('const FrameRoot'), frame.indexOf('export const FrameBody'));
		assert.doesNotMatch(root, /<Banner/, 'no banner above every route');
		assert.match(root, /const gates: IDocGates = \{ host, summon, signIn \};/);
	});
});

describe('grid layouts are copies everywhere: a frame keeps them in the session, the full app in its own prefs', () => {
	/** The test runner's 'shell' module (stub-shell.cjs's one object). */
	const shell = (): Record<string, unknown> => createRequire(__filename)('shell') as Record<string, unknown>;

	it('a frame env hands its grids the realm\'s session persistence, which copies in and out and never writes the host\'s prefs', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		const { frame } = mountFrame(mounted.h, undefined);
		const { frame: other } = mountFrame(mounted.h, undefined);
		// Installed once everything is mounted, so only the persistence calls see the stand-in document.
		const host = installHostGridBridge(shell());
		const grids = frame.env(true).gridPersistence;
		try {
			assert.equal(other.env(true).gridPersistence, grids, 'one store per realm: another frame of the realm shares it');
			grids.write('graph-frame-probe', 'sort', [{ column: 'name', dir: 'asc' }]);
			tabulatorSetSort(grids.read('graph-frame-probe', 'sort'));
			assert.deepEqual(grids.read('graph-frame-probe', 'sort'), [{ column: 'name', dir: 'asc' }], 'Tabulator rewriting what it read never reaches the stored layout');
			assert.deepEqual(host.prefs.tableLayouts, {}, 'the host\'s prefs are never written');
		} finally {
			grids.clear('graph-frame-probe');
			other.dispose();
			frame.dispose();
			mounted.controller.dispose();
			host.uninstall();
		}
	});

	it('every grid with a tableId, in any source file, takes the env\'s persistence', () => {
		const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((rel) => /\.tsx?$/.test(rel));
		const persisted = files.filter((rel) => /tableId=/.test(read(rel)));
		assert.ok(persisted.includes(path.join('components', 'ResultViews.tsx')), persisted.join(', '));
		for (const rel of persisted) {
			const text = read(rel);
			assert.equal((text.match(/persistence=\{env\.gridPersistence\}/g) ?? []).length, (text.match(/tableId=/g) ?? []).length, `${rel}: every persisted grid`);
		}
		assert.match(read('devtool/frame.ts'), /gridPersistence: SESSION_GRIDS,/);
	});

	it('the full app keeps layouts in its own prefs through the shell\'s channel, but hands Tabulator copies; the controller never writes the host\'s prefs', () => {
		const host = installHostGridBridge(shell());
		let controller: ReturnType<typeof createLocalGraphEnv>['gridPersistence'] | null = null;
		try {
			// #2625's channel alone hands a grid the host's own stored object.
			// This is what put a Tabulator column into the prefs and froze the save.
			host.prefs.tableLayouts['probe'] = { sort: [{ column: 'name', dir: 'asc' }] };
			tabulatorSetSort(host.bareChannel().read('probe', 'sort'));
			assert.throws(() => JSON.stringify(host.prefs), /circular/i, '#2625\'s channel hands out the host\'s object');
			delete host.prefs.tableLayouts['probe'];

			const options = (mount: 'app' | 'controller') => ({ mount, ready: true, client: null, stores: { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), schemas: createSchemaStore(), dataVersions: createDataVersions(), history: makeGraphHistory(0), previews: createPreviewStore() }, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: () => undefined, prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
			const grids = createLocalGraphEnv(options('app')).gridPersistence;
			host.prefs.tableLayouts['graph-results-k'] = { sort: [{ column: 'name', dir: 'asc' }] };
			const handed = grids.read('graph-results-k', 'sort');
			assert.deepEqual(handed, [{ column: 'name', dir: 'asc' }], 'the stored layout is read from the app\'s prefs');
			tabulatorSetSort(handed);
			assert.doesNotThrow(() => JSON.stringify(host.prefs), 'so the next workspace save can serialize them');
			const blob = [{ column: 'name', dir: 'desc' }];
			grids.write('graph-results-k', 'sort', blob);
			tabulatorSetSort(blob);
			assert.deepEqual(host.prefs.tableLayouts['graph-results-k'], { sort: [{ column: 'name', dir: 'desc' }] }, 'a write reaches the prefs as a plain copy');

			controller = createLocalGraphEnv(options('controller')).gridPersistence;
			assert.notEqual(controller, grids);
			controller.write('graph-controller-k', 'sort', [{ column: 'name', dir: 'asc' }]);
			assert.equal('graph-controller-k' in host.prefs.tableLayouts, false, 'a dev-tool controller keeps any layout in the session');
		} finally {
			controller?.clear('graph-controller-k');
			host.uninstall();
		}
	});
});

describe('R11 - what cannot work in a dev-tool mount degrades visibly', () => {
	it('the history note says where each mount keeps history', () => {
		assert.match(APP_HISTORY_PRIVACY_NOTE, /workspace file on the server/);
		assert.match(DEVTOOL_HISTORY_PRIVACY_NOTE, /rocketride\.graph\.history\.json/);
		assert.match(DEVTOOL_HISTORY_PRIVACY_NOTE, /session only/);
		assert.match(code(read('components/HistoryPanel.tsx')), /\{env\.historyPrivacyNote\}/);
	});

	it('a layout worker the window cannot start (a VS Code webview loading the remote from the engine) falls back to the grid, with a note', () => {
		const strategy = chooseWorkerStrategy({ workerUrl: 'http://127.0.0.1:5565/apps/rocketride.graph/v3/static/js/async/graph-layout.js', pageHref: 'vscode-webview://abc123/index.html', production: true, hasWorker: true });
		assert.equal(strategy.kind, 'unavailable');
		assert.match(code(read('components/GraphView.tsx')), /layoutStatus\.state === 'fallback' && \([\s\S]*?\$\{GRID_NOTICE\} \(\$\{layoutStatus\.detail\}\)/);
		assert.match(GRID_NOTICE, /grid/);
	});

	it('a blocked clipboard leaves the text on screen to copy by hand (Raw view and inspector)', () => {
		assert.match(COPY_BLOCKED_NOTE, /select it/);
		const raw = code(read('components/ResultViews.tsx'));
		assert.match(raw, /\{blocked !== null && <CopyBlocked text=\{blocked\} \/>\}/);
		assert.match(raw, /<textarea readOnly value=\{text\}/);
		assert.match(code(read('components/InspectorPanel.tsx')), /\{blocked !== null && blocked === m\.json && <CopyBlocked text=\{blocked\} \/>\}/);
	});
});
