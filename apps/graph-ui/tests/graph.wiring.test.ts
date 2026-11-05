// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WIRING GUARDS: React-side rules that the pure tests cannot see
// =============================================================================
//
// No React harness runs under node:test, so the rules that decide whether the UI stays in
// step with its state are pinned by reading the source. Each one guards a failure that
// only shows in a browser:
//
//   --  Escape must close the inspector: disposing the graph session when a new result
//       arrives would drop the surface's subscription, so closing the inspector would
//       change the state and nothing would re-render.
//   --  a refreshed discovery list hands back a NEW endpoint object for the same connection;
//       rebuilding the graph session from it would silently drop the user's selection,
//       inspector and expansions.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve(__dirname, '..', 'src');
const read = (...parts: string[]): string => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
/** Source without comments, so a rule is checked against code only. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('the surface disposes its graph session when the session is replaced or the surface unmounts, never from the effect that loads a new result', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const loadEffect = surface.slice(surface.indexOf('graphSession.load(result)') - 200, surface.indexOf('graphSession.load(result)') + 200);
	assert.doesNotMatch(loadEffect, /dispose\(\)/, 'dispose() beside load(result) runs on every new result');
	assert.match(surface, /useEffect\(\(\) => \(\) => graphSession\.dispose\(\), \[graphSession\]\)/);
});

test('the graph session is built from the connection key and refs, not from objects that change when discovery refreshes', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const factory = surface.slice(surface.indexOf('const graphSession = useMemo'), surface.indexOf('useEffect(() => () => graphSession.dispose()'));
	assert.match(factory, /\[endpoint\.key\]\)/, 'its dependency list is the key alone');
	// Every read of a changing value goes through `latest.current`: strip those, and no bare dialect/session/writable is left.
	const bare = factory.replace(/latest\.current\.(dialect|session|writable|announce)/g, '');
	assert.doesNotMatch(bare, /\b(dialect|writable)\b\s*[?.)]|[(,]\s*(session|dialect|writable)\s*[,)]/, 'it closes over a changing object');
	assert.match(factory, /latest\.current\./, 'what changes over time is read through a ref');
});

test('every open drawer and dialog goes through the shell: no graph-ui code handles Escape or swallows key events above them', () => {
	for (const file of ['components/GraphView.tsx', 'components/InspectorPanel.tsx', 'components/CanvasMenu.tsx', 'components/CanvasSearch.tsx', 'components/GraphStatusLine.tsx', 'components/KeysPanel.tsx', 'components/LegendPanel.tsx', 'components/StyleEditor.tsx', 'components/HistoryPanel.tsx', 'components/RunSurface.tsx', 'views/ConnectionsView.tsx', 'components/ConnectionDrawer.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx', 'components/ConnectionDetails.tsx', 'components/ConnectionDetailsPanel.tsx', 'components/SidePanel.tsx', 'components/SavedQueriesPanel.tsx', 'components/QueryTabs.tsx', 'components/SplitPane.tsx', 'components/AskBar.tsx', 'components/RowPanel.tsx']) {
		const text = code(read(...file.split('/')));
		assert.doesNotMatch(text, /stopPropagation/, `${file} stops event propagation`);
		assert.doesNotMatch(text, /addEventListener\(\s*['"]key/, `${file} registers its own key listener`);
	}
});

test('opening a workbench from the connection drawer closes the drawer first, so it cannot sit above the workbench', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	const onOpen = view.slice(view.indexOf('onOpen={'), view.indexOf('onClose={() => setDrawerKey(null)}'));
	assert.match(onOpen, /setDrawerKey\(null\)/);
	assert.ok(onOpen.indexOf('setDrawerKey(null)') < onOpen.indexOf('open(endpoint)'));
});

test('the inspector is an inline aside that closes through the session, and its panel is rendered from the same state the session publishes', () => {
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.match(inspector, /<aside aria-label="Inspector"/);
	assert.match(inspector, /session\.inspect\(null\)/);
	assert.match(inspector, /const target: IInspectTarget \| null = state\.inspect/);
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.doesNotMatch(surface, /InspectorPanel/, 'the inspector is mounted by the graph view, beside the canvas');
	const view = code(read('components', 'GraphView.tsx'));
	assert.match(view, /<InspectorPanel /);
	// The graph view, which renders the inspector, follows the session's published state (the surface no longer needs to).
	assert.match(view, /useSyncExternalStore\(session\.subscribe, session\.getState, session\.getState\)/);
});

// Nothing in a document may be a modal: rocket-ui keeps every document mounted, and a modal or drawer left open in a
// hidden one traps Tab, locks scroll and takes Escape for the whole window. The view's panels are inline, its menus are
// drawn inside the canvas, and keys are React handlers on its own elements, so none of them registers a listener.
test('the graph view, the inspector, the menus and the keys help import no Modal or DetailPanel and register no listener of their own', () => {
	for (const file of ['GraphView', 'InspectorPanel', 'CanvasMenu', 'KeysPanel', 'CanvasSearch', 'GraphStatusLine', 'LegendPanel', 'StyleEditor']) {
		const text = code(read('components', `${file}.tsx`));
		assert.doesNotMatch(text, /\b(Modal|DetailPanel)\b/, `${file} uses a modal`);
		assert.doesNotMatch(text, /addEventListener/, `${file} registers a listener`);
	}
	for (const [file, label] of [['InspectorPanel', 'Inspector'], ['KeysPanel', 'Keyboard shortcuts']] as const) {
		assert.match(code(read('components', `${file}.tsx`)), new RegExp(`<aside\\s[^>]*aria-label="${label}"`), `${file} is an aside`);
	}
	assert.match(code(read('components', 'CanvasMenu.tsx')), /role="menu"/);
});

// A re-probe (a restart of ANY pipeline, a shell reconnect, Test connection) takes the probe away for a moment. Both
// connection documents keep a run surface that has opened and pause it, rather than unmount it and lose the results,
// graph, expansions, inspector and row limit.
test('the workbench and the write console keep an opened run surface through a re-probe, and pass the pause reason down', () => {
	for (const file of ['WorkbenchView.tsx', 'WriteConsoleView.tsx']) {
		const view = code(read('views', file));
		assert.match(view, /surfaceGate\(/, `${file} decides through surfaceGate`);
		assert.match(view, /gate\.mounted \?/, `${file} mounts the surface on the gate`);
		assert.doesNotMatch(view, /\{(view\.openable|allowed) \? \(/, `${file} still unmounts the surface whenever the connection is not openable`);
		const surface = view.slice(view.indexOf('<RunSurface'), view.indexOf('/>', view.indexOf('<RunSurface')));
		assert.match(surface, /paused=\{gate\.paused\}/, `${file} tells the surface why it is paused`);
	}
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.match(surface, /canRun: \(\) => [^\n]*paused == null/, 'a paused surface sends nothing');
});

// A request is consumed by the surface through the host's slot, never de-duplicated by a ref the surface
// re-creates on every mount; a request the surface cannot run now is never queued to run later. The workbench keeps
// one slot per query tab, so a request for one tab can never land in another (the M5 rule: no draft is overwritten).
test('the run surface takes its editor request from the host\'s slot, and the hosts never queue a run for a surface that is not on screen', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/loadSlot\.take\(\)/.test(surface), 'the surface takes the request');
	assert.ok(!/loadRequest\.seq === handled\.current/.test(surface), 'a per-mount ref decides what was handled');
	const writeConsole = code(read('views', 'WriteConsoleView.tsx'));
	assert.ok(/useState\(createLoadSlot\)/.test(writeConsole), 'the write console keeps one slot for the life of the document');
	const consoleTag = writeConsole.slice(writeConsole.indexOf('<RunSurface'), writeConsole.indexOf('/>', writeConsole.indexOf('<RunSurface')));
	assert.ok(/loadSlot=\{slot\}/.test(consoleTag), 'the write console hands the slot to its surface');

	const workbench = code(read('views', 'WorkbenchView.tsx'));
	const slotOf = workbench.slice(workbench.indexOf('const slotOf = useCallback'), workbench.indexOf('const [seqs, setSeqs]'));
	assert.ok(/slots\.current\.get\(id\)/.test(slotOf) && /slot = createLoadSlot\(\);\s*slots\.current\.set\(id, slot\);/.test(slotOf), 'each tab gets its own slot, made once and kept for the life of the tab');
	const tag = workbench.slice(workbench.indexOf('<RunSurface'), workbench.indexOf('/>', workbench.indexOf('<RunSurface')));
	assert.ok(/loadSlot=\{slotOf\(tab\.id\)\}/.test(tag) && /loadSeq=\{seqs\[tab\.id\] \?\? 0\}/.test(tag), 'every tab\'s surface takes from its own slot');
	assert.ok(/tabId=\{tab\.id\}/.test(tag) && /active=\{shown\}/.test(tag), 'and knows its tab');
	assert.ok(/draftKey=\{tab\.id === FIRST_QUERY_TAB \? undefined : null\}/.test(tag), 'only Query 1 keeps the persisted draft');
	// DA I1: a text put into another tab (a preview, an Ask draft) must never reach Query 1's persisted draft.
	const changeText = surface.slice(surface.indexOf('const changeText = useCallback'), surface.indexOf('useEffect(() => () => { if (draftTimer.current)'));
	assert.ok(/setText\(next\);\s*if \(draftKey === null\) return;/.test(changeText), 'a tab without a draft key writes no draft');
	assert.ok(/const bag = draftKey === null \? null : prefs\.getPref\(DRAFTS_PREF_KEY\);/.test(surface), 'and reads none: a new tab never opens with Query 1\'s draft');
	const deliver = workbench.slice(workbench.indexOf('const deliver = useCallback'), workbench.indexOf('const activate = useCallback'));
	assert.ok(/const placed = placeRequest\(tabsNow\.current, request\);/.test(deliver), 'where text goes is decided by the pure tab model');
	assert.ok(/const runNow = placed\.put\.run && now\.mounted && now\.paused === null;/.test(deliver), 'a run is asked for only while the surface can run it');
	assert.ok(/slotOf\(placed\.target\)\.put\(\{ text: placed\.put\.text, run: runNow, insert: placed\.put\.insert \}\)/.test(deliver), 'into the target tab\'s slot only');
	assert.doesNotMatch(workbench, /useState\(createLoadSlot\)/, 'no one slot shared by every tab');
});

// F23: with several tabs per connection, a results grid layout keyed per result only would be shared between tabs.
test('the results grid key includes the tab, and the graph full screen leaves with Escape on its own element', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/tableKey=\{`\$\{endpoint\.key\}-\$\{tabId\}-\$\{resultKey\.current\}`\}/.test(surface), 'the tab id is part of the grid key');
	assert.ok(/style=\{maximized \? styles\.maximized : styles\.body\}/.test(surface), 'full screen restyles the results body: the graph is not remounted');
	assert.ok(/if \(event\.defaultPrevented \|\| !maximized \|\| event\.key !== 'Escape' \|\| !event\.currentTarget\.contains\(event\.target as Node\)\) return;/.test(surface), 'Escape that nothing inside used (checked first), on the element itself');
	assert.ok(/maximized=\{maximized\}/.test(surface) && /onToggleMaximized=\{toggleMaximized\}/.test(surface), 'the graph view drives it');
	assert.doesNotMatch(surface, /requestFullscreen|fullscreenElement/, 'not the browser\'s Fullscreen API');
});

// Apache AGE's node has four database connections, and a request the user stopped waiting for keeps one until the
// database finishes it: every request of every tab of a workbench goes through its one gate (graph/requestGate.ts),
// and the write console's through its own.
test('every request goes through its document\'s one request gate: the workbench\'s for all its tabs, the write console\'s own', () => {
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/const \[requests\] = useState\(createRequestGate\);/.test(workbench), 'one gate for the life of the document');
	const tag = workbench.slice(workbench.indexOf('<RunSurface'), workbench.indexOf('/>', workbench.indexOf('<RunSurface')));
	assert.ok(/gate=\{requests\}/.test(tag), 'every tab\'s surface gets it');
	const surface = code(read('components', 'RunSurface.tsx'));
	const execute = surface.slice(surface.indexOf('execute: async'), surface.indexOf('settle:'));
	assert.ok(/\? \(gate \? gate\.send\(TOOL\.readQuery, read\) : read\(\)\)/.test(execute), 'a statement read goes through it');
	const factory = surface.slice(surface.indexOf('const graphSession = useMemo'), surface.indexOf('useEffect(() => () => graphSession.dispose()'));
	assert.ok(/const through = latest\.current\.gate;\s*return through \? through\.send\(TOOL\.readQuery, read\) : read\(\);/.test(factory), 'and so does every graph action');
	const writeConsole = code(read('views', 'WriteConsoleView.tsx'));
	assert.ok(/const \[requests\] = useState\(\(\) => createRequestGate\('write console'\)\);/.test(writeConsole), 'the write console has its own gate, not the workbench\'s');
	assert.ok(/gate=\{requests\}/.test(writeConsole.slice(writeConsole.indexOf('<RunSurface'), writeConsole.indexOf('/>', writeConsole.indexOf('<RunSurface')))), 'and hands it to its surface');
	// A write goes through the gate INSIDE countWrite: a write the gate refused was never sent and marks nothing out of date.
	assert.ok(/: env\.countWrite\(endpoint\.key, \(\) => \(gate \? gate\.send\(TOOL\.execute, write\) : write\(\)\)\);/.test(execute), 'a write goes through it, inside the count');
});

// A statement of a batch can meet the gate taken in the gap after the one before it: it was never sent, the pipeline
// is running. Its banner gives no "start the pipeline" hint, History does not record it, and Run says it is waiting.
test('a gate refusal is a warning with no pipeline hint and no History entry, and Run waits on the gate with its reason', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/const notice = isGateRefusal\(error\) \? gateRefusalNotice\(message\) : mode === 'write'/.test(surface), 'statements');
	assert.ok(/describe: \(error\) => \(isGateRefusal\(error\) \? gateRefusalNotice\(/.test(surface), 'graph actions');
	const record = surface.slice(surface.indexOf('record: (run) =>'), surface.indexOf('summarize:'));
	assert.ok(/if \(run\.outcome === 'error' && isGateRefusalText\(run\.error\)\) return;\s*env\.history\.record\(/.test(record), 'a statement that was never sent is not recorded');
	assert.ok(/const gateBusy = useSyncExternalStore\(gate \? gate\.subscribe : NO_GATE\.subscribe, gate \? gate\.busy : NO_GATE\.busy, gate \? gate\.busy : NO_GATE\.busy\);/.test(surface), 'the surface follows its gate');
	assert.ok(/if \(gateBusy === null\) setStartRefusal\(\(current\) => \(isGateRefusalText\(current\) \? null : current\)\);/.test(surface), '"Try again in a moment" goes once the gate is free');
	assert.ok(/waiting \? 'Waiting for an earlier request to finish…'/.test(surface) && /title=\{waiting \? gateWaitingTitle\(mode === 'read' \? 'Run' : 'Execute'\) :/.test(surface) && /title=\{waiting \? gateWaitingTitle\(mode === 'read' \? 'Run all' : 'Execute all'\) :/.test(surface), 'Run says it is waiting, and why, naming its own button (Execute in the write console)');
});

// Live bug 1: with the strip's basis fixed at 220 px, a run bar that just fitted beside it squeezed the tabs, and the
// tab list scrolled the new tab out of sight. Live check at d9b7c0cb8: sharing the row, the run bar joined the tabs'
// line while a run was out (narrower: Stop waiting, "Running…", no counts) and wrapped inside it, so the tabs sank to
// the bottom of a two-row line. The rule now: the tabs have a row of their own, the shown tab's controls the row under
// it; only tabs wider than the row scroll, and the shown tab is scrolled into view.
test('the tabs have a row of their own and the run bar the row under it, and the shown tab is always in view', () => {
	const tabs = code(read('components', 'QueryTabs.tsx'));
	assert.ok(/strip: \{ flex: '1 1 auto', minWidth: 0,/.test(tabs), 'the strip fills the tab row');
	assert.ok(/list: \{[^}]*overflowX: 'auto'/.test(tabs), 'tabs wider than the row scroll');
	assert.ok(/view\.scrollLeft = scrollLeftToShow\([^;]*\);\s*\}, \[active, tabs\.length\]\);/.test(tabs), 'the shown tab is scrolled into view');
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/<div style=\{styles\.tabRow\}>\s*<QueryTabs[\s\S]*?focusRequest=\{focusTabs\}\s*\/>\s*<\/div>\s*<div style=\{styles\.controlRow\}>\s*<div ref=\{setBarHost\} style=\{tabs\.active === OVERVIEW_TAB \? styles\.hidden : styles\.barHost\} \/>\s*\{tabs\.active === OVERVIEW_TAB && \(\s*<div style=\{styles\.overviewActions\}>/.test(workbench), 'the tab row holds the tabs alone; the row under it holds the run bar, or Overview\'s actions');
	assert.doesNotMatch(workbench.slice(workbench.indexOf('tabRow: {'), workbench.indexOf('\n', workbench.indexOf('tabRow: {'))), /flexWrap/, 'nothing wraps into the tab row');
	assert.ok(/controlRow: \{ flex: '0 0 auto', display: 'flex', justifyContent: 'flex-end', padding: '4px 24px' \}/.test(workbench), 'right-aligned, with the bottom padding the hidden editor\'s divider sits over');
	assert.ok(/barHost: \{ flex: '1 1 auto', minWidth: 0, display: 'flex' \}/.test(workbench));
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/runBarInRow: \{ flex: '1 1 auto', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end', minWidth: 0 \}/.test(surface), 'the bar fills the row: its lines break on the row\'s width, not on a measured width that counts the state text\'s content instead of its basis');
	assert.ok(/firstLine: \{ flex: '1 1 0', maxWidth: '40%', minWidth: 60,/.test(surface), 'the hidden editor\'s first line takes the room left, and never wraps the bar');
});

// Review 4c: Stop waiting appearing beside Run widened the run bar by about 95 px, so a bar near the wrap threshold
// wrapped and unwrapped around every run. It takes Run's slot instead, and a focus on the button that went moves to the
// one that came.
test('Stop waiting takes the Run / Run all slot while a run is out, and the focus follows the slot', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const bar = surface.slice(surface.indexOf('const runBar = ('), surface.indexOf('return (', surface.indexOf('const runBar = (')));
	assert.ok(/<span\s+ref=\{runSlot\}\s+style=\{styles\.runSlot\(runOut \? held\?\.slot : undefined\)\}/.test(bar), 'one slot');
	assert.ok(/\{runner\.canStop \? \(\s*<Button variant="ghost" small=\{inRow\} title=\{STOP_WAITING_NOTE\} onClick=\{\(\) => runner\.stopWaiting\(\)\}>\s*Stop waiting\s*<\/Button>\s*\) : \(/.test(bar), 'Stop waiting in place of Run and Run all');
	assert.equal((bar.match(/Stop waiting\s*<\/Button>/g) ?? []).length, 1, 'and nowhere else in the bar');
	// Live check at d9b7c0cb8: as display: contents the slot had no width to keep, so Stop waiting narrowed the bar.
	// While a run is out the slot and the result switch keep the widths measured before it; every other control's
	// width does not depend on a run, so the bar's lines break where they did.
	assert.ok(/runSlot: \(minWidth: number \| undefined\): CSSProperties => \(\{ display: 'inline-flex', alignItems: 'center', gap: 'inherit', minWidth \}\)/.test(surface), 'a box of its own that can keep a width');
	const hold = surface.slice(surface.indexOf('const viewsGroup = useRef'), surface.indexOf('const runStateText ='));
	assert.ok(/const runOut = runner\.running \|\| runner\.canStop;/.test(hold));
	assert.ok(/if \(runOut \|\| !runSlot\.current \|\| !viewsGroup\.current\) return;/.test(hold), 'measured only while no run is out');
	assert.ok(/slot: runSlot\.current\.getBoundingClientRect\(\)\.width, views: viewsGroup\.current\.getBoundingClientRect\(\)\.width/.test(hold));
	// Review 4g: a run that ends while its document is hidden (rocket-ui) or its panel is not visible (VS Code) measures
	// inside display: none, where every width is 0; those are not kept, so the next run holds what was measured shown.
	assert.ok(/if \(next\.slot === 0 \|\| next\.views === 0\) return;\s*setHeld\(/.test(hold), 'a width measured hidden (0) is not kept');
	assert.ok(/\}, \[runOut, views, mode, inRow, active, barHost\]\);/.test(hold), 'measured again when the labels, the size or the bar change');
	assert.ok(/<span ref=\{viewsGroup\} role="group" aria-label="Show the result as" style=\{styles\.views\(runOut \? held\?\.views : undefined\)\}>/.test(bar), 'the result switch keeps its width too');
	// Review 4d: a focus lost with the button that went goes to the slot's button when it can be pressed, otherwise to
	// the state text (it says why), and back to Run once Run can be pressed; only this tab's run moves a lost focus.
	const focusRule = surface.slice(surface.indexOf('const parkedFromSlot = useRef(false);'), surface.indexOf('const runBar = ('));
	assert.ok(/const stuck = focused instanceof HTMLButtonElement && focused\.disabled && runSlot\.current\?\.contains\(focused\) === true;/.test(focusRule), 'a disabled Run that kept the focus counts as lost');
	assert.ok(/if \(!parked && !\(runChanged && runSlotFocused\.current && \(lost \|\| stuck\)\)\) return;/.test(focusRule), 'only this tab\'s run (or parked focus) moves it');
	assert.ok(/if \(button && !button\.disabled\) \{\s*parkedFromSlot\.current = false;\s*button\.focus\(\);\s*\} else if \(!parked && runState\.current\) \{\s*parkedFromSlot\.current = true;\s*runState\.current\.focus\(\);\s*\}/.test(focusRule), 'a pressable button, else the state text');
	assert.ok(/\}, \[runner\.canStop, runner\.running, gateBusy\]\);/.test(focusRule), 'a run that ends before Stop waiting shows, and the gate freeing, both count');
	assert.ok(/if \(event\.relatedTarget !== null && !event\.currentTarget\.contains\(event\.relatedTarget as Node\)\) runSlotFocused\.current = false;/.test(surface), 'focus going nowhere still belongs to the slot');
	// Review 4d: line breaking sees one width for the state text whatever it says (a basis of 0 and a fixed minimum); it
	// takes the room left on its line, cut with an ellipsis.
	assert.ok(/runState: \(focused: boolean\): CSSProperties => \(\{\s*flex: '1 1 0',\s*minWidth: 120,\s*maxWidth: 260,[\s\S]*?textOverflow: 'ellipsis',/.test(surface), 'one width for line breaking, cut with an ellipsis');
	assert.ok(/outline: focused \? '2px solid var\(--rr-border-focus\)' : 'none',/.test(surface), 'holding the focus, it shows the ring');
	assert.ok(/<span\s+ref=\{runState\}\s+tabIndex=\{-1\}\s+style=\{styles\.runState\(runStateFocused\)\}\s+title=\{runStateText\}/.test(bar), 'the state text can hold the focus, and its title is the whole text');
	// Review 4c: the hidden-editor divider sits 3 px over the control row's bottom padding, in the workbench only.
	assert.ok(/overlap=\{split\.collapsed && barHost !== undefined \? 3 : 0\}/.test(surface));
	const divider = code(read('components', 'SplitPane.tsx'));
	assert.ok(/margin: overlap > 0 \? `-\$\{overlap\}px 24px 0` : '2px 24px 0'/.test(divider) && /height: 9,/.test(divider), 'same 9 px hit area, less height');
	// Review 4c: the shown tab is brought into view by scrolling the tab list itself, never an ancestor.
	const tabs = code(read('components', 'QueryTabs.tsx'));
	assert.doesNotMatch(tabs, /scrollIntoView/);
	assert.ok(/view\.scrollLeft = scrollLeftToShow\(view\.getBoundingClientRect\(\), tab\.getBoundingClientRect\(\), view\.scrollLeft\);/.test(tabs));
});

// Live bug 3: Home hid the editor and unmounted the divider, so the focus fell to the page and End did nothing.
test('the divider stays mounted while the editor is hidden, so Home keeps the focus and End shows the editor again', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/<SplitDivider split=\{\{ height: editorHeight, collapsed: split\.collapsed \}\}/.test(surface), 'it always renders, with the hidden state');
	assert.doesNotMatch(surface, /!split\.collapsed && <SplitDivider/, 'never removed while hidden');
});

// DA-R2 N-1: full screen covers the document, so what it covers must not stay reachable by the keyboard or a screen
// reader: the host hides its root (visibility keeps the layout) and the graph's area makes itself visible again.
test('in full screen the covered document is hidden from the keyboard and screen readers, and its editor runs nothing', () => {
	const styles = code(read('styles.ts'));
	assert.ok(/documentRootCovered: \{\s*\.\.\.commonStyles\.columnFill,\s*position: 'relative',\s*visibility: 'hidden',\s*\}/.test(styles), 'the covered root is hidden');
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/maximized: \{[^}]*visibility: 'visible' \}/.test(surface), 'the graph\'s area shows itself again');
	assert.ok(/wasMaximized\.current = maximized;\s*fullScreenListener\.current\?\.\(maximized\);/.test(surface), 'the host is told on the way in and out');
	assert.ok(/useEffect\(\(\) => \(\) => \{\s*if \(wasMaximized\.current\) fullScreenListener\.current\?\.\(false\);\s*\}, \[\]\);/.test(surface), 'and when the surface goes while full screen (its tab closed)');
	const run = surface.slice(surface.indexOf('const run = useCallback'), surface.indexOf('}, [startRun]);', surface.indexOf('const run = useCallback')));
	assert.ok(/if \(fullScreenNow\.current\) return;/.test(run), 'Ctrl/Cmd+Enter in the hidden editor sends nothing');
	assert.ok(/fullScreenNow\.current = maximized;/.test(surface));
	for (const [file, root] of [['views/WorkbenchView.tsx', 'shared'], ['views/WriteConsoleView.tsx', 'styles']] as const) {
		const view = code(read(...file.split('/')));
		assert.ok(new RegExp(`<div style=\\{fullScreen \\? ${root}\\.documentRootCovered : ${root}\\.documentRoot\\}>`).test(view), `${file} hides its root while a graph fills it`);
		assert.ok(/onFullScreen=\{setFullScreen\}/.test(view), `${file} listens`);
	}
});

// DA-R2 N-7: Ask is one of the workbench's requests (on Apache AGE its check runs EXPLAIN through the same pool).
test('Ask goes through the workbench\'s gate, and a refusal says the gate\'s sentence, not "no language model"', () => {
	const ask = code(read('components', 'AskBar.tsx'));
	assert.ok(/const busy = gate\?\.busy\(\) \?\? null;\s*if \(busy !== null\) \{\s*setOutcome\(\{ kind: 'refused', text: busy \}\);/.test(ask), 'checked before anything is sent');
	assert.ok(/gate \? gate\.send\(TOOL\.getQuery, \(\) => send\(text\)\) : send\(text\)/.test(ask), 'sent through it');
	assert.ok(/if \(isGateRefusal\(error\)\) refused\.text = \(error as Error\)\.message;/.test(ask) && /refused\.text !== null \? \{ kind: 'refused', text: refused\.text \} : answer/.test(ask), 'a refusal that races the check is said as the gate says it');
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	const bar = workbench.slice(workbench.indexOf('<AskBar'), workbench.indexOf('/>', workbench.indexOf('<AskBar')));
	assert.ok(/gate=\{requests\}/.test(bar), 'the workbench hands Ask its gate');
});

// DA-R1 I-2: the graph view is mounted only while its tab is shown, so how the graph is shown lives with the tab: a
// tab switch must not reset Tree to Force (the grid again in VS Code past 100 nodes), unpin nodes or reopen the legend.
test('a tab keeps its layout choice, pinning and legend for its graph view, which it mounts only while shown', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/export const DEFAULT_GRAPH_VIEW: IGraphViewState = Object\.freeze\(\{ layoutMode: 'force', keepPinned: true, legendOpen: false \}\);/.test(surface), 'a new tab: Force, dragged nodes kept pinned, the legend closed');
	assert.ok(/const \[graphView, setGraphView\] = useState<IGraphViewState>\(DEFAULT_GRAPH_VIEW\);/.test(surface), 'kept by the surface, which a hidden tab keeps mounted');
	const tag = surface.slice(surface.indexOf('<GraphView'), surface.indexOf('/>', surface.indexOf('<GraphView')));
	for (const prop of ['layoutMode={graphView.layoutMode}', 'onLayoutModeChange={setLayoutMode}', 'keepPinned={graphView.keepPinned}', 'onKeepPinnedChange={setKeepPinned}', 'legendOpen={graphView.legendOpen}', 'onLegendOpenChange={setLegendOpen}']) {
		assert.ok(tag.includes(prop), `the graph view is controlled: ${prop}`);
	}
});

// A hidden tab keeps its runs, result and graph session, but no canvas or grid (8 tabs x every open document).
test('only the shown tab draws its results, puts its run bar under the tabs, and keeps a row open', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/\{active && \(\s*<div style=\{styles\.fill\}>/.test(surface), 'the graph, the table and the raw view render only while the tab is shown');
	assert.ok(/\{barHost !== undefined && active && barHost !== null && createPortal\(runBar, barHost\)\}/.test(surface), 'only the shown tab\'s run bar is under the tabs');
	assert.ok(/if \(!active\) setOpenRow\(null\);/.test(surface), 'a hidden tab closes its row panel');
	assert.doesNotMatch(surface, /RowInspector/, 'no shared row drawer (it listens for Escape on the whole page)');
	assert.ok(/<RowPanel /.test(surface), 'the row opens inline');
	// I5: the results have no row of their own for Graph / Table / Raw; the switch is a compact toggle in the run bar.
	assert.doesNotMatch(surface, /TabControl/, 'no results tab row');
	const bar = surface.slice(surface.indexOf('const runBar = ('), surface.indexOf('return (', surface.indexOf('const runBar = (')));
	assert.ok(/<span ref=\{viewsGroup\} role="group" aria-label="Show the result as" style=\{[^}]*\}>\s*<ToggleGroup options=\{views\} value=\{tab\} onChange=\{\(id\) => setTab\(id\)\} \/>\s*<\/span>/.test(bar), 'the switch is in the run bar, named by its group');
	// Query 1's draft is written when its tab closes right after typing, not dropped with the timer.
	assert.ok(/if \(draftTimer\.current\) clearTimeout\(draftTimer\.current\);\s*pendingDraft\.current\?\.\(\);/.test(surface), 'a pending draft is flushed on unmount');
	assert.ok(/onRunFrom=\{mode === 'read' \? runFrom : undefined\}/.test(surface), 'Run from statement N only in the read workbench: a write that may have been applied is never re-sent from the banner');
});

// The shell's ToggleGroup drops aria-label, so a toggle's name lives on a group wrapper (the attribute alone names nothing).
test('every toggle is named by a group wrapper, and none passes the aria-label the shell drops', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/<span role="group" aria-label="Row limit">\s*<ToggleGroup options=\{LIMIT_OPTIONS\}/.test(surface), 'the row limit');
	assert.ok(/<span ref=\{viewsGroup\} role="group" aria-label="Show the result as" style=\{[^}]*\}>\s*<ToggleGroup options=\{views\}/.test(surface), 'the result view');
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/<span role="group" aria-label="Show history or saved queries">\s*<ToggleGroup options=\{SIDE_OPTIONS\}/.test(workbench), 'History or Saved');
	for (const text of [surface, workbench]) assert.doesNotMatch(text, /<ToggleGroup[^>]*aria-label=/, 'no aria-label on the toggle itself');
});

// After a close confirmed in a dialog the focus would fall to the page; the shown tab takes it, as after a mouse close.
test('the tab shown after a confirmed close takes the focus, and a flagged Ask draft says so without opening Details', () => {
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	const confirm = workbench.slice(workbench.indexOf('title={`Close '), workbench.indexOf('/>', workbench.indexOf('title={`Close ')));
	assert.ok(/closeNow\(id\);\s*setFocusTabs\(\(n\) => n \+ 1\);/.test(confirm), 'confirming moves the focus to the shown tab');
	assert.ok(/focusRequest=\{focusTabs\}/.test(workbench));
	const tabs = code(read('components', 'QueryTabs.tsx'));
	assert.ok(/if \(focusRequest > 0\) buttons\.current\.get\(active\)\?\.focus\(\);/.test(tabs));
	assert.ok(/\{note\.check !== null && \(\s*<>\s*(\{\}\s*)?<StatusBadge variant="warning">Check before running<\/StatusBadge>/.test(workbench), 'a visible cue beside Details');
	// The run bar under the tabs is right-aligned.
	assert.ok(/controlRow: \{[^}]*justifyContent: 'flex-end'/.test(workbench));
});

// The seams the other packages left for the surface: the node's shortestPath flag (P3), the failure's place and the
// editor's write warnings and completion (P4), the graph's export mode (P2), and every preview kind (P5).
test('the surface and the workbench hand the other parts what they need, and only where it is safe', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/shortestPath: latest\.current\.dialect\.capabilities\.shortest_path === true/.test(surface), 'the node\'s shortestPath flag reaches the path search');
	assert.ok(/warnWrites=\{mode === 'read'\}/.test(surface), 'write warnings in the read workbench only');
	assert.ok(/\.\.\.\(mode === 'write' \? \{ writes: true \} : \{\}\)/.test(surface), 'write clauses offered in the write console only');
	assert.ok(/if \(!failure \|\| buffer === null \|\| buffer !== text\) return null;/.test(surface), 'a failure is placed only in the text its batch was taken from');
	assert.ok(/locateFailure\(buffer, \{ start: failed\.start, end: failed\.end \}, failure\.notice\.verbatim, dialect\?\.dialect \?\? null\)/.test(surface));
	assert.ok(/markers=\{markers\}/.test(surface) && /total=\{runner\.runs\.length\}/.test(surface), 'the editor marks it and the banner names it');
	assert.ok(/exportMode=\{isInVSCode\(\) \? 'copy' : 'download'\}/.test(surface), 'VS Code copies instead of downloading');
	// Captions are part of the connection's style (P5's store): the surface neither reads nor writes graph.captions.
	assert.doesNotMatch(surface, /CAPTIONS_PREF_KEY|graph\.captions|onCaption=/, 'no caption prefs of its own');
	assert.ok(/const styleView = useConnectionStyle\(endpoint\.key\);/.test(surface) && /style\.caption/.test(surface), 'the session\'s captions come from the style');
	// One source: what the session says out loud and what the graph view draws are the same captions, so Reset clears both.
	const captionsBlock = surface.slice(surface.indexOf('const styleView = useConnectionStyle'), surface.indexOf('captionsRef.current = captions;'));
	assert.ok(/for \(const \[label, style\] of Object\.entries\(styleView\.style\.labels\)\) if \(style\.caption\) out\.set\(label, style\.caption\);/.test(captionsBlock), 'built from the style alone');
	assert.ok(/const captionsRef = useRef\(captions\);/.test(captionsBlock) && /captionChoice: \(label\) => captionsRef\.current\.get\(label\)/.test(surface), 'the session reads those');
	assert.ok(/<GraphView[\s\S]*?captions=\{captions\}/.test(surface), 'and the graph view gets the same map, so no other caption can win over the style\'s');
	assert.doesNotMatch(surface, /prefs\.(get|set)Pref\(\s*['"]graph\.captions/, 'no caption prefs read or written');
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/const \{ recipe, run \} = previewStatement\(engine, request\);/.test(workbench), 'every preview kind is decided by previewStatement: a "New query" request is never run');
	assert.doesNotMatch(workbench, /request\.action === 'type-preview' \?/, 'no two-way guess at the kind');
});

// F3: rocket-ui keeps hidden documents mounted, so a modal drawer left open in a background document would trap Tab and
// take Escape for the realm. History, Saved, the tab strip and the divider are part of the document's layout.
test('History, Saved, the side panel, the tab strip and the divider are inline: no DetailPanel, no Modal', () => {
	for (const file of ['components/HistoryPanel.tsx', 'components/SavedQueriesPanel.tsx', 'components/SidePanel.tsx', 'components/QueryTabs.tsx', 'components/SplitPane.tsx', 'components/RowPanel.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx']) {
		const text = code(read(...file.split('/')));
		assert.doesNotMatch(text, /\bDetailPanel\b|\bModal\b/, `${file} renders a modal panel`);
	}
	const side = code(read('components', 'SidePanel.tsx'));
	assert.ok(/<aside\s+ref=\{region\}\s+tabIndex=\{-1\}\s+aria-label=\{title\}/.test(side), 'a complementary landmark that takes the focus');
	assert.ok(/if \(event\.key !== 'Escape' \|\| event\.defaultPrevented \|\| !event\.currentTarget\.contains\(event\.target as Node\)\) return;/.test(side), 'Escape only from inside it, when nothing inside used it');
	const divider = code(read('components', 'SplitPane.tsx'));
	assert.ok(/role="separator"/.test(divider) && /aria-orientation="horizontal"/.test(divider) && /aria-valuenow=\{aria\.now\}/.test(divider) && /tabIndex=\{0\}/.test(divider), 'a focusable WAI-ARIA window splitter');
	assert.ok(/setPointerCapture\(event\.pointerId\)/.test(divider), 'a drag captures the pointer');
	const tabs = code(read('components', 'QueryTabs.tsx'));
	assert.ok(/role="tablist"/.test(tabs) && /role="tab"/.test(tabs) && /aria-selected=\{selected\}/.test(tabs) && /tabIndex=\{selected \? 0 : -1\}/.test(tabs), 'a tab list with one tab in the Tab order');
});

// A JS escape written as JSX text is shown literally ("Asking the language model\u2026" on screen).
test('no graph-ui view writes a \\u escape as JSX text', () => {
	for (const file of ['components/AskBar.tsx', 'components/RunSurface.tsx', 'components/SavedQueriesPanel.tsx', 'components/HistoryPanel.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx']) {
		const text = code(read(...file.split('/')));
		assert.doesNotMatch(text, />[^<>{}]*\\u[0-9a-fA-F]{4}[^<>{}]*</, `${file} has an escape in JSX text`);
	}
});

// A write is not counted in `record`, which the shared runner skips once the document is closed: a write that lands
// after the console closed still marks other graphs out of date.
// The count lives behind the GraphEnv: the full app's LOCAL env counts in the call (countWrite on its data versions),
// and as a dev tool the CONTROLLER counts it in its execute handler, so every frame of the connection sees the
// version move; a frame never counts a write itself (it would count it twice).
test('the write console counts a write where it is sent, not in the record step a closed document skips', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const execute = surface.slice(surface.indexOf('execute: async'), surface.indexOf('settle:'));
	assert.ok(/const write = \(\): Promise<ReadQueryResult> => session\.invoke<ReadQueryResult>\(TOOL\.execute, \{ query: send\.cypher, shape: 'graph' \}/.test(execute) && /env\.countWrite\(endpoint\.key, \(\) => \(gate \? gate\.send\(TOOL\.execute, write\) : write\(\)\)\)/.test(execute), 'execute is sent through the env\'s countWrite');
	const record = surface.slice(surface.indexOf('record: (run) =>'), surface.indexOf('summarize:'));
	assert.ok(/isAbandonedWrite\(mode, run\.outcome\)\) env\.markAbandonedWrite\(endpoint\.key\)/.test(record), 'record counts only a write the user stopped waiting for');
	assert.ok(!/mayHaveChangedData/.test(surface));
	assert.ok(/describeWriteFailure\(message, error\)/.test(surface), 'the write console words its failures as possibly applied');

	const local = code(read('localEnv.ts'));
	assert.ok(/countWrite: \(key, send\) => countWrite\(stores\.dataVersions, key, send\)/.test(local), 'the LOCAL env counts the write in the call');
	const controller = code(read('devtool', 'controller.ts'));
	const handler = controller.slice(controller.indexOf('[OP.execute]: async'), controller.indexOf('[OP.ask]:'));
	assert.ok(/countWrite\(stores\.dataVersions, key, \(\) => session\.invoke<ReadQueryResult>\(TOOL\.execute, \{ query, shape: 'graph' \}\)\)/.test(handler), 'the controller counts the write in its handler');
	const frame = code(read('devtool', 'frame.ts'));
	assert.ok(/countWrite: \(_key, send\) => send\(\)/.test(frame), 'a frame never counts a write itself');
});

// A run is settled by its mode: the write console's runs are not settled as 'rows' with the read toggle's limit.
test('the run surface settles, records and describes a run through the mode-aware helpers', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/settle: \(_run, result\) => settleRun\(mode, result, dialect\?\.dialect \?\? null\)/.test(surface), 'settle follows the mode (and the engine: Apache AGE reports rows, not changes)');
	assert.ok(/patch: limitPatch\(mode, p\.limit\)/.test(surface), 'a limit is recorded only where one is sent');
	assert.ok(/historySummaryOf\(run, Date\.now\(\), \{ affectedNotReported: notReported \}\)/.test(surface), 'history keeps an affected count, and an AGE write\'s is not reported');
	assert.ok(/resultMeta\(displayed/.test(surface), 'the result line shows the affected count');
});

// The busy sentence says "stop waiting for it", so the control is offered for every request, not only a path search.
test('the graph offers Stop waiting for whatever it is waiting on, in the toolbar and in the inspector', () => {
	const view = code(read('components', 'GraphView.tsx'));
	assert.ok(/\.\.\.\(busy \? \[\{ id: 'stop', label: 'Stop waiting'[^\]]*keep: 100, run: \(\) => session\.stopWaiting\(\) \}\]/.test(view), 'the toolbar offers it whenever a request runs, and it is the last action to move to More');
	assert.ok(!/state\.busy === 'path' && <Button/.test(view), 'not only for a path search');
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.ok(/state\.busy !== null && <Button[^>]*onClick=\{\(\) => session\.stopWaiting\(\)\}>Stop waiting<\/Button>/.test(inspector), 'the inspector offers it beside Refresh');
});

// Run stays disabled for as long as a statement runs, Stop waiting shown or not: a press then would do nothing.
test('Run is disabled for as long as a statement runs, and a run that cannot start says why', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const buttons = surface.match(/<Button variant="(primary|ghost)" disabled=\{[^}]*\} onClick=\{\(\) => run\((false|true)\)\}/g) ?? [];
	assert.equal(buttons.length, 2, 'Run and Run all');
	for (const button of buttons) assert.ok(button.includes('disabled={runner.running || blocked !== null || gateBusy !== null}'), button);
	const startRun = surface.slice(surface.indexOf('const startRun = useCallback'), surface.indexOf('const run = useCallback'));
	assert.ok(/runRefusal\(\{ running: runner\.running, blocked, busy: gate\?\.busy\(\) \?\? null \}\)/.test(startRun), 'startRun refuses with a sentence, the document\'s busy gate included (both modes)');
	assert.ok(/setStartRefusal\(refusal\);/.test(startRun), 'and the sentence stays on screen until the next press');
	const confirm = surface.slice(surface.indexOf('onConfirm={'), surface.indexOf('onCancel={'));
	assert.ok(/runRefusal\(\{ running: runner\.running, blocked, busy: gate\?\.busy\(\) \?\? null \}\)/.test(confirm), 'so does confirming a write, the console\'s gate included');
});

// The write confirmation is the shell's ConfirmDialog, which focuses its confirm button when it mounts, so an Enter
// right after Ctrl/Cmd+Enter (or a double Enter) would execute the write. WriteConfirmDialog renders that dialog and
// moves focus to Cancel from its OWN mount effect, which React runs after the dialog's (a parent's effects run after
// its children's in the same commit).
// An effect in RunSurface keyed on the dialog being open is not enough. Under <React.StrictMode> (the shell renders in
// it) a development build re-runs the mount effects of what was just mounted (the dialog, so Execute takes the focus
// again) but not RunSurface's update effect, so focus would end on Execute. A mount effect of the component that
// renders the dialog is re-run with it, after it. No React harness runs here, so the shape is pinned by the source.
test('the write confirmation opens with focus on Cancel, never on Execute, under StrictMode too', () => {
	const confirmation = code(read('components', 'WriteConfirmDialog.tsx'));
	assert.ok(/import \{[^}]*\bfocusCancelIn\b[^}]*\} from 'shared\/explorer\/components\/PatternConfirmDialog';/.test(confirmation), 'the shared focus step is used');
	assert.ok(/useEffect\(\(\) => \{\s*focusCancelIn\(anchor\.current, WRITE_CANCEL_LABEL\);\s*\}, \[\]\);/.test(confirmation), 'a mount effect of the component that renders the dialog moves focus to Cancel');
	assert.equal(confirmation.match(/useEffect\(/g)?.length, 1, 'and it is the only effect there');
	const start = confirmation.indexOf('<ConfirmDialog');
	assert.ok(start > 0, 'the component renders the shell dialog itself, so it is the dialog\'s parent');
	const dialog = confirmation.slice(start, confirmation.indexOf('onConfirm={', start));
	assert.ok(/cancelLabel=\{WRITE_CANCEL_LABEL\}/.test(dialog), 'the Cancel button carries the label the focus step looks for');
	assert.ok(/message=\{\s*<div ref=\{anchor\}>/.test(dialog), 'the anchor sits inside the dialog');

	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/import \{ WriteConfirmDialog \} from '\.\/WriteConfirmDialog';/.test(surface));
	assert.ok(/\{confirm && \(\s*<WriteConfirmDialog\s+content=\{confirm\.content\}/.test(surface), 'the console mounts it while a confirmation is pending');
	assert.doesNotMatch(surface, /<ConfirmDialog\b/, 'the console renders no write dialog of its own');
	assert.doesNotMatch(surface, /focusCancelIn|confirmOpen|confirmAnchor/, 'no RunSurface effect moves the focus: StrictMode does not re-run it');
});

// The empty state never replaces the card grid when there are cards: a stopped, unreachable or No access node keeps
// its card, so the reason and Test connection the message points to can be reached.
test('the landing renders its cards whenever there are any, under its message, and the empty state alone only when there is no card', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/const landing = landingView\(status, endpoints, error\);/.test(view), 'the layout comes from landingView');
	assert.ok(!/\{empty \? \(/.test(view), 'an empty state still replaces the card grid');
	assert.ok(/\{landing\.message && !landing\.cards && \(\s*<EmptyState/.test(view), 'the empty state stands alone only without cards');
	assert.ok(/\{landing\.message && landing\.cards && \(/.test(view), 'with cards, the message sits above them');
	assert.ok(/\{landing\.cards && \(\s*<div style=\{styles\.cardGrid\}>/.test(view), 'the grid renders whenever there are cards');
});

// On a change of user, organization or team (or a sign-out) the shared store forgets every connection, so the open
// workbench and write-console documents must not keep the previous identity's results on screen.
test('a change of identity closes every connection document and clears the per-connection caches', () => {
	const app = code(read('GraphApp.tsx'));
	assert.ok(/const fingerprint = identityFingerprint\(identityFromConnectResult\(identity\)\);/.test(app), 'the app tracks the fingerprint the shared store tracks');
	assert.ok(/useLayoutEffect\(\(\) => \{\s*forgetConnections\(getDocs\(\), \{ schemas \}\);\s*pinned\.userData\.forget\(\);\s*\}, \[pinned, fingerprint\]\);/.test(app), 'every change of it forgets the connections, and the colour slots wanted for them, before the next paint');
});

// #2625 9bd5d931f gave Documents a dirty-close policy and moved every app's group close onto it; the full app follows.
test('closing a group goes through the shell\'s dirty-close policy (requestCloseGroup), as every app on #2625 does', () => {
	const app = code(read('GraphApp.tsx'));
	assert.ok(/onCloseGroup=\{\(gid\) => \{ void docs\.requestCloseGroup\(gid\); \}\}/.test(app), 'the group close asks the policy first');
	assert.ok(!/docs\.closeGroup\(/.test(app), 'nothing closes a group around it');
});

// The drawer starts fresh for every card: one shared instance would show the last Test result on the next card opened.
test('the connection drawer starts fresh for every card, and words its Test result through testResultText', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/<ConnectionDrawer\s+key=\{drawerKey \?\? ''\}/.test(view), 'the drawer is keyed on the card it shows');
	// The Test step is shared by the drawer and the dev-tool documents' inline panel (components/ConnectionDetails.tsx).
	const details = code(read('components', 'ConnectionDetails.tsx'));
	assert.ok(/setTested\(testResultText\(result\)\)/.test(details), 'a missing result is not read as a failed probe');
	assert.ok(/useConnectionTest\(onTest\)/.test(code(read('components', 'ConnectionDrawer.tsx'))), 'the drawer tests through it');
});

// One body and one Test step for both places that show a connection's details: the full app's drawer (a DetailPanel
// over the window) and a dev-tool document's inline panel. The summary comes first (Status with the chips, Graph);
// the plumbing (pipeline, node, run, writes, What to know) sits behind the "Connection details" disclosure.
test('the connection details (Status, Graph, the plumbing behind a disclosure, the Test result) are one component the drawer renders', () => {
	const details = code(read('components', 'ConnectionDetails.tsx'));
	assert.ok(/export function useConnectionTest\(/.test(details));
	assert.ok(/export const ConnectionDetailsBody: React\.FC<IConnectionDetailsBodyProps>/.test(details));
	for (const label of ['Status', 'Graph']) assert.ok(details.includes(`<Section label="${label}">`), label);
	assert.match(details, /<button type="button" style=\{styles\.disclosure\} aria-expanded=\{plumbingOpen\}/, 'the plumbing is a disclosure');
	assert.match(details, /Connection details <span style=\{styles\.disclosureHint\}>pipeline, node, run, read boundary<\/span>/);
	assert.match(details, /<div style=\{styles\.notesHeading\}>What to know<\/div>/, 'What to know is inside it');
	assert.match(details, /const schema = useSchemaView\(endpoint\.key\);/, 'counts only from a schema already read');
	assert.ok(/\{tested && <div style=\{styles\.notice\}><Banner variant=\{tested\.variant\}>\{tested\.text\}<\/Banner><\/div>\}/.test(details), 'the Test result in the Status section');
	assert.doesNotMatch(details, /DetailPanel|addEventListener|style=\{\{/, 'a body only: no overlay, no listener, styles in `styles`');
	const drawer = code(read('components', 'ConnectionDrawer.tsx'));
	assert.ok(/<ConnectionDetailsBody endpoint=\{endpoint\} probe=\{probe\} tested=\{tested\} \/>/.test(drawer));
	assert.doesNotMatch(drawer, /<Section /, 'the drawer renders no section of its own');
});

// A store reset (sign-out, change of identity) left the drawer open on its key, so it could reopen by itself with the
// previous identity's Test result once discovery listed the same key again.
test('the connection drawer closes when the store forgets its card', () => {
	const view = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/useEffect\(\(\) => \{\s*const next = drawerKeyAfter\(drawerKey, endpoints\);\s*if \(next !== drawerKey\) setDrawerKey\(next\);\s*\}, \[drawerKey, endpoints\]\);/.test(view), 'an effect drops a key the store no longer lists');
});

// As a dev tool there is no Connections landing: the drawer (details, Test connection) opens inside the connection's
// own document, anchored to it (DetailPanel `contained`), and the documents offer no "Open Connections". The full app
// keeps its landing, its fixed drawer and its buttons.
// CE-1 (rocket-ui keeps hidden documents mounted with display: none): a modal DetailPanel left open in a background
// document would trap Tab, lock the page scroll and take Escape for the whole realm. So a dev-tool document shows the
// connection details INLINE, in its own layout; the full app keeps its drawer over the window.
test('the full app\'s drawer is the window-wide DetailPanel it was: not contained, no auto-test, Open workbench always', () => {
	const drawer = code(read('components', 'ConnectionDrawer.tsx'));
	assert.ok(!/contained|testOnOpen/.test(drawer), 'nothing frame-only is left in the drawer');
	assert.ok(/<DetailPanel\s+open=\{open\}/.test(drawer));
	assert.ok(/<Button variant="primary" disabled=\{!view\.openable\} onClick=\{\(\) => onOpen\(endpoint\)\}>\s*Open workbench/.test(drawer), 'Open workbench, as on every card');
	assert.ok(!/\{onOpen &&/.test(drawer), 'not optional any more');
	const landing = code(read('views', 'ConnectionsView.tsx'));
	assert.ok(/<ConnectionDrawer\s+key=\{drawerKey \?\? ''\}/.test(landing), 'the full app\'s landing still uses the drawer');
	assert.ok(!/contained|testOnOpen/.test(landing), 'unchanged');
});

test('the inline details panel adds no overlay and no listener outside itself: Escape closes it only while the focus is inside', () => {
	const panel = code(read('components', 'ConnectionDetailsPanel.tsx'));
	assert.doesNotMatch(panel, /addEventListener|DetailPanel|Modal|ConfirmDialog|createPortal/, 'no document- or window-level listener, no overlay');
	assert.ok(/<section\s+ref=\{region\}\s+tabIndex=\{-1\}\s+aria-label=\{`Connection details: \$\{view\.title\}`\}\s+style=\{styles\.panel\}\s+onKeyDown=\{\(event\) => \{\s*if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*onClose\(\);\s*\}\s*\}\}\s*>/.test(panel), 'Escape on the panel itself (its own subtree)');
	assert.ok(/<button type="button" style=\{styles\.close\} title="Close details" aria-label="Close details" onClick=\{onClose\}>/.test(panel), 'its own close button');
	assert.ok(/<ConnectionDetailsBody endpoint=\{endpoint\} probe=\{probe\} tested=\{tested\} \/>/.test(panel), 'the same body as the drawer');
	assert.ok(/useConnectionTest\(onTest\)/.test(panel), 'the same Test step');
	// Each Test connection asked from outside tests once; StrictMode's second effect run must not probe again.
	assert.ok(/useEffect\(\(\) => \{\s*if \(testRequest === 0 \|\| testRequest === lastTest\.current\) return;\s*lastTest\.current = testRequest;\s*void test\(endpoint\);\s*\}, \[testRequest\]\);/.test(panel));
	// Keyboard users keep their place: the Test button is never disabled under the focus; activation is ignored while it runs.
	assert.ok(/onClick=\{\(\) => \{ if \(!testing\) void test\(endpoint\); \}\}/.test(panel));
	assert.doesNotMatch(panel, /disabled=\{testing\}/);
	assert.ok(/\{onOpen && \(\s*<Button variant="primary" disabled=\{!view\.openable\} onClick=\{\(\) => onOpen\(endpoint\)\}>/.test(panel), 'Open workbench only where it is not already open');
	assert.ok(/region\.current\?\.focus\(\)/.test(panel), 'it takes the focus when it opens');
	assert.ok(/opener instanceof HTMLElement && opener\.isConnected/.test(panel), 'and gives it back to what opened it when it closes');
});

test('in a dev-tool frame the workbench shows the details inline: a Details toggle, and Test connection where it cannot be browsed', () => {
	const view = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/const inFrame = env\.mount === 'frame';/.test(view));
	assert.doesNotMatch(view, /ConnectionDrawer|<DetailPanel/, 'no drawer in a connection document');
	assert.ok(/const \[details, setDetails\] = useState<IDetailsPanelState>\(DETAILS_CLOSED\);/.test(view));
	assert.ok(/const panel = \(action: DetailsPanelAction\): void => setDetails\(\(current\) => detailsPanelAfter\(current, action\)\);/.test(view));
	const header = view.slice(view.indexOf('<ContentHeader'), view.indexOf('{inFrame && details.open'));
	assert.ok(/\{inFrame && \(\s*<Button variant="ghost" onClick=\{\(\) => panel\('toggle'\)\} ariaExpanded=\{details\.open\}[^\n]*>\s*Details\s*<\/Button>/.test(header), 'a ghost Details toggle, frame only');
	assert.ok(/\{writable && \(\s*<Button variant="ghost" onClick=\{openWrite\}/.test(header), 'Write console stays as it was');
	assert.ok(/inFrame \? \(\s*<Button variant="primary" onClick=\{\(\) => panel\('test'\)\}>\s*Test connection\s*<\/Button>\s*\) : \(\s*<Button variant="primary" onClick=\{\(\) => env\.openDocument\(\{ kind: 'connections' \}\)\}>\s*Open Connections\s*<\/Button>/.test(view), 'Test connection in a frame; the full app keeps Open Connections');
	assert.ok(/\{inFrame && details\.open && \(\s*<ConnectionDetailsPanel\s+key=\{endpoint\.key\}\s+endpoint=\{endpoint\}\s+probe=\{probe\}\s+testRequest=\{details\.testRequest\}/.test(view), 'keyed on the connection, in a frame only, under the header');
	assert.ok(view.indexOf('<ConnectionDetailsPanel') < view.indexOf('{gate.mounted ?'), 'part of the document\'s layout, above its body');
	assert.ok(/onTest=\{\(target\) => \(env\.ready \? env\.probe\(target\.key\) : Promise\.resolve\(null\)\)\}/.test(view), 'a probe that cannot run says "not tested"');
	assert.ok(/onClose=\{\(\) => panel\('close'\)\}/.test(view));
	const detailsTag = view.slice(view.indexOf('<ConnectionDetailsPanel'), view.indexOf('/>', view.indexOf('<ConnectionDetailsPanel')));
	assert.ok(!/onOpen=/.test(detailsTag), 'no Open workbench inside the workbench');
});

test('in a dev-tool frame the write console offers Test connection where it is unavailable, inline, with Open workbench', () => {
	const view = code(read('views', 'WriteConsoleView.tsx'));
	assert.ok(/const inFrame = env\.mount === 'frame';/.test(view));
	assert.doesNotMatch(view, /ConnectionDrawer|<DetailPanel/, 'no drawer in a connection document');
	assert.ok(/inFrame \? \(\s*<Button variant="primary" onClick=\{\(\) => panel\('test'\)\}>\s*Test connection\s*<\/Button>\s*\) : \(\s*<Button variant="primary" onClick=\{\(\) => env\.openDocument\(\{ kind: 'connections' \}\)\}>\s*Open Connections\s*<\/Button>/.test(view));
	assert.ok(/\{inFrame && details\.open && \(\s*<ConnectionDetailsPanel\s+key=\{endpoint\.key\}\s+endpoint=\{endpoint\}\s+probe=\{probe\}\s+testRequest=\{details\.testRequest\}/.test(view));
	assert.ok(view.indexOf('<ConnectionDetailsPanel') < view.indexOf('{gate.mounted ?'), 'part of the document\'s layout, above its body');
	assert.ok(/onOpen=\{\(target\) => \{\s*panel\('close'\);\s*env\.openDocument\(\{ kind: 'workbench', endpoint: target \}\);\s*\}\}/.test(view), 'Open workbench closes the panel first');
});

// A found path stays on screen while a node or relationship is inspected, and Clear path must stay reachable then:
// on the toolbar (whatever the inspector shows) and in the inspector's own actions.
test('Clear path is offered whenever a path is shown, on the toolbar and beside a node or relationship in the inspector', () => {
	const view = code(read('components', 'GraphView.tsx'));
	assert.match(view, /\.\.\.\(state\.path \? \[\{ id: 'clear-path', label: 'Clear path'[^\]]*session\.clearPath\(\)/);
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	const nodeView = inspector.slice(inspector.indexOf('New query from here'));
	assert.match(nodeView, /\{state\.path && <Button[^>]*onClick=\{clearPath\}>Clear path<\/Button>\}/);
	// The button that was pressed goes away with the path, so focus is put back (the same way Close does).
	assert.match(inspector, /const clearPath = \(\): void => \{\s*session\.clearPath\(\);\s*onClosed\?\.\(\);/);
	assert.match(view, /id: 'clear-path'[^\]]*run: \(\) => \{ session\.clearPath\(\); restoreFocus\(\); \}/);
});

// A menu is placed for the size the window and canvas had when it opened. Closing it on a resize (a ResizeObserver, since a
// listener on the window is not allowed here) keeps it from being left cut off, and focus goes back to its trigger.
test('an open menu is closed when the toolbar or the canvas changes size, through a ResizeObserver and not a window listener', () => {
	const view = code(read('components', 'GraphView.tsx'));
	const observer = view.slice(view.indexOf('new ResizeObserver'), view.indexOf('return () => observer.disconnect()'));
	assert.match(observer, /seen\.has\(entry\.target\)/, 'the first report of an element is not a change');
	assert.match(observer, /setMenu\(null\);\s*setToolMenu\(null\);/);
	assert.match(observer, /closest\('\[data-menu-trigger\]'\)\?\.querySelector\('button'\);\s*if \(trigger\) trigger\.focus\(\);\s*else restoreFocusRef\.current\(\)/, 'focus goes back to the trigger, or to the node for a context menu');
	assert.match(observer, /observer\.observe\(canvasBox\.current\)/);
	assert.match(observer, /observer\.observe\(document\.documentElement\)/, 'a resize of the window is seen whichever box moved');
	assert.match(observer, /if \(entry\.target === document\.documentElement\) continue;/, 'the document\'s own size (it can follow its content) is not a resize');
	assert.match(observer, /const now = `\$\{window\.innerWidth\}x\$\{window\.innerHeight\}`;\s*if \(now !== viewport\) \{\s*viewport = now;\s*changed = true;/, 'a change counts only when the window size differs from the last one seen');
	assert.match(view.slice(view.indexOf('return () => observer.disconnect()')), /^return \(\) => observer\.disconnect\(\);[\s\S]{0,200}\}, \[drawn\]\);/, 'the observer is set up again once the toolbar exists (a view mounted before its result arrives has none)');
	assert.doesNotMatch(view, /addEventListener/);
});

// The menu-button pattern: Down opens the menu on its first item, Up on its last. A key from inside an open menu, a key
// something already handled and a modified key are not the button's.
test('Down and Up open a toolbar menu from its button, on the first and the last item, and ignore keys that are not the button\'s', () => {
	const view = code(read('components', 'GraphView.tsx'));
	const open = view.slice(view.indexOf('const openFromKey'), view.indexOf('const toolMenuTrigger'));
	assert.match(open, /event\.key !== 'ArrowDown' && event\.key !== 'ArrowUp'/);
	assert.match(open, /event\.defaultPrevented \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return/);
	assert.match(open, /closest\('\[role="menu"\]'\)\) return/);
	assert.match(open, /setToolStart\(event\.key === 'ArrowUp' \? 'last' : 'first'\)/);
	assert.match(view, /start=\{toolStart\}/);
	assert.equal(view.split('onKeyDown={(event) => openFromKey(event,').length - 1, 2, 'both the toolbar menu buttons and More');
	assert.match(code(read('components', 'CanvasMenu.tsx')), /useState\(start === 'last' \? Math\.max\(0, items\.length - 1\) : 0\)/);
});
