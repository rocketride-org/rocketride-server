// MIT License
//
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
// UNDO TESTS — the latest turn's file changes, put back or refused
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatMessage } from 'shell';
import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import type { IVirtualFileSystem } from 'shell/src/modules/explorer/types';

import { StagedFileSystem } from '../vfs/stagedFileSystem';
import type { AgentHost } from './host';
import { BUILDER_PROMPTS } from './prompts';
import { runAgent } from './run';
import { FilesystemTools } from './toolkits/filesystem';
import { UNDO_MAX_BYTES, UNDO_ROW, type UndoRecord } from './toolkits/undo';
import { undoParts } from './turn';
import type { ModelCall, QuestionSpec } from './wave/plan';

// =============================================================================
// HELPERS
// =============================================================================

/** A store backend in memory. It logs every change the server takes, and can hold or fail a write. */
interface MemoryBackend extends IVirtualFileSystem {
	/** Every file, path to content. A test may edit it directly, as a teammate would. */
	files: Map<string, string>;
	/** Every change the server took, in order. */
	log: string[];
	/** Paths whose next write fails. */
	failing: Set<string>;
	/** Writes of a path wait for this before they land. */
	holds: Map<string, Promise<void>>;
	/** Reads of a path wait for this before they answer. */
	readHolds: Map<string, Promise<void>>;
	/** Paths whose reads fail as a dropped connection does, not as a missing file. */
	readFailing: Set<string>;
}

/** The backend. */
function memoryBackend(seed: Record<string, string>): MemoryBackend {
	const files = new Map(Object.entries(seed));
	const log: string[] = [];
	const failing = new Set<string>();
	const holds = new Map<string, Promise<void>>();
	const readHolds = new Map<string, Promise<void>>();
	const readFailing = new Set<string>();
	return {
		files,
		log,
		failing,
		holds,
		readHolds,
		readFailing,
		list: async (dir) => {
			const prefix = dir ? `${dir}/` : '';
			const names = new Map<string, 'file' | 'dir'>();
			for (const path of files.keys()) {
				if (!path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				names.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file');
			}
			return [...names].map(([name, type]) => ({ name, type }));
		},
		read: async (path) => {
			await readHolds.get(path);
			if (readFailing.has(path)) throw new Error('socket closed');
			if (!files.has(path)) throw new Error(`No such file: ${path}`);
			return files.get(path);
		},
		write: async (path, content) => {
			await holds.get(path);
			if (failing.delete(path)) throw new Error('disk full');
			log.push(`write ${path}`);
			files.set(path, String(content));
		},
		rename: async (from, to) => {
			log.push(`rename ${from} ${to}`);
			for (const [path, content] of [...files]) {
				if (path !== from && !path.startsWith(`${from}/`)) continue;
				files.delete(path);
				files.set(to + path.slice(from.length), content);
			}
		},
		delete: async (path) => {
			log.push(`delete ${path}`);
			for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
		},
		mkdir: async () => undefined,
	};
}

/** The real view over the backend: auto writes through, manual stages. */
function workspace(seed: Record<string, string>, mode: 'auto' | 'manual'): { backend: MemoryBackend; vfs: StagedFileSystem } {
	const backend = memoryBackend(seed);
	return { backend, vfs: new StagedFileSystem(new CachedVfs(backend), null, { writeThrough: mode === 'auto' }) };
}

/** The agent's file tools over a view, as one run has them, with their Undo record. */
function agentTools(vfs: StagedFileSystem): { record: UndoRecord; tool: (name: string, args: Record<string, unknown>) => Promise<string> } {
	const files = new FilesystemTools(vfs);
	const tools = files.tools();
	return {
		record: files.undo,
		// a delete's approval is the loop's; these tests let it through
		tool: async (name, args) => (await (tools.find((t) => t.name === name) ?? assert.fail(name)).prepare(args)).run(),
	};
}

/** What the view serves for a path, or null when nothing. */
async function shown(vfs: StagedFileSystem, path: string): Promise<string | null> {
	try {
		return String(await vfs.read(path));
	} catch {
		return null;
	}
}

/**
 * One turn of changes over a.txt, d.txt and r.txt: a.txt edited, c.txt
 * created, d.txt deleted, r.txt renamed to s.txt.
 */
async function changeEach(tool: (name: string, args: Record<string, unknown>) => Promise<string>): Promise<void> {
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	await tool('write_file', { path: 'c.txt', content: 'gamma' });
	await tool('delete_file', { path: 'd.txt' });
	await tool('rename', { oldPath: 'r.txt', newPath: 's.txt' });
}

/** The seed every per-kind test starts from. */
const SEED = { 'a.txt': 'alpha', 'd.txt': 'delta', 'r.txt': 'rho' };

// =============================================================================
// EACH KIND OF CHANGE
// =============================================================================

test('auto: Undo puts back a modified, a created, a deleted and a renamed file on the server', async () => {
	const { backend, vfs } = workspace(SEED, 'auto');
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA', 'c.txt': 'gamma', 's.txt': 'rho' });
	assert.equal(record.state(), 'ready');
	const outcome = await record.undo();
	assert.equal(outcome.kind, 'undone');
	assert.equal(outcome.text, `${UNDO_ROW}the user reversed the file changes of the turn before, so these files are back as they were before it: a.txt, c.txt, d.txt, r.txt and s.txt.`);
	assert.deepEqual(Object.fromEntries([...backend.files].sort()), { 'a.txt': 'alpha', 'd.txt': 'delta', 'r.txt': 'rho' });
	assert.deepEqual({ a: await shown(vfs, 'a.txt'), c: await shown(vfs, 'c.txt'), s: await shown(vfs, 's.txt') }, { a: 'alpha', c: null, s: null });
	assert.deepEqual(record.state(), { unavailable: 'this turn was undone' }, 'one level: nothing more to undo');
});

test('manual: Undo drops what the turn staged, writes nothing to the server, and leaves nothing pending', async () => {
	const { backend, vfs } = workspace(SEED, 'manual');
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	assert.deepEqual(Object.fromEntries(vfs.changedPaths()), { 'a.txt': 'modified', 'c.txt': 'added', 'd.txt': 'deleted', 'r.txt': 'deleted', 's.txt': 'added' });
	assert.equal((await record.undo()).kind, 'undone');
	assert.equal(vfs.hasPendingChanges(), false, 'no staged entry, tombstones included');
	assert.deepEqual(
		vfs.getLayers().map((layer) => [...layer.entries.keys()]),
		[[]]
	);
	assert.deepEqual(backend.log, [], 'the server was never written');
	assert.deepEqual({ a: await shown(vfs, 'a.txt'), c: await shown(vfs, 'c.txt'), d: await shown(vfs, 'd.txt'), r: await shown(vfs, 'r.txt'), s: await shown(vfs, 's.txt') }, { a: 'alpha', c: null, d: 'delta', r: 'rho', s: null });
});

test('manual: the server holds A, the agent stages B, and Undo restores the earlier staged state from the staged content, without the server', async () => {
	// step: nothing staged before the turn: Undo leaves nothing staged
	const plain = workspace({ 'p.txt': 'A' }, 'manual');
	const first = agentTools(plain.vfs);
	await first.tool('read_file', { path: 'p.txt' });
	await first.tool('write_file', { path: 'p.txt', content: 'B' });
	assert.equal((await first.record.undo()).kind, 'undone', 'the check read the staged B, not the server A');
	assert.deepEqual({ shown: await shown(plain.vfs, 'p.txt'), pending: plain.vfs.hasPendingChanges(), log: plain.backend.log }, { shown: 'A', pending: false, log: [] });

	// step: the user staged A1 before the turn: Undo brings A1 back, still staged
	const staged = workspace({ 'p.txt': 'A' }, 'manual');
	await staged.vfs.write('p.txt', 'A1', 'editor');
	const second = agentTools(staged.vfs);
	await second.tool('read_file', { path: 'p.txt' });
	await second.tool('write_file', { path: 'p.txt', content: 'B' });
	assert.equal((await second.record.undo()).kind, 'undone');
	assert.deepEqual({ shown: await shown(staged.vfs, 'p.txt'), staged: staged.vfs.changedPaths().get('p.txt'), server: staged.backend.files.get('p.txt'), log: staged.backend.log }, { shown: 'A1', staged: 'modified', server: 'A', log: [] });
});

test('manual: a file the agent created and that was committed since is checked on the server, and its removal is staged as a delete', async () => {
	const { backend, vfs } = workspace({}, 'manual');
	const { record, tool } = agentTools(vfs);
	await tool('write_file', { path: 'n.txt', content: 'new' });
	await vfs.commit();
	assert.equal(backend.files.get('n.txt'), 'new');
	assert.equal((await record.undo()).kind, 'undone');
	assert.deepEqual({ shown: await shown(vfs, 'n.txt'), staged: vfs.changedPaths().get('n.txt'), server: backend.files.get('n.txt') }, { shown: null, staged: 'deleted', server: 'new' });
});

// =============================================================================
// REFUSALS — every path is checked before any is put back
// =============================================================================

test('an editor with unsaved changes on any path refuses the whole Undo, and names it', async () => {
	const { backend, vfs } = workspace(SEED, 'auto');
	const { record, tool } = agentTools(vfs);
	await changeEach(tool);
	vfs.registerOverlay('a.txt', { getContent: () => 'ALPHA, and typing', isDirty: () => true });
	const outcome = await record.undo();
	assert.deepEqual(outcome, { kind: 'refused', text: 'Undo refused, nothing was changed: a.txt has unsaved changes in an editor.' });
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA', 'c.txt': 'gamma', 's.txt': 'rho' }, 'no other path was put back either');
	assert.equal(record.state(), 'ready', 'a refused Undo can be tried again');
});

test('a path that moved on since the turn refuses the Undo', async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	await vfs.write('a.txt', 'ALPHA, saved by the user', 'editor');
	assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: a.txt changed since the turn.' });
	assert.equal(backend.files.get('a.txt'), 'ALPHA, saved by the user');
});

test("a change by someone else between two of the agent's changes refuses the Undo, though the path is at the agent's version", async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'one two' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'one', newString: 'ONE' });
	await vfs.write('a.txt', 'ONE two three', 'editor');
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'two', newString: 'TWO' });
	assert.equal(backend.files.get('a.txt'), 'ONE TWO three');
	assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: a.txt was changed by someone else during the turn.' });
	assert.equal(backend.files.get('a.txt'), 'ONE TWO three', "the user's three stays");
});

test("auto: a teammate's server edit to a file the agent created refuses the Undo: the check reads the server afresh", async () => {
	const { backend, vfs } = workspace({}, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('write_file', { path: 'c.txt', content: 'gamma' });
	// step: another browser writes the server copy; this page counts no version for it
	backend.files.set('c.txt', 'gamma, and a teammate');
	assert.equal(vfs.version('c.txt'), 1);
	assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: c.txt changed on the server since the turn.' });
	assert.equal(backend.files.get('c.txt'), 'gamma, and a teammate', "the teammate's file is not deleted");
});

test("auto: Undo of a delete puts back what the server held when the agent deleted it; a teammate's edit after the agent's own change refuses the delete", async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	// step: an editor tab read a.txt, not the agent, so the delete names no copy; another browser then writes the server copy, and this page's cached copy is still alpha
	await vfs.read('a.txt');
	backend.files.set('a.txt', 'alpha, and a teammate');
	await tool('delete_file', { path: 'a.txt' });
	assert.equal((await record.undo()).kind, 'undone');
	assert.equal(backend.files.get('a.txt'), 'alpha, and a teammate', "the teammate's copy, which the delete removed, comes back");

	// step: the agent changed b.txt and a teammate changed it on the server: the delete is refused, so their change stays, and Undo of the edit is refused too
	const second = workspace({ 'b.txt': 'beta' }, 'auto');
	const agent = agentTools(second.vfs);
	await agent.tool('read_file', { path: 'b.txt' });
	await agent.tool('edit_file', { path: 'b.txt', oldString: 'beta', newString: 'BETA' });
	second.backend.files.set('b.txt', 'BETA, and a teammate');
	await assert.rejects(agent.tool('delete_file', { path: 'b.txt' }), /^RefusedError: delete_file refused: b\.txt changed since you read it\./);
	assert.deepEqual(await agent.record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: b.txt changed since the turn.' });
	assert.equal(second.backend.files.get('b.txt'), 'BETA, and a teammate', 'nothing was written back');
});

test("a teammate's edit the agent read again before its next change still refuses the Undo, whichever tool changed it next", async () => {
	type Tool = (name: string, args: Record<string, unknown>) => Promise<string>;
	const changes: Array<[string, (tool: Tool) => Promise<unknown>]> = [
		['delete_file', (tool) => tool('delete_file', { path: 'b.txt' })],
		['edit_file', (tool) => tool('edit_file', { path: 'b.txt', oldString: 'teammate', newString: 'TEAMMATE' })],
	];
	for (const [name, change] of changes) {
		const { backend, vfs } = workspace({ 'b.txt': 'beta' }, 'auto');
		const { record, tool } = agentTools(vfs);
		await tool('read_file', { path: 'b.txt' });
		await tool('edit_file', { path: 'b.txt', oldString: 'beta', newString: 'BETA' });
		// step: a teammate writes the server copy, the page drops its cached copy, and the agent reads the teammate's
		backend.files.set('b.txt', 'BETA, and a teammate');
		vfs.invalidate('b.txt');
		await tool('read_file', { path: 'b.txt' });
		await change(tool);
		const after = backend.files.get('b.txt');
		assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: b.txt was changed by someone else during the turn.' }, name);
		assert.equal(backend.files.get('b.txt'), after, `${name}: beta is not written over the teammate's edit`);
	}
});

test('a check read that fails for any reason but a missing file refuses the whole Undo, and names the path', async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha', 'd.txt': 'delta' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	await tool('delete_file', { path: 'd.txt' });
	// step: the server cannot be reached for d.txt, so nothing proves it is still absent
	backend.readFailing.add('d.txt');
	assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: d.txt could not be checked (socket closed).' });
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA' }, 'no other path was put back either');
	assert.equal(record.state(), 'ready', 'a refused Undo can be tried again');
});

test('an editor that turns dirty while Undo reads the server refuses it: the editors and versions are checked again just before the inverses', async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	let release!: () => void;
	backend.readHolds.set('a.txt', new Promise((resolve) => (release = resolve)));
	const undoing = record.undo();
	// step: the user starts typing while Undo waits for the server's copy
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	vfs.registerOverlay('a.txt', { getContent: () => 'ALPHA and typing', isDirty: () => true });
	release();
	assert.deepEqual(await undoing, { kind: 'refused', text: 'Undo refused, nothing was changed: a.txt has unsaved changes in an editor.' });
	assert.equal(backend.files.get('a.txt'), 'ALPHA', 'nothing was written behind the typing');
});

// =============================================================================
// FAILURE PART WAY, SETTLED WRITES, AND THE CAP
// =============================================================================

test('an I/O failure part way is reported as it is: what was reversed and what was not', async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	await tool('write_file', { path: 'c.txt', content: 'gamma' });
	backend.failing.add('a.txt');
	const outcome = await record.undo();
	assert.deepEqual(outcome, { kind: 'partial', text: `${UNDO_ROW}reversing the file changes of the turn before stopped part way. Reversed: c.txt. Not reversed: a.txt (disk full).` });
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'ALPHA' });
});

test('Undo waits until every change of the turn has ended, a call that timed out included', async () => {
	const { backend, vfs } = workspace({ 'a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'a.txt' });
	await tool('edit_file', { path: 'a.txt', oldString: 'alpha', newString: 'ALPHA' });
	let release!: () => void;
	backend.holds.set('slow.txt', new Promise((resolve) => (release = resolve)));
	// step: the loop gave up on this call, and the turn ended; the write still runs
	const late = tool('write_file', { path: 'slow.txt', content: 'late' });
	for (let i = 0; i < 100 && record.settled; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(record.state(), 'waiting');
	assert.deepEqual(undoParts('waiting').actions, [{ id: 'undo', label: 'Undo', disabled: true }]);
	assert.deepEqual(await record.undo(), { kind: 'refused', text: 'Undo refused, nothing was changed: a change of the turn is still running.' });
	let heard = 0;
	record.onSettled(() => heard++);
	release();
	await late;
	assert.deepEqual({ state: record.state(), heard }, { state: 'ready', heard: 1 });
	assert.equal((await record.undo()).kind, 'undone');
	assert.deepEqual(Object.fromEntries(backend.files), { 'a.txt': 'alpha' }, 'the late write is undone too');
});

test('a turn that changed more than 4 MB of files cannot be undone, and the card says so', async () => {
	const big = (tag: string, mb: number): string => `${'x'.repeat(mb * 1024 * 1024)}${tag}`;
	const { vfs } = workspace({ 'one.txt': big('END1', 3), 'two.txt': big('END2', 2) }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('read_file', { path: 'one.txt' });
	await tool('edit_file', { path: 'one.txt', oldString: 'END1', newString: 'DONE1' });
	assert.equal(record.state(), 'ready', '3 MB is under the cap');
	await tool('read_file', { path: 'two.txt' });
	await tool('edit_file', { path: 'two.txt', oldString: 'END2', newString: 'DONE2' });
	assert.equal(UNDO_MAX_BYTES, 4 * 1024 * 1024);
	assert.deepEqual(record.state(), { unavailable: 'this turn changed more than 4 MB of files' });
	assert.deepEqual(undoParts({ unavailable: 'this turn changed more than 4 MB of files' }), { lines: ['Undo is unavailable: this turn changed more than 4 MB of files.'] });
	assert.equal((await record.undo()).kind, 'refused');
});

test('a turn that deletes a folder cannot be undone', async () => {
	const { vfs } = workspace({ 'dir/a.txt': 'alpha' }, 'auto');
	const { record, tool } = agentTools(vfs);
	await tool('delete_file', { path: 'dir', recursive: true });
	assert.deepEqual(record.state(), { unavailable: 'this turn deleted a folder' });
});

/** A PNG's first bytes as the store's UTF-8 decode returns them: U+FFFD where a byte is not UTF-8, and NUL characters. */
const PNG_TEXT = new TextDecoder().decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x10, 0xff, 0xd8]));

test('a file that is not text, read as the store decodes it, makes the turn one that cannot be undone, whichever tool changed it', async () => {
	type Tool = (name: string, args: Record<string, unknown>) => Promise<string>;
	const changes: Array<[string, (tool: Tool) => Promise<unknown>]> = [
		['delete_file', (tool) => tool('delete_file', { path: 'logo.png' })],
		['rename', (tool) => tool('rename', { oldPath: 'logo.png', newPath: 'old-logo.png' })],
		['write_file', async (tool) => (await tool('read_file', { path: 'logo.png' }), tool('write_file', { path: 'logo.png', content: 'not a picture' }))],
		['edit_file', async (tool) => (await tool('read_file', { path: 'logo.png' }), tool('edit_file', { path: 'logo.png', oldString: 'IHDR', newString: 'IHDX' }))],
	];
	for (const [name, change] of changes) {
		const { vfs } = workspace({ 'logo.png': PNG_TEXT }, 'auto');
		const { record, tool } = agentTools(vfs);
		await change(tool);
		assert.deepEqual(record.state(), { unavailable: 'this turn changed a file that is not text' }, name);
	}
});

// =============================================================================
// THROUGH A RUN — create_app, no undo tool, and the history row
// =============================================================================

/** A model that answers from a script and keeps every question. */
function scriptedModel(replies: string[]): ModelCall & { questions: QuestionSpec[] } {
	const queue = [...replies];
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = queue.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		return next;
	};
	return Object.assign(call, { questions });
}

/**
 * Runs one turn over a view.
 *
 * @param vfs - The view.
 * @param model - The scripted model.
 * @param history - The chat's rows before the turn.
 * @returns The turn and the run's Undo record.
 */
async function turnOver(vfs: StagedFileSystem, model: ModelCall, history: ChatMessage[] = []): Promise<{ undoAvailable?: boolean; record: UndoRecord | null }> {
	const host: AgentHost = { vfs, scaffoldApp: async () => ({ appId: 'daybook', folder: 'daybook-ui' }), packApp: async () => new Uint8Array(), devSession: () => null };
	let record: UndoRecord | null = null;
	const options = { history, prompts: BUILDER_PROMPTS, token: async () => 'tk', signal: new AbortController().signal, takeQueued: () => [], undo: (r: UndoRecord) => (record = r) };
	const turn = await runAgent('Do it.', () => undefined, options, { host, client: () => null, model, markers: async () => null, currentScope: () => '' });
	return { undoAvailable: turn.undoAvailable, record };
}

test('a turn that creates an app cannot be undone, and the model has no undo tool', async () => {
	const { vfs } = workspace({}, 'auto');
	const model = scriptedModel([JSON.stringify({ thought: 'scaffold', tool_calls: [{ tool: 'create_app', args: { appName: 'daybook', displayName: 'Daybook' } }] }), JSON.stringify({ thought: 'done', done: true, answer: 'Made Daybook.' })]);
	const { undoAvailable, record } = await turnOver(vfs, model);
	assert.deepEqual({ undoAvailable, state: record?.state() }, { undoAvailable: false, state: { unavailable: 'this turn created an app' } });
	const tools = model.questions[0].instructions.find((section) => section.title === 'Available Tools')?.text ?? '';
	assert.ok(tools.includes('"name":"write_file"') && !/undo/i.test(tools), 'the catalog lists the tools and none undoes');
});

test('the row an Undo leaves reaches the model in the history; other note rows do not', async () => {
	const { vfs } = workspace({}, 'auto');
	const model = scriptedModel([JSON.stringify({ thought: 'done', done: true, answer: 'OK.' })]);
	const undone = `${UNDO_ROW}the user reversed the file changes of the turn before, so these files are back as they were before it: a.txt.`;
	const rows: ChatMessage[] = [
		{ id: 1, text: 'Change a.txt.', sender: 'user', timestamp: '09:00' },
		{ id: 2, text: 'Changed a.txt.', sender: 'bot', timestamp: '09:00' },
		{ id: 3, text: undone, sender: 'system', timestamp: '09:01' },
		{ id: 4, text: 'Undo refused, nothing was changed: a.txt has unsaved changes in an editor.', sender: 'system', timestamp: '09:01' },
		{ id: 5, text: 'I removed a key from your message.', sender: 'system', timestamp: '09:01' },
	];
	await turnOver(vfs, model, rows);
	assert.deepEqual(model.questions[0].history, [
		{ role: 'user', content: 'Change a.txt.' },
		{ role: 'assistant', content: 'Changed a.txt.' },
		{ role: 'user', content: undone },
	]);
});
