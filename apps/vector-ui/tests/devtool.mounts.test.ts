// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL MOUNTS: the descriptor, frames without a client, docKey routing,
// what a document says before it can open, what degrades, and what a frame
// must never render (T1, T2, T9, R7, R11, F1-F14)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import type { IFrameCallerOptions } from 'shared/explorer/devtool/frame';
import type { IVectorFrameOptions } from '../src/devtool/frame';
import { CONTROLLER_NOT_READY_TEXT, DOC_STATE_TEXT, LANDING_TEXT, UNKNOWN_DOCUMENT_DESCRIPTION, UNKNOWN_DOCUMENT_TITLE, connectionDocState, controllerNotReadyError, frameFailureText, isNotSent, missingConnectionText, showsControllerBanner } from '../src/devtool/frameText';
import type { ConnectionDocState, IDocGates } from '../src/devtool/frameText';
import { routeDocKey } from '../src/devtool/protocol';
import { COPY_BLOCKED_SENTENCE, copyLabel, runExport } from '../src/vector/export';
import { chooseWorkerStrategy } from '../src/map/workerStrategy';
import { createRegionClaims } from '../src/realmRegion';
import { consoleUri, documentUri } from '../src/vector/addresses';

const APP = path.resolve(__dirname, '..');
const SRC = path.join(APP, 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source without comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/**
 * Every source file reachable from an entry through relative value imports (the module graph of one mount).
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
			if (file) visit(file.split(path.sep).join('/'));
		}
	};
	visit(entry);
	return [...seen].sort();
}

const KEY = 'k1|dev|user|u1|team-1|proj-1|tools=tools_1|store_1';

describe('T1 - the descriptor declares both dev-tool mounts; the manifest says devTool; the id is unchanged', () => {
	it('AppDescriptor exports devToolFrame and devToolSidebar beside app and the collapsed sidebar, under rocketride.vector', () => {
		const descriptor = code(read('AppDescriptor.ts'));
		assert.match(descriptor, /id: 'rocketride\.vector',/);
		assert.match(descriptor, /app: VectorApp,/);
		assert.match(descriptor, /sidebar: 'collapsed',/);
		assert.match(descriptor, /devToolFrame: VectorDevTool,/);
		assert.match(descriptor, /devToolSidebar: VectorDevToolSidebar,/);
		assert.match(descriptor, /import \{ VectorDevTool \} from '\.\/VectorDevTool';/);
		assert.match(descriptor, /import \{ VectorDevToolSidebar \} from '\.\/VectorDevToolSidebar';/);
		const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
		assert.equal(pkg.appManifest.id, 'rocketride.vector');
		assert.ok(pkg.appManifest.categories.includes('devTool'), 'the manifest category the hosts list dev tools by');
		assert.ok(pkg.appManifest.categories.includes('tools'), 'and its launcher card');
		assert.notEqual(pkg.version, '1.0.0', 'bumped, so the engine re-seeds the built-in app');
		assert.deepEqual(pkg.appManifest.include, ['apps/shared']);
		assert.match(fs.readFileSync(path.join(APP, 'rsbuild.config.mts'), 'utf8'), /'\.\/AppDescriptor': '\.\/src\/AppDescriptor\.ts'/, 'the module federation expose is still ./AppDescriptor');
	});

	it('the two mount components are real exports', async () => {
		const frame = await import('../src/VectorDevTool');
		const sidebar = await import('../src/VectorDevToolSidebar');
		assert.equal(typeof frame.VectorDevTool, 'function');
		assert.equal(typeof sidebar.VectorDevToolSidebar, 'function');
	});
});

describe('T2 - frames hold no client', () => {
	const FRAME_ENTRY = 'VectorDevTool.tsx';

	it('no module a frame loads reaches for a client, the ConnectionManager, the workspace prefs, the full app\'s documents or its store', () => {
		const files = reachable(FRAME_ENTRY);
		for (const premise of ['devtool/frame.ts', 'views/ConsoleView.tsx', 'views/DocumentView.tsx', 'views/MapView.tsx', 'components/ChatPanel.tsx', 'envContext.tsx']) assert.ok(files.includes(premise), `the premise: the walk reaches ${premise}`);
		for (const forbidden of ['VectorApp.tsx', 'VectorSidebar.tsx', 'VectorDevToolSidebar.tsx', 'docs.ts', 'adapters/react.ts', 'views/ConnectionsView.tsx', 'components/RemoveDialogHost.tsx', 'devtool/controller.ts', 'localEnv.ts']) {
			assert.ok(!files.includes(forbidden), `a frame loads ${forbidden}`);
		}
		for (const file of files) {
			const text = code(read(file));
			assert.doesNotMatch(text, /useShellConnection|ConnectionManager|getClient\(|getBusExplorerClient|RocketRideClient|usePrefs|shared\/explorer\/react/, `${file} reaches for a client or the workspace prefs`);
			// The full app's store singleton is defined in the adapter and bound to the full app's registry there; no
			// other module a frame loads names it (a runtime test proves a frame never calls it: devtool.frame.test.ts).
			if (file === 'adapters/explorer.ts' || file === 'adapters/connections.ts') continue;
			assert.doesNotMatch(text, /\bvectorEndpoints\b|\bvectorHistory\b/, `${file} names one of the full app's stores`);
			assert.doesNotMatch(text, /import\s*\{[^}]*\bactiveConnection\b[^}]*\}\s*from\s*'[./]*adapters\/explorer'/, `${file} imports the full app's active connection`);
		}
	});

	it('a frame is built without a client: its options have none (the type refuses one)', () => {
		// @ts-expect-error a frame takes no ConnectionManager
		const typed: IVectorFrameOptions = { cm: {} };
		void typed;
		const caller: Partial<IFrameCallerOptions> = {};
		assert.ok(!('cm' in caller));
	});
});

describe('T9 - docKey routing for every family', () => {
	it('undefined (VS Code) and \'\' (rocket-ui) are the landing; console: and document: route by key; anything else, malformed included, is not found', () => {
		assert.deepEqual(routeDocKey(undefined), { kind: 'landing' });
		assert.deepEqual(routeDocKey(''), { kind: 'landing' });
		assert.deepEqual(routeDocKey(null), { kind: 'landing' });
		assert.deepEqual(routeDocKey(consoleUri(KEY)), { kind: 'console', key: KEY });
		assert.deepEqual(routeDocKey(documentUri(KEY, 'docs/a b:c.md')), { kind: 'document', key: KEY, objectId: 'docs/a b:c.md' }, 'an objectId with a colon and a space');
		for (const unknown of ['console:', 'document:', `document:${KEY}`, `document:${KEY}:`, 'document::abc', `document:${KEY}:%E0%A4%A`, 'connections', 'workbench:x', 'edit:*new*', KEY, 'console:a:b']) {
			assert.deepEqual(routeDocKey(unknown), { kind: 'unknown', docKey: unknown }, unknown);
		}
	});

	it('the frame renders each route: the landing, a connection document, or the not-found empty state', () => {
		const frame = code(read('VectorDevTool.tsx'));
		// Rod's generic frame (F1): one EmptyState, no landing list; the connection list lives in the sidebar.
		assert.match(frame, /if \(route\.kind === 'landing'\) \{\s*return \(\s*<div style=\{styles\.center\}>\s*<EmptyState icon=\{<VectorIcon \/>\} title=\{LANDING_TEXT\.title\} description=\{LANDING_TEXT\.description\} \/>/);
		assert.match(frame, /if \(route\.kind === 'unknown'\) \{[\s\S]*?title=\{UNKNOWN_DOCUMENT_TITLE\} description=\{UNKNOWN_DOCUMENT_DESCRIPTION\}/);
		assert.match(frame, /return <FrameConnectionDocument frame=\{frame\} route=\{route\} gates=\{gates\} \/>;/);
		assert.match(frame, /route\.kind === 'console' \? <ConsoleFrame key=\{endpoint\.key\} frame=\{frame\} endpoint=\{endpoint\} \/> : <DocumentFrame key=\{endpoint\.key\} frame=\{frame\} endpoint=\{endpoint\} objectId=\{route\.objectId\} \/>/);
		assert.doesNotMatch(frame, /ConnectionsView|<Button[^>]*Open Connections/, 'no landing list, no "Open Connections"');
	});
});

describe('F1-F3 - what the frames say', () => {
	it('the landing, the not-found document and the document states, in Rod\'s words, naming no op and no landing', () => {
		assert.deepEqual(LANDING_TEXT, { title: 'Vector Explorer', description: 'Open a connection from the sidebar. Connections are the vector store nodes of your running pipelines.' });
		assert.equal(UNKNOWN_DOCUMENT_TITLE, 'Document not found');
		assert.equal(UNKNOWN_DOCUMENT_DESCRIPTION, 'This Vector Explorer document no longer exists. Pick a connection in the sidebar.');
		assert.deepEqual(DOC_STATE_TEXT['not-connected'], { title: 'Not connected', description: 'Connect to a RocketRide server to open this document.' });
		assert.deepEqual(DOC_STATE_TEXT.waiting, { title: 'Waiting for the server connection…', description: 'This document opens once the host reports the server connection.' });
		assert.equal(DOC_STATE_TEXT.starting.title, 'Starting Vector Explorer…');
		assert.equal(DOC_STATE_TEXT['no-sidebar'].title, 'Open the Vector Explorer sidebar to connect');
		assert.deepEqual(DOC_STATE_TEXT['sign-in'], { title: 'Waiting for sign-in', description: 'Sign in to RocketRide to open this document.' });
		for (const [kind, text] of Object.entries(DOC_STATE_TEXT)) assert.doesNotMatch(`${text.title} ${text.description}`, /vector\.|Open Connections/, kind);
		assert.match(missingConnectionText('loading', 0).title, /Looking/);
		assert.match(missingConnectionText('ready', 3).description, /too many connections/);
		assert.match(missingConnectionText('ready', 0).description, /Pick a connection in the sidebar\.$/);
		assert.doesNotMatch(CONTROLLER_NOT_READY_TEXT, /vector\./);
	});

	it('a call no controller took reads as "open the sidebar" (unavailable: it cannot have run); a dropped call says nothing', () => {
		const notSent = new ExplorerToolError({ kind: 'timeout', tool: 'vector.stats', message: "'vector.stats' was not sent: the tool's controller did not become ready within 51s." });
		assert.ok(isNotSent(notSent));
		assert.equal(frameFailureText(notSent, false), CONTROLLER_NOT_READY_TEXT);
		assert.equal(frameFailureText(new ExplorerToolError({ kind: 'stale', tool: 'x', message: 'dropped' }), true), null);
		const error = controllerNotReadyError('stats');
		assert.equal(error.kind, 'unavailable');
		assert.equal(error.tool, 'stats');
	});
});

describe('F13 - what a connection document shows: the first state that applies wins', () => {
	const base: IDocGates & { found: boolean; opened: boolean } = { host: true, summon: 'ready', signIn: 'signed-in', found: true, opened: false };
	const state = (over: Partial<typeof base>): ConnectionDocState => connectionDocState({ ...base, ...over });

	it('the order: host false, host unknown, summoning, unanswered, nobody signed in, then the list', () => {
		assert.equal(state({ host: false, summon: 'unanswered', signIn: 'nobody', found: false }), 'not-connected');
		assert.equal(state({ host: undefined, summon: 'unanswered', signIn: 'nobody', found: false }), 'waiting');
		assert.equal(state({ summon: 'summoning', signIn: 'nobody', found: false }), 'starting');
		assert.equal(state({ summon: 'unanswered', signIn: 'nobody', found: false }), 'no-sidebar');
		assert.equal(state({ signIn: 'nobody' }), 'sign-in');
		assert.equal(state({ signIn: 'pending', found: false }), 'missing');
		assert.equal(state({}), 'open');
		assert.equal(state({ found: false }), 'missing');
	});

	it('never "Not connected" while the host is connected: every gate combination with the host up says something else', () => {
		for (const summon of ['ready', 'summoning', 'unanswered'] as const) {
			for (const signIn of ['pending', 'nobody', 'signed-in'] as const) {
				for (const found of [true, false]) {
					for (const opened of [true, false]) {
						const got = state({ host: true, summon, signIn, found, opened });
						assert.notEqual(got, 'not-connected', JSON.stringify({ summon, signIn, found, opened }));
						if (signIn === 'nobody' && (summon === 'ready' || (opened && found))) assert.equal(got, 'sign-in', 'nobody signed in waits for sign-in');
					}
				}
			}
		}
		assert.equal(state({ host: undefined }), 'waiting', 'not yet known is not "not connected" either');
	});

	it('a document that has opened stays through a summon gap, unless nobody is signed in; the banner shows only once the summon went unanswered', () => {
		assert.equal(state({ summon: 'summoning', opened: true }), 'open');
		assert.equal(state({ summon: 'unanswered', opened: true }), 'open');
		assert.equal(state({ summon: 'summoning', opened: true, found: false }), 'starting');
		assert.equal(state({ summon: 'unanswered', signIn: 'nobody', opened: true }), 'sign-in');
		assert.equal(showsControllerBanner('open', 'unanswered'), true);
		assert.equal(showsControllerBanner('open', 'summoning'), false);
		for (const other of ['not-connected', 'waiting', 'starting', 'no-sidebar', 'sign-in', 'missing'] as const) assert.equal(showsControllerBanner(other, 'unanswered'), false, other);
	});

	it('the frame decides through connectionDocState, marks "opened" after a commit, and keeps a stopped document on screen', () => {
		const frame = code(read('VectorDevTool.tsx'));
		const doc = frame.slice(frame.indexOf('const FrameConnectionDocument'));
		assert.match(doc, /connectionDocState\(\{ host: gates\.host, summon: gates\.summon, signIn: gates\.signIn, found: endpoint !== null, opened: opened\.current \}\)/);
		assert.match(doc, /useEffect\(\(\) => \{\s*if \(state === 'open'\) opened\.current = true;\s*\}, \[state\]\);/);
		assert.equal(doc.match(/opened\.current = true/g)?.length, 1, 'no write of the ref in the render path');
		assert.match(doc, /const endpoint = listed \?\? \(opened\.current \? seen\.current : null\);/, 'an opened document whose connection left the list stays, as stopped');
		assert.match(doc, /showsControllerBanner\(state, gates\.summon\) && \(/);
		const root = frame.slice(frame.indexOf('const FrameRoot'), frame.indexOf('export const FrameBody'));
		assert.doesNotMatch(root, /<Banner/, 'no banner above every route');
	});
});

describe('F14 - no window-wide overlay in a frame: confirmations and details are inline', () => {
	it('no module a frame loads renders a Modal, a ConfirmDialog or a DetailPanel (rocket-ui keeps hidden documents mounted)', () => {
		const files = reachable('VectorDevTool.tsx');
		assert.ok(files.includes('components/InlineRemoveConfirm.tsx') && files.includes('components/ConnectionDetailsPanel.tsx'), 'the premise: the inline panels');
		for (const forbidden of ['components/RemoveConfirmDialog.tsx', 'components/MultiRemoveConfirmDialog.tsx', 'components/RemoveDialogHost.tsx']) assert.ok(!files.includes(forbidden) && !fs.existsSync(path.join(SRC, forbidden)), `${forbidden}: no modal confirmation is left`);
		// The upload panel's replace confirmation is the one overlay a frame loads: the panel renders only while uploads
		// are on, and the frame env switches them off for every connection (R11, devToolConsoleModel).
		const uploads = 'ingest/ReplaceConfirmDialog.tsx';
		for (const file of files) if (file !== uploads) assert.doesNotMatch(code(read(file)), /<(Modal|ConfirmDialog|DetailPanel)\b/, `${file} renders a window-wide overlay`);
		const renderers = files.filter((file) => /<ReplaceConfirmDialog\b/.test(code(read(file))));
		assert.deepEqual(renderers, ['components/IngestPanel.tsx'], 'only the upload panel renders it');
		assert.match(code(read('components/AddDocumentsAside.tsx')), /\{model\.ingest\.enabled \? <IngestPanel /, 'and the console renders that panel only while uploads are on');
	});

	it('the inline confirmation: the same words and typed rule, the first focus by the write\'s weight, Escape on its own keydown, Confirm unavailable (aria-disabled) until ready', () => {
		const panel = code(read('components/InlineRemoveConfirm.tsx'));
		assert.match(panel, /confirmationFor\(pending, removeContextFor\(entry\.ctx\.endpoint, probe\)\)/);
		assert.match(panel, /const ready = confirmReady\(content\.typed, typed\);/);
		assert.match(panel, /button\.textContent\?\.trim\(\) === content\.cancelLabel/);
		assert.match(panel, /onKeyDown=\{\(event\) => \{\s*if \(event\.defaultPrevented\) return;\s*if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*onCancel\(\);/, 'Escape: the innermost handler acts');
		assert.match(panel, /aria-disabled=\{!ready\} onClick=\{onConfirm\}/);
		assert.match(panel, /const onConfirm = \(\): void => \{\s*if \(!ready\) return;/, 'Confirm does nothing until the typed rule is met');
		assert.match(panel, /entry\.controller\.confirmRemove\(\)/);
		assert.match(panel, /entry\.controller\.cancelRemove\(\)/);
		for (const file of ['components/InlineRemoveConfirm.tsx', 'components/ConnectionDetailsPanel.tsx', 'components/PendingBar.tsx', 'components/DocumentDrawer.tsx', 'components/focusTargets.ts']) {
			const text = code(read(file));
			assert.doesNotMatch(text, /(window|document)\.addEventListener/, `${file} listens on the page`);
			assert.doesNotMatch(text, /style=\{\{/, `${file} keeps its styles in \`styles\``);
		}
	});

	it('the console offers the connection\'s details (Test connection included) as an inline panel, keyed on the connection; both kinds of document confirm inline', () => {
		// The workbench owns both, in either mount: a console frame renders it as it is.
		const view = code(read('views/ConsoleView.tsx'));
		assert.match(view, /<Button variant="ghost" pressed=\{details\} onClick=\{\(\) => setDetails\(\(open\) => !open\)\}>\s*Details\s*<\/Button>/);
		assert.match(view, /\{details && <ConnectionDetailsPanel key=\{endpoint\.key\} endpoint=\{endpoint\} probe=\{probe\} stats=\{state\.stats\.view\} onTest=\{\(target\) => env\.probe\(target\.key\)\} onClose=\{\(\) => setDetails\(false\)\} \/>\}/);
		assert.equal(view.match(/<InlineRemoveConfirm entry=\{entry\} probe=\{/g)?.length, 1, 'the console');
		const frame = code(read('VectorDevTool.tsx'));
		assert.match(frame, /return <ConsoleView opened=\{endpoint\} active=\{visible\} \/>;/, 'a console frame adds nothing of its own');
		assert.equal(frame.match(/<InlineRemoveConfirm entry=\{entry\} probe=\{/g)?.length, 1, 'the document');
		const details = code(read('components/ConnectionDetailsPanel.tsx'));
		assert.match(details, /onKeyDown=\{\(event\) => \{\s*if \(event\.key === 'Escape'\)/);
		assert.match(details, /<ConnectionDrawerDetails drawer=\{drawerView\(endpoint, probe, stats\)\} \/>/);
		assert.match(details, /testResultText\(await onTest\(endpoint\)\)/);
	});
});

describe('R11 - what cannot work in a dev-tool mount degrades visibly, and keeps working in the full app', () => {
	it('chat: the console still renders the chat panel where chat is off for the mount, so Search (no LLM) stays one click away under the reason', () => {
		const view = code(read('components/QueryTab.tsx'));
		assert.match(view, /\{model\.chat\.enabled \|\| env\.degraded !== null \? <ChatPanel /);
		const panel = code(read('components/ChatPanel.tsx'));
		assert.match(panel, /description=\{model\.chat\.reason \?\? NO_CHAT_SENTENCE\}/, 'the panel says the mount\'s reason');
		assert.match(panel, /SEARCH_WITHOUT_CHAT/);
		assert.match(code(read('components/AddDocumentsAside.tsx')), /model\.ingest\.enabled \? <IngestPanel [^>]*\/> : <EmptyState title="Add documents" description=\{model\.ingest\.reason \?\? undefined\} \/>/, 'uploads: the area says why, the layout stays');
		assert.match(code(read('devtool/frame.ts')), /consoleModel: devToolConsoleModel,/, 'the frame env serves the degraded model');
	});

	it('a refused download of rows keeps its text to copy instead; a refused clipboard shows it to select', async () => {
		const item = { id: 'docs', label: 'Documents', kind: 'documents', disabled: null, rows: () => ({ columns: ['path'], rows: [{ path: 'a.md' }] }) } as never;
		const outcome = await runExport(item, 'csv', { collection: 'c', download: () => false, yieldToUi: async () => undefined });
		assert.equal(outcome.status, 'blocked');
		assert.ok(outcome.status === 'blocked' && outcome.copy && outcome.copy.format === 'csv' && /a\.md/.test(outcome.copy.text), 'the CSV text is kept');
		assert.equal(copyLabel('json'), 'Copy as JSON');
		assert.match(COPY_BLOCKED_SENTENCE, /select it and copy it/);
		const menu = code(read('components/ExportMenu.tsx'));
		assert.match(menu, /if \(outcome\.status === 'blocked' && outcome\.copy\) setFallback\(\{ \.\.\.outcome\.copy, fileName: outcome\.fileName \}\);/);
		assert.match(menu, /<textarea readOnly value=\{props\.copyBlocked\}/);
	});

	it('a blocked clipboard is said, never an unhandled rejection (the document\'s objectId, the map\'s keys)', () => {
		const doc = code(read('views/DocumentView.tsx'));
		assert.match(doc, /onClick=\{\(\) => copyText\(objectId, actions\.announce\)\}/);
		assert.match(doc, /clipboard\.writeText\(text\)\.then\(\s*\(\) => undefined,\s*\(\) => announce\(COPY_BLOCKED_NOTE\)\s*\)/);
		assert.doesNotMatch(doc, /void navigator\.clipboard\?\.writeText/);
		const map = code(read('views/MapView.tsx'));
		assert.match(map, /navigator\.clipboard\.writeText\(text\)\.then\(\(\) => actions\.announce\(`Copied \$\{num\(keys\.length\)\} keys\.`\), \(\) => actions\.announce\(COPY_KEYS_BLOCKED\)\)/);
	});

	it('a layout worker the window cannot start (a VS Code webview loading the remote from the engine) leaves the map on PCA, with the reason', () => {
		const strategy = chooseWorkerStrategy({ workerUrl: 'http://127.0.0.1:5565/apps/rocketride.vector/v2/static/js/async/vector-layout.js', pageHref: 'vscode-webview://abc123/index.html', production: true, hasWorker: true });
		assert.equal(strategy.kind, 'unavailable');
		const map = code(read('views/MapView.tsx'));
		assert.match(map, /setLayout\('pca'\);\s*setLayoutState\(outcome\.kind\);\s*setNotice\(outcome\.kind === 'cancelled' \? LAYOUT_CANCELLED : outcome\.message\);/);
	});
});

describe('one live region per realm (rocket-ui runs several Vector documents, and the full app, in one realm)', () => {
	it('the first claim speaks; when it goes the next takes over; none is left after the last', () => {
		const claims = createRegionClaims();
		const a = {};
		const b = {};
		claims.claim(a);
		claims.claim(b);
		assert.equal(claims.owner(), a);
		claims.release(a);
		assert.equal(claims.owner(), b);
		claims.release(b);
		assert.equal(claims.owner(), null);
	});

	it('the frame and the full app render the realm\'s region, portalled to the page; neither renders one of its own', () => {
		for (const file of ['VectorDevTool.tsx', 'VectorApp.tsx']) {
			const text = code(read(file));
			assert.match(text, /<RealmLiveRegion \/>/, file);
			assert.doesNotMatch(text, /<LiveRegion \/>/, file);
		}
		assert.match(code(read('components/RealmLiveRegion.tsx')), /createPortal\(<LiveRegion \/>, document\.body\)/);
	});
});

describe('R6, R7, F9 - the mounts: effects with cleanups, documents opened on a click only, styles in `styles`', () => {
	it('the frame builds its frame in an effect with a disposing cleanup, never in a memo, and never subscribes the peer', () => {
		const frame = code(read('VectorDevTool.tsx'));
		assert.match(frame, /useEffect\(\(\) => \{[\s\S]*?const created: IVectorFrame = createVectorFrame\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(frame, /useMemo\(\(\) => createVectorFrame|peer\.subscribe/);
		assert.match(frame, /useEffect\(\(\) => frame\.bindConsole\(entry\), \[frame, entry\]\);/);
		assert.match(frame, /frame\.bindDocument\(entry, objectId, \{/);
	});

	it('no inline style objects in the new mount files', () => {
		for (const file of ['VectorDevTool.tsx', 'VectorDevToolSidebar.tsx', 'components/DevToolConnectionList.tsx', 'components/InlineRemoveConfirm.tsx', 'components/ConnectionDetailsPanel.tsx', 'components/RealmLiveRegion.tsx']) {
			assert.doesNotMatch(code(read(file)), /style=\{\{/, file);
		}
	});

	it('a frame opens documents only from handlers: no effect of the frame mount calls documents.open or the env\'s openers', () => {
		const frame = code(read('VectorDevTool.tsx'));
		const effects = [...frame.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
		assert.ok(effects.length > 0);
		for (const effect of effects) assert.doesNotMatch(effect, /openConsole|openDocument|documents\.open/);
	});
});
