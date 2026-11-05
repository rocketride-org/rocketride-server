// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WIRING: the React-side rules, pinned by reading the source, and the per-connection objects
// =============================================================================
//
// No React renderer runs under node:test. Logic lives in pure modules with
// unit tests; the rules that decide whether the UI stays in step with them
// (the console is the first view, the map a tab, Cancel focused, no token
// or configuration rendered, identity reset wired) are pinned here.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IExplorerEndpoint } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { makeConsoleActions, removeTargets, showAnswerOnMap } from '../src/adapters/consoleActions';
import { connectionEntry, entryCount, existingEntry } from '../src/adapters/connections';
import { connectionCaches } from '../src/adapters/explorer';
import { DEFAULT_LIMITS } from '../src/vector/results';

const SRC = path.resolve(__dirname, '..', 'src');

/** A source file without its comments. */
function code(file: string): string {
	return fs
		.readFileSync(path.join(SRC, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

/** Every file of the console's own lane (the map's and the chat/ingest components belong to their lanes). */
const LANE_FILES = [
	'VectorApp.tsx',
	'VectorSidebar.tsx',
	'AppDescriptor.ts',
	'docs.ts',
	'styles.ts',
	'icons.tsx',
	'adapters/explorer.ts',
	'adapters/actions.ts',
	'adapters/connections.ts',
	'adapters/consoleActions.ts',
	'adapters/react.ts',
	'env.ts',
	'envContext.tsx',
	'localEnv.ts',
	// The dev-tool mounts follow the same rules (no token, no configuration, no page key listeners, no browser storage).
	'VectorDevTool.tsx',
	'VectorDevToolSidebar.tsx',
	'realmRegion.ts',
	'devtool/protocol.ts',
	'devtool/controller.ts',
	'devtool/frame.ts',
	'devtool/frameText.ts',
	'devtool/wiring.ts',
	'components/DevToolConnectionList.tsx',
	'components/InlineRemoveConfirm.tsx',
	'components/ConnectionDetailsPanel.tsx',
	'components/RealmLiveRegion.tsx',
	'components/StatsStrip.tsx',
	'components/StatsCharts.tsx',
	'components/ScopeBar.tsx',
	'components/HealthPanel.tsx',
	'components/DocumentDirectory.tsx',
	'components/DocumentRow.tsx',
	'components/ChunkList.tsx',
	'components/RemoveConfirmDialog.tsx',
	'components/MultiRemoveConfirmDialog.tsx',
	'components/RemoveDialogHost.tsx',
	'components/ConnectionDrawerDetails.tsx',
	'components/SupportBadge.tsx',
	'views/ConnectionsView.tsx',
	'views/ConsoleView.tsx',
	'views/DocumentView.tsx',
	...fs
		.readdirSync(path.join(SRC, 'vector'))
		.filter((f) => /^(addresses|budgets|chartTokens|charts|colors|confirm|connections|consoleModel|consoleStore|documents|fileType|filters|health|identityChange|layout|results|savedFilters|stats|support|wording)\.ts$/.test(f))
		.map((f) => `vector/${f}`),
];

/** An endpoint for the registry tests. */
function endpoint(key: string): IExplorerEndpoint {
	return { key, legacyKey: null, projectId: 'vp', pipelineName: 'Vector docs', runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't1', roles: { tools: { source: 'tools_1' }, chat: null, ingest: null }, missingRoles: ['chat', 'ingest'], source: 'tools_1', nodeId: 'store_1', nodeName: 'Store', provider: 'qdrant', state: 'ready', running: true, components: [], anchorRole: 'tools', readOnly: false };
}

test('every lane file exists (the premise of the checks below)', () => {
	assert.ok(LANE_FILES.length >= 35, String(LANE_FILES.length));
	for (const file of LANE_FILES) assert.ok(fs.existsSync(path.join(SRC, file)), file);
});

test("a document tab and the console both front the connection's console tab for map and chat actions", () => {
	// From a document tab, "Show chunk path on map" and the per-chunk "map" must land on the visible map, not
	// leave the document tab in front with the map hidden behind it (APP_SPEC R9: every action lands back in the console).
	const app = code('VectorApp.tsx');
	assert.match(app, /import ConnectionsView, \{ openConsole \} from '\.\/views\/ConnectionsView';/);
	assert.match(app, /makeConsoleActions\(entry, \{[\s\S]*?showConsole: \(\) => openConsole\(entry\.ctx\.endpoint\),[\s\S]*?\}\)/);
	// The console is also a dev-tool frame's document, so it fronts the console through its mount's env (the full
	// app's env opens it with openConsole, tests/devtool.env.test.ts), never through the full app's landing.
	const view = code('views/ConsoleView.tsx');
	assert.doesNotMatch(view, /from '\.\/ConnectionsView'/);
	assert.match(view, /makeConsoleActions\(entry, \{[\s\S]*?showConsole: \(\) => env\.openConsole\(entry\.ctx\.endpoint\),[\s\S]*?\}\)/);
	assert.match(app, /createLocalVectorEnv\(\{[^}]*openConsole, openDocument: openDocumentTab \}\)/, "and the full app's env is the landing's openConsole");
});

test('the console is the first view of a connection: the landing and the sidebar open its console', () => {
	assert.match(code('views/ConnectionsView.tsx'), /openStaticDocument\(consoleUri\(endpoint\.key\)/);
	assert.match(code('views/ConnectionsView.tsx'), /Elasticsearch and OpenSearch stores are not listed\./, "the landing's help text says which stores are left out");
	assert.match(code('VectorSidebar.tsx'), /openConsole\(endpoint\)/);
	const app = code('VectorApp.tsx');
	assert.match(app, /if \(isConsoleUri\(uri\)\)[\s\S]*<ConsoleView key=\{uri\} opened=\{payload\.endpoint\} active=\{active\} \/>/);
	assert.match(app, /docs\.openStaticDocument\(CONNECTIONS_URI, 'Connections'\)/, 'the landing opens with the app');
});

test('a document tab is told when it is in front, and scores its chunks against the query only then', () => {
	const app = code('VectorApp.tsx');
	assert.match(app, /if \(isDocumentUri\(uri\)\)[\s\S]*<DocumentTab key=\{uri\} payload=\{payload\} active=\{active\} \/>/);
	assert.match(app, /<DocumentView [^>]*active=\{active\}/);
	const view = code('views/DocumentView.tsx');
	assert.match(view, /if \(!active \|\| query === null \|\| !embedReady/, 'a hidden tab (every editor stays mounted) sends nothing');
	assert.match(view, /heat\.query === query && heat\.chunks === chunkCount\) return undefined;/, 'coming back to the same query does not score again');
});

test('the Map is a tab of the console: both stay mounted, the map is told when it is visible', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /display: tab === 'console' \? 'flex' : 'none'/);
	assert.match(view, /display: tab === 'map' \? 'flex' : 'none'/);
	assert.match(view, /<MapView model=\{mapModel\} channels=\{channels\} selection=\{entry\.selection\} actions=\{actions\} visible=\{active && tab === 'map'\} documents=\{entry\.documents\} writes=\{entry\.writes\} \/>/);
	assert.match(view, /const nextMapScope = mapScopeFor\(mapScope, wiring\);\s*if \(nextMapScope !== mapScope\) setMapScope\(nextMapScope\);/, 'the map keeps the scope it drew with while a new one finds its documents');
	assert.match(view, /const mapModel = useMemo\(\(\) => \(nextMapScope === \(model\.scope \?\? null\) \? model : \{ \.\.\.model, scope: nextMapScope \}\), \[model, nextMapScope\]\)/);
	assert.match(view, /\{ id: 'console', label: 'Console' \},\s*\{ id: 'map', label: 'Map' \}/);
});

test('the console renders the strip, the directory, the chunks, adding documents and the chat, and paces itself through its controller', () => {
	const view = code('views/ConsoleView.tsx');
	for (const part of ['<StatsStrip', '<DocumentDirectory', '<ChunkList', '<IngestPanel', '<ChatPanel']) assert.ok(view.includes(part), part);
	assert.match(view, /entry\.controller\.setVisible\(active\)/, 'hidden: no quick stats, the directory pauses');
	assert.match(view, /entry\.controller\.setWritesEnabled\(model\.writes\.enabled\)/, 'nothing is confirmed or sent while writes are off');
	assert.match(view, /writes=\{writesDuringRemoval\(model\.writes, state\.removal\.status\)\}/, 'the trash follows the model, and is disabled while a removal runs');
	assert.match(view, /\(state\.removal\.status === 'running' \|\| state\.removal\.message\) &&/, 'the status line says Removing… while a removal runs');
	assert.match(view, /entry\.controller\.open\(\)/);
	assert.match(view, /consoleColumns\(width\)/, 'the ratios come from vector/layout.ts');
	const strip = code('components/StatsStrip.tsx');
	for (const fn of ['statsFigures(', 'statsChips(', 'countsAsOfText(']) assert.ok(strip.includes(fn), fn);
});

test('the scope: the listing asks for its conditions, its documents resolve from the listing, the chat is scoped within the cap, filters are saved per connection', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /scope !== null && scope\.applyTo\.documents \? listingFilter\(scope\.filter\) : null/, 'the list is filtered by the scope only while its Documents toggle is on');
	assert.match(view, /entry\.controller\.setFilter\(listing\)/);
	assert.match(view, /resolveScope\(current, state\.directory, cap\)/);
	assert.match(view, /if \(next !== current\) entry\.scope\.set\(next\)/, 'set only when it changed, so the effect settles');
	assert.match(view, /const wiring = useMemo\(\(\) => consoleScope\(chatScope, scope, state\.directory, cap\), \[chatScope, scope, state\.directory, cap\]\)/, 'the chat, search and the map are scoped exactly when the ScopeBar shows their toggles on');
	assert.match(view, /const chatDocuments = wiring\.chat;/);
	assert.match(view, /<ChatPanel model=\{surfaceModel\} [^>]*scope=\{chatDocuments\}/, 'search gets the scope as it applies');
	assert.match(view, /\{model\.chat\.enabled && wiring\.chatNotice !== null && \(\s*<p role="status" data-chat-scope-notice=""[^>]*>\s*\{wiring\.chatNotice\}/, 'the chat says when its question goes to every document');
	assert.match(view, /savedFiltersFor\(savedFilters, entry\.key\)/, "the app's per-connection map, emptied on a change of identity");
	assert.match(view, /<DocumentDirectory [\s\S]*?scope=\{scope\} onScope=\{setScope\} cap=\{cap\}/);
	assert.match(view, /<StatsStrip [^>]*scopeLine=\{scopeLine\}/);
	assert.match(view, /<StatsStrip [^>]*sample=\{selection\.connectionKey === entry\.key \? selection\.sampleModel : null\}[^>]*onScope=\{scopeFromChart\}/, "the charts read the map's sample and a bar scopes the directory");
	assert.match(view, /scopeWith\(scope, scope\?\.filter\.path_contains \?\? '', filter\)/, "a bar sets its kind of condition and keeps the scope's others");
	assert.match(view, /const scopeFromChart = useCallback\(/, 'the charts are memoised: their click handler keeps its identity between renders');
	assert.match(view, /const next = scopeWith\(scope, scope\?\.filter\.path_contains \?\? '', filter\);\s*const refused = checkScope\(next\);\s*if \(refused !== null\) announcer\.announce\(refused\);\s*else entry\.scope\.set\(next\);/, 'a bar the node would refuse is said, never sent');
	const dir = code('components/DocumentDirectory.tsx');
	assert.match(dir, /directoryView\(pager, scope, applied, cap\)/);
	assert.match(dir, /<ScopeBar [^>]*listing=\{pager\}/, "the toggles say how far the scope's documents are");
	assert.match(dir, /useDebounced\(filter, FILTER_DEBOUNCE_MS\)/);
	assert.match(dir, /Scope to this folder/);
	assert.match(dir, /const next = scopeWith\(scope, applied, \{ path_prefix: folderMenu\.folder \}\);\s*const refused = checkScope\(next\);\s*setFolderError\(refused\);\s*if \(refused === null\) onScope\?\.\(next\);/, 'a folder the node would refuse is said, never sent');
	assert.match(dir, /\{folderError !== null && \(\s*<div role="alert"[^>]*>\s*\{folderError\}/);
});

test("a document's health: the tab compares with the console's loaded documents and counts deleted chunks only when asked; the directory and the strip use the same flags", () => {
	const view = code('views/DocumentView.tsx');
	assert.match(view, /<HealthPanel item=\{info\} medianChunks=\{median\} listing="all"/, "the tab's row is listed with deleted:'all'");
	// The full app's tab compares with its console's rows; a dev-tool document frame passes the console's median in
	// (its summary hint: tests/devtool.frame.test.ts), so the tab never reads another frame's memory.
	assert.match(view, /const median = consoleMedian !== undefined \? consoleMedian : medianChunks\(consoleState\);/);
	assert.match(view, /const consoleEntry = consoleMedian === undefined \? existingEntry\(model\.connectionKey\) : undefined;/);
	assert.match(view, /onProbe=\{\(\) => void countDeleted\(\)\}/, 'the two one-row chunks calls run only on the click');
	assert.match(view, /model\.capabilities\.soft_delete === true/, 'offered only where the store soft-deletes');
	assert.doesNotMatch(view, /Without first chunk/);
	assert.match(code('components/DocumentDirectory.tsx'), /buildGroups\(matches, \{ medianChunks: median, trash: inTrash \}\)/);
	assert.match(code('views/ConsoleView.tsx'), /healthSummary\(state\.directory\.rows, \{ medianChunks: settled \? medianChunks\(state\.directory\.rows\) : null, complete: state\.directory\.status === 'done' && state\.directory\.filter === null \}\)/);
});

test("every removal is confirmed by the app-level host, with Cancel focused by the dialog's own mount effect", () => {
	assert.match(code('VectorApp.tsx'), /<RemoveDialogHost \/>/);
	for (const file of ['components/RemoveConfirmDialog.tsx', 'components/MultiRemoveConfirmDialog.tsx']) {
		const source = code(file);
		assert.match(source, /useEffect\(\(\) => \{\s*focusCancelIn\(anchor\.current, REMOVE_CANCEL_LABEL\);\s*\}, \[\]\);/, file);
		assert.match(source, /\bdestructive\b/, file);
		assert.match(source, /confirmDisabled=\{!ready\}/, `${file}: a typed confirmation gates Remove`);
	}
	const host = code('components/RemoveDialogHost.tsx');
	assert.match(host, /entry\.controller\.confirmRemove\(\)/);
	assert.match(host, /entry\.controller\.cancelRemove\(\)/);
	for (const file of ['components/DocumentRow.tsx', 'views/DocumentView.tsx', 'components/DocumentDirectory.tsx', 'views/ConsoleView.tsx']) {
		assert.doesNotMatch(code(file), /\b(deleteBatch|trashBatch|restoreBatch)\b|'(remove_document|delete|soft_delete|restore)'/, `${file} never writes on its own`);
	}
});

test('the trash buttons say what they do, and are disabled with the reason', () => {
	for (const file of ['components/DocumentRow.tsx', 'views/DocumentView.tsx']) {
		const source = code(file);
		assert.match(source, /aria-label=\{`Move \$\{\w+\} to the trash`\}/, file);
		assert.match(source, /disabled=\{!(model\.)?writes\.enabled\}/, file);
		assert.match(source, /writes\.reason/, file);
	}
	const row = code('components/DocumentRow.tsx');
	assert.match(row, /aria-label=\{`Restore \$\{\w+\}`\}/, 'a trashed row restores');
	assert.match(row, /aria-label=\{`Delete \$\{\w+\} permanently`\}/, 'and deletes permanently');
});

test('the Trash view: the console hands the directory its view, the store count and the trash actions; the host confirms each write with its own dialog', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /pager=\{state\.view === 'trash' \? state\.trash : state\.directory\}/);
	assert.match(view, /view=\{state\.view\} onView=\{\(next\) => entry\.controller\.setView\(next\)\}/);
	assert.match(view, /trashCount=\{state\.stats\.view\?\.deletedDocuments \?\? null\}/, 'the badge is the store count, never the loaded rows');
	assert.match(view, /onRestore=\{\(targets\) => void entry\.controller\.restore\(targets\)\}/);
	assert.match(view, /onDelete=\{\(targets\) => entry\.controller\.requestDelete\(targets\)\}/);
	assert.match(view, /onEmptyTrash=\{\(\) => void entry\.controller\.requestEmptyTrash\(\)\}/);
	const host = code('components/RemoveDialogHost.tsx');
	for (const fn of ['trashConfirmation(', 'multiTrashConfirmation(', 'removeConfirmation(', 'multiRemoveConfirmation(', 'emptyTrashConfirmation(']) assert.ok(host.includes(fn), fn);
	const connections = code('adapters/connections.ts');
	assert.match(connections, /trash: \(ids\) => trashBatch\(session\('soft_delete'\)/);
	assert.match(connections, /restore: \(ids\) => restoreBatch\(session\('restore'\)/);
	assert.match(connections, /remove: \(ids, opts\) => deleteBatch\(session\('delete'\), ctx\.endpoint\.nodeId, ids, opts\)/);
	assert.match(connections, /onWritten: \(\) => entry\.writes\.set\(entry\.writes\.get\(\) \+ 1\)/, "every write that ran bumps the connection's write count");
	assert.match(view, /<MapView [^>]*writes=\{entry\.writes\}/, 'which the map reads');
	const map = code('views/MapView.tsx');
	assert.match(map, /useSyncExternalStore\(\(props\.writes \?\? NO_WRITES\)\.subscribe/, 'the map subscribes to the write count');
	assert.match(map, /drawnWrites\.current !== writes/, 'and draws its sample again when a write changed the store');
});

test("no lane file reads a token or a component's configuration, or stops events for the shell", () => {
	for (const file of LANE_FILES) {
		const source = code(file);
		assert.doesNotMatch(source, /\.token\b|roleTokens/, `${file} touches a token`);
		assert.doesNotMatch(source, /\.config\b|\['config'\]/, `${file} reads a component's configuration`);
		assert.doesNotMatch(source, /stopPropagation\(/, `${file} stops an event`);
		assert.doesNotMatch(source, /(window|document)\.addEventListener\(\s*'key/, `${file} listens for keys above the shell's drawers and dialogs`);
		assert.doesNotMatch(source, /localStorage|sessionStorage/, `${file} stores something outside the shell's preferences`);
	}
});

test('pure modules stay pure: vector/ and the pure adapters import no shell value and no React', () => {
	const pure = LANE_FILES.filter((f) => f.startsWith('vector/') || ['adapters/explorer.ts', 'adapters/actions.ts', 'adapters/connections.ts', 'adapters/consoleActions.ts', 'env.ts', 'localEnv.ts', 'realmRegion.ts', 'devtool/protocol.ts', 'devtool/controller.ts', 'devtool/frame.ts', 'devtool/frameText.ts'].includes(f));
	for (const file of pure) {
		const source = code(file);
		assert.doesNotMatch(source, /^import (?!type )[^;]*from 'shell';/m, `${file} imports a shell value`);
		assert.doesNotMatch(source, /from 'react'/, `${file} imports React`);
		assert.doesNotMatch(source, /from 'shared\/explorer\/react'/, `${file} imports the shell-bound bindings`);
	}
	assert.match(code('adapters/react.ts'), /from 'shared\/explorer\/react'/, 'the one file that does');
});

test('identity: the store is attached to the platform, and a change of fingerprint closes documents and clears every cache', () => {
	const app = code('VectorApp.tsx');
	assert.match(app, /useEndpointStoreLifecycle\(vectorEndpoints, client, identity\)/);
	assert.match(app, /useEffect\(\(\) => \{\s*forgetConnections\(getDocs\(\), connectionCaches, endpointKeyFromUri, LANDING\);\s*\}, \[fingerprint\]\);/);
	// One polite region per REALM: in rocket-ui dev-tool documents may share the app's realm (tests/devtool.mounts.test.ts).
	assert.match(app, /<RealmLiveRegion \/>/);
	assert.doesNotMatch(app, /<LiveRegion \/>/);
	assert.match(app, /<VectorHistoryPrefsBridge \/>/);
	assert.match(app, /display: active \? 'flex' : 'none'/, 'editors stay mounted and hidden');
	assert.match(code('adapters/explorer.ts'), /textField: 'question'/, 'chat history keeps questions only');
});

test('the per-connection objects: one entry per key, refreshed in place, gone after a change of identity', () => {
	const clock = manualClock();
	const a = connectionEntry(endpoint('key-a'), null, DEFAULT_LIMITS, clock);
	assert.equal(connectionEntry({ ...endpoint('key-a'), state: 'stopped' }, null, DEFAULT_LIMITS, clock), a, 'the same entry for the same key');
	assert.equal(a.ctx.endpoint.state, 'stopped', 'its context follows the live endpoint');
	assert.equal(a.selection.getState().connectionKey, 'key-a');
	connectionEntry(endpoint('key-b'), null, DEFAULT_LIMITS, clock);
	assert.equal(entryCount(), 2);
	a.selection.selectDocument({ objectId: 'doc-1', path: 'a.md' });
	const disposed: string[] = [];
	const original = a.controller.dispose;
	a.controller.dispose = () => {
		disposed.push('a');
		original();
	};
	const cleared = connectionCaches.clearAll();
	assert.ok(cleared.includes('documents, auto-pager, chunks and removals'));
	assert.ok(cleared.includes('selection and sample models'));
	assert.deepEqual(disposed, ['a'], 'every controller is disposed');
	assert.equal(a.selection.getState().document, null, 'every selection is reset');
	assert.equal(entryCount(), 0);
	assert.equal(existingEntry('key-a'), undefined);
});

test('a call made while disconnected fails with a sentence, and never reaches a session', async () => {
	const clock = manualClock();
	const entry = connectionEntry(endpoint('key-offline'), null, DEFAULT_LIMITS, clock);
	entry.controller.refresh();
	await clock.settle();
	assert.equal(entry.controller.getState().stats.status, 'error');
	assert.match(entry.controller.getState().stats.error?.headline ?? '', /Not connected to the server/);
	connectionCaches.clearAll();
});

test("a chat answer's map action tells the map its question before the highlight lands, so the star is the question's own vector", () => {
	const clock = manualClock();
	const entry = connectionEntry(endpoint('key-answer'), null, DEFAULT_LIMITS, clock);
	const actions = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => undefined, announce: () => undefined });
	entry.selection.setQuery('radio check-in schedule');
	const seen: Array<{ query: string | null; source: string | null }> = [];
	const unsubscribe = entry.selection.subscribe(() => {
		const state = entry.selection.getState();
		seen.push({ query: state.query, source: state.highlight?.source ?? null });
	});
	showAnswerOnMap(entry.selection, actions, 'Where does Falcon Station get its water?', [['doc-1', 3]]);
	unsubscribe();
	const firstChat = seen.find((state) => state.source === 'chat');
	assert.ok(firstChat, 'the chat highlight landed');
	assert.equal(firstChat.query, 'Where does Falcon Station get its water?', 'the question was there when the map saw the highlight');
	assert.deepEqual(entry.selection.getState().highlight, { source: 'chat', keys: [['doc-1', 3]] });
	assert.equal(entry.tab.get(), 'map');
	connectionCaches.clearAll();
});

test('console actions: show on the map, ask about these, remove (confirmed by the console), documents changed, open, announce', () => {
	const clock = manualClock();
	const entry = connectionEntry(endpoint('key-actions'), null, DEFAULT_LIMITS, clock);
	const opened: Array<[string, number | undefined]> = [];
	const announced: string[] = [];
	// Every action that changes what the console shows also brings the connection's console tab to the front.
	const fronted: string[] = [];
	const actions = makeConsoleActions(entry, {
		openDocument: (id, chunk) => opened.push([id, chunk]),
		showConsole: () => fronted.push(`${entry.tab.get()}:${entry.selection.getState().highlight?.keys.length ?? 0}`),
		announce: (t) => announced.push(t),
	});
	actions.showOnMap([['doc-1', 3]], 'chat');
	assert.deepEqual(entry.selection.getState().highlight, { source: 'chat', keys: [['doc-1', 3]] });
	assert.equal(entry.tab.get(), 'map');
	assert.deepEqual(fronted, ['map:1'], 'showing on the map fronts the console, already on its Map tab with the highlight set');
	actions.askAbout(['doc-1', 'doc-2']);
	assert.deepEqual(entry.chatScope.get(), ['doc-1', 'doc-2']);
	assert.equal(entry.tab.get(), 'console', 'asking lands back in the console');
	assert.deepEqual(fronted, ['map:1', 'console:1'], 'asking about documents fronts the console too');
	actions.askAbout([]);
	assert.equal(entry.chatScope.get(), null);
	actions.openDocument('doc-1', 4);
	assert.deepEqual(opened, [['doc-1', 4]]);
	assert.equal(fronted.length, 3, 'opening a document tab does not front the console');
	actions.announce('hello');
	assert.deepEqual(announced, ['hello']);
	entry.controller.setWritesEnabled(true);
	entry.selection.selectDocument({ objectId: 'doc-9', path: 'C:/x/nine.md' });
	assert.deepEqual(removeTargets(entry, ['doc-9', 'doc-0']), [
		{ objectId: 'doc-9', path: 'C:/x/nine.md', chunks: null },
		{ objectId: 'doc-0', path: 'doc-0', chunks: null },
	]);
	actions.requestRemove(['doc-9']);
	assert.deepEqual(entry.controller.getState().confirm?.targets, [{ objectId: 'doc-9', path: 'C:/x/nine.md', chunks: null }], 'the console confirms; nothing is sent');
	connectionCaches.clearAll();
});
