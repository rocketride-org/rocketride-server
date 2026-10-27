// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA IN THE FULL APP - the workspace preferences behind the page's pin
// (ported from sql-ui's tests/fullAppIdentity.test.ts), the stored user data's
// reads, and the first-seen colour slots
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IDataGridPersistence } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IPrefsAccessor } from 'shared/explorer';
import { CAPTIONS_PREF_KEY, makeGraphHistory } from '../src/adapters/explorer';
import { createSchemaStore } from '../src/graph/schemaStore';
import { APP_USER_DATA_NOTE, EMPTY_STYLE, SESSION_USER_DATA_NOTE, createMemoryUserData, devToolUserDataNote, followAssignments } from '../src/graph/userData';
import { SAVED_QUERIES_PREF, STYLES_PREF } from '../src/graph/userDataStore';
import { ANOTHER_ACCOUNT_USER_DATA, appHistoryNote, appUserDataNote, createAppUserData, createForwardingPrefs, createWorkspacePin, pinHistory, pinnedGrids, pinnedPrefs } from '../src/graph/workspacePin';
import { fixture } from './support/builders';
import { manualTimers } from './support/devtool';

const KEY = 'k1|neo';
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';
const LOADED = () => true;
const failure = () => ({ variant: 'error' as const, headline: '', detail: '', verbatim: '', generic: false, hint: null, ignore: false });

/**
 * The shell's workspace preferences as the full app sees them: read once per page from the first account's file, and
 * the whole bag written back through whoever is signed in when any key changes.
 *
 * @param first - The account signed in when the page read its preferences.
 * @returns The model.
 */
function shellModel(first: string | null) {
	let owner = first;
	const bag = new Map<string, unknown>();
	const files = new Map<string, string>();
	const prefs: IPrefsAccessor = {
		getPref: (key) => bag.get(key),
		setPref: (key, value) => {
			bag.set(key, value);
			if (owner !== null) files.set(owner, JSON.stringify(Object.fromEntries(bag)));
		},
	};
	return { prefs, bag, files, owner: () => owner, signIn: (next: string | null) => { owner = next; } };
}

describe('full app: A, then B without a reload', () => {
	it('B is served none of A\'s styles or saved queries, nothing is written while B is signed in, and B\'s file never holds A\'s', async () => {
		const shell = shellModel(FP_A);
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin());
		await data.editSaved(KEY, { action: 'save', name: 'A payroll', cypher: "MATCH (p:Person {name: 'Alice'}) RETURN p.salary" });
		await data.editStyle(KEY, { kind: 'label', label: 'Person', patch: { slot: 4 } });
		assert.match(shell.files.get(FP_A) ?? '', /A payroll/);
		assert.equal(data.saved(KEY).get().status, 'ready');
		assert.equal(data.privacyNote, APP_USER_DATA_NOTE);

		shell.signIn(FP_B);
		data.notify();
		const filesBefore = new Map(shell.files);
		assert.deepEqual(data.saved(KEY).get(), { status: 'error', queries: [], note: ANOTHER_ACCOUNT_USER_DATA }, 'B is never shown A\'s saved queries');
		assert.deepEqual(data.style(KEY).get(), { ready: true, style: EMPTY_STYLE }, 'or A\'s styles');
		await assert.rejects(data.editSaved(KEY, { action: 'save', name: 'B query', cypher: 'RETURN 2' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale' && /different account/.test(error.message));
		await assert.rejects(data.editStyle(KEY, { kind: 'reset' }), (error: unknown) => error instanceof ExplorerToolError && /different account/.test(error.message));
		data.want([{ key: KEY, labels: ['Company'], complete: true }]);
		assert.equal(shell.files.has(FP_B), false, 'nothing was written while B is signed in');
		assert.deepEqual(shell.files, filesBefore);
	});

	it('A, back again before a reload, is served A\'s own and can save again', async () => {
		const shell = shellModel(FP_A);
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin());
		await data.editSaved(KEY, { action: 'save', name: 'Mine', cypher: 'RETURN 1' });
		shell.signIn(FP_B);
		data.notify();
		shell.signIn(FP_A);
		data.notify();
		assert.deepEqual(data.saved(KEY).get().queries.map((q) => q.name), ['Mine']);
		await data.editSaved(KEY, { action: 'save', name: 'Again', cypher: 'RETURN 2' });
		assert.equal(data.saved(KEY).get().queries.length, 2);
	});

	it('signed out, nothing is read or written either', async () => {
		const shell = shellModel(null);
		shell.bag.set(SAVED_QUERIES_PREF, { [KEY]: [{ id: 'x', name: 'X', cypher: 'RETURN 1', savedAt: 1 }] });
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin());
		assert.deepEqual(data.saved(KEY).get(), { status: 'error', queries: [], note: 'Not signed in to a RocketRide server.' });
		await assert.rejects(data.editSaved(KEY, { action: 'delete', id: 'x' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
	});
});

describe('full app: one pin per page, over every preference Graph Explorer keeps itself', () => {
	it('the first account seen binds; nobody and another account read nothing and write nothing', () => {
		const pin = createWorkspacePin();
		assert.equal(pin.access(null), 'nobody', 'nobody binds nothing');
		assert.equal(pin.access(FP_A), 'owner');
		assert.equal(pin.access(FP_B), 'another');
		assert.equal(pin.access(FP_A), 'owner', 'the first account back is served its own bag');
	});

	it('pinnedPrefs and pinnedGrids pass through for the pinned account only', () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		const prefs = pinnedPrefs(pin, shell.prefs, shell.owner);
		const layouts = new Map<string, unknown>();
		const writes: string[] = [];
		const inner: IDataGridPersistence = {
			read: (id, type) => layouts.get(`${id}/${type}`) ?? false,
			write: (id, type, data) => {
				writes.push(`write ${id}/${type}`);
				layouts.set(`${id}/${type}`, data);
			},
			clear: (id) => {
				writes.push(`clear ${id}`);
			},
		};
		const grids = pinnedGrids(pin, inner, shell.owner);
		prefs.setPref('graph.drafts', { [KEY]: 'MATCH (n) RETURN n' });
		grids.write('t', 'sort', [1]);
		assert.deepEqual(prefs.getPref('graph.drafts'), { [KEY]: 'MATCH (n) RETURN n' });
		assert.deepEqual(grids.read('t', 'sort'), [1]);
		shell.signIn(FP_B);
		assert.equal(prefs.getPref('graph.drafts'), undefined, 'B reads none of A\'s drafts');
		assert.equal(grids.read('t', 'sort'), false, 'or A\'s layouts');
		prefs.setPref('graph.drafts', { [KEY]: 'B' });
		grids.write('t', 'sort', [2]);
		grids.clear('t');
		assert.deepEqual(shell.bag.get('graph.drafts'), { [KEY]: 'MATCH (n) RETURN n' }, 'and writes nothing');
		assert.deepEqual(writes, ['write t/sort']);
	});
});

describe('stored user data: reads are stable, and say where they are', () => {
	it('one readable per key, the same snapshot until something changes, even when the host hands out a new object for the same value', async () => {
		let bag: Record<string, unknown> = {};
		// A host that copies the value on every read (as JSON would).
		const prefs: IPrefsAccessor = { getPref: (key) => (bag[key] === undefined ? undefined : JSON.parse(JSON.stringify(bag[key]))), setPref: (key, value) => { bag = { ...bag, [key]: value }; } };
		const data = createAppUserData(prefs, () => FP_A, LOADED, createWorkspacePin());
		await data.editStyle(KEY, { kind: 'label', label: 'Person', patch: { slot: 1 } });
		await data.editSaved(KEY, { action: 'save', name: 'One', cypher: 'RETURN 1' });
		assert.equal(data.style(KEY), data.style(KEY));
		assert.equal(data.style(KEY).get(), data.style(KEY).get(), 'a stable style snapshot');
		assert.equal(data.saved(KEY).get(), data.saved(KEY).get(), 'a stable saved-queries snapshot');
		const before = data.saved(KEY).get();
		await data.editSaved(KEY, { action: 'save', name: 'Two', cypher: 'RETURN 2' });
		assert.notEqual(data.saved(KEY).get(), before, 'a change is a new snapshot');
	});

	it('a change tells every subscriber once it is written; a refusal writes nothing and tells nobody', async () => {
		const data = createMemoryUserData('session');
		let told = 0;
		const off = data.saved(KEY).subscribe(() => (told += 1));
		await data.editSaved(KEY, { action: 'save', name: 'One', cypher: 'RETURN 1' });
		assert.equal(told, 1);
		await assert.rejects(data.editSaved(KEY, { action: 'save', name: '', cypher: 'RETURN 1' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		assert.equal(told, 1);
		off();
	});
});

describe('the full app\'s history goes through the same pin', () => {
	it('another account gets a throwaway accessor: it is shown none of A\'s history and its runs write nothing into the shell\'s prefs', async () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		const store = makeGraphHistory(0);
		const pinned = pinHistory(store, pin);
		let detach = pinned.attachPrefs(shell.prefs, FP_A);
		store.runs.emitRun(KEY, { id: 'a1', at: 1, kind: 'read', cypher: "MATCH (p {name: 'Alice'}) RETURN p", ms: 1, outcome: 'rows', rows: 1 } as never);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.match(shell.files.get(FP_A) ?? '', /Alice/, 'A\'s run lands in A\'s file');
		shell.signIn(FP_B);
		detach();
		detach = pinned.attachPrefs(shell.prefs, FP_B);
		assert.equal(pinned.access(), 'another');
		assert.deepEqual(store.getHistory(KEY), [], 'B is never shown A\'s history');
		store.runs.emitRun(KEY, { id: 'b1', at: 2, kind: 'read', cypher: 'RETURN 2', ms: 1, outcome: 'rows', rows: 1 } as never);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(shell.files.has(FP_B), false, 'nothing was written into B\'s file');
		detach();
	});
});

describe('colour slots: given once, in the realm that owns the schema, written only to a store that was read', () => {
	const two = { version: 2, labels: [{ name: 'Person', properties: [] }, { name: 'Company', properties: [] }], relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'startup', stale: false, error: null, capable: true };

	it('the slots of a loaded schema\'s labels are shown at once and saved with the next change in the page; a later new label takes a free slot without moving any', async () => {
		const shell = shellModel(FP_A);
		const timers = manualTimers();
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin(), { schedule: timers.schedule });
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => ({ schema: two }), failure);
		assert.deepEqual(data.style(KEY).get().style.assigned, { Company: 0, Person: 1 }, 'shown at once');
		timers.advance(5_000);
		assert.equal(shell.bag.get(STYLES_PREF), undefined, 'not written by itself (the full app holds it)');
		data.userWrote();
		assert.deepEqual((shell.bag.get(STYLES_PREF) as Record<string, { assigned: unknown }>)[KEY].assigned, { Company: 0, Person: 1 }, 'written with the next change');
		await schemas.load(KEY, async () => ({ schema: { ...two, labels: [{ name: 'Aardvark', properties: [] }, ...two.labels] } }), failure, { refresh: true });
		data.userWrote();
		assert.deepEqual(data.style(KEY).get().style.assigned, { Company: 0, Person: 1, Aardvark: 2 });
		off();
	});

	it('no slot is written before the shell has loaded the prefs; the style is not ready until then', async () => {
		const shell = shellModel(FP_A);
		let loaded = false;
		const timers = manualTimers();
		const data = createAppUserData(shell.prefs, shell.owner, () => loaded, createWorkspacePin(), { schedule: timers.schedule });
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => ({ schema: two }), failure);
		timers.advance(5_000);
		assert.equal(data.style(KEY).get().ready, false, 'not ready: screens draw neutral');
		assert.equal(shell.bag.get(STYLES_PREF), undefined, 'nothing written before the load');
		await assert.rejects(data.editSaved(KEY, { action: 'save', name: 'Early', cypher: 'RETURN 1' }), (error: unknown) => error instanceof ExplorerToolError && /still loading/.test(error.message));
		loaded = true;
		data.notify();
		assert.equal(data.style(KEY).get().ready, true);
		data.userWrote();
		assert.ok((shell.bag.get(STYLES_PREF) as Record<string, unknown>)[KEY], 'written once loaded, with the next change');
		off();
	});

	it('a session-only store shows the slots and writes them nowhere', async () => {
		const data = createMemoryUserData('session');
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => fixture('schema_v2'), failure);
		assert.ok(Object.keys(data.style(KEY).get().style.assigned).length > 0);
		off();
	});

	it('nothing is assigned where nothing can be written (another account in the full app), and it is once the account is back', async () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		pin.access(FP_A);
		shell.signIn(FP_B);
		const timers = manualTimers();
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, pin, { schedule: timers.schedule });
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => fixture('schema_v2'), failure);
		data.userWrote();
		assert.equal(shell.bag.get(STYLES_PREF), undefined, 'nothing written for B');
		shell.signIn(FP_A);
		data.notify();
		assert.ok(Object.keys(data.style(KEY).get().style.assigned).length > 0, 'assigned for A');
		data.userWrote();
		assert.ok((shell.bag.get(STYLES_PREF) as Record<string, unknown>)[KEY], 'and written for A');
		off();
	});

	it('the slots come from the whole schema: a screen that passes fewer labels sees the same colours', async () => {
		const data = createMemoryUserData('session');
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => ({ schema: two }), failure);
		const { style } = data.style(KEY).get();
		assert.equal(style.assigned.Person, 1, 'Person is second in sorted order of the whole schema, whatever a screen draws');
		off();
	});
});

describe('where each mount says it keeps them', () => {
	it('one true sentence per mount and per state, each under 160 characters', () => {
		const states = ['file', 'session', 'none'] as const;
		const notes = [APP_USER_DATA_NOTE, SESSION_USER_DATA_NOTE, ...states.flatMap((saved) => states.map((styles) => devToolUserDataNote(saved, styles)))];
		for (const note of notes) assert.ok(note.length <= 160, `${note.length}: ${note}`);
		assert.match(APP_USER_DATA_NOTE, /workspace file on the server, for your account/);
		assert.match(devToolUserDataNote('file', 'file'), /rocketride\.graph\.saved\.json, rocketride\.graph\.styles\.json/);
		assert.match(devToolUserDataNote('file', 'file'), /the last window to save wins/);
		assert.match(devToolUserDataNote('session', 'file'), /^Saved queries are kept for this session only: rocketride\.graph\.saved\.json/);
		assert.match(devToolUserDataNote('file', 'session'), /^Styles are kept for this session only: rocketride\.graph\.styles\.json/);
		assert.match(devToolUserDataNote('session', 'session'), /^Kept for this session only/);
		assert.match(devToolUserDataNote('none', 'file'), /nobody is signed in/);
	});
});

describe('the full app routes every preference it keeps through the one page pin', () => {
	const read = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');

	it('the env\'s prefs (drafts, captions, the editor height), the grid layouts, the styles, the saved queries and history', () => {
		const app = read('GraphApp.tsx');
		assert.match(app, /prefs: pinnedPrefs\(APP_WORKSPACE_PIN, prefs, ownerNow\), grids: pinnedGrids\(APP_WORKSPACE_PIN, APP_GRIDS, ownerNow\), userData: createAppUserData\(prefs, ownerNow, \(\) => prefsLoaded\.current\)/);
		assert.match(app, /createLocalGraphEnv\(\{ mount: 'app', ready: isConnected, client, stores: APP_STORES, activeConnection, openDocument: openAppDocument, prefs: pinned\.prefs, historyPrivacyNote: \(\) => appHistoryNote\(APP_WORKSPACE_PIN\.access\(owner\.current\)\), userData: pinned\.userData, gridPersistence: pinned\.grids \}\)/);
		assert.match(app, /const \[prefs\] = useState\(createForwardingPrefs\);/, 'one accessor that reads its own writes');
		assert.match(app, /<AppPrefsBinding prefs=\{prefs\} onBound=\{pinned\.userData\.notify\} \/>/, 'readers read again once the shell hands out the new accessor');
		assert.match(app, /const \{ loaded \} = useWorkspace\(\);/, 'styles and saved queries wait for the shell to load the prefs');
		assert.match(app, /useEffect\(\(\) => prefs\.onWrite\(\(\) => pinned\.userData\.userWrote\(\)\), \[prefs, pinned\]\);/, 'what is automatic is saved with the person\'s next change in this page');
		assert.match(read('GraphSidebar.tsx'), /const typeColors = useMemo\(\(\) => typeColorsOf\(style\), \[style\]\);/, 'the sidebar draws type colours as the canvas does');
		assert.doesNotMatch(app, /prefs: prefs[,\s}]/, 'the bare accessor never reaches the env');
		const bridge = read('adapters', 'react.ts');
		assert.match(bridge, /export const pinnedGraphHistory = pinHistory\(graphHistory\);/);
		assert.match(bridge, /createHistoryPrefsBridge\(pinnedGraphHistory\)/);
		assert.doesNotMatch(bridge, /createHistoryPrefsBridge\(graphHistory\)/);
	});
});

describe('review P5: the full app across accounts, and the shell\'s snapshot accessor', () => {
	const schemaOf = (names: string[]) => ({ schema: { version: 2, labels: names.map((name) => ({ name, properties: [] })), relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'startup', stale: false, error: null, capable: true } });

	it('C-1 (T7): A, then B, then A again without a reload: B\'s labels never reach A\'s bag, and a slot write pending at a switch is dropped', async () => {
		let owner: string | null = FP_A;
		const bag = new Map<string, unknown>();
		const prefs: IPrefsAccessor = { getPref: (k) => bag.get(k), setPref: (k, v) => void bag.set(k, v) };
		const timers = manualTimers();
		const pin = createWorkspacePin();
		const data = createAppUserData(prefs, () => owner, LOADED, pin, { schedule: timers.schedule });
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		pin.access(FP_A);
		// A loads a schema; before the pause ends, B signs in (GraphApp: forgetConnections clears the schemas, then forget()).
		await schemas.load('k1|dev|user|uA|K_A0', async () => schemaOf(['APending']), failure);
		owner = FP_B;
		schemas.clear();
		data.forget();
		data.notify();
		await schemas.load('k1|dev|user|uB|K_B', async () => schemaOf(['BSecretLabel']), failure);
		data.userWrote();
		assert.equal(bag.get(STYLES_PREF), undefined, 'nothing written for B, and the write pending for A was dropped');
		// A is back without a reload, and loads a connection of A's.
		owner = FP_A;
		schemas.clear();
		data.forget();
		data.notify();
		await schemas.load('k1|dev|user|uA|K_A', async () => schemaOf(['Person']), failure);
		data.userWrote();
		const written = bag.get(STYLES_PREF) as Record<string, unknown>;
		assert.deepEqual(Object.keys(written), ['k1|dev|user|uA|K_A'], 'A\'s own connection only');
		assert.equal(JSON.stringify(written).includes('BSecretLabel'), false);
		off();
	});

	it('C-1: a slot write computed for one account is dropped when the account is another one by the time it is due', async () => {
		let owner: string | null = FP_A;
		const bag = new Map<string, unknown>();
		const prefs: IPrefsAccessor = { getPref: (k) => bag.get(k), setPref: (k, v) => void bag.set(k, v) };
		const timers = manualTimers();
		const data = createAppUserData(prefs, () => owner, LOADED, createWorkspacePin(), { schedule: timers.schedule });
		data.want([{ key: 'k1|dev|user|uA|K', labels: ['Person'], complete: true }]);
		owner = FP_B;
		timers.advance(1_000);
		data.userWrote();
		assert.equal(bag.get(STYLES_PREF), undefined, 'even without forget(): never written under another account');
	});

	it('I-1: the shell hands out a snapshot accessor per render; a reader told about an edit sees it, two quick edits both keep, and a re-bind changes nothing', async () => {
		let state: Record<string, unknown> = {};
		const snapshotApi = (): IPrefsAccessor => {
			const snap = state;
			return { getPref: (k) => snap[k], setPref: (k, v) => { state = { ...state, [k]: v }; } };
		};
		const forwarding = createForwardingPrefs();
		forwarding.bind(snapshotApi());
		const data = createAppUserData(forwarding, () => FP_A, LOADED, createWorkspacePin());
		const view = data.style('K');
		const seen: unknown[] = [];
		const off = view.subscribe(() => seen.push(view.get().style.labels));
		await data.editStyle('K', { kind: 'label', label: 'Person', patch: { slot: 4 } });
		await data.editStyle('K', { kind: 'label', label: 'Person', patch: { size: 'L' } });
		assert.deepEqual(seen.at(-1), { Person: { slot: 4, size: 'L' } }, 'told, and reads what was written; the second edit kept the first');
		await data.editSaved('K', { action: 'save', name: 'one', cypher: 'RETURN 1' });
		await data.editSaved('K', { action: 'save', name: 'two', cypher: 'RETURN 2' });
		const next = snapshotApi();
		assert.equal(forwarding.bind(next), true, 'the shell renders: a new accessor');
		assert.equal(forwarding.bind(next), false, 'the same accessor again is not news');
		data.notify();
		assert.deepEqual(((state[SAVED_QUERIES_PREF] as Record<string, Array<{ name: string }>>).K).map((q) => q.name), ['two', 'one'], 'both saves are in the shell\'s prefs');
		assert.deepEqual(view.get().style.labels, { Person: { slot: 4, size: 'L' } });
		off();
	});

	it('m-1: the notes follow the account signed in now', () => {
		assert.equal(appUserDataNote('owner'), APP_USER_DATA_NOTE);
		assert.match(appUserDataNote('another'), /^Not saved: you are signed in as a different account/);
		assert.match(appHistoryNote('another'), /kept for this session only/);
		assert.match(appHistoryNote('nobody'), /nobody is signed in/);
		for (const note of [appUserDataNote('another'), appUserDataNote('nobody'), appHistoryNote('another'), appHistoryNote('nobody')]) assert.ok(note.length <= 160, note);
	});
});

describe('DA-R1: two pages of one account, and captions from 1.2', () => {
	const schemaOf = (names: string[]) => ({ schema: { version: 2, labels: names.map((name) => ({ name, properties: [] })), relationship_types: [], sampled: true, truncated: false, refreshed_at: null, source: 'startup', stale: false, error: null, capable: true } });

	it('I-1: the full app shows new colour slots at once and saves them only with the next change the person makes in that page', async () => {
		const shell = shellModel(FP_A);
		const timers = manualTimers();
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin(), { schedule: timers.schedule });
		const schemas = createSchemaStore(() => 1);
		const off = followAssignments(schemas, data);
		await schemas.load(KEY, async () => schemaOf(['Person', 'Company']), failure);
		timers.advance(10_000);
		assert.deepEqual(data.style(KEY).get().style.assigned, { Company: 0, Person: 1 }, 'shown at once');
		assert.equal(shell.bag.get(STYLES_PREF), undefined, 'merely opening a connection writes nothing');
		data.userWrote();
		assert.deepEqual((shell.bag.get(STYLES_PREF) as Record<string, { assigned: unknown }>)[KEY].assigned, { Company: 0, Person: 1 }, 'saved with the next change the person makes');
		off();
	});

	it('I-1: a person\'s own edit carries the held slots with it', async () => {
		const shell = shellModel(FP_A);
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin());
		data.want([{ key: KEY, labels: ['Person'], complete: true }]);
		await data.editSaved(KEY, { action: 'save', name: 'Mine', cypher: 'RETURN 1' });
		assert.deepEqual((shell.bag.get(STYLES_PREF) as Record<string, { assigned: unknown }>)[KEY].assigned, { Person: 0 });
	});

	it('I-5: 1.2\'s caption choices are shown at once and moved into the style once, with the next change; never for another account', async () => {
		const shell = shellModel(FP_A);
		shell.bag.set(CAPTIONS_PREF_KEY, { [KEY]: { Person: 'name', Company: '<id>', Bad: 7 }, other: { Topic: 'title' } });
		shell.bag.set(STYLES_PREF, { [KEY]: { labels: { Company: { caption: 'legalName' } } } });
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, createWorkspacePin());
		assert.equal(data.style(KEY).get().style.labels.Person?.caption, 'name', 'shown from the old choice before any write');
		assert.equal(data.style(KEY).get().style.labels.Company?.caption, 'legalName', 'a caption already in the style wins');
		assert.ok(shell.bag.has(CAPTIONS_PREF_KEY), 'nothing written yet');
		// The person clears Person's caption: the move happens first, then the edit, so the old choice does not come back.
		await data.editStyle(KEY, { kind: 'label', label: 'Person', clear: ['caption'] });
		assert.equal(shell.bag.get(CAPTIONS_PREF_KEY), undefined, 'the old key is cleared');
		const styles = shell.bag.get(STYLES_PREF) as Record<string, { labels: Record<string, { caption?: string }> }>;
		assert.equal(styles[KEY].labels.Person, undefined, 'the person\'s clear stands');
		assert.equal(styles[KEY].labels.Company.caption, 'legalName');
		assert.equal(styles.other.labels.Topic.caption, 'title', 'every connection moved, once');
		assert.equal(data.style(KEY).get().style.labels.Person, undefined);
	});

	it('I-5: another account signed in without a reload: nothing is moved or written for it', async () => {
		const shell = shellModel(FP_A);
		shell.bag.set(CAPTIONS_PREF_KEY, { [KEY]: { Person: 'name' } });
		const pin = createWorkspacePin();
		pin.access(FP_A);
		shell.signIn(FP_B);
		const data = createAppUserData(shell.prefs, shell.owner, LOADED, pin);
		data.userWrote();
		assert.deepEqual(shell.bag.get(CAPTIONS_PREF_KEY), { [KEY]: { Person: 'name' } }, 'left alone');
		assert.equal(shell.bag.get(STYLES_PREF), undefined);
		assert.equal(data.style(KEY).get().style.labels.Person, undefined, 'and not shown to B');
	});
});
