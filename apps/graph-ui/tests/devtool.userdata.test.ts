// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA IN A DEV TOOL - where styles and saved queries are kept, and whose
// they are (ported from sql-ui's tests/devtool.savedQueries.test.ts)
// =============================================================================
//
// The controller keeps saved queries and label styles in two per-user files of
// their own, `rocketride.graph.saved.json` and `rocketride.graph.styles.json`,
// one bag per account each (the dev-tool library's createFsPrefs, beside
// history's). Frames read them with `graph.savedQueries` and `graph.styles`
// and change them with `graph.savedEdit` and `graph.styleEdit`, all owned
// calls, and follow the retained `userData` topic's two revisions. The
// identity cases follow T7 for history: nothing is served to, or written for,
// another account, in any order the account can change. The automatic colour
// slots write only the styles file, only once it was read. Frames also read
// the full schema view with `graph.schemaView`, on first use and after every
// newer load.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import { PREFS_FILE_VERSION, PREFS_FS_TIMEOUT_MS, PREFS_LOAD_ATTEMPTS } from 'shared/explorer/devtool/prefs';
import { jsonByteLength } from 'shared/explorer/devtool/state';
import { assertJsonSafe } from 'shared/explorer/devtool/testing';
import { OP, STATE, USER_DATA_LOAD_WAIT_MS, frameTimeoutFor } from '../src/devtool/protocol';
import { parseSchema } from '../src/graph/schema';
import type { ISavedQuery, SavedEdit, StyleEdit } from '../src/graph/userData';
import { MAX_SAVED_QUERIES, SAVED_QUERIES_PATH, SAVED_QUERIES_PREF, STYLES_PATH, STYLES_PREF } from '../src/graph/userDataStore';
import { NEO4J_SCHEMA, account, mountController, mountFrame, readOnlyNode, settle, signInVsCode, until, vscodeRealm } from './support/devtool';
import type { IToolCall } from 'shared/explorer/connect/testing';

const FP_A = 'u1|org-1|team-1';

/** Every request for one of the files. */
const fileRequests = (engine: { requests: Array<{ op: string; params: unknown }> }, op: string, path: string = SAVED_QUERIES_PATH) => engine.requests.filter((r) => r.op === op && (r.params as { path?: string } | null)?.path === path);

/**
 * What one account's bag holds in a file.
 *
 * @param files - The user store.
 * @param owner - The account.
 * @param path - The file (default the saved-queries file).
 * @returns Its preferences, or undefined.
 */
function bagOf(files: Map<string, unknown>, owner: string, path: string = SAVED_QUERIES_PATH): Record<string, unknown> | undefined {
	const file = files.get(path) as { owners?: Record<string, { prefs?: Record<string, unknown> }> } | undefined;
	return file?.owners?.[owner]?.prefs;
}

/**
 * A signed-in VS Code realm, its controller and one frame on the connection's workbench, discovery done.
 *
 * @param behave - The node.
 * @returns The rig.
 */
async function rig(behave: (call: IToolCall) => unknown = readOnlyNode) {
	const engine = vscodeRealm(undefined, behave);
	signInVsCode(engine.realm);
	const mounted = mountController(engine.cm);
	mounted.h.setHostConnection(true);
	const landing = mountFrame(mounted.h, undefined);
	await until(() => landing.frame.env(true).endpoints.get().endpoints.length === 1 && Object.keys(landing.frame.env(true).endpoints.get().probes).length === 1, 'discovery and the probe');
	const key = landing.frame.env(true).endpoints.get().endpoints[0].key;
	const doc = mountFrame(mounted.h, `workbench:${key}`);
	await until(() => doc.frame.guard.first() !== null, 'the frame learnt its account');
	const read = (owner: string | null) => doc.frame.caller.callReply(OP.savedQueries, { key, owner }, { timeoutMs: frameTimeoutFor(OP.savedQueries) });
	const readStyle = (owner: string | null) => doc.frame.caller.callReply(OP.styles, { key, owner }, { timeoutMs: frameTimeoutFor(OP.styles) });
	const save = (owner: string | null, edit: SavedEdit) => doc.frame.caller.callReply(OP.savedEdit, { key, owner, edit }, { timeoutMs: frameTimeoutFor(OP.savedEdit) });
	const style = (owner: string | null, edit: StyleEdit) => doc.frame.caller.callReply(OP.styleEdit, { key, owner, edit }, { timeoutMs: frameTimeoutFor(OP.styleEdit) });
	return {
		engine, ...mounted, landing: landing.frame, frame: doc.frame, key, read, readStyle, save, style,
		dispose() {
			doc.frame.dispose();
			landing.frame.dispose();
			mounted.controller.dispose();
		},
	};
}

/** Wait until the frame's view of the saved queries is no longer loading. */
async function loaded(view: { get(): { status: string } }, what = 'the saved queries read'): Promise<void> {
	await until(() => view.get().status !== 'loading', what, 200);
}

/** A save, as a frame sends it. */
const saveOf = (name: string, cypher = 'MATCH (p:Person) RETURN p'): SavedEdit => ({ action: 'save', name, cypher });

/** A file was written (after the library's debounce). */
const written = (engine: { requests: Array<{ op: string; params: unknown }> }, path: string = SAVED_QUERIES_PATH, count = 1) => until(() => fileRequests(engine, 'client.fsWriteJson', path).length >= count, `${path} written`, 200);

describe('user data in a dev tool: the controller keeps it in its own file, per account', () => {
	it('names the two files beside the history file, and waits for them as long as the library may take to read one', () => {
		assert.equal(SAVED_QUERIES_PATH, '@/User/.workspace/rocketride.graph.saved.json');
		assert.equal(STYLES_PATH, '@/User/.workspace/rocketride.graph.styles.json');
		assert.equal(USER_DATA_LOAD_WAIT_MS, PREFS_LOAD_ATTEMPTS * 2 * PREFS_FS_TIMEOUT_MS + 1_000 + 3_000, 'the library\'s whole load');
		for (const op of [OP.styles, OP.savedQueries, OP.styleEdit, OP.savedEdit]) assert.ok(frameTimeoutFor(op) > USER_DATA_LOAD_WAIT_MS, `${op}: the frame waits longer than the controller may`);
	});

	it('a frame\'s save and its style land in their own files under the signed-in account, beside the history file, not in it; the frame reads them back with where they are kept', async () => {
		const r = await rig();
		const view = r.frame.env(true).userData.saved(r.key);
		const off = view.subscribe(() => undefined);
		await loaded(view);
		assert.equal(view.get().status, 'ready');
		await r.save(FP_A, saveOf('Who works where'));
		await r.style(FP_A, { kind: 'label', label: 'Person', patch: { slot: 4 } });
		await r.style(FP_A, { kind: 'label', label: 'Person', patch: { size: 'L' } });
		await until(() => view.get().queries.length === 1, 'the frame read its save back');
		assert.equal(view.get().queries[0].name, 'Who works where');
		assert.match(r.frame.env(true).userData.privacyNote, /rocketride\.graph\.saved\.json, rocketride\.graph\.styles\.json/);
		await written(r.engine);
		await until(() => (bagOf(r.engine.files, FP_A, STYLES_PATH)?.[STYLES_PREF] as Record<string, { labels?: Record<string, unknown> }> | undefined)?.[r.key]?.labels?.Person !== undefined, 'the style in its file', 200);
		const saved = bagOf(r.engine.files, FP_A) ?? {};
		const styles = bagOf(r.engine.files, FP_A, STYLES_PATH) ?? {};
		assert.deepEqual((saved[SAVED_QUERIES_PREF] as Record<string, ISavedQuery[]>)[r.key].map((q) => q.name), ['Who works where']);
		assert.equal(saved[STYLES_PREF], undefined, 'no style in the saved-queries file');
		assert.deepEqual(((styles[STYLES_PREF] as Record<string, { labels: unknown }>)[r.key]).labels, { Person: { slot: 4, size: 'L' } }, 'two quick edits, both kept');
		assert.equal(styles[SAVED_QUERIES_PREF], undefined, 'no saved query in the styles file');
		assert.equal((r.engine.files.get(SAVED_QUERIES_PATH) as { version: number }).version, PREFS_FILE_VERSION);
		assert.doesNotMatch(JSON.stringify([...r.engine.files.entries()].filter(([path]) => path !== SAVED_QUERIES_PATH)), /Who works where/, 'no other file holds it');
		off();
		r.dispose();
	});

	it('the caps refuse a save through the op with the sentence, and an edit this app does not make is refused', async () => {
		const r = await rig();
		for (let i = 0; i < MAX_SAVED_QUERIES; i += 1) await r.save(FP_A, saveOf(`q${i}`));
		await assert.rejects(r.save(FP_A, saveOf('one more')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /already keeps 50 saved queries/.test(error.message));
		await assert.rejects(r.style(FP_A, { kind: 'assign', add: { X: 0 }, release: [] } as never), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', 'an assignment never comes from a frame');
		await assert.rejects(r.save(FP_A, { action: 'clear' } as never), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		r.dispose();
	});

	it('never writes a file it could not read: they are kept for the session, and the answer says so', async () => {
		const engine = vscodeRealm();
		engine.files.set(SAVED_QUERIES_PATH, { format: 'from the future' });
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.env(true).endpoints.get().endpoints.length === 1, 'discovery');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await until(() => frame.guard.first() !== null, 'the frame learnt its account');
		await frame.caller.callReply(OP.savedEdit, { key, owner: FP_A, edit: saveOf('Kept') }, { timeoutMs: frameTimeoutFor(OP.savedEdit) });
		const answer = await frame.caller.callReply(OP.savedQueries, { key, owner: FP_A }, { timeoutMs: frameTimeoutFor(OP.savedQueries) });
		assert.equal(answer.saved.status, 'session');
		assert.deepEqual(answer.saved.queries.map((q) => q.name), ['Kept']);
		assert.match(answer.privacyNote, /^Saved queries are kept for this session only/);
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.deepEqual(fileRequests(engine, 'client.fsWriteJson'), [], 'the file was never written');
		assert.deepEqual(engine.files.get(SAVED_QUERIES_PATH), { format: 'from the future' });
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('user data: frames follow a small revision topic, and read the data as an op result', () => {
	it('each revision moves on its own changes; the topic carries no data and stays under 64 bytes; the ops round-trip JSON-safe', async () => {
		const r = await rig();
		const snapshots = (): Array<{ styleRev: number; savedRev: number }> => r.h.wire.flatMap((entry) => Object.values((entry.value ?? {}) as Record<string, { __rrtool?: string; topic?: string; snapshot?: { styleRev: number; savedRev: number } }>).filter((m) => m?.__rrtool === 'state' && m.topic === STATE.userData).map((m) => m.snapshot!));
		const last = () => snapshots()[snapshots().length - 1];
		await until(() => snapshots().length > 0, 'the topic published');
		await r.read(FP_A);
		await r.readStyle(FP_A);
		const before = last();
		await r.save(FP_A, saveOf('Who works where'));
		await until(() => last().savedRev > before.savedRev, 'the saved revision moved');
		const afterSave = last();
		assert.equal(afterSave.styleRev, before.styleRev, 'a save leaves the style revision alone');
		await r.style(FP_A, { kind: 'label', label: 'Person', patch: { badge: 'dot' } });
		await until(() => last().styleRev > afterSave.styleRev, 'the style revision moved');
		assert.equal(last().savedRev, afterSave.savedRev, 'a style edit leaves the saved revision alone: frames do not read their saved queries again');
		for (const entry of r.h.wire) {
			for (const m of Object.values((entry.value ?? {}) as Record<string, { __rrtool?: string; topic?: string; snapshot?: unknown }>)) {
				if (m?.__rrtool !== 'state' || m.topic !== STATE.userData) continue;
				assert.deepEqual(Object.keys(m.snapshot as object).sort(), ['savedRev', 'styleRev']);
				assert.ok(jsonByteLength(m.snapshot) < 64, 'a tiny topic');
				assert.doesNotMatch(JSON.stringify(m.snapshot), /Who works where/);
			}
		}
		for (const [i, entry] of r.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		assert.deepEqual(r.h.violations, [], 'nothing JSON would change crossed the wire');
		r.dispose();
	});

	it('a second document\'s view of the same connection follows a change made in the first', async () => {
		const r = await rig();
		const other = mountFrame(r.h, `write:${r.key}`);
		await until(() => other.frame.guard.first() !== null, 'the second frame learnt its account');
		const style = other.frame.env(true).userData.style(r.key);
		const off = style.subscribe(() => undefined);
		await r.frame.env(true).userData.editStyle(r.key, { kind: 'label', label: 'Person', patch: { slot: 2 } });
		await until(() => style.get().style.labels.Person?.slot === 2, 'the second document saw the style');
		assert.equal(style.get().ready, true);
		off();
		other.frame.dispose();
		r.dispose();
	});
});

describe('user data: colour slots are given by the controller, written only to the styles file once it was read', () => {
	it('a loaded schema\'s labels get the lowest free slots in sorted order, shown to frames at once and written to the styles file; a later new label moves nobody', async () => {
		let schema: Record<string, unknown> = NEO4J_SCHEMA;
		const r = await rig((call) => (call.tool === 'get_schema' || call.tool === 'refresh_schema' ? schema : readOnlyNode(call)));
		const style = r.frame.env(true).userData.style(r.key);
		const off = style.subscribe(() => undefined);
		await r.frame.env(true).loadSchema(r.key);
		const names = parseSchema(NEO4J_SCHEMA).labels.map((label) => label.name).sort();
		await until(() => Object.keys(style.get().style.assigned).length === 6, 'six labels given slots', 200);
		assert.equal(style.get().ready, true);
		assert.deepEqual(style.get().style.assigned, Object.fromEntries(names.slice(0, 6).map((name, i) => [name, i])));
		await written(r.engine, STYLES_PATH);
		assert.equal(fileRequests(r.engine, 'client.fsWriteJson', SAVED_QUERIES_PATH).length, 0, 'the saved-queries file is never written by a slot');
		// A new label that sorts first appears; nobody already given a slot moves, and every slot is held by a label the
		// schema still lists, so it hashes.
		const inner = schema.schema as Record<string, unknown>;
		schema = { ...schema, schema: { ...inner, labels: [{ name: 'Aardvark', properties: [], count: 1, count_estimated: false }, ...(inner.labels as unknown[])] } };
		await r.frame.env(true).loadSchema(r.key, { fresh: true });
		await until(() => r.controller.stores.schemas.get(r.key).view.labels.some((label) => label.name === 'Aardvark'), 'the new label loaded', 200);
		await settle();
		assert.deepEqual(style.get().style.assigned, Object.fromEntries(names.slice(0, 6).map((name, i) => [name, i])), 'no slot moved');
		off();
		r.dispose();
	});

	it('no slot is written before the styles file was read: a schema loaded first writes nothing, and the stored slots win', async () => {
		const engine = vscodeRealm();
		let hold = true;
		const releases: Array<() => void> = [];
		const inner = engine.cm.request.bind(engine.cm);
		const cm = Object.assign(Object.create(null), engine.cm, {
			request: async (op: string, params: unknown, opts?: { timeoutMs?: number }) => {
				if (hold && (params as { path?: string } | null)?.path === STYLES_PATH && (op === 'client.fsStat' || op === 'client.fsReadJson')) await new Promise<void>((resolve) => releases.push(resolve));
				return inner(op, params, opts);
			},
		});
		signInVsCode(engine.realm);
		const mounted = mountController(cm as never);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.env(true).endpoints.get().endpoints.length === 1, 'discovery');
		const endpointKey = frame.env(true).endpoints.get().endpoints[0].key;
		// What another window stored for this connection: a person's colour, and slots in an order the schema would not give.
		engine.files.set(STYLES_PATH, { version: PREFS_FILE_VERSION, owners: { [FP_A]: { at: 1, prefs: { [STYLES_PREF]: { [endpointKey]: { assigned: { Person: 5, GxPerson: 0 }, labels: { Person: { slot: 3 } } } } } } } });
		await until(() => releases.length > 0, 'the styles file read held');
		await frame.env(true).loadSchema(endpointKey);
		await until(() => mounted.controller.stores.schemas.get(endpointKey).loadedAt > 0, 'the schema loaded before the file');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.deepEqual(fileRequests(engine, 'client.fsWriteJson', STYLES_PATH), [], 'nothing written while the file was not read');
		assert.equal(mounted.controller.env(true).userData.style(endpointKey).get().ready, false, 'and the style is not ready');
		hold = false;
		for (const release of releases.splice(0)) release();
		await until(() => mounted.controller.env(true).userData.style(endpointKey).get().ready, 'the file read');
		const { style } = mounted.controller.env(true).userData.style(endpointKey).get();
		assert.equal(style.assigned.Person, 5, 'the stored slot is kept');
		assert.equal(style.assigned.GxPerson, 0);
		assert.deepEqual(style.labels.Person, { slot: 3 }, 'and the person\'s colour');
		await written(engine, STYLES_PATH);
		const stored = (bagOf(engine.files, FP_A, STYLES_PATH)?.[STYLES_PREF] as Record<string, { assigned: Record<string, number>; labels: unknown }>)[endpointKey];
		assert.equal(stored.assigned.Person, 5, 'the write added slots around what was stored');
		assert.deepEqual(stored.labels, { Person: { slot: 3 } });
		frame.dispose();
		mounted.controller.dispose();
	});

	it('two windows: window 2 saves a query while window 1 gives colour slots from its own copy; the saved query survives', async () => {
		const one = vscodeRealm();
		const two = vscodeRealm();
		// Both windows reach the same user store (the engine's), each through its own realm.
		const shared = (engine: typeof one) => Object.assign(Object.create(null), engine.cm, {
			request: (op: string, params: unknown, opts?: { timeoutMs?: number }) => (op.startsWith('client.fs') ? one.cm.request(op, params, opts) : engine.cm.request(op, params, opts)),
		});
		signInVsCode(one.realm);
		signInVsCode(two.realm);
		const w1 = mountController(shared(one) as never);
		const w2 = mountController(shared(two) as never);
		for (const w of [w1, w2]) w.h.setHostConnection(true);
		const f1 = mountFrame(w1.h, undefined).frame;
		const f2 = mountFrame(w2.h, undefined).frame;
		await until(() => f1.env(true).endpoints.get().endpoints.length === 1 && f2.env(true).endpoints.get().endpoints.length === 1, 'both windows discovered');
		const key = f2.env(true).endpoints.get().endpoints[0].key;
		await until(() => f1.guard.first() !== null && f2.guard.first() !== null, 'both frames know their account');
		// Both windows have read both files (empty) before either writes.
		await f1.caller.callReply(OP.styles, { key, owner: FP_A }, { timeoutMs: frameTimeoutFor(OP.styles) });
		await f1.caller.callReply(OP.savedQueries, { key, owner: FP_A }, { timeoutMs: frameTimeoutFor(OP.savedQueries) });
		await f2.caller.callReply(OP.savedQueries, { key, owner: FP_A }, { timeoutMs: frameTimeoutFor(OP.savedQueries) });
		// Window 2 saves a query; it reaches the file.
		await f2.caller.callReply(OP.savedEdit, { key, owner: FP_A, edit: saveOf('Who works where') }, { timeoutMs: frameTimeoutFor(OP.savedEdit) });
		await until(() => JSON.stringify(bagOf(one.files, FP_A) ?? {}).includes('Who works where'), 'window 2\'s save in the file', 200);
		// Window 1, whose copy predates that save, loads the schema and writes its colour slots.
		await f1.env(true).loadSchema(key);
		await until(() => JSON.stringify(bagOf(one.files, FP_A, STYLES_PATH) ?? {}).includes('"assigned"'), 'window 1\'s slots in the styles file', 200);
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.ok(JSON.stringify(bagOf(one.files, FP_A) ?? {}).includes('Who works where'), 'the saved query survives');
		f1.dispose();
		f2.dispose();
		w1.controller.dispose();
		w2.controller.dispose();
	});
});

describe('T7 - user data: nothing of one account is served to, kept for, or written for another', () => {
	it('a frame bound to A is refused once B is signed in, reading or saving; no owner is refused too', async () => {
		const r = await rig();
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.save(FP_A, saveOf('A after B')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.readStyle(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.style(FP_A, { kind: 'reset' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(r.read(null), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		r.dispose();
	});

	it('A saves, then B signs in directly: A\'s save is never written into B\'s bag, and B is never served it', async () => {
		const r = await rig();
		await r.save(FP_A, saveOf('A only'));
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		const answer = await r.read('u2|org-1|team-1');
		assert.deepEqual(answer.saved.queries, [], 'B is served nothing of A');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify(bagOf(r.engine.files, 'u2|org-1|team-1') ?? {}).includes('A only'), false, 'nothing of A in B\'s bag');
		assert.equal(JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A only'), false, 'and A\'s pending write was dropped, not written later under B');
		r.dispose();
	});

	it('A saves, signs out, and signs in again with the sidebar open: written for A, and only for A', async () => {
		const r = await rig();
		await r.save(FP_A, saveOf('A again'));
		r.engine.realm.root.disconnect();
		await until(() => !r.controller.identity.get().known, 'nobody signed in');
		await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable', 'nothing is served while nobody is signed in');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A again'), false, 'the premise: held while nobody is signed in');
		r.engine.realm.root.connect(account('u1'));
		await until(() => JSON.stringify(bagOf(r.engine.files, FP_A) ?? {}).includes('A again'), 'A\'s save written for A', 200);
		r.dispose();
	});

	it('a save that waits for the file while the account changes is refused after the wait and never reaches B\'s file', async () => {
		const engine = vscodeRealm();
		let hold = true;
		const releases: Array<() => void> = [];
		const inner = engine.cm.request.bind(engine.cm);
		const cm = Object.assign(Object.create(null), engine.cm, {
			request: async (op: string, params: unknown, opts?: { timeoutMs?: number }) => {
				if (hold && (params as { path?: string } | null)?.path === SAVED_QUERIES_PATH && (op === 'client.fsStat' || op === 'client.fsReadJson')) await new Promise<void>((resolve) => releases.push(resolve));
				return inner(op, params, opts);
			},
		});
		signInVsCode(engine.realm);
		const mounted = mountController(cm as never);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => frame.env(true).endpoints.get().endpoints.length === 1, 'discovery');
		const key = frame.env(true).endpoints.get().endpoints[0].key;
		await until(() => releases.length > 0, 'A\'s file read held');
		const pending = frame.caller.callReply(OP.savedEdit, { key, owner: FP_A, edit: saveOf('Mid-switch') }, { timeoutMs: frameTimeoutFor(OP.savedEdit) });
		await settle();
		engine.realm.root.accountChanged(account('u2'));
		await until(() => mounted.controller.identity.get().fingerprint === 'u2|org-1|team-1', 'account B');
		hold = false;
		for (const release of releases.splice(0)) release();
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(JSON.stringify([...engine.files.values()]).includes('Mid-switch'), false, 'written nowhere');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('an account change clears the frame\'s view of the styles and saved queries, and its schema view', async () => {
		const r = await rig();
		const view = r.landing.env(true).userData.saved(r.key);
		const off = view.subscribe(() => undefined);
		await r.save(FP_A, saveOf('A only'));
		await until(() => view.get().queries.length === 1, 'the landing read A\'s');
		await r.landing.env(true).loadSchema(r.key);
		const offView = r.landing.schemaView.subscribe(() => undefined);
		r.landing.schemaView.get(r.key);
		await until(() => r.landing.schemaView.get(r.key) !== null, 'the landing read the schema view');
		r.engine.realm.root.accountChanged(account('u2'));
		await until(() => r.landing.lastReset() === 'identity', 'the landing reset');
		assert.deepEqual(view.get().queries, [], 'nothing of A is shown');
		assert.equal(r.landing.schemaView.get(r.key), null, 'nor A\'s schema');
		off();
		offView();
		r.dispose();
	});
});

describe('the schema view in a frame: read on first use, and again when a newer load completed', () => {
	it('null until the controller loaded it; the view after; read again after a refresh', async () => {
		let reads = 0;
		const r = await rig((call) => {
			if (call.tool === 'get_schema' || call.tool === 'refresh_schema') reads += 1;
			return readOnlyNode(call);
		});
		const views = r.engine.requests.length;
		const off = r.frame.env(true).schemaView.subscribe(() => undefined);
		assert.equal(r.frame.env(true).schemaView.get(r.key), null, 'nothing read yet');
		await settle();
		assert.equal(r.frame.env(true).schemaView.get(r.key), null, 'the controller has not loaded it either');
		await r.frame.env(true).loadSchema(r.key);
		await until(() => r.frame.env(true).schemaView.get(r.key) !== null, 'the view after the load');
		assert.deepEqual(r.frame.env(true).schemaView.get(r.key), JSON.parse(JSON.stringify(parseSchema(NEO4J_SCHEMA))));
		const first = r.frame.env(true).schemaView.get(r.key);
		assert.equal(r.frame.env(true).schemaView.get(r.key), first, 'stable between changes');
		const loadedAt = r.frame.schemas.get()[r.key].loadedAt;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await r.frame.env(true).loadSchema(r.key, { fresh: true });
		await until(() => r.frame.schemas.get()[r.key].loadedAt !== loadedAt, 'the refresh completed');
		await until(() => r.frame.env(true).schemaView.get(r.key) !== first, 'the view read again');
		assert.ok(reads >= 2, 'the premise: two loads');
		assert.ok(r.engine.requests.length >= views, 'the reads are op results, not engine calls');
		off();
		r.dispose();
	});
});

describe('the schema view of a connection whose label names do not fit the summaries', () => {
	it('still crosses with its load time, so the frame reads the view after the load and again after a refresh', async () => {
		const names = Array.from({ length: 2_000 }, (_, i) => `ALabelWithAVeryLongNameNumber${i}`);
		const big = { database: 'neo4j', labels: names, nodes: Object.fromEntries(names.map((n) => [n, [{ property: 'p', type: 'string' }]])), relationships: {} };
		const r = await rig((call) => (call.tool === 'get_schema' || call.tool === 'refresh_schema' ? big : readOnlyNode(call)));
		const off = r.frame.env(true).schemaView.subscribe(() => undefined);
		r.frame.env(true).schemaView.get(r.key);
		await r.frame.env(true).loadSchema(r.key);
		await until(() => r.frame.schemas.get()[r.key]?.loadedAt > 0, 'the summary', 200);
		assert.equal(r.frame.schemas.get()[r.key].labelsCut, true, 'the premise: the names did not fit');
		await until(() => (r.frame.env(true).schemaView.get(r.key)?.labels.length ?? 0) === names.length, 'the view read', 200);
		const first = r.frame.env(true).schemaView.get(r.key);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await r.frame.env(true).loadSchema(r.key, { fresh: true });
		await until(() => r.frame.env(true).schemaView.get(r.key) !== first, 'the view read again after the refresh', 200);
		off();
		r.dispose();
	});
});

describe('review P5: colour slots, account switches and frames that watch again', () => {
	it('C-1 (T7): A loads a schema and B signs in within the pause; B\'s styles file never gets A\'s connection or labels', async () => {
		const r = await rig();
		await r.readStyle(FP_A);
		await r.landing.env(true).loadSchema(r.key);
		await until(() => r.controller.stores.schemas.get(r.key).loadedAt > 0, 'A\'s schema loaded');
		r.engine.realm.root.accountChanged(account('u2'));
		const FP_B = 'u2|org-1|team-1';
		await until(() => r.controller.identity.get().fingerprint === FP_B, 'account B');
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const names = parseSchema(NEO4J_SCHEMA).labels.map((label) => label.name);
		const bText = JSON.stringify(bagOf(r.engine.files, FP_B, STYLES_PATH) ?? {});
		assert.equal(bText.includes(r.key), false, 'A\'s connection never reaches B\'s file');
		for (const name of names) assert.equal(bText.includes(`"${name}"`), false, `A's label ${name} never reaches B's file`);
		assert.equal(JSON.stringify(bagOf(r.engine.files, FP_A, STYLES_PATH) ?? {}).includes('"assigned"'), false, 'and nothing was written for A after the switch either');
		assert.deepEqual(Object.keys(r.controller.env(true).userData.style(r.key).get().style.assigned), [], 'B is shown none of the slots wanted for A');
		r.dispose();
	});

	it('I-2: a frame view watched again after a change made while nobody watched it reads it again', async () => {
		const r = await rig();
		const view = r.frame.env(true).userData.saved(r.key);
		let off = view.subscribe(() => undefined);
		await until(() => view.get().status === 'ready', 'the first read');
		off();
		await r.landing.env(true).userData.editSaved(r.key, saveOf('Elsewhere'));
		await settle();
		off = view.subscribe(() => undefined);
		await until(() => view.get().queries.some((q) => q.name === 'Elsewhere'), 'the change made elsewhere', 200);
		off();
		r.dispose();
	});

	for (const unreadable of [false, true]) {
		it(`I-3: a frame that read its style before the schema loaded gets the same colour slots as the sidebar at once (styles file ${unreadable ? 'unreadable: session only' : 'readable'})`, async () => {
			const engine = vscodeRealm();
			if (unreadable) engine.files.set(STYLES_PATH, { format: 'from the future' });
			signInVsCode(engine.realm);
			const mounted = mountController(engine.cm);
			mounted.h.setHostConnection(true);
			const landing = mountFrame(mounted.h, undefined).frame;
			await until(() => landing.env(true).endpoints.get().endpoints.length === 1, 'discovery');
			const key = landing.env(true).endpoints.get().endpoints[0].key;
			const doc = mountFrame(mounted.h, `workbench:${key}`).frame;
			await until(() => doc.guard.first() !== null, 'the account');
			const style = doc.env(true).userData.style(key);
			const off = style.subscribe(() => undefined);
			await until(() => style.get().ready, 'the frame read its style');
			await doc.env(true).loadSchema(key);
			await until(() => mounted.controller.stores.schemas.get(key).loadedAt > 0, 'the schema');
			const sidebar = () => mounted.controller.env(true).userData.style(key).get().style.assigned;
			await until(() => Object.keys(sidebar()).length === 6 && JSON.stringify(style.get().style.assigned) === JSON.stringify(sidebar()), 'the frame agrees with the sidebar', 30);
			assert.deepEqual(fileRequests(engine, 'client.fsWriteJson', STYLES_PATH), [], 'before any write: what is shown, not only what is stored');
			off();
			doc.dispose();
			landing.dispose();
			mounted.controller.dispose();
		});
	}
});
