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
	for (const file of ['components/InspectorPanel.tsx', 'components/HistoryPanel.tsx', 'components/RunSurface.tsx', 'views/ConnectionsView.tsx', 'components/ConnectionDrawer.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx', 'components/ConnectionDetails.tsx', 'components/ConnectionDetailsPanel.tsx']) {
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

test('the inspector closes through the session, and its panel is rendered from the same state the session publishes', () => {
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.match(inspector, /onClose=\{\(\) => session\.inspect\(null\)\}/);
	assert.match(inspector, /const target: IInspectTarget \| null = state\.inspect/);
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.match(surface, /useSyncExternalStore\(graphSession\.subscribe, graphSession\.getState, graphSession\.getState\)/);
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
// re-creates on every mount; a request the surface cannot run now is never queued to run later.
test('the run surface takes its editor request from the host\'s slot, and the hosts never queue a run for a surface that is not on screen', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	assert.ok(/loadSlot\.take\(\)/.test(surface), 'the surface takes the request');
	assert.ok(!/loadRequest\.seq === handled\.current/.test(surface), 'a per-mount ref decides what was handled');
	for (const file of ['WorkbenchView.tsx', 'WriteConsoleView.tsx']) {
		const view = code(read('views', file));
		assert.ok(/useState\(createLoadSlot\)/.test(view), `${file} keeps one slot for the life of the document`);
		const surfaceTag = view.slice(view.indexOf('<RunSurface'), view.indexOf('/>', view.indexOf('<RunSurface')));
		assert.ok(/loadSlot=\{slot\}/.test(surfaceTag), `${file} hands the slot to the surface`);
	}
	const workbench = code(read('views', 'WorkbenchView.tsx'));
	assert.ok(/const runNow = run && now\.mounted && now\.paused === null;/.test(workbench) && /slot\.put\(\{ text, run: runNow \}\)/.test(workbench), 'a run is asked for only while the surface can run it');
});

// A write is not counted in `record`, which the shared runner skips once the document is closed: a write that lands
// after the console closed still marks other graphs out of date.
// The count lives behind the GraphEnv: the full app's LOCAL env counts in the call (countWrite on its data versions),
// and as a dev tool the CONTROLLER counts it in its execute handler, so every frame of the connection sees the
// version move; a frame never counts a write itself (it would count it twice).
test('the write console counts a write where it is sent, not in the record step a closed document skips', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const execute = surface.slice(surface.indexOf('execute: async'), surface.indexOf('settle:'));
	assert.ok(/env\.countWrite\(endpoint\.key, \(\) => session\.invoke<ReadQueryResult>\(TOOL\.execute/.test(execute), 'execute is sent through the env\'s countWrite');
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
	assert.ok(/settle: \(_run, result\) => settleRun\(mode, result\)/.test(surface), 'settle follows the mode');
	assert.ok(/patch: limitPatch\(mode, p\.limit\)/.test(surface), 'a limit is recorded only where one is sent');
	assert.ok(/historySummaryOf\(run, Date\.now\(\)\)/.test(surface), 'history keeps an affected count');
	assert.ok(/resultMeta\(displayed/.test(surface), 'the result line shows the affected count');
});

// The busy sentence says "stop waiting for it", so the control is offered for every request, not only a path search.
test('the graph offers Stop waiting for whatever it is waiting on, in the toolbar and in the inspector', () => {
	const view = code(read('components', 'GraphView.tsx'));
	assert.ok(/\{busy && <Button[^>]*onClick=\{\(\) => session\.stopWaiting\(\)\}>Stop waiting<\/Button>\}/.test(view), 'the toolbar offers it whenever a request runs');
	assert.ok(!/state\.busy === 'path' && <Button/.test(view), 'not only for a path search');
	const inspector = code(read('components', 'InspectorPanel.tsx'));
	assert.ok(/state\.busy !== null && <Button[^>]*onClick=\{\(\) => session\.stopWaiting\(\)\}>Stop waiting<\/Button>/.test(inspector), 'the inspector offers it beside Refresh');
});

// Run stays disabled for as long as a statement runs, Stop waiting shown or not: a press then would do nothing.
test('Run is disabled for as long as a statement runs, and a run that cannot start says why', () => {
	const surface = code(read('components', 'RunSurface.tsx'));
	const buttons = surface.match(/<Button variant="(primary|ghost)" disabled=\{[^}]*\} onClick=\{\(\) => run\((false|true)\)\}/g) ?? [];
	assert.equal(buttons.length, 2, 'Run and Run all');
	for (const button of buttons) assert.ok(button.includes('disabled={runner.running || blocked !== null}'), button);
	const startRun = surface.slice(surface.indexOf('const startRun = useCallback'), surface.indexOf('const run = useCallback'));
	assert.ok(/runRefusal\(\{ running: runner\.running, blocked \}\)/.test(startRun), 'startRun refuses with a sentence');
	const confirm = surface.slice(surface.indexOf('onConfirm={'), surface.indexOf('onCancel={'));
	assert.ok(/runRefusal\(/.test(confirm), 'so does confirming a write');
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
	assert.ok(/useEffect\(\(\) => \{\s*forgetConnections\(getDocs\(\), \{ schemas \}\);\s*\}, \[fingerprint\]\);/.test(app), 'every change of it forgets the connections');
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
// over the window) and a dev-tool document's inline panel.
test('the connection details (Status, Connection, What to know, the Test result) are one component the drawer renders', () => {
	const details = code(read('components', 'ConnectionDetails.tsx'));
	assert.ok(/export function useConnectionTest\(/.test(details));
	assert.ok(/export const ConnectionDetailsBody: React\.FC<IConnectionDetailsBodyProps>/.test(details));
	for (const label of ['Status', 'Connection', 'What to know']) assert.ok(details.includes(`<Section label="${label}">`), label);
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
	assert.ok(!/onOpen=/.test(view.slice(view.indexOf('<ConnectionDetailsPanel'))), 'no Open workbench inside the workbench');
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
