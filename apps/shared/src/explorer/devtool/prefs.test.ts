// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER DEV TOOL — FS-BACKED HISTORY PREFERENCES (§3.5: load first, then attach)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { manualClock } from '../connect/testing';
import { createHistoryStore } from '../history/store';
import type { IHistoryEntry } from '../history/types';
import type { IPrefsFs } from './engineClient';
import { attachWhenLoaded, createFsPrefs, historyPrefsPath, PREFS_FILE_VERSION, PREFS_LOAD_ATTEMPTS, PREFS_WRITE_DEBOUNCE_MS, PREFS_WRITE_RETRIES } from './prefs';
import type { IFsPrefsOptions } from './prefs';
import { settle } from './testing';

const PATH = historyPrefsPath('graph');
const OWNER = 'user-a|org-1|team-1';

/** One recorded fs request. */
interface IFsRequest {
	op: string;
	params: unknown;
}

/**
 * A file store answering the fs calls a test scripts (an unscripted call throws).
 *
 * @param script - The answer per call (a function of the params; throw to fail).
 * @returns The store and its request log.
 */
function fakeFs(script: Record<string, (params: Record<string, unknown>) => unknown>): { fs: IPrefsFs; requests: IFsRequest[] } {
	const requests: IFsRequest[] = [];
	const run = async (op: string, params: Record<string, unknown>): Promise<never> => {
		requests.push({ op, params });
		const answer = script[op];
		if (answer === undefined) throw new Error(`unexpected ${op}`);
		return answer(params) as never;
	};
	const fs: IPrefsFs = {
		fsStat: (path) => run('fsStat', { path }),
		fsReadJson: (path) => run('fsReadJson', { path }),
		fsMkdir: (path) => run('fsMkdir', { path }),
		fsWriteJson: (path, value) => run('fsWriteJson', { path, value }),
	};
	return { fs, requests };
}

/** A stored file holding `prefs` for OWNER (and any other owners given). */
const file = (prefs: Record<string, unknown>, others: Record<string, { at: number; prefs: Record<string, unknown> }> = {}) => ({
	version: PREFS_FILE_VERSION,
	owners: { ...others, [OWNER]: { at: 1, prefs } },
});

/** A history entry. */
const entry = (id: string, at: number): IHistoryEntry<'cypher'> => ({ id, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read', cypher: `MATCH (n) RETURN n // ${id}` });

/**
 * Options over a fake file store and a manual clock.
 *
 * @param fs - The file store.
 * @param over - Overrides.
 * @returns The options and the clock.
 */
function options(fs: IPrefsFs, over: Partial<IFsPrefsOptions> = {}) {
	const clock = manualClock();
	return { clock, opts: { fs, path: PATH, owner: OWNER, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, ...over } satisfies IFsPrefsOptions };
}

describe('historyPrefsPath', () => {
	it("sits beside the SQL tool's saved-connection file in the user's workspace folder", () => {
		assert.equal(historyPrefsPath('graph'), '@/User/.workspace/rocketride.graph.history.json');
	});
});

describe('createFsPrefs — load first', () => {
	it('attach waits for the load, and the store hydrates from the loaded file', async () => {
		let release: (value: unknown) => void = () => undefined;
		const { fs } = fakeFs({
			'fsStat': () => ({ exists: true, type: 'file' }),
			'fsReadJson': () => new Promise((resolve) => { release = resolve; }),
		});
		const prefs = createFsPrefs(options(fs).opts);
		const attached: Array<{ owner: string; history: unknown }> = [];
		attachWhenLoaded(prefs, (api, owner) => {
			attached.push({ owner, history: api.getPref('graph.history') });
			return () => undefined;
		});
		await settle();
		assert.deepEqual(attached, [], 'nothing attaches while the file is being read');
		release(file({ 'graph.history': { k1: [entry('e1', 10)] } }));
		await settle();
		assert.deepEqual(attached, [{ owner: OWNER, history: { k1: [entry('e1', 10)] } }]);
		assert.equal(prefs.status(), 'ready');
	});

	it('the first write after the load contains the loaded entries (a real history store)', async () => {
		const writes: unknown[] = [];
		const { fs } = fakeFs({
			'fsStat': () => ({ exists: true, type: 'file' }),
			'fsReadJson': () => file({ 'graph.history': { k1: [entry('e1', 10)] } }),
			'fsMkdir': () => undefined,
			'fsWriteJson': (params) => { writes.push(params.value); },
		});
		const { clock, opts } = options(fs);
		const prefs = createFsPrefs(opts);
		const store = createHistoryStore({ historyKey: 'graph.history', recordingKey: 'graph.historyRecording', textField: 'cypher', persistDelayMs: 0 });
		const detach = attachWhenLoaded(prefs, (api, owner) => store.attachPrefs(api, owner));
		await settle();
		store.runs.emitRun('k1', entry('e2', 20));
		await settle();
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.equal(writes.length, 1);
		const written = writes[0] as { version: number; owners: Record<string, { prefs: Record<string, Record<string, Array<{ id: string }>>> }> };
		assert.equal(written.version, PREFS_FILE_VERSION);
		assert.deepEqual(written.owners[OWNER].prefs['graph.history'].k1.map((e) => e.id), ['e2', 'e1']);
		detach();
	});

	it('a read failure never overwrites the file: history stays in memory for the session', async () => {
		const errors: string[] = [];
		const { fs, requests } = fakeFs({
			'fsStat': () => ({ exists: true, type: 'file' }),
			'fsReadJson': () => { throw new Error('Op failed at the root'); },
		});
		const { clock, opts } = options(fs, { onError: (_error, phase) => errors.push(phase) });
		const prefs = createFsPrefs(opts);
		const attached: string[] = [];
		attachWhenLoaded(prefs, (_api, owner) => { attached.push(owner); return () => undefined; });
		// A failed request is retried (PREFS_LOAD_ATTEMPTS in all) before the session falls back to memory.
		await clock.advance(60_000);
		await settle();
		assert.equal(prefs.status(), 'failed');
		assert.deepEqual(attached, [OWNER], 'the store still attaches (session-only history)');
		prefs.setPref('graph.history', { k1: [entry('e9', 90)] });
		assert.deepEqual(prefs.getPref('graph.history'), { k1: [entry('e9', 90)] });
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS * 5);
		await prefs.flush();
		const attempt = ['fsStat', 'fsReadJson'];
		assert.deepEqual(requests.map((r) => r.op), Array.from({ length: PREFS_LOAD_ATTEMPTS }, () => attempt).flat(), 'retried reads only: no mkdir, no write');
		assert.deepEqual(errors, ['load'], 'reported once, after the last attempt');
	});

	it('a file in an unknown or newer format is never overwritten either', async () => {
		for (const stored of [{ version: PREFS_FILE_VERSION + 1, owners: {} }, 'not an object', { version: PREFS_FILE_VERSION, owners: [] }]) {
			const { fs, requests } = fakeFs({ 'fsStat': () => ({ exists: true }), 'fsReadJson': () => stored });
			const prefs = createFsPrefs(options(fs).opts);
			assert.equal(await prefs.load(), 'failed', JSON.stringify(stored));
			prefs.setPref('graph.history', {});
			await prefs.flush();
			assert.equal(requests.some((r) => r.op === 'fsWriteJson'), false);
		}
	});

	it('first run (no file): nothing is read; the first write makes the folder, then writes', async () => {
		const { fs, requests } = fakeFs({
			'fsStat': () => ({ exists: false }),
			'fsMkdir': () => undefined,
			'fsWriteJson': () => undefined,
		});
		const { clock, opts } = options(fs);
		const prefs = createFsPrefs(opts);
		assert.equal(await prefs.load(), 'ready');
		assert.equal(prefs.getPref('graph.history'), undefined);
		prefs.setPref('graph.history', { k1: [entry('e1', 1)] });
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.deepEqual(requests.map((r) => [r.op, (r.params as { path: string }).path]), [
			['fsStat', PATH],
			['fsMkdir', '@/User/.workspace'],
			['fsWriteJson', PATH],
		]);
	});
});

describe('createFsPrefs — writes', () => {
	/**
	 * A loaded adapter over an empty file.
	 *
	 * @param over - Option overrides.
	 * @returns The adapter, its clock and the written values.
	 */
	async function loaded(over: Partial<IFsPrefsOptions> = {}, stored: unknown = file({})) {
		const writes: unknown[] = [];
		const { fs, requests } = fakeFs({
			'fsStat': () => ({ exists: true }),
			'fsReadJson': () => stored,
			'fsMkdir': () => undefined,
			'fsWriteJson': (params) => { writes.push(params.value); },
		});
		const { clock, opts } = options(fs, over);
		const prefs = createFsPrefs(opts);
		await prefs.load();
		return { prefs, clock, writes, requests };
	}

	it('are debounced into one write; flush() writes at once', async () => {
		const { prefs, clock, writes } = await loaded();
		prefs.setPref('a', 1);
		prefs.setPref('b', 2);
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS - 1);
		assert.equal(writes.length, 0);
		await clock.advance(1);
		await settle();
		assert.equal(writes.length, 1);
		prefs.setPref('a', 3);
		await prefs.flush();
		assert.equal(writes.length, 2);
		assert.deepEqual((writes[1] as { owners: Record<string, { prefs: unknown }> }).owners[OWNER].prefs, { a: 3, b: 2 });
	});

	it("keep owners apart: another identity's preferences are neither read nor changed", async () => {
		const other = { 'user-b|org-1|team-1': { at: 5, prefs: { 'graph.history': { k9: [entry('x', 1)] } } } };
		const { prefs, writes } = await loaded({}, file({ 'graph.history': {} }, other));
		assert.deepEqual(prefs.getPref('graph.history'), {});
		prefs.setPref('graph.history', { k1: [entry('e1', 1)] });
		await prefs.flush();
		const owners = (writes[0] as { owners: Record<string, unknown> }).owners;
		assert.deepEqual(owners['user-b|org-1|team-1'], other['user-b|org-1|team-1']);
	});

	it('keep at most maxOwners bags, dropping the least recently written', async () => {
		const others: Record<string, { at: number; prefs: Record<string, unknown> }> = {};
		for (let i = 0; i < 5; i += 1) others[`user-${i}|o|t`] = { at: i, prefs: {} };
		const { prefs, writes } = await loaded({ maxOwners: 3 }, file({}, others));
		prefs.setPref('a', 1);
		await prefs.flush();
		assert.deepEqual(Object.keys((writes[0] as { owners: object }).owners).sort(), [OWNER, 'user-3|o|t', 'user-4|o|t'].sort());
	});

	it('are dropped once the identity is no longer the owner', async () => {
		let current: string | null = OWNER;
		const { prefs, clock, writes } = await loaded({ ownerNow: () => current });
		prefs.setPref('a', 1);
		current = 'user-b|org-1|team-1';
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await prefs.flush();
		assert.equal(writes.length, 0);
	});

	it('respect the file cap: an oversize file is refused and reported, never written', async () => {
		const errors: unknown[] = [];
		const { prefs, writes } = await loaded({ maxFileChars: 200, onError: (error) => errors.push(error) });
		prefs.setPref('graph.history', { k1: [entry('e1', 1), entry('e2', 2), entry('e3', 3)] });
		await prefs.flush();
		assert.equal(writes.length, 0);
		assert.equal(errors.length, 1);
		assert.ok(errors[0] instanceof RangeError);
	});

	it('dispose drops a pending write; close flushes it', async () => {
		const a = await loaded();
		a.prefs.setPref('a', 1);
		a.prefs.dispose();
		await a.clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.equal(a.writes.length, 0);
		const b = await loaded();
		b.prefs.setPref('a', 1);
		await b.prefs.close();
		assert.equal(b.writes.length, 1);
	});

	it('refuses to exist without an owner (no identity: history stays in memory)', () => {
		const { fs } = fakeFs({});
		assert.throws(() => createFsPrefs({ fs, path: PATH, owner: '' }), RangeError);
	});
});

describe('createFsPrefs — round 3: nothing a person changed is lost to timing', () => {
	/**
	 * An adapter over a scripted bus, with a manual clock.
	 *
	 * @param script - The fs answers.
	 * @param over - Option overrides.
	 * @returns The adapter, clock, writes and requests.
	 */
	function make(script: Record<string, (params: Record<string, unknown>) => unknown>, over: Partial<IFsPrefsOptions> = {}) {
		const writes: unknown[] = [];
		const { fs, requests } = fakeFs({
			'fsMkdir': () => undefined,
			'fsWriteJson': (params) => { writes.push(params.value); },
			...script,
		});
		const { clock, opts } = options(fs, over);
		return { prefs: createFsPrefs(opts), clock, writes, requests };
	}
	const ownPrefs = (value: unknown): Record<string, unknown> => (value as { owners: Record<string, { prefs: Record<string, unknown> }> }).owners[OWNER].prefs;

	it('a write that falls due while the identity is transiently unknown is kept, and written once the same owner is back (CE-4)', async () => {
		let current: string | null = OWNER;
		const { prefs, clock, writes } = make({ 'fsStat': () => ({ exists: false }) }, { ownerNow: () => current });
		await prefs.load();
		prefs.setPref('k', 'v');
		current = null;
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.equal(writes.length, 0, 'nothing is written while nobody is vouched for');
		current = OWNER;
		await clock.advance(60_000);
		await settle();
		assert.equal(writes.length, 1, 'the kept change is written once the same owner is back, without another setPref');
		assert.deepEqual(ownPrefs(writes[0]), { k: 'v' });
	});

	it('a different owner still drops the pending change', async () => {
		let current: string | null = OWNER;
		const { prefs, clock, writes } = make({ 'fsStat': () => ({ exists: false }) }, { ownerNow: () => current });
		await prefs.load();
		prefs.setPref('k', 'v');
		current = 'user-b|org-1|team-1';
		await clock.advance(60_000);
		await prefs.close();
		assert.equal(writes.length, 0);
	});

	it('a failed write keeps the change and retries, a bounded number of times', async () => {
		let failures = 1;
		const attempts: number[] = [];
		const { prefs, clock, writes } = make({
			'fsStat': () => ({ exists: false }),
			'fsWriteJson': (params) => {
				attempts.push(1);
				if (failures > 0) { failures -= 1; throw new Error('Op failed at the root'); }
				writes.push(params.value);
			},
		});
		await prefs.load();
		prefs.setPref('k', 1);
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.equal(writes.length, 0);
		await clock.advance(60_000);
		await settle();
		assert.equal(writes.length, 1, 'retried and written');
		failures = 1_000;
		prefs.setPref('k', 2);
		const before = attempts.length;
		await clock.advance(30 * 60_000);
		await settle();
		assert.equal(attempts.length - before, 1 + PREFS_WRITE_RETRIES, 'bounded: the first attempt plus PREFS_WRITE_RETRIES');
	});

	it('a change made while the file is loading is written once the load is ready, without another setPref (review finding 1)', async () => {
		let release: (value: unknown) => void = () => undefined;
		const { prefs, clock, writes } = make({
			'fsStat': () => ({ exists: true }),
			'fsReadJson': () => new Promise((resolve) => { release = resolve; }),
		});
		const loading = prefs.load();
		await settle();
		prefs.setPref('a', 1);
		release(file({ stored: true }));
		assert.equal(await loading, 'ready');
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.equal(writes.length, 1);
		assert.deepEqual(ownPrefs(writes[0]), { stored: true, a: 1 });
	});

	it('a change made before load() is queued and applied over the loaded file (CE-5)', async () => {
		const { prefs, clock, writes } = make({
			'fsStat': () => ({ exists: true }),
			'fsReadJson': () => file({ stored: 1, early: 'old' }),
		});
		prefs.setPref('early', true);
		await prefs.load();
		assert.equal(prefs.getPref('early'), true, 'the queued change wins over the stored value');
		assert.equal(prefs.getPref('stored'), 1);
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await settle();
		assert.deepEqual(ownPrefs(writes[0]), { stored: 1, early: true });
	});

	it('a transient load failure is retried; a first run never ends up session-only (engine fs_stat: {exists:false} for a missing file or folder)', async () => {
		let failures = 1;
		const { prefs, clock } = make({
			'fsStat': () => {
				if (failures > 0) { failures -= 1; throw new Error("Op 'fsStat' timed out after 15000ms"); }
				return { exists: false };
			},
		});
		const loading = prefs.load();
		await clock.advance(60_000);
		assert.equal(await loading, 'ready');
		const stuck = make({ 'fsStat': () => { throw new Error('Not connected to server'); } });
		const stuckLoading = stuck.prefs.load();
		await stuck.clock.advance(5 * 60_000);
		assert.equal(await stuckLoading, 'failed');
		assert.equal(stuck.requests.filter((r) => r.op === 'fsStat').length, PREFS_LOAD_ATTEMPTS, 'bounded');
	});

	it('the file cap measures what the SDK writes: pretty JSON with two-space indents (client.ts fsWriteJson)', async () => {
		const value = { k1: [entry('e1', 1)] };
		const compact = JSON.stringify(file({ 'graph.history': value })).length;
		const { prefs, writes } = make({ 'fsStat': () => ({ exists: false }) }, { maxFileChars: compact + 40 });
		await prefs.load();
		prefs.setPref('graph.history', value);
		await prefs.flush();
		assert.equal(writes.length, 0, 'the indented file is over the cap although the compact one is not');
	});

	it('close() works when taken off the object', async () => {
		const { prefs, writes } = make({ 'fsStat': () => ({ exists: false }) });
		await prefs.load();
		prefs.setPref('k', 1);
		const { close } = prefs;
		await close();
		assert.equal(writes.length, 1);
	});
});

describe('createFsPrefs — the owner is re-checked after every file request', () => {
	const B = 'user-b|org-1|team-1';

	/**
	 * An adapter whose fsMkdir is held until released, over a first-run store.
	 *
	 * @param ownerNow - Who is signed in now.
	 * @returns The adapter, its clock, the release and the request log.
	 */
	function heldMkdir(ownerNow: () => string | null) {
		let release: () => void = () => undefined;
		let mkdirs = 0;
		const writes: unknown[] = [];
		const { fs, requests } = fakeFs({
			'fsStat': () => ({ exists: false }),
			'fsMkdir': () => { mkdirs += 1; return new Promise<void>((resolve) => { release = resolve; }); },
			'fsWriteJson': (params) => { writes.push(params.value); },
		});
		const { clock, opts } = options(fs, { ownerNow });
		return { prefs: createFsPrefs(opts), clock, writes, requests, release: () => release(), mkdirs: () => mkdirs };
	}

	it('mkdir in flight, then nobody is vouched for: nothing is sent until the owner is back, then exactly one write', async () => {
		let current: string | null = OWNER;
		const r = heldMkdir(() => current);
		await r.prefs.load();
		r.prefs.setPref('k', 'a-run');
		await r.clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		assert.equal(r.mkdirs(), 1, 'the first write is waiting on its mkdir');
		current = null;
		r.release();
		await r.clock.advance(60_000);
		await settle();
		assert.equal(r.writes.length, 0, 'nothing sent while unknown');
		current = OWNER;
		await r.clock.advance(60_000);
		await settle();
		assert.equal(r.writes.length, 1);
		assert.deepEqual((r.writes[0] as { owners: Record<string, { prefs: unknown }> }).owners[OWNER].prefs, { k: 'a-run' });
	});

	it('mkdir in flight, then another account: nothing is ever sent', async () => {
		let current: string | null = OWNER;
		const r = heldMkdir(() => current);
		await r.prefs.load();
		r.prefs.setPref('k', 'a-run');
		await r.clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		current = B;
		r.release();
		await r.clock.advance(30 * 60_000);
		await r.prefs.flush();
		await r.prefs.close();
		assert.equal(r.writes.length, 0);
		assert.equal(r.requests.some((q) => q.op === 'fsWriteJson'), false);
	});

	it('mkdir in flight, then dispose(): nothing is sent', async () => {
		const r = heldMkdir(() => OWNER);
		await r.prefs.load();
		r.prefs.setPref('k', 'a-run');
		await r.clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		r.prefs.dispose();
		r.release();
		await r.clock.advance(30 * 60_000);
		await settle();
		assert.equal(r.writes.length, 0);
	});

	it('a read that answers after the owner changed is discarded: another account stops the load, a return of the same owner reads again', async () => {
		for (const next of [B, null]) {
			let current: string | null = OWNER;
			const reads: Array<(value: unknown) => void> = [];
			const { fs, requests } = fakeFs({
				'fsStat': () => ({ exists: true }),
				'fsReadJson': () => new Promise((resolve) => { reads.push(resolve); }),
			});
			const { clock, opts } = options(fs, { ownerNow: () => current });
			const prefs = createFsPrefs(opts);
			const loading = prefs.load();
			await settle();
			assert.equal(reads.length, 1);
			current = next;
			reads[0](file({ secret: 'read while the owner was not signed in' }));
			await settle();
			if (next === B) {
				assert.equal(await loading, 'failed', 'another account: the load stops');
				assert.equal(prefs.getPref('secret'), undefined, 'and keeps nothing it read');
				continue;
			}
			assert.equal(prefs.status(), 'loading', 'unknown: the result is discarded and the load waits');
			assert.equal(prefs.getPref('secret'), undefined);
			current = OWNER;
			await clock.advance(5_000);
			assert.equal(reads.length, 2, 'read again once the owner is back');
			reads[1](file({ fresh: true }));
			assert.equal(await loading, 'ready');
			assert.equal(prefs.getPref('fresh'), true);
			assert.equal(prefs.getPref('secret'), undefined);
			assert.equal(requests.filter((q) => q.op === 'fsStat').length, 2);
		}
	});

	it('no fs request, first or retry, while nobody is vouched for', async () => {
		let current: string | null = null;
		let failures = 1;
		const { fs, requests } = fakeFs({
			'fsStat': () => {
				if (failures > 0) { failures -= 1; throw new Error('Not connected to server'); }
				return { exists: false };
			},
		});
		const { clock, opts } = options(fs, { ownerNow: () => current });
		const prefs = createFsPrefs(opts);
		const loading = prefs.load();
		await clock.advance(10_000);
		assert.equal(requests.length, 0, 'nothing before the owner is known');
		current = OWNER;
		await clock.advance(1_000);
		assert.equal(requests.length, 1, 'the first attempt, which fails');
		current = null;
		await clock.advance(60_000);
		assert.equal(requests.length, 1, 'no retry while unknown');
		current = OWNER;
		await clock.advance(5_000);
		assert.equal(requests.length, 2);
		assert.equal(await loading, 'ready');
	});
});

describe('createFsPrefs — nothing the module does not understand is ever erased (DA-R1-02)', () => {
	/** A store holding `stored`, recording what is written. */
	function storeOf(stored: unknown) {
		let file: unknown = JSON.parse(JSON.stringify(stored));
		const writes: unknown[] = [];
		const fs: IPrefsFs = {
			fsStat: async () => ({ exists: true, type: 'file' }),
			fsReadJson: async <T,>() => JSON.parse(JSON.stringify(file)) as T,
			fsMkdir: async () => undefined,
			fsWriteJson: async (_path: string, obj: unknown) => { writes.push(obj); file = JSON.parse(JSON.stringify(obj)); },
		};
		return { fs, writes, stored: () => file as { version: number; owners: Record<string, unknown>; [key: string]: unknown } };
	}

	it('another owner\'s malformed entry, a well-formed one this module would normalise, and an unknown top-level field all survive another owner\'s write, unchanged in STORAGE', async () => {
		const original = {
			version: PREFS_FILE_VERSION,
			note: 'written by a newer client',
			newer: { nested: [1, 2, { three: 3 }] },
			owners: {
				'team-B': { at: 5, prefs: ['legacy', 'array', 'form'] },
				'team-C': { at: 6, prefs: { k: 'kept' } },
				'team-D': { prefs: { noAt: true }, flag: 'extra field on an entry' },
				'team-E': 'not even an object',
			},
		};
		const { fs, stored } = storeOf(original);
		const { clock, opts } = options(fs, { owner: 'team-A' });
		const prefs = createFsPrefs(opts);
		assert.equal(await prefs.load(), 'ready');
		prefs.setPref('history', { q: 1 });
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await prefs.flush();
		await settle();
		const after = stored();
		assert.equal(after.note, original.note);
		assert.deepEqual(after.newer, original.newer);
		for (const id of ['team-B', 'team-C', 'team-D', 'team-E']) assert.deepEqual(after.owners[id], (original.owners as Record<string, unknown>)[id], `${id} is exactly as stored`);
		assert.deepEqual((after.owners['team-A'] as { prefs: unknown }).prefs, { history: { q: 1 } });
		assert.equal(after.version, PREFS_FILE_VERSION);
	});

	it('an entry of THIS owner that is not a bag is never overwritten: the session stays in memory and nothing is written', async () => {
		const original = { version: PREFS_FILE_VERSION, owners: { [OWNER]: ['old', 'format'], other: { at: 1, prefs: { a: 1 } } } };
		const { fs, writes, stored } = storeOf(original);
		const errors: string[] = [];
		const { clock, opts } = options(fs, { onError: (_error, phase) => errors.push(phase) });
		const prefs = createFsPrefs(opts);
		assert.equal(await prefs.load(), 'failed');
		prefs.setPref('history', { q: 1 });
		await prefs.flush();
		await clock.advance(60_000);
		assert.deepEqual(writes, []);
		assert.deepEqual(stored(), original);
		assert.deepEqual(errors, ['load']);
	});

	it('the owner cap trims only well-formed bags: a malformed entry is never the one dropped', async () => {
		const owners: Record<string, unknown> = { junk: 42 };
		for (let i = 0; i < 6; i += 1) owners[`o${i}`] = { at: i + 1, prefs: { i } };
		const { fs, stored } = storeOf({ version: PREFS_FILE_VERSION, owners });
		const { clock, opts } = options(fs, { maxOwners: 4 });
		const prefs = createFsPrefs(opts);
		await prefs.load();
		prefs.setPref('k', 1);
		await clock.advance(PREFS_WRITE_DEBOUNCE_MS);
		await prefs.flush();
		await settle();
		const ids = Object.keys(stored().owners);
		assert.ok(ids.includes('junk'), 'the malformed entry is carried');
		assert.ok(ids.includes(OWNER));
		assert.ok(!ids.includes('o0') && ids.includes('o5'), 'the least recently written well-formed bags went');
	});
});
