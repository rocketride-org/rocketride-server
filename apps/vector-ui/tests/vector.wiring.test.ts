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
import { DEFAULT_TAB, WORKBENCH_TABS, tabLabel } from '../src/vector/workbench';

const SRC = path.resolve(__dirname, '..', 'src');

/** A source file without its comments. */
function code(file: string): string {
	return fs
		.readFileSync(path.join(SRC, file), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every source file under src, relative to it.
 *
 * @param dir - Where to start.
 * @returns The files, sorted.
 */
function sources(dir: string = SRC): string[] {
	const out: string[] = [];
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) out.push(...sources(full));
		else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(SRC, full).split(path.sep).join('/'));
	}
	return out.sort();
}

/** Every source file of the app. */
const ALL_FILES = sources();

/**
 * The files the lane rules below do not cover yet, each with why. Every other source file is checked, so a file
 * added later is covered without being listed here.
 */
const LANE_EXEMPT: Readonly<Record<string, string>> = {};

/** The files the lane rules cover: no token, no configuration, no stopped events, no page key listeners, no browser storage. */
const LANE_FILES = ALL_FILES.filter((f) => !(f in LANE_EXEMPT));

/** The modules that hold no shell value and no React, and why the two exceptions in their folders do. */
const PURE_EXEMPT: Readonly<Record<string, string>> = {
	'adapters/react.ts': "the one file that binds the shared library's React hooks to the shell",
	'devtool/wiring.ts': "the shell's protocol factories, handed to the pure frame and controller",
};

/** The pure modules: vector/, adapters/ and devtool/ (but the two above), and the env seam. */
const PURE_FILES = ALL_FILES.filter((f) => (/^(vector|adapters|devtool)\/[^/]+\.ts$/.test(f) || ['env.ts', 'localEnv.ts', 'realmRegion.ts'].includes(f)) && !(f in PURE_EXEMPT));

/** An endpoint for the registry tests. */
function endpoint(key: string): IExplorerEndpoint {
	return { key, legacyKey: null, projectId: 'vp', pipelineName: 'Vector docs', runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't1', roles: { tools: { source: 'tools_1' }, chat: null, ingest: null }, missingRoles: ['chat', 'ingest'], source: 'tools_1', nodeId: 'store_1', nodeName: 'Store', provider: 'qdrant', state: 'ready', running: true, components: [], anchorRole: 'tools', readOnly: false };
}

test('every source file is under the lane rules or exempt with its reason, so a new file is checked without being listed', () => {
	assert.ok(ALL_FILES.length >= 150, String(ALL_FILES.length));
	for (const [file, why] of [...Object.entries(LANE_EXEMPT), ...Object.entries(PURE_EXEMPT)]) {
		assert.ok(ALL_FILES.includes(file), `${file} is exempt but does not exist`);
		assert.ok(why.length > 20, `${file} says why it is exempt`);
	}
	assert.equal(LANE_FILES.length + Object.keys(LANE_EXEMPT).length, ALL_FILES.length);
	for (const file of ['views/ConsoleView.tsx', 'components/WorkbenchTabs.tsx', 'components/PendingBar.tsx', 'vector/workbench.ts', 'vector/staged.ts', 'vector/focus.ts', 'adapters/queryHistory.ts', 'map/overlay.ts', 'chat/chatSession.ts']) assert.ok(LANE_FILES.includes(file), file);
	for (const file of ['vector/workbench.ts', 'vector/staged.ts', 'vector/fields.ts', 'vector/focus.ts', 'adapters/queryHistory.ts', 'adapters/consoleActions.ts', 'devtool/frame.ts', 'env.ts']) assert.ok(PURE_FILES.includes(file), file);
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

test('the Map is a tab of the workbench: every panel mounts the first time its tab shows and stays mounted, the map is told when it is visible', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /if \(!mounted\.has\(tab\)\) setMounted\(new Set\(\[\.\.\.mounted, tab\]\)\);/, 'a tab shown once keeps its panel');
	assert.match(view, /panel: \(shown: boolean, gutter: number\): CSSProperties => \(\{[^}]*display: shown \? 'flex' : 'none'/, 'hidden, never unmounted');
	for (const id of ['overview', 'documents', 'query', 'map', 'collection', 'trash']) {
		assert.match(view, new RegExp(`\\{mounted\\.has\\('${id}'\\) && \\(\\s*<WorkbenchPanel id="${id}" shown=\\{tab === '${id}'\\} gutter=\\{\\d+\\} prefix=\\{prefix\\}>`), id);
	}
	assert.match(view, /<div role="tabpanel" id=\{ids\.panel\} aria-labelledby=\{ids\.tab\} style=\{layout\.panel\(shown, gutter\)\} data-workbench-panel=\{id\}>/, 'each panel is the tab panel its tab names');
	assert.match(view, /<MapView model=\{mapModel\} channels=\{channels\} selection=\{entry\.selection\} actions=\{actions\} visible=\{active && tab === 'map'\} documents=\{entry\.documents\} writes=\{entry\.writes\} \/>/);
	assert.match(view, /const nextMapScope = mapScopeFor\(mapScope, wiring\);\s*if \(nextMapScope !== mapScope\) setMapScope\(nextMapScope\);/, 'the map keeps the scope it drew with while a new one finds its documents');
	assert.match(view, /const mapModel = useMemo\(\(\) => \(nextMapScope === \(model\.scope \?\? null\) \? model : \{ \.\.\.model, scope: nextMapScope \}\), \[model, nextMapScope\]\)/);
	assert.match(view, /<WorkbenchTabs value=\{tab\} onChange=\{\(id\) => entry\.tab\.set\(id\)\} trashCount=\{state\.stats\.view\?\.deletedDocuments \?\? null\} idPrefix=\{prefix\} mounted=\{mounted\} \/>/, 'the tab row is the entry\'s tab, with the store\'s trash count');
	assert.deepEqual(WORKBENCH_TABS.map((t) => t.label), ['Overview', 'Documents', 'Query', 'Map', 'Collection', 'Trash']);
	assert.equal(DEFAULT_TAB, 'overview');
	assert.equal(tabLabel('trash', { trash: 1234 }), 'Trash (1,234)');
	assert.equal(tabLabel('trash', { trash: null }), 'Trash', 'no count where the store cannot count');
	assert.equal(tabLabel('map', { trash: 3 }), 'Map');
	// The header, then the tab row on a row of its own, then what shows on every tab, then the panels.
	// The pending bar sits under the panels, so staging never moves a row above it (DA-R0 I14).
	const order = ['<ContentHeader', '<WorkbenchTabs', '<InlineRemoveConfirm', '<ConnectionDetailsPanel', "{mounted.has('overview')", "{mounted.has('trash')", '<PendingBar', '<AddDocumentsAside'].map((part) => view.indexOf(part));
	assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), order.join(' < '));
});

test('the workbench header and tab row never move: Refresh keeps its width and says Refreshing… only for a refresh someone asked for', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /<span style=\{layout\.held\}>\s*<span style=\{layout\.heldLabel\(!refreshing\)\}>Refresh<\/span>\s*<span style=\{layout\.heldLabel\(refreshing\)\}>\{BUSY\.refreshing\}<\/span>/, 'both labels in one grid cell: the button keeps the longer width');
	assert.match(view, /heldLabel: \(shown: boolean\): CSSProperties => \(\{ gridArea: '1 \/ 1', visibility: shown \? 'visible' : 'hidden' \}\)/, 'the hidden label is not read out');
	assert.match(view, /const refreshing = refreshAsked && statsLoading;/, 'the 15 s quick tick changes nothing in the header');
	// The tab row is its own row, under the header and above every banner and panel.
	// The banners of a lasting state at the top; what comes and goes after a write (its line, the pending bar) under the panels (R1-I6).
	const order = ['<ContentHeader', '<WorkbenchTabs', '{card.blocked &&', '{!card.blocked && unreachable && statsError !== null &&', "{!card.blocked && dialect?.health.control_record === false &&", '{!card.blocked && dialect?.health.model_mismatch === true &&', '{!card.blocked && entry.opened && !model.writes.enabled', '{!card.blocked && !unreachable && emptyCollection &&', '<InlineRemoveConfirm', "{mounted.has('overview')", "{mounted.has('trash')", '<PendingBar', 'data-write-line=""'].map((part) => view.indexOf(part));
	assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), order.join(' < '));
	assert.match(view, /<Button small variant="secondary" onClick=\{refresh\}>\s*Retry/, 'a store error keeps the last figures and offers Retry');
	assert.match(view, /\{emptyText\}\s*\{model\.ingest\.enabled \? \(/, 'an empty collection says how to add documents where the mount can, and why not where it cannot');
	assert.match(view, /const emptyText = !missing && inTrash > 0 \? `No documents outside the trash \(\$\{formatCount\(inTrash\)\} in the Trash\)\.` : EMPTY\.noDocuments;/, 'every document in the Trash is not "No documents yet"');
	assert.match(view, /const unreachable = statsError !== null && unreachableShown\(failures\.current, state\.stats\.view !== null\);/, 'one failed quick tick never adds a banner above every tab');
	assert.match(view, /const missing = collectionMissing\(dialect, state\.stats\.view\);\s*const emptyCollection = missing \|\| state\.stats\.view\?\.documents === 0;/, 'one "Empty collection" rule with the chip and the card');
	assert.match(code('components/WorkbenchTabs.tsx'), /<TabRow tabs=\{tabs\} value=\{value\} onSelect=\{onChange\} activation="manual" label="Collection views"/, 'arrows move the focus only: activation is manual (the Map samples)');
	assert.match(code('components/WorkbenchTabs.tsx'), /reserve: tabLabel\('trash', \{ trash: 888 \}\)/, 'the Trash label keeps the width of a three-digit count');
	const row = code('components/TabRow.tsx');
	assert.match(row, /role="tablist"/);
	assert.match(row, /role="tab"[\s\S]*?id=\{ids\.tab\}[\s\S]*?aria-selected=\{selected\}[\s\S]*?aria-controls=\{mounted === undefined \|\| mounted\.has\(tab\.id\) \|\| selected \? ids\.panel : undefined\}[\s\S]*?tabIndex=\{selected \? 0 : -1\}/, 'a roving tabindex; each tab names its panel');
	assert.match(row, /const target = tabKeyTarget\(event\.key, index, tabs\.length\);\s*if \(target === null\) return;\s*event\.preventDefault\(\);\s*if \(activation === 'automatic'\) onSelect\(tabs\[target\]\.id\);/, 'only an automatic row shows the tab a key reaches');
	assert.match(row, /fontVariantNumeric: 'tabular-nums'/);
	const overviewRow = code('components/OverviewPanel.tsx');
	assert.match(overviewRow, /<TabRow<OverviewViewId> tabs=\{tabs\} value=\{view\} onSelect=\{setView\} activation="automatic" label="Overview"/, "the Overview's views call nothing: automatic");
	assert.match(overviewRow, /<div role="tabpanel" id=\{ids\.panel\} aria-labelledby=\{ids\.tab\} style=\{local\.body\(view === id\)\}/, 'each view is the panel its tab names, kept mounted once shown');
});

test('focus in the workbench: a tab switch from inside a panel moves the focus to the new tab; the aside closes on Escape and gives the focus back', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /useLayoutEffect\(\(\) => \{[\s\S]*?focusStranded\(focused, tab\)[\s\S]*?currentTab\(\)\?\.focus\(\);\s*\}, \[tab\]\);/);
	const aside = code('components/AddDocumentsAside.tsx');
	assert.match(aside, /if \(event\.key !== 'Escape' \|\| event\.defaultPrevented\) return;\s*event\.preventDefault\(\);\s*onClose\(\);/, 'the Escape rule: an inner handler that acted wins; no stopPropagation');
	assert.match(aside, /opener\.current = document\.activeElement;\s*region\.current\?\.focus\(\);/, 'opened: it takes the focus');
	assert.match(aside, /if \(!focusLost\(document\.activeElement, document\.body, region\.current\)\) return;\s*firstFocusable\(\[back instanceof HTMLElement \? back : null, fallback\.current\?\.\(\)\]\)\?\.focus\(\);/, 'closed: back to its opener, else (gone, or on a hidden tab) to the fallback');
	assert.match(view, /const asideFocus = \(\): HTMLElement \| null => firstFocusable\(\[root\.current\?\.querySelector<HTMLElement>\('\[data-add-documents\] button'\), currentTab\(\)\]\);/, "the fallback: the header's Add documents, else the current tab");
	assert.match(view, /returnFocus=\{asideFocus\} \/>/);
});

test("the Overview's Top folders show a folder's documents in Documents (its client-side folder view, C2); the write line keeps the store's audit", () => {
	const overview = code('components/OverviewPanel.tsx');
	assert.match(overview, /onOpenFolder=\{\(view\) => \{\s*documentsFolder\(entry\)\.set\(view\);\s*openTab\('documents'\);/);
	assert.match(overview, /onOpenFolder\(f\.kind === 'uploaded' \? \{ kind: 'uploaded' \} : \{ kind: 'folder', prefix: f\.folder \}\)/, 'a folder row opens that folder with its subfolders, which is what it counts');
	assert.match(overview, /`Directly in \$\{f\.folder\}`/, "an opened folder's own documents are not a button: a folder view would show its subfolders too");
	assert.doesNotMatch(overview, /setFilter|entry\.scope\.set/, 'a folder opened from the Overview never relists or changes the scope');
	const hub = code('views/ConsoleView.tsx');
	assert.match(hub, /<div key="alert" role="alert" style=\{layout\.status\}>\s*\{state\.removal\.message\}\s*<\/div>/, 'a failure in an element of its own, so it is announced as one');
	assert.match(hub, /<div key="status" role="status" style=\{layout\.status\}>\s*\{state\.removal\.status === 'running' \? \(state\.removal\.message \?\? BUSY\.removing\) : state\.removal\.message\}\s*<\/div>\s*\)\}\s*(\{\}\s*)?\{\(state\.removal\.status === 'done' \|\| state\.removal\.status === 'error'\) && <WriteAuditDetails audit=\{state\.removal\.audit\} \/>\}/, "after the result sentence, once the write finished, and outside the announced element: opening it does not announce the line again");
});

test('B1(b): fresh stats that say the collection exists, against a probe that said it did not, probe the store again once per disagreement', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /const disagree = state\.stats\.view !== null && state\.stats\.view\.collectionExists && dialect\?\.health\.collection_exists === false;/);
	assert.match(view, /const next = reprobeFor\(reprobed\.current, disagree, endpoint\.key\);\s*reprobed\.current = next\.tried;\s*if \(next\.probe\) void env\.probe\(endpoint\.key\);\s*\}, \[disagree, env, endpoint\.key\]\);/, 'not on every quick tick: the stats time is not a dependency');
	assert.match(view, /if \(refreshing\) return;/, 'a refresh already running is not asked again');
});

test('the console renders the strip, the directory, the chunks, adding documents and the chat (each in its tab), and paces itself through its controller', () => {
	const view = code('views/ConsoleView.tsx');
	for (const part of ['<OverviewPanel', '<DocumentsTab', '<QueryTab', '<MapView', '<CollectionPanel', '<TrashTab', '<PendingBar', '<AddDocumentsAside']) assert.ok(view.includes(part), part);
	// Today's parts, each in the tab that holds it now.
	for (const [file, parts] of [
		['components/OverviewPanel.tsx', ['<StatsStrip']],
		['components/DocumentsTab.tsx', ['<FolderRail', '<ScopeBar', '<VectorGrid', '<DocumentDrawer']],
		['components/TrashTab.tsx', ['<ScopeBar', '<VectorGrid']],
		['components/QueryTab.tsx', ['<ChatPanel']],
		['components/AddDocumentsAside.tsx', ['<IngestPanel']],
		['components/CollectionPanel.tsx', ['collectionView(', '<Section label="Metadata fields"']],
	] as const) {
		for (const part of parts) assert.ok(code(file).includes(part), `${file} ${part}`);
	}
	assert.match(view, /entry\.controller\.setVisible\(active\)/, 'hidden: no quick stats, the directory pauses');
	assert.match(view, /entry\.controller\.setWritesEnabled\(model\.writes\.enabled\)/, 'nothing is confirmed or sent while writes are off');
	for (const file of ['components/DocumentsTab.tsx', 'components/TrashTab.tsx']) {
		assert.match(code(file), /const writes = writesDuringRemoval\(model\.writes, state\.removal\.status\);/, `${file}: the writes follow the model, and are unavailable while a removal runs`);
	}
	assert.match(view, /const write: SlotWrite = removal === dismissed \|\| \(removal\.status !== 'running' && removal\.message === null\) \? null : removal\.status === 'running' \? 'running' : removal\.status === 'error' \? 'failure' : 'result';/, 'the status line says Removing… while a removal runs');
	assert.match(view, /entry\.controller\.open\(\)/);
	assert.match(view, /\{addingMounted && <AddDocumentsAside [^>]*open=\{adding\}/, 'Add documents is an aside beside the panels, kept mounted once opened (an upload keeps following its progress)');
	const strip = code('components/StatsStrip.tsx');
	for (const fn of ['overviewCards(', 'statsChips(', 'countsAsOfText(']) assert.ok(strip.includes(fn), fn);
	assert.ok(code('vector/overview.ts').includes('statsFigures('), "the cards are the strip's figures");
});

test('the scope: the listing asks for its conditions, its documents resolve from the listing, the chat is scoped within the cap, filters are saved per connection', () => {
	const view = code('views/ConsoleView.tsx');
	assert.match(view, /scope !== null && scope\.applyTo\.documents \? listingFilter\(scope\.filter\) : null/, 'the list is filtered by the scope only while its Documents toggle is on');
	assert.match(view, /entry\.controller\.setFilter\(listing\)/);
	assert.match(view, /resolveScope\(current, state\.directory, cap\)/);
	assert.match(view, /if \(next !== current\) entry\.scope\.set\(next\)/, 'set only when it changed, so the effect settles');
	assert.match(view, /const wiring = useMemo\(\(\) => consoleScope\(chatScope, scope, state\.directory, cap\), \[chatScope, scope, state\.directory, cap\]\)/, 'the chat, search and the map are scoped exactly when the ScopeBar shows their toggles on');
	assert.match(view, /const chatDocuments = wiring\.chat;/);
	assert.match(view, /<QueryTab [^>]*surfaceModel=\{surfaceModel\} chatDocuments=\{chatDocuments\} chatNotice=\{wiring\.chatNotice\} onClearChatScope=\{clearChatScope\} \/>/);
	const query = code('components/QueryTab.tsx');
	assert.match(query, /<ChatPanel model=\{surfaceModel\} [^>]*scope=\{chatDocuments\}/, 'search gets the scope as it applies');
	assert.match(query, /\{model\.chat\.enabled && chatNotice !== null && \(\s*<p role="status" data-chat-scope-notice=""[^>]*>\s*\{chatNotice\}/, 'the chat says when its question goes to every document');
	assert.match(view, /savedFiltersFor\(savedFilters, entry\.key\)/, "the app's per-connection map, emptied on a change of identity");
	assert.match(view, /<DocumentsTab [^>]*scope=\{scope\} onScope=\{setScope\} cap=\{cap\}/);
	assert.match(code('components/DocumentsTab.tsx'), /<ScopeBar [^>]*scope=\{scope\} onScope=\{onScope\} cap=\{cap\}/);
	assert.match(view, /<OverviewPanel [^>]*scopeLine=\{scopeLine\} health=\{health\} median=\{median\} onChartScope=\{scopeFromChart\} /);
	const overview = code('components/OverviewPanel.tsx');
	assert.match(overview, /<StatsStrip [^>]*scopeLine=\{scopeLine\}/);
	assert.match(overview, /sample=\{selection\.connectionKey === entry\.key \? selection\.sampleModel : null\}/, "the charts read the map's sample");
	assert.match(overview, /<StatsCharts [^>]*onScope=\{props\.onChartScope\}/, 'and a bar scopes the documents');
	assert.match(overview, /onChartScope=\{\(filter\) => \{\s*onChartScope\(filter\);\s*openTab\('documents'\);/, 'then shows them');
	assert.match(overview, /scoped && scope !== null \? \(directoryView\(dir, scope, '', cap\)\.scopeRows \?\? \[\]\) : dir\.rows/, "Top folders count the scope's documents as Documents and its folder rail do");
	assert.match(view, /scopeWith\(scope, scope\?\.filter\.path_contains \?\? '', filter\)/, "a bar sets its kind of condition and keeps the scope's others");
	assert.match(view, /const scopeFromChart = useCallback\(/, 'the charts are memoised: their click handler keeps its identity between renders');
	assert.match(view, /const next = scopeWith\(scope, scope\?\.filter\.path_contains \?\? '', filter\);\s*const refused = checkScope\(next\);\s*if \(refused !== null\) announcer\.announce\(refused\);\s*else entry\.scope\.set\(next\);/, 'a bar the node would refuse is said, never sent');
	const dir = code('components/DocumentsTab.tsx');
	assert.match(dir, /directoryView\(pager, scope, applied, cap\)/);
	assert.match(dir, /<ScopeBar [^>]*listing=\{state\.directory\}/, "the toggles say how far the scope's documents are (the listing itself, even while the grid holds its last rows)");
	assert.match(dir, /useDebounced\(text, FILTER_DEBOUNCE_MS\)/);
	// A folder in the rail narrows what is loaded; setting the scope to it is its own, explicit action (C2).
	assert.match(dir, /folderRows\(view\.rows, folder\)/);
	assert.match(dir, /\{folderScopeLabel\(folderTargets\)\}/, 'the action names the surfaces it scopes');
	assert.match(dir, /const next = folderScope\(scope, applied, prefix\);\s*const refused = checkScope\(next\);\s*setFolderError\(refused\);\s*if \(refused === null\) onScope\(next\);/, 'a folder the node would refuse is said, never sent; folderScope decides whether the list is scoped (R1-I4, F1-1)');
	assert.match(dir, /\{folderError !== null && \(\s*<div role="alert"[^>]*>\s*\{folderError\}/);
	assert.doesNotMatch(code('components/FolderRail.tsx'), /onScope|setFilter|scopeWith/, 'the rail never changes the scope or the listing');
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
	assert.match(code('components/DocumentsTab.tsx'), /healthCell\(item, median\)/, "the Documents grid's Health column");
	assert.match(code('components/DocumentsTab.tsx'), /pager\.status === 'loading' \|\| pager\.status === 'idle' \? null : medianChunks\(pager\.rows\)/, 'oversize waits for the listing to settle');
	assert.match(code('views/ConsoleView.tsx'), /const median = settled \? medianChunks\(state\.directory\.rows\) : null;\s*return \{ median, health: healthSummary\(state\.directory\.rows, \{ medianChunks: median, complete: state\.directory\.status === 'done' && state\.directory\.filter === null \}\) \};/, 'the chip and Insights read the same rows and median');
});

test('every removal is confirmed inline in the document that shows it, in both mounts (no app-level dialog); the panel takes the first focus by the write\'s weight', () => {
	const app = code('VectorApp.tsx');
	assert.doesNotMatch(app, /RemoveDialogHost/, 'the full app mounts no modal confirmation');
	assert.match(code('views/ConsoleView.tsx'), /<InlineRemoveConfirm entry=\{entry\} probe=\{probe\} origin=\{CONSOLE_ORIGIN\} returnFocus=\{returnFocus\} \/>/, 'the workbench confirms its own requests inline, on every tab');
	assert.match(code('views/ConsoleView.tsx'), /firstFocusable\(\[inShown\('\[data-return-focus\]'\), inShown\('\[data-grid-focus\] \[data-grid-row\]\[tabindex="0"\]'\), inShown\('\[data-grid-focus\]'\), currentTab\(\)\]\)/, "a lost focus goes to the shown panel's marked row, else its grid, else the current tab");
	assert.match(code('components/InlineRemoveConfirm.tsx'), /firstFocusable\(\[how\.current === 'cancel' \? back : null, closing\.current\.returnFocus\?\.\(back\), surfaceTarget\(surface\)\]\)/, "after Cancel, back to the opener first; the caller's fallback hears the opener; with none named, the surface's own (R1-I1)");
	assert.match(app, /<DocumentView [^>]*beforeBody=\{<InlineRemoveConfirm entry=\{entry\} probe=\{probes\[endpoint\.key\]\} origin=\{documentOrigin\(payload\.objectId\)\} returnFocus=\{returnFocus\} \/>\}/, "and the full app's document tab its own (it shares the console's controller)");
	// R1-I1: after Confirm on a document surface the focus stays in the document: the opener while shown, its tabs, then its first control.
	assert.match(app, /const returnFocus = \(opener: HTMLElement \| null\): HTMLElement \| null => documentFocus\(root\.current, opener\) as HTMLElement \| null;/);
	const devFrame = code('VectorDevTool.tsx');
	assert.match(devFrame, /<InlineRemoveConfirm entry=\{entry\} probe=\{probes\[live\.key\]\} returnFocus=\{returnFocus\} \/>/);
	assert.match(devFrame, /if \(typeof document === 'undefined' \|\| !focusLost\(document\.activeElement, document\.body, null\)\) return;\s*returnFocus\(null\)\?\.focus\(\);/, 'and after a read again or the document going');
	assert.match(devFrame, /<div tabIndex=\{-1\} style=\{styles\.gone\} data-document-gone="">/, 'the gone state can hold the focus');
	assert.match(devFrame, /const seen = useRef\(\{ version, gone \}\);\s*useEffect\(\(\) => \{\s*if \(seen\.current\.version === version && seen\.current\.gone === gone\) return;\s*seen\.current = \{ version, gone \};\s*if \(typeof document === 'undefined' \|\| !focusLost/, 'only on a change: a frame that opens never takes the focus from the host or another frame');
	// R1-I7: a dev-tool document reads itself again only for a write that may have changed it.
	assert.match(devFrame, /version: \(written\) => \{\s*if \(!writeTouches\(written\.gone, objectId\)\) return;/);
	assert.match(devFrame, /<DocumentView refreshKey=\{version\} /, 'in place: its sub-tab, sort, drawer and focus stay');
	assert.doesNotMatch(devFrame, /<DocumentView key=\{version\}/, 'never a remount');
	// I6/R1-I12: the bottom slot is always there, one style in every state; what it holds changes, its height never.
	const hub = code('views/ConsoleView.tsx');
	assert.equal(hub.match(/<div\s+ref=\{slotRef\}\s+style=\{layout\.slot\}\s+data-bottom-slot=""/g)?.length, 1);
	assert.doesNotMatch(hub, /style=\{\{ \.\.\.layout\.slot/, 'one style, never merged with a state');
	// The flip back to the pending bar (bottomSlot): never while a write runs, nor under the focus or the pointer.
	assert.match(hub, /const slot = bottomSlot\(\{ staged: staged\.size, write, fresh, stagedSince, held: inSlot\.focus \|\| inSlot\.pointer, showing: showing\.current \}\);/);
	assert.match(hub, /onPointerEnter=\{\(\) => setInSlot\(\(was\) => \(\{ \.\.\.was, pointer: true \}\)\)\}\s*onPointerLeave=\{\(\) => setInSlot\(\(was\) => \(\{ \.\.\.was, pointer: false \}\)\)\}/);
	assert.match(hub, /\{write === 'failure' && \(\s*<Button small variant="ghost" onClick=\{\(\) => setDismissed\(removal\)\}>\s*Dismiss\s*<\/Button>\s*\)\}/, 'a failure stays until dismissed (or the staged set changes)');
	assert.match(hub, /if \(focusLost\(document\.activeElement, document\.body, null\)\) firstFocusable\(\[node\?\.querySelector<HTMLElement>\(TABBABLE\) \?\? null, returnFocus\(\)\]\)\?\.focus\(\);/, 'a control that leaves the slot with the focus hands it on, never to the page');
	assert.match(hub, /status: \{ \.\.\.styles\.small, flex: 1,/, 'the sentence takes the room: Write details sit at the right end');
	assert.match(hub, /slot: \{ flexShrink: 0, boxSizing: 'border-box', height: PENDING_BAR_HEIGHT,/, "exactly the pending bar's height");
	assert.match(hub, /\{slot === 'pending' && <PendingBar \{\.\.\.panel\(tab\)\} \/>\}/);
	const audit = code('components/WriteAuditDetails.tsx');
	assert.match(audit, /list: \{ position: 'absolute',/, 'Write details open over the panel: the line keeps its height');
	assert.match(audit, /unplaced: \{ bottom: `calc\(100% \+ \$\{POPOVER_GAP\}px\)`, right: 0 \}/, 'up from the line until placed');
	// Placed before paint by the map popovers' rules, inside the window, clipping ancestors and its surface (never under the sidebar).
	assert.match(audit, /import \{ POPOVER_GAP, clipArea, placePopover, popoverKey \} from '\.\.\/map\/popover';/);
	assert.match(audit, /const surface = node\.closest<HTMLElement>\('\[data-console\], \[data-document\]'\);\s*const area = clipArea\(\{ width: window\.innerWidth, height: window\.innerHeight \}, \[\.\.\.clippingRects\(node\), \.\.\.\(surface \? \[surface\.getBoundingClientRect\(\)\] : \[\]\)\]\);/);
	assert.match(audit, /const at = placePopover\(\{ left: across\.left, right: across\.right, top: Math\.min\(line\.top, across\.top\), bottom: Math\.max\(line\.bottom, across\.bottom\) \}, size, area\);/, 'above its whole line, never over its words');
	// Closed like them: Escape (the innermost handler that acts) back to its summary, a press outside, a resize.
	assert.match(audit, /const key = popoverKey\(event\.key, event\.defaultPrevented\);\s*if \(!open \|\| !key\.close\) return;\s*event\.preventDefault\(\);\s*close\(key\.refocus\);/);
	assert.match(audit, /window\.addEventListener\('resize', onResize\);\s*document\.addEventListener\('pointerdown', onDown\);/);
	assert.match(audit, /new ResizeObserver/, 'and a resize of its line');
	assert.doesNotMatch(audit, /stopPropagation/);
	assert.match(app, /origin: documentOrigin\(payload\.objectId\),/, "the tab's actions ask under its origin");
	for (const file of ['components/RemoveConfirmDialog.tsx', 'components/MultiRemoveConfirmDialog.tsx', 'components/RemoveDialogHost.tsx']) assert.ok(!fs.existsSync(path.join(SRC, file)), `${file}: no modal confirmation is left`);
	const panel = code('components/InlineRemoveConfirm.tsx');
	assert.match(panel, /const first = confirmFirstFocus\(pending\.action, pending\.targets\.length, entry\.ctx\.limits\.write_ids_max\);/, 'the first focus is the pure rule (P2-11: a bulk move opens on Cancel)');
	assert.match(panel, /if \(first === 'confirm'\) confirmButton\.current\?\.focus\(\);\s*else if \(first === 'typed' && content\.typed\) input\.current\?\.focus\(\);\s*else Array\.from\(actions\.current\?\.querySelectorAll\('button'\) \?\? \[\]\)\.find\(\(button\) => button\.textContent\?\.trim\(\) === content\.cancelLabel\)\?\.focus\(\);/, 'Confirm for a move to the trash; the typed field, else Cancel, for a permanent write');
	assert.match(code('components/VectorGrid.tsx'), /data-return-focus=\{returnId === id \? '' : undefined\}/, 'the grid marks the row after the rows a confirmed write takes away, for the hub\'s fallback');
	for (const file of ['components/DocumentsTab.tsx', 'components/TrashTab.tsx']) assert.match(code(file), /leaving=\{leaving\}/, `${file}: tells its grid which rows the open confirmation takes away`);
	for (const file of ['views/DocumentView.tsx', 'views/ConsoleView.tsx', 'components/DocumentsTab.tsx', 'components/TrashTab.tsx', 'components/PendingBar.tsx', 'components/DocumentDrawer.tsx', 'components/FolderRail.tsx', 'components/VectorGrid.tsx']) {
		assert.doesNotMatch(code(file), /\b(deleteBatch|trashBatch|restoreBatch)\b|'(remove_document|delete|soft_delete|restore)'/, `${file} never writes on its own`);
	}
});

test('the trash buttons say what they do, and say why when they are unavailable', () => {
	const view = code('views/DocumentView.tsx');
	assert.match(view, /aria-label=\{`Move \$\{\w+\} to the trash`\}/);
	assert.match(view, /disabled=\{!(model\.)?writes\.enabled\}/);
	assert.match(view, /writes\.reason/);
	const documents = code('components/DocumentsTab.tsx');
	assert.match(documents, /const blocked = !writes\.enabled && !staged\.has\(item\.objectId\);/, 'staging waits for the writes; unstaging never does');
	assert.match(documents, /aria-label=\{`Stage \$\{name\} to move to the trash`\} aria-disabled=\{blocked \? true : undefined\} title=\{blocked \? \(writes\.reason \?\? undefined\) : undefined\}/, 'a row stages; writes off, it says why and stays focusable');
	const trash = code('components/TrashTab.tsx');
	assert.match(trash, /aria-label=\{`Restore \$\{label\(item\)\}`\} title=\{off \?\? `Restore \$\{label\(item\)\}`\} aria-disabled=\{off !== null \|\| undefined\}/, 'a trashed row restores');
	assert.match(trash, /aria-label=\{`Delete \$\{label\(item\)\} permanently`\} title=\{off \?\? `Delete \$\{label\(item\)\} permanently`\} aria-disabled=\{off !== null \|\| undefined\}/, 'and deletes permanently');
	assert.match(code('components/GatedButton.tsx'), /aria-disabled=\{off \|\| undefined\}[\s\S]*title=\{off \? unavailable : title\}[\s\S]*if \(!off\) onClick\(\);/, 'an unavailable control keeps the focus and says why');
});

test('the Trash tab: the trash listing, the store count and the trash actions; each write is confirmed with its own words', () => {
	const view = code('views/ConsoleView.tsx');
	const documents = code('components/DocumentsTab.tsx');
	const trash = code('components/TrashTab.tsx');
	assert.match(view, /<TrashTab \{\.\.\.panel\('trash'\)\} \/>/);
	assert.match(documents, /const pager = restarting \? held\.current : state\.directory;/, 'Documents lists the directory (holding its rows while the same listing starts over)');
	assert.match(trash, /const pager = state\.trash;/);
	// The controller pages the listing its view names: each tab names its own while it shows (the trash is listed once, when first shown).
	assert.match(documents, /if \(visible\) entry\.controller\.setView\('active'\);/);
	assert.match(trash, /if \(visible\) entry\.controller\.setView\('trash'\);/);
	for (const file of [documents, trash]) assert.match(file, /state\.stats\.view\?\.deletedDocuments \?\? null/, 'the Trash count is the store count, never the loaded rows');
	assert.match(trash, /onRestore: \(item\) => void entry\.controller\.restore\(\[targetOf\(item\)\]\)/);
	assert.match(trash, /onClick=\{\(\) => void entry\.controller\.restore\(checkedItems\.map\(targetOf\)\)\}/);
	assert.match(trash, /onDelete: \(item\) => entry\.controller\.requestDelete\(\[targetOf\(item\)\]\)/);
	assert.match(trash, /onClick=\{\(\) => entry\.controller\.requestDelete\(checkedItems\.map\(targetOf\)\)\}/);
	assert.match(trash, /onClick=\{\(\) => void entry\.controller\.requestEmptyTrash\(\)\}/);
	assert.match(code('components/PendingBar.tsx'), /onClick=\{\(\) => entry\.controller\.requestRemove\(\[\.\.\.staged\.values\(\)\]\)\}/, 'Apply: the one confirmation for every staged document');
	assert.match(code('components/InlineRemoveConfirm.tsx'), /confirmationFor\(pending, removeContextFor\(entry\.ctx\.endpoint, probe\)\)/);
	const confirm = code('vector/confirm.ts');
	const chooser = confirm.slice(confirm.indexOf('export function confirmationFor'));
	for (const fn of ['trashConfirmation(', 'multiTrashConfirmation(', 'removeConfirmation(', 'multiRemoveConfirmation(', 'emptyTrashConfirmation(']) assert.ok(chooser.includes(fn), fn);
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
	for (const file of PURE_FILES) {
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
	assert.match(app, /queryHistory: vectorQueryHistory,/, "the full app's Query history is the bridged, persisted store");
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
	assert.equal(entry.tab.get(), 'query', 'asking lands on the Query tab');
	assert.equal(entry.queryMode.get(), 'ask', 'in its Ask mode');
	assert.deepEqual(fronted, ['map:1', 'query:1'], 'asking about documents fronts the console too');
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
