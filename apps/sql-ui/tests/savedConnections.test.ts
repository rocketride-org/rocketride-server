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
// SQL-UI — THE SAVED-CONNECTION LIST'S LOAD GUARD (develop's #2625 rules)
// =============================================================================
//
// What keeps a transient failure from wiping the stored connections:
//
//   - the persistence writer is installed only after a PROVEN load;
//   - only a proven-missing file ("File not found") is a first run;
//   - an outdated in-flight load never wins (loadSeq);
//   - a plain reset is skipped while listeners still render the list;
//   - an upsert that races the load queues and applies on top of it.
// =============================================================================

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	getSavedConnections,
	getSavedConnectionsLoadProblem,
	getSavedConnectionsStatus,
	loadSavedConnections,
	resetSavedConnections,
	subscribeSavedConnections,
	upsertSavedConnection,
} from '../src/connect';
import type { SavedConnectionsFs, SavedSqlConnection } from '../src/connect';

const ONE: SavedSqlConnection = { id: 'c1', mode: 'pipeline', name: 'One', projectId: 'p1', pipelineName: 'A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };
const TWO: SavedSqlConnection = { ...ONE, id: 'c2', name: 'Two' };

/** A fake user store; `read` decides each read's answer. */
function fakeFs(read: () => Promise<unknown> | unknown): { fs: SavedConnectionsFs; writes: unknown[] } {
	const writes: unknown[] = [];
	const fs: SavedConnectionsFs = {
		fsMkdir: async () => undefined,
		fsReadJson: async () => read(),
		fsWriteJson: async (_path, value) => { writes.push(value); },
	};
	return { fs, writes };
}

afterEach(() => resetSavedConnections({ force: true }));

describe('loadSavedConnections: a failed read never installs the writer', () => {
	it('a transport error leaves the list idle and unwritable: a later upsert writes nothing', async () => {
		const { fs, writes } = fakeFs(() => { throw new Error('socket closed'); });
		await loadSavedConnections(fs);
		assert.equal(getSavedConnectionsStatus(), 'idle');
		upsertSavedConnection(ONE);
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		assert.deepEqual(writes, [], 'the empty-based list was not persisted over the stored one');
	});

	it('a malformed-JSON error is not a first run either', async () => {
		const { fs, writes } = fakeFs(() => { throw new SyntaxError('Unexpected token } in JSON'); });
		await loadSavedConnections(fs);
		assert.equal(getSavedConnectionsStatus(), 'idle');
		assert.deepEqual(writes, []);
	});

	it('a proven-missing file ("File not found") is the first run: the list is ready, empty, and writable', async () => {
		const { fs, writes } = fakeFs(() => { throw new Error('File not found: .workspace/rocketride.sql.json'); });
		await loadSavedConnections(fs);
		assert.equal(getSavedConnectionsStatus(), 'ready');
		upsertSavedConnection(ONE);
		assert.deepEqual(writes, [[ONE]]);
	});

	it('a deadline timeout is not "file not found": the request may still complete, so nothing is installed', async () => {
		const { fs, writes } = fakeFs(() => { throw Object.assign(new Error("'fsReadJson' did not answer within 15s; the request was not cancelled and may still complete."), { kind: 'timeout' }); });
		await loadSavedConnections(fs);
		assert.equal(getSavedConnectionsStatus(), 'idle');
		assert.deepEqual(writes, []);
	});
});

describe('loadSavedConnections: a file that parses but is not a list is unreadable, never replaced (D6-SQL-2)', () => {
	/** A user store holding one file; every write replaces it (as the real store does). */
	function store(initial: unknown): { fs: SavedConnectionsFs; content: () => unknown; writes: number } {
		const state = { content: initial, writes: 0 };
		const fs: SavedConnectionsFs = {
			fsMkdir: async () => undefined,
			fsReadJson: async () => JSON.parse(JSON.stringify(state.content)),
			fsWriteJson: async (_path, value) => { state.content = value; state.writes += 1; },
		};
		return { fs, content: () => state.content, get writes() { return state.writes; } };
	}

	for (const [what, stored] of [
		['a versioned object', { version: 2, connections: [ONE, TWO] }],
		['a string', 'connections'],
		['a number', 7],
		['null', null],
	] as Array<[string, unknown]>) {
		it(`${what}: no writer, a surfaced reason, and the stored file is untouched after a save`, async () => {
			const original = JSON.parse(JSON.stringify(stored));
			const s = store(stored);
			await loadSavedConnections(s.fs);
			assert.equal(getSavedConnectionsStatus(), 'idle', 'the list is not ready');
			assert.match(getSavedConnectionsLoadProblem() ?? '', /not a list of connections|format/i, 'the reason is surfaced');
			upsertSavedConnection({ ...ONE, id: 'c-new', name: 'New' });
			await new Promise<void>((resolve) => { setImmediate(resolve); });
			assert.equal(s.writes, 0, 'nothing was written');
			assert.deepEqual(s.content(), original, 'the stored file is exactly what it was');
		});
	}

	it('a real list still loads, and clears an earlier problem', async () => {
		await loadSavedConnections(store({ not: 'a list' }).fs);
		assert.ok(getSavedConnectionsLoadProblem() !== null);
		await loadSavedConnections(store([ONE]).fs);
		assert.equal(getSavedConnectionsStatus(), 'ready');
		assert.equal(getSavedConnectionsLoadProblem(), null);
	});
});

describe('loadSavedConnections: ordering', () => {
	it('an outdated load never wins over a newer one', async () => {
		let release: (value: unknown) => void = () => undefined;
		const slow = fakeFs(() => new Promise((resolve) => { release = resolve; }));
		const first = loadSavedConnections(slow.fs);
		const fast = fakeFs(() => [TWO]);
		await loadSavedConnections(fast.fs);
		assert.deepEqual(getSavedConnections(), [TWO]);
		release([ONE]);
		await first;
		assert.deepEqual(getSavedConnections(), [TWO], 'the slow, older read was dropped');
	});

	it('an upsert that races the load queues and lands on top of the loaded list', async () => {
		let release: (value: unknown) => void = () => undefined;
		const { fs, writes } = fakeFs(() => new Promise((resolve) => { release = resolve; }));
		const loading = loadSavedConnections(fs);
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		upsertSavedConnection(TWO);
		assert.deepEqual(writes, [], 'nothing is written while the load is in flight');
		release([ONE]);
		await loading;
		assert.deepEqual(getSavedConnections().map((c) => c.id), ['c1', 'c2']);
		assert.deepEqual((writes.at(-1) as unknown as SavedSqlConnection[]).map((c) => c.id), ['c1', 'c2']);
	});
});

describe('resetSavedConnections', () => {
	it('is skipped while a consumer still renders the list, unless forced', async () => {
		await loadSavedConnections(fakeFs(() => [ONE]).fs);
		const off = subscribeSavedConnections(() => undefined);
		resetSavedConnections();
		assert.deepEqual(getSavedConnections(), [ONE], 'a frame unmounting must not empty the sidebar\'s list');
		resetSavedConnections({ force: true });
		assert.deepEqual(getSavedConnections(), []);
		off();
	});
});
