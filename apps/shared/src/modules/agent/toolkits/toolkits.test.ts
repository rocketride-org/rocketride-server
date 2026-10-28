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
// TOOLKIT TESTS — read before edit, no overwriting unsaved editor changes, the save race,
// the file tracker, read-only guides, the user says yes first, the RocketRide client tool,
// secrets stay out of the model, deploy_app keeps its version, check_app, and a run that deletes a file
// =============================================================================

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';
import type { ChatMessage } from 'shell';
import { TurnController } from 'shell/src/components/chat/turns/turnController';
import type { ChatAskAnswer, ChatAskCard, ChatAsking, ChatTurn, TextResult } from 'shell/src/components/chat/types';

import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';
import type { IVirtualFileSystem } from 'shell/src/modules/explorer/types';

import type { ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import { docsPathFor, isReferencePath } from '../../vfs/referenceTree';
import { StaleVersionError, StagedFileSystem } from '../../vfs/stagedFileSystem';
import type { IWorkspaceFileSystem, VfsEntry } from '../../vfs/vfsTypes';
import { AgentSession } from '../agent';
import { otherDialogOpen, queueChoices } from '../choice';
import { setAgentHost, type AgentDevSession, type AgentHost, type ApprovalPrefs, type ApprovalSettings, type EditorControl, type Grant } from '../host';
import { BUILDER_PROMPTS } from '../prompts';
import { runAgent } from '../run';
import type { AgentTool } from '../tools';
import { TOOL_TIMEOUT_MS } from '../wave/loop';
import type { ModelCall, QuestionSpec } from '../wave/plan';
import { AppCheckToolkit, type AppCheckOptions, type CheckReport, type MarkerInfo, type MarkerSource } from './appCheck';
import { Approvals } from './approval';
import { AppToolkit } from './appTools';
import { clip, isSecretName, looksLikeCredential, NOT_CONNECTED_MESSAGE, redactText, RESULT_MAX_CHARS, toolText, type ChoiceFn, type ClientGetter, type UnsavedChoice } from './common';
import { FileTracker } from './fileTracker';
import { FilesystemTools } from './filesystem';
import { SecretMarkers } from './secretMarkers';
import { RocketRideClientToolkit } from './rocketrideClient';

// =============================================================================
// MEMORY WORKSPACE — an in-memory IWorkspaceFileSystem for these tests
// =============================================================================

/**
 * A fake workspace that keeps text files in a Map. It satisfies the full
 * IWorkspaceFileSystem view contract so tools and checks run against it
 * unchanged, and it records every mutation in `log` for a test to assert on.
 * The cache and subscription methods do nothing, because an in-memory map has
 * no cache to keep warm. Each mutation counts one version of its path, as the
 * staged view's do; a test that edits `files` directly changes content
 * without a version, the way another browser tab would.
 */

/** One recorded mutation. For a rename, `path` is the old path. */
interface MemoryWorkspaceLogEntry {
	/** The operation. */
	op: 'write' | 'rename' | 'delete' | 'mkdir';
	/** The path acted on. */
	path: string;
}

/** The workspace view plus the handles a test uses to set up and inspect it. */
interface MemoryWorkspace extends IWorkspaceFileSystem {
	/** Every file, path to content. Tests may edit it directly. */
	files: Map<string, string>;
	/** Every write, rename, delete and mkdir, in order. */
	log: MemoryWorkspaceLogEntry[];
	/** Counts one mutation of a path without changing it, as a write elsewhere in the page would. */
	bump(path: string, origin?: string): void;
	/** Marks a path dirty (with the buffer reads then see) or clean. */
	setDirty(path: string, dirty: boolean, buffer?: string): void;
}

/** The workspace class; callers get it through createMemoryWorkspace(). */
class InMemoryWorkspace implements MemoryWorkspace {
	readonly files: Map<string, string>;
	readonly log: MemoryWorkspaceLogEntry[] = [];
	/** Folders made with mkdir(); folders that hold files are implied by their paths. */
	private readonly dirs = new Set<string>();
	private readonly dirty: Set<string>;
	/** The unsaved editor buffer of a dirty path, which reads see. */
	private readonly buffers = new Map<string, string>();
	/** Each path's version and last writer. */
	private readonly versions = new Map<string, number>();
	private readonly writers = new Map<string, string>();

	/**
	 * @param files - Starting files, path to content.
	 * @param dirty - Paths that start out dirty.
	 */
	constructor(files: Record<string, string>, dirty: string[]) {
		this.files = new Map(Object.entries(files));
		this.dirty = new Set(dirty);
	}

	// ---- reads ----

	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const base = dir.replace(/\/+$/, '');
		if (base && !this.isDir(base)) throw new Error(`No such directory: ${dir}`);
		const prefix = base ? `${base}/` : '';
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of [...this.files.keys(), ...this.dirs]) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			const isFile = slash < 0 && this.files.has(path);
			names.set(slash < 0 ? rest : rest.slice(0, slash), isFile ? 'file' : 'dir');
		}
		return [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, type]) => ({ name, type }));
	}

	async read(path: string): Promise<unknown> {
		if (this.dirty.has(path) && this.buffers.has(path)) return this.buffers.get(path);
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`No such file: ${path}`);
		return content;
	}

	async readMany(paths: string[]): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		for (const path of paths) {
			const content = this.files.get(path);
			if (content !== undefined) out[path] = content;
		}
		return out;
	}

	async stat(path: string): Promise<'file' | 'dir' | null> {
		return this.entryType(path);
	}

	listEntries(): VfsEntry[] {
		const byPath = new Map<string, 'file' | 'dir'>();
		for (const path of [...this.files.keys(), ...this.dirs]) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) byPath.set(parts.slice(0, i).join('/'), 'dir');
		}
		for (const dir of this.dirs) byPath.set(dir, 'dir');
		for (const file of this.files.keys()) byPath.set(file, 'file');
		return [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, type]) => ({ path, type }));
	}

	entryType(path: string): 'file' | 'dir' | null {
		if (this.files.has(path)) return 'file';
		return this.isDir(path) ? 'dir' : null;
	}

	cachedContent(path: string): unknown {
		return this.files.get(path);
	}

	async peekBase(path: string): Promise<unknown> {
		return this.read(path);
	}

	// ---- path versions ----

	version(path: string): number {
		return this.versions.get(path) ?? 0;
	}

	async readVersioned(path: string): Promise<{ content: unknown; version: number }> {
		const version = this.version(path);
		return { content: await this.read(path), version };
	}

	lastWriter(path: string): string | undefined {
		return this.writers.get(path);
	}

	/** Counts one mutation of a path. */
	bump(path: string, origin?: string): void {
		this.versions.set(path, this.version(path) + 1);
		if (origin) this.writers.set(path, origin);
	}

	// ---- mutations ----

	async write(path: string, content: unknown, origin?: string, expect?: number): Promise<void> {
		if (expect !== undefined && expect !== this.version(path)) throw new StaleVersionError(path, { expected: expect, actual: this.version(path), lastWriter: this.lastWriter(path) });
		if (typeof content !== 'string') throw new Error(`The memory workspace holds text only: ${path}`);
		this.bump(path, origin);
		this.files.set(path, content);
		this.record('write', path);
	}

	async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
		if (this.entryType(oldPath) === null) throw new Error(`No such file or directory: ${oldPath}`);
		this.bump(oldPath, origin);
		this.bump(newPath, origin);
		const move = (path: string) => (path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`);
		for (const path of this.under(oldPath, this.files.keys())) {
			this.files.set(move(path), this.files.get(path) as string);
			this.files.delete(path);
		}
		for (const path of this.under(oldPath, this.dirs)) {
			this.dirs.delete(path);
			this.dirs.add(move(path));
		}
		this.record('rename', oldPath);
	}

	async delete(path: string, origin?: string): Promise<void> {
		if (this.entryType(path) === null) throw new Error(`No such file or directory: ${path}`);
		this.bump(path, origin);
		for (const file of this.under(path, this.files.keys())) this.files.delete(file);
		for (const dir of this.under(path, this.dirs)) this.dirs.delete(dir);
		this.record('delete', path);
	}

	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
		this.record('mkdir', path);
	}

	// ---- dirty state ----

	isDirty(path: string): boolean {
		return this.dirty.has(path);
	}

	/** Marks a path dirty (with the buffer reads then see) or clean, the way an editor overlay flips. */
	setDirty(path: string, dirty: boolean, buffer?: string): void {
		if (dirty) this.dirty.add(path);
		else this.dirty.delete(path);
		if (dirty && buffer !== undefined) this.buffers.set(path, buffer);
		else this.buffers.delete(path);
	}

	dirtyPaths(): Set<string> {
		return new Set(this.dirty);
	}

	// ---- cache and subscription: nothing to keep warm or announce ----

	async refresh(): Promise<void> {}
	upsert(): void {}
	prime(): void {}
	invalidate(): void {}
	registerOverlay(): () => void {
		return () => {};
	}
	subscribe(): () => void {
		return () => {};
	}
	notify(): void {}

	// ---- helpers ----

	/** Whether a path is a folder: made by mkdir(), or the parent of something stored. */
	private isDir(path: string): boolean {
		if (path === '') return true;
		const prefix = `${path}/`;
		return this.dirs.has(path) || [...this.files.keys(), ...this.dirs].some((p) => p.startsWith(prefix));
	}

	/** The paths equal to `root` or inside it, collected up front so callers may mutate the source. */
	private under(root: string, paths: Iterable<string>): string[] {
		const prefix = `${root}/`;
		return [...paths].filter((p) => p === root || p.startsWith(prefix));
	}

	/** Appends a log entry. */
	private record(op: MemoryWorkspaceLogEntry['op'], path: string): void {
		this.log.push({ op, path });
	}
}

/**
 * Builds an in-memory workspace.
 *
 * @param files - Starting files, path to content.
 * @param opts - `dirty` lists paths that start out with unsaved editor changes.
 * @returns The workspace.
 */
function createMemoryWorkspace(files: Record<string, string>, opts?: { dirty?: string[] }): MemoryWorkspace {
	return new InMemoryWorkspace(files, opts?.dirty ?? []);
}

// =============================================================================
// HELPERS
// =============================================================================

/** A tool as these tests call it: prepared, let through, then run, as the loop does. */
interface Callable {
	/** The tool itself. */
	readonly tool: AgentTool;
	/**
	 * Calls the tool.
	 *
	 * @param args - The tool arguments.
	 * @returns The tool result text.
	 */
	execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * A tool, callable the way the loop calls it.
 *
 * @param tool - The tool.
 * @param approvals - Lets a step's act through, as a run's do; without them every act is let through.
 * @returns The tool and its call.
 */
function callable(tool: AgentTool, approvals?: Approvals): Callable {
	return {
		tool,
		execute: async (args) => {
			const step = await tool.prepare(args);
			const work = step.act && approvals ? await approvals.approve(step.act, () => step.run()) : () => step.run();
			return work();
		},
	};
}

/** One toolkit per workspace, so reads carry over between calls the way they do within one run. */
const toolkits = new WeakMap<MemoryWorkspace, FilesystemTools>();

/**
 * Runs one filesystem tool by name against a workspace. Calls on the same
 * workspace share one toolkit, as the tools of one agent run do. The result,
 * and the message of an error, pass through redactText, as every call's
 * outcome does in the agent loop (wave/loop.ts): the model only ever sees
 * them that way.
 *
 * @param ws - The workspace the tools work on.
 * @param tool - The tool name the model would call.
 * @param args - The tool arguments.
 * @returns The tool result text, as the model would see it.
 */
async function run(ws: MemoryWorkspace, tool: string, args: Record<string, unknown>): Promise<string> {
	if (!toolkits.has(ws)) toolkits.set(ws, new FilesystemTools(ws));
	const found = toolkits
		.get(ws)
		?.tools()
		.find((t) => t.name === tool);
	if (!found) throw new Error(`No such tool: ${tool}`);
	try {
		return redactText(await callable(found).execute(args));
	} catch (error) {
		// step: the error keeps its name, since a RefusedError tells the loop the call changed nothing
		const redacted = new Error(redactText((error as Error).message));
		redacted.name = (error as Error).name;
		throw redacted;
	}
}

/** One row of an app's version rail, as `listDeployments` returns it. */
interface Row {
	registryVersion: number;
	buildStatus: string;
	state: string;
}

/** A version row: built and private unless told otherwise. */
function row(registryVersion: number, buildStatus = 'ok', state = 'private'): Row {
	return { registryVersion, buildStatus, state };
}

/** What the fake client answers. */
interface Answers {
	/** What `listDeployments` returns on each call; the last repeats. */
	listings?: Row[][];
	/** What `deploy.add` returns. */
	added?: unknown;
	/** What `buildLog` returns as the log. */
	log?: string;
}

/**
 * A fake client with the methods the app tools call, cast to the real type.
 *
 * @param answers - What it answers.
 * @returns The client and the name of each method called, in order.
 */
function fakeClient(answers: Answers = {}): { client: RocketRideClient; calls: string[] } {
	const calls: string[] = [];
	const listings = answers.listings ?? [[]];
	let listed = 0;
	const method = (name: string, value: () => unknown) => async () => {
		calls.push(name);
		return value();
	};
	const client = {
		deploy: {
			add: method('add', () => answers.added ?? { artifact: { version: 3 } }),
		},
		listDeployments: method('listDeployments', () => listings[Math.min(listed++, listings.length - 1)]),
		buildLog: method('buildLog', () => ({ log: answers.log ?? '' })),
		publishApp: method('publishApp', () => ({ publish: {} })),
		submitApp: method('submitApp', () => ({ artifact: {} })),
	};
	return { client: client as unknown as RocketRideClient, calls };
}

/**
 * One of a toolkit's tools by name.
 *
 * @param toolkit - The toolkit.
 * @param name - The tool name.
 * @param approvals - Lets the tool's acts through; without them every act is let through.
 * @returns The tool, callable.
 */
function toolOf(toolkit: { tools(): AgentTool[] }, name: string, approvals?: Approvals): Callable {
	const found = toolkit.tools().find((t) => t.name === name);
	assert.ok(found, `${name} is mounted`);
	return callable(found, approvals);
}

/** The app tools over a client getter and a workspace with one app, `a-ui`, whose manifest id is `acme.a`. */
function appTools(client: ClientGetter): AppToolkit {
	const host: AgentHost = {
		vfs: createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) }),
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array([1, 2, 3]),
		devSession: () => null,
	};
	return new AppToolkit(client, host, { pollMs: 0, buildWaitMs: 50 });
}

// =============================================================================
// READ BEFORE EDIT
// =============================================================================

test('edit_file and write_file refuse a file not read; write_file refuses one changed since it was read', async () => {
	const edit = { path: 'a.ts', oldString: 'a', newString: 'b' };
	const write = { path: 'a.ts', content: 'new' };
	const rows: Array<[name: string, tool: string, args: Record<string, unknown>, changed: boolean, message: RegExp]> = [
		['edit, unread', 'edit_file', edit, false, /^RefusedError: edit_file refused: read a\.ts first — edits must start from its current content\.$/],
		['write, unread', 'write_file', write, false, /^RefusedError: write_file refused: read a\.ts first — edits must start from its current content\.$/],
		['write, changed since read', 'write_file', write, true, /^RefusedError: write_file refused: a\.ts changed since you read it\. Read it again, then redo the change from the current content\.$/],
		['edit, changed since read, anchor gone', 'edit_file', { path: 'a.ts', oldString: '1', newString: '3' }, true, /^RefusedError: edit_file refused: a\.ts changed since you read it\. Read it again, then redo the change from the current content\.$/],
	];
	for (const [name, tool, args, changed, message] of rows) {
		const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
		if (changed) {
			await run(ws, 'read_file', { path: 'a.ts' });
			ws.files.set('a.ts', 'a = 2');
		}
		await assert.rejects(run(ws, tool, args), message, name);
		assert.equal(ws.files.get('a.ts'), changed ? 'a = 2' : 'a = 1', `${name}: file unchanged`);
		assert.deepEqual(ws.log, [], `${name}: nothing written`);
	}
});

test('a changed file can be edited after it is read again', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	await run(ws, 'read_file', { path: 'a.ts' });
	ws.files.set('a.ts', 'a = 2');
	await run(ws, 'read_file', { path: 'a.ts' });
	await run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' });
	assert.equal(ws.files.get('a.ts'), 'b = 2');
});

// =============================================================================
// UNSAVED EDITOR CHANGES
// =============================================================================

test('edit_file and write_file refuse a dirty file, even after reading it', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' }, { dirty: ['a.ts'] });
	await run(ws, 'read_file', { path: 'a.ts' });
	await assert.rejects(run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' }), /edit_file refused: a\.ts has unsaved editor changes/);
	await assert.rejects(run(ws, 'write_file', { path: 'a.ts', content: 'b' }), /write_file refused: a\.ts has unsaved editor changes/);
	assert.deepEqual(ws.log, []);
	assert.equal(ws.files.get('a.ts'), 'a = 1');
});

/**
 * A choice function that records each message it was asked and answers in turn.
 *
 * @param answers - What the user picks, one per question; the last repeats.
 * @returns The function and the messages it was asked.
 */
function fakeChoice(...answers: UnsavedChoice[]): { choose: ChoiceFn; asked: string[] } {
	const asked: string[] = [];
	return {
		choose: async (_title, message) => {
			asked.push(message);
			return answers[Math.min(asked.length - 1, answers.length - 1)];
		},
		asked,
	};
}

/**
 * Opens an editor with unsaved typing in a memory workspace. Its save writes the
 * buffer at the version it loaded, as the Monaco tab does; its discard drops it.
 *
 * @param ws - The workspace.
 * @param path - The file.
 * @param buffer - What the user typed.
 * @returns The editor, and what the agent asked it to do.
 */
function dirtyEditor(ws: MemoryWorkspace, path: string, buffer: string): EditorControl & { did: string[] } {
	const loaded = ws.version(path);
	ws.setDirty(path, true, buffer);
	const did: string[] = [];
	return {
		did,
		save: async () => {
			did.push('save');
			await ws.write(path, buffer, 'editor', loaded);
			ws.setDirty(path, false);
		},
		discard: async () => {
			did.push('discard');
			ws.setDirty(path, false);
		},
	};
}

/**
 * The file tools over a workspace whose dirty files ask the user.
 *
 * @param ws - The workspace.
 * @param choose - The user's answers.
 * @param editors - The open editors, by path.
 * @returns A function that runs one tool by name.
 */
function promptingTools(ws: MemoryWorkspace, choose: ChoiceFn, editors: Record<string, EditorControl>): (tool: string, args: Record<string, unknown>) => Promise<string> {
	const tools = new FilesystemTools(ws, undefined, undefined, { choose, editor: (path) => editors[path] ?? null }).tools();
	return (tool, args) => toolOf({ tools: () => tools }, tool).execute(args);
}

// =============================================================================
// UNSAVED CHANGES ASK THE USER — save mine first, discard mine, keep mine
// =============================================================================

test('Save mine first: the editor saves, then the edit lands on top of the saved text', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'title = 1;\n' });
	const { choose, asked } = fakeChoice('save');
	const editor = dirtyEditor(ws, 'a.ts', 'title = 1;\nmine = 2;\n');
	const tool = promptingTools(ws, choose, { 'a.ts': editor });
	await tool('read_file', { path: 'a.ts' });
	const result = await tool('edit_file', { path: 'a.ts', oldString: 'title = 1', newString: 'title = 3' });
	assert.deepEqual(asked, ['The agent wants to change a.ts, which has unsaved changes.']);
	assert.deepEqual(editor.did, ['save']);
	assert.equal(ws.files.get('a.ts'), 'title = 3;\nmine = 2;\n', 'both the user and the agent kept their change');
	assert.match(result, /The user saved their unsaved changes first; your anchor still matched once in the saved text/);
});

test('Save mine first on a delete or a rename saves the text, then refuses with a plain error so the agent reads again and asks', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1', 'b.ts': 'b = 1' });
	const editors = { 'a.ts': dirtyEditor(ws, 'a.ts', 'a = 1 // mine'), 'b.ts': dirtyEditor(ws, 'b.ts', 'b = 1 // mine') };
	const tool = promptingTools(ws, fakeChoice('save').choose, editors);
	await assert.rejects(tool('delete_file', { path: 'a.ts' }), /^Error: delete_file refused: the user saved their unsaved changes in a\.ts first, so a\.ts changed since you decided to delete it\. Read it again, then ask the user whether to delete it\.$/);
	await assert.rejects(tool('rename', { oldPath: 'b.ts', newPath: 'c.ts' }), /^Error: rename refused: the user saved their unsaved changes in b\.ts first, so the files changed since you planned the move\. Read b\.ts again, then ask the user whether to move b\.ts to c\.ts\.$/);
	assert.deepEqual([ws.files.get('a.ts'), ws.files.get('b.ts'), ws.files.has('c.ts')], ['a = 1 // mine', 'b = 1 // mine', false]);
	assert.deepEqual([editors['a.ts'].did, editors['b.ts'].did], [['save'], ['save']]);
});

test('a delete of a file with unsaved changes asks for the OK first, then about the changes, and a denied delete leaves the typing alone', async () => {
	const order: string[] = [];
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	const editor = dirtyEditor(ws, 'a.ts', 'a = 1 // mine');
	const choose: ChoiceFn = async (_title, message) => {
		order.push(`question: ${message}`);
		return 'discard';
	};
	const tools = new FilesystemTools(ws, undefined, undefined, { choose, editor: (path) => (path === 'a.ts' ? editor : null) });
	const deleteWith = (answer: ChatAskAnswer) => {
		const asked = fakeAsk([answer]);
		const ask = (card: ChatAskCard): ChatAsking => {
			order.push(`card: ${card.title}`);
			return asked.ask(card);
		};
		return toolOf(tools, 'delete_file', approvalsFor(null, ask)).execute({ path: 'a.ts' });
	};

	// step: the user denies the delete: nothing asks about the changes, and the typing stays
	await assert.rejects(deleteWith('deny'), /^Error: The user declined: Delete a\.ts\./);
	assert.deepEqual(order, ['card: Delete a.ts']);
	assert.deepEqual([editor.did, ws.log, ws.isDirty('a.ts')], [[], [], true]);

	// step: the user approves it, then answers Discard mine: the typing goes, then the file
	order.length = 0;
	assert.equal(await deleteWith('approve'), 'Deleted a.ts.');
	assert.deepEqual(order, ['card: Delete a.ts', 'question: The agent wants to delete a.ts, which has unsaved changes.']);
	assert.deepEqual(editor.did, ['discard']);
	assert.equal(ws.files.has('a.ts'), false);
});

test('a question that cannot show because another dialog is open says so, and is not a Keep mine', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	const editors = { 'a.ts': dirtyEditor(ws, 'a.ts', 'a = 1 // mine') };
	let otherOpen = true;
	const shown: string[] = [];
	const choose = queueChoices(
		(_title, message) => {
			shown.push(message);
			return { answer: Promise.resolve<UnsavedChoice>('discard'), close: () => undefined };
		},
		() => otherOpen
	);
	const tool = promptingTools(ws, choose, editors);
	await tool('read_file', { path: 'a.ts' });
	await assert.rejects(tool('edit_file', { path: 'a.ts', oldString: '1', newString: '2' }), /^RefusedError: The user was not asked about a\.ts because another dialog was open\. Try again after they close it\.$/);
	assert.deepEqual(shown, []);
	otherOpen = false;
	await tool('edit_file', { path: 'a.ts', oldString: '1', newString: '2' });
	assert.equal(shown.length, 1);
	assert.equal(ws.files.get('a.ts'), 'a = 2');
});

test('our own last dialog, still in the page before its deferred unmount, does not block the next question', () => {
	const dialog = (own: boolean) => ({ closest: (selector: string) => (own && selector === '[data-agent-choice]' ? {} : null) });
	const page = (...dialogs: Array<ReturnType<typeof dialog>>) => ({ querySelectorAll: () => dialogs }) as unknown as ParentNode;
	assert.equal(otherDialogOpen(page(dialog(true))), false);
	assert.equal(otherDialogOpen(page(dialog(true), dialog(false))), true);
	assert.equal(otherDialogOpen(page()), false);
});

test('a run that ends answers its open and waiting questions Keep mine, and takes the open dialog down', async () => {
	const shown: string[] = [];
	const closed: string[] = [];
	const choose = queueChoices((_title, message) => {
		shown.push(message);
		return { answer: new Promise<UnsavedChoice>(() => undefined), close: () => closed.push(message) };
	});
	const ended = new AbortController();
	const open = choose('Unsaved changes', 'a', ended.signal);
	const waiting = choose('Unsaved changes', 'b', ended.signal);
	await new Promise((resolve) => setImmediate(resolve));
	ended.abort();
	assert.deepEqual(await Promise.all([open, waiting]), ['keep', 'keep']);
	assert.deepEqual(shown, ['a'], 'the waiting question was never shown');
	assert.deepEqual(closed, ['a']);
});

test('a dirty file with no editor that can save or discard it is refused without asking', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' }, { dirty: ['a.ts'] });
	const { choose, asked } = fakeChoice('save');
	const tool = promptingTools(ws, choose, {});
	await tool('read_file', { path: 'a.ts' });
	await assert.rejects(tool('edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' }), /edit_file refused: a\.ts has unsaved editor changes\. Ask the user to save or discard them first\./);
	assert.deepEqual(asked, []);
});

// =============================================================================
// THE SAVE RACE — the real staged view over CachedVfs
// =============================================================================

/** An in-memory store backend for CachedVfs. */
function memoryBackend(seed: Record<string, string>): IVirtualFileSystem & { files: Map<string, string> } {
	const files = new Map(Object.entries(seed));
	return {
		files,
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
			if (!files.has(path)) throw new Error(`No such file: ${path}`);
			return files.get(path);
		},
		write: async (path, content) => {
			files.set(path, String(content));
		},
		rename: async () => {},
		delete: async (path) => {
			files.delete(path);
		},
		mkdir: async () => {},
	};
}

/**
 * The agent's file tools over the real view, after the agent read apps/a.ts.
 * The next readVersioned of the view holds once its content is read, so a test
 * can act in the gap between the agent's read and its write.
 */
async function racyWorkspace(): Promise<{ backend: ReturnType<typeof memoryBackend>; cached: CachedVfs; vfs: StagedFileSystem; tool: (name: string, args: Record<string, unknown>) => Promise<string>; entered: Promise<void>; release: () => void }> {
	const backend = memoryBackend({ 'apps/a.ts': 'const a = 1;' });
	const cached = new CachedVfs(backend);
	const vfs = new StagedFileSystem(cached, null, { writeThrough: true });
	const tools = new FilesystemTools(vfs).tools();
	const tool = (name: string, args: Record<string, unknown>) => toolOf({ tools: () => tools }, name).execute(args);
	await tool('read_file', { path: 'apps/a.ts' });
	let entered!: () => void;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const enteredPromise = new Promise<void>((r) => (entered = r));
	const original = vfs.readVersioned.bind(vfs);
	vfs.readVersioned = async (path) => {
		const value = await original(path);
		vfs.readVersioned = original;
		entered();
		await gate;
		return value;
	};
	return { backend, cached, vfs, tool, entered: enteredPromise, release };
}

test("a user's save that lands while the agent edits is kept, and the agent is told to read again", async () => {
	const { backend, vfs, tool, entered, release } = await racyWorkspace();
	const editing = tool('edit_file', { path: 'apps/a.ts', oldString: '1', newString: '2' });
	await entered;
	await vfs.write('apps/a.ts', 'const a = 100;', 'editor');
	release();
	await assert.rejects(editing, /^RefusedError: edit_file refused: apps\/a\.ts changed since you read it \(version 0, now 1; last writer: editor\)\. Read it again, then redo the change from the current content\.$/);
	assert.equal(backend.files.get('apps/a.ts'), 'const a = 100;');
});

test('an edit whose anchor still matches once lands on the current content and says so', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'one = 1;\ntwo = 2;\n' });
	await run(ws, 'read_file', { path: 'a.ts' });
	await ws.write('a.ts', 'one = 1;\ntwo = 2;\nthree = 3;\n', 'editor');
	const result = await run(ws, 'edit_file', { path: 'a.ts', oldString: 'two = 2', newString: 'two = 22' });
	assert.equal(ws.files.get('a.ts'), 'one = 1;\ntwo = 22;\nthree = 3;\n');
	assert.match(result, /The file had changed since you read it \(last writer: editor\); your anchor still matched once/);
	// step: a stale anchor that names two places is refused, and nothing is written
	await ws.write('a.ts', 'x\nx\n', 'editor');
	await assert.rejects(run(ws, 'edit_file', { path: 'a.ts', oldString: 'x', newString: 'y', replaceAll: true }), /changed since you read it \(version 2, now 3; last writer: editor\)/);
	assert.equal(ws.files.get('a.ts'), 'x\nx\n');
});

// =============================================================================
// FILE TRACKER — what a run read and changed, and what moved on since
// =============================================================================

test('the tracker lists the files changed since the run saw them, not the ones it deleted or moved itself', () => {
	const versions = new Map<string, number>();
	const vfs = { version: (path: string) => versions.get(path) ?? 0 };
	const tracker = new FileTracker();
	tracker.saw('a.ts', 0, 'h0');
	tracker.saw('gone.ts', 0, 'h1');
	tracker.deleted('gone.ts');
	tracker.saw('old.ts', 0, 'h2');
	tracker.renamed('old.ts', 'renamed.ts', () => 1);
	assert.deepEqual(tracker.seen(), ['a.ts', 'renamed.ts']);

	// step: someone else writes a.ts; the deleted file is never listed, and the moved one only when it moves on
	versions.set('a.ts', 2);
	versions.set('gone.ts', 5);
	versions.set('renamed.ts', 1);
	assert.deepEqual(
		tracker.changedSince(vfs).map((f) => f.path),
		['a.ts']
	);
	tracker.saw('a.ts', 2, 'h3');
	assert.deepEqual(tracker.changedSince(vfs), []);
});

// =============================================================================
// GUIDES — the agent reads guides at .rocketride/ but cannot change them
// =============================================================================

test('a delete the view refuses is refused before any card', async () => {
	const ws = createMemoryWorkspace({ '.rocketride/docs/ROCKETRIDE_APPS.md': '# Apps\n' });
	ws.assertWritable = (path) => {
		if (path === '.rocketride' || path.startsWith('.rocketride/')) throw new Error('.rocketride/ is read-only reference.');
	};
	const asked = fakeAsk(['approve']);

	await assert.rejects(toolOf(new FilesystemTools(ws), 'delete_file', approvalsFor(null, asked.ask)).execute({ path: '.rocketride/docs/ROCKETRIDE_APPS.md' }), /^Error: \.rocketride\/ is read-only reference\.$/);
	assert.deepEqual(asked.cards, [], 'no card was shown');
	assert.deepEqual(ws.log, [], 'nothing reached the workspace');
});

test('every guide the router names is a served file in docs/agents/context', () => {
	const named = [...BUILDER_PROMPTS.router.matchAll(/\.rocketride\/(docs\/[\w.-]+\.md)/g)];
	assert.ok(named.length > 0, 'the router names guides');
	for (const [full, served] of named) {
		const file = served.slice('docs/'.length);
		assert.ok(existsSync(resolve(__dirname, '../../../../../../docs/agents/context', file)), `${full} is in docs/agents/context`);
		assert.equal(docsPathFor(file), served, `${full} is served, not hidden`);
	}
});

// =============================================================================
// THE USER SAYS YES FIRST
// =============================================================================

test('publish_app and delete_file name their exact act, and only an approved one acts', async () => {
	const publish = { app: 'a-ui', target: 'public' };
	const { client, calls } = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	const step = await toolOf(
		appTools(() => client),
		'publish_app'
	).tool.prepare(publish);
	assert.deepEqual(step.act, { name: 'publishApp', params: ['acme.a', 4, '@public'] });
	assert.deepEqual(calls, ['listDeployments'], 'preparing publishes nothing');

	// through a run's approvals the publish reaches the client only by the checked view, so its act must match its call
	const denied = approvalsFor(client, fakeAsk(['deny']).ask);
	await assert.rejects(toolOf(appTools(denied.client), 'publish_app', denied).execute(publish), /^Error: The user declined: Publish Alpha \(acme\.a\) v4 to everyone\./);
	const approved = approvalsFor(client, fakeAsk(['approve']).ask);
	assert.equal(await toolOf(appTools(approved.client), 'publish_app', approved).execute(publish), 'Published v4 to everyone.');
	assert.equal(calls.filter((name) => name === 'publishApp').length, 1, 'only the approved publish reached the client');

	const ws = createMemoryWorkspace({ 'apps/a-ui/a.ts': 'a' });
	const remove = (answer: ChatAskAnswer) => toolOf(new FilesystemTools(ws), 'delete_file', approvalsFor(null, fakeAsk([answer]).ask)).execute({ path: 'apps/a-ui/a.ts' });
	await assert.rejects(remove('deny'), /^Error: The user declined: Delete apps\/a-ui\/a\.ts\./);
	assert.deepEqual(ws.log, [], 'a denied delete deletes nothing');
	assert.equal(await remove('approve'), 'Deleted apps/a-ui/a.ts.');
});

// =============================================================================
// THE ROCKETRIDE CLIENT TOOL
// =============================================================================

/**
 * A fake client that answers each method from a table and records every call.
 * A method throws unless it is called on the object that holds it, the way a
 * real client method fails when it loses `this`.
 *
 * @param answers - What each method returns, by the name the tool takes (`use`, `deploy.get`).
 * @returns The client, and each call as its method name and params, in order.
 */
function scriptedClient(answers: Record<string, unknown>): { client: RocketRideClient; calls: Array<[method: string, params: unknown[]]> } {
	const calls: Array<[method: string, params: unknown[]]> = [];
	const root: Record<string, unknown> = {};
	for (const [method, answer] of Object.entries(answers)) {
		const [first, second] = method.split('.');
		const holder = (second === undefined ? root : (root[first] ??= {})) as Record<string, unknown>;
		holder[second ?? first] = async function (this: unknown, ...params: unknown[]) {
			if (this !== holder) throw new Error(`${method} was called without its object`);
			calls.push([method, params]);
			return answer;
		};
	}
	return { client: root as unknown as RocketRideClient, calls };
}

/** A chat ask where the user approves every card. */
function approveAll(): ChatAsking {
	return { answer: Promise.resolve('approve'), approve: () => undefined };
}

/** The rocketride_client tool over a client (null for none) and a workspace view, let through by a run's approvals: the user approves every card unless told otherwise. */
function clientTool(client: RocketRideClient | null, vfs: IWorkspaceFileSystem = createMemoryWorkspace({}), approvals = approvalsFor(client, approveAll)): Callable {
	return toolOf(new RocketRideClientToolkit(approvals.client, vfs), 'rocketride_client', approvals);
}

test('rocketride_client calls a method by its guide name, with its params in order', async () => {
	const status = { teamId: 't1', projectId: 'p1', state: 'enabled' };
	const { client, calls } = scriptedClient({ 'deploy.get': status, getTaskStatus: { state: 'running' } });
	const tool = clientTool(client);
	assert.deepEqual(JSON.parse(await tool.execute({ method: 'deploy.get', params: ['p1', 't1'] })), status);
	await tool.execute({ method: 'client.getTaskStatus', params: ['tk-1'] });
	assert.deepEqual(calls, [
		['deploy.get', ['p1', 't1']],
		['getTaskStatus', ['tk-1']],
	]);
});

test('rocketride_client refuses every blocked method without reaching the client', async () => {
	const blocked = ['getApiKey', 'getAccountInfo', 'account.getProfile', 'connect', 'login', 'account.getEnv', 'account.createKey', 'billing.createCheckoutSession', 'billing.purchaseTopup', 'billing.createPortalSession', 'call', 'request', 'fsReadString', 'fsWriteString'];
	const { client, calls } = scriptedClient(Object.fromEntries(blocked.map((method) => [method, 'rr_fake_session'])));
	for (const method of blocked) {
		await assert.rejects(clientTool(client).execute({ method }), new RegExp(`Error: ${method.replace('.', '\\.')} is blocked: `), method);
	}
	assert.deepEqual(calls, []);
});

test('rocketride_client reads a filepath from the workspace, unsaved edits included', async () => {
	const edited = { name: 'Digest', components: [{ id: 'webhook_1', provider: 'webhook', config: { mode: 'Source' } }], project_id: 'p1' };
	const ws = createMemoryWorkspace({ 'pipelines/digest.pipe': JSON.stringify({ pipeline: edited, version: 1 }), 'pipelines/nameless.pipe': JSON.stringify({ pipeline: { components: [], project_id: 'p2' } }) }, { dirty: ['pipelines/digest.pipe'] });
	// read() returns the editor's buffer; the saved copy on disk is older.
	ws.peekBase = async () => JSON.stringify({ pipeline: { name: 'Old', components: [], project_id: 'p1' } });
	const { client, calls } = scriptedClient({ use: { token: 'tk-1' }, validate: { errors: [], warnings: [] }, 'deploy.add': { artifact: { version: 1 } } });
	const tool = clientTool(client, ws);

	for (const method of ['use', 'validate', 'deploy.add']) await tool.execute({ method, params: [{ filepath: './pipelines/digest.pipe', source: 'webhook_1' }] });
	const sent = { source: 'webhook_1', pipeline: { ...edited, version: 1 } };
	assert.deepEqual(calls, [
		['use', [sent]],
		['validate', [sent]],
		['deploy.add', [sent]],
	]);

	await assert.rejects(tool.execute({ method: 'deploy.add', params: [{ filepath: 'pipelines/nameless.pipe' }] }), /needs a name/);
	assert.equal(calls.length, 3, 'a nameless pipeline never reaches deploy.add');
});

test('rocketride_client results hide secrets but keep the run token, and the catalog only loses its icons', async () => {
	const services = { llm_openai: { classType: ['llm'], description: 'Calls OpenAI.', apikey: { type: 'string', title: 'API key' } } };
	const { client } = scriptedClient({
		// Run tokens carry the engine's tk_ prefix, which redactText keeps (common.ts RUN_TOKEN_PREFIX).
		use: { token: 'tk_run_0001', pipeline: { components: [{ id: 'llm_1', config: { apikey: 'sk-fake-not-a-real-key', api_key: '${ROCKETRIDE_OPENAI_KEY}' } }] } },
		'deploy.run': { token: 'tk_run_0002', version: 3 },
		getTasks: [{ token: 'tk-other-0003', name: 'Digest' }],
		getServices: { services, icons: { i1: '<svg/>' }, version: 2 },
	});
	const tool = clientTool(client);

	const used = await tool.execute({ method: 'use', params: [{ pipeline: {} }] });
	assert.match(used, /tk_run_0001/, 'use hands out its run token');
	assert.doesNotMatch(used, /sk-fake-not-a-real-key/);
	assert.match(used, /\[redacted\]/);
	assert.match(used, /\$\{ROCKETRIDE_OPENAI_KEY\}/, 'a placeholder names a key without holding it');
	assert.match(await tool.execute({ method: 'deploy.run', params: ['p1', 'webhook_1', 't1'] }), /tk_run_0002/);
	assert.doesNotMatch(await tool.execute({ method: 'getTasks' }), /tk-other-0003/, 'a token anywhere else stays hidden');
	assert.deepEqual(JSON.parse(await tool.execute({ method: 'getServices' })), { services, version: 2 });
});

test('rocketride_client explains a call it cannot make', async () => {
	/** A class instance, like pipe()'s DataPipe: printing its fields would print the client and its key. */
	class LiveObject {
		client = { _apikey: 'rr_fake_session' };
	}
	const { client, calls } = scriptedClient({ pipe: {}, getTasks: [], getTaskPipeline: new LiveObject() });
	const tool = clientTool(client);
	const rows: Array<[args: Record<string, unknown>, message: RegExp]> = [
		[{ method: 'nope' }, /'nope' is not a RocketRide client method\. .*ROCKETRIDE_typescript_API\.md/],
		[{ method: 'toString' }, /is not a RocketRide client method/],
		[{ method: 'account.client.getApiKey' }, /is not a RocketRide client method/],
		[{ method: '_detach' }, /is private/],
		[{ method: 'pipe', params: ['tk-1'] }, /pipe can't work over JSON: .*send\(token, text\)/],
		[{ method: 'getTasks', params: { token: 'tk-1' } }, /params must be an array/],
		[{ method: 'getTaskPipeline', params: ['tk-1'] }, /getTaskPipeline returned a live object/],
	];
	for (const [args, message] of rows) await assert.rejects(tool.execute(args), message, String(args.method));
	assert.deepEqual(
		calls.map(([method]) => method),
		['getTaskPipeline'],
		'only the live-object call reached the client'
	);
	await assert.rejects(clientTool(null).execute({ method: 'getServices' }), { message: NOT_CONNECTED_MESSAGE });
});

// =============================================================================
// APPROVALS — the list, the card, the modes and the checked client
// =============================================================================

/**
 * A chat ask that answers each card in turn from `answers`; 'wait' leaves a
 * card open until something approves it.
 *
 * @param answers - How each card ends, in order; past the end, 'deny'.
 * @returns The ask, and every card it was shown.
 */
function fakeAsk(answers: Array<ChatAskAnswer | 'wait'>): { ask: (card: ChatAskCard) => ChatAsking; cards: ChatAskCard[] } {
	const cards: ChatAskCard[] = [];
	const ask = (card: ChatAskCard): ChatAsking => {
		cards.push(card);
		const next = answers.shift() ?? 'deny';
		let settle: (answer: ChatAskAnswer) => void = () => undefined;
		const answer = new Promise<ChatAskAnswer>((resolve) => {
			settle = resolve;
		});
		if (next !== 'wait') settle(next);
		return { answer, approve: () => settle('approve') };
	};
	return { ask, cards };
}

/** Approval settings a test changes by hand; every grant the run turns on is recorded. */
function fakeSettings(): ApprovalSettings & { set(prefs: Partial<ApprovalPrefs>): void; granted: Grant[] } {
	let prefs: ApprovalPrefs = { mode: 'ask', grants: { schedules: false, deploymentToggles: false } };
	const listeners = new Set<() => void>();
	const granted: Grant[] = [];
	return {
		read: () => prefs,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		grant: (kind) => granted.push(kind),
		set: (next) => {
			prefs = { ...prefs, ...next };
			for (const listener of [...listeners]) listener();
		},
		granted,
	};
}

/** One run's approvals over a client, in a workspace with the app `a-ui` (id `acme.a`, named Alpha). */
function approvalsFor(client: RocketRideClient | null, ask: (card: ChatAskCard) => ChatAsking, opts: { settings?: ApprovalSettings; signal?: AbortSignal } = {}): Approvals {
	const vfs = createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) });
	return new Approvals({ client: () => client, vfs, ask, settings: opts.settings, signal: opts.signal ?? new AbortController().signal });
}

/** Calls a client method by its dotted name, on the object that holds it. */
function callMethod(client: RocketRideClient | null, name: string, params: unknown[]): unknown {
	const [first, second] = name.split('.');
	const root = client as unknown as Record<string, Record<string, (...p: unknown[]) => unknown>>;
	return second === undefined ? (root as unknown as Record<string, (...p: unknown[]) => unknown>)[first](...params) : root[first][second](...params);
}

/** An act let through by `approvals`, then run: the run makes the announced call through the checked client. */
async function approveAndRun(approvals: Approvals, name: string, params: unknown[]): Promise<string> {
	const run = await approvals.approve({ name, params }, async () => JSON.stringify(await callMethod(approvals.client(), name, params)));
	return run();
}

/** Waits a few milliseconds at a time, up to 100 times, for `ready`. */
async function until(ready: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

test("an asked call runs only after Approve, with a card in the user's words; Deny and Stop run nothing", async () => {
	const { client, calls } = scriptedClient({ publishApp: { publish: {} }, 'deploy.remove': {} });
	const yes = fakeAsk(['approve']);
	await approveAndRun(approvalsFor(client, yes.ask), 'publishApp', ['acme.a', 4, '@public']);
	assert.deepEqual(yes.cards, [{ title: 'Publish Alpha (acme.a) v4 to everyone', detail: 'It is approved, so it goes live to everyone straight away.' }]);
	assert.equal(calls.length, 1);

	await assert.rejects(approveAndRun(approvalsFor(client, fakeAsk(['deny']).ask), 'publishApp', ['acme.a', 4, '@public']), /^Error: The user declined: Publish Alpha \(acme\.a\) v4 to everyone\./);
	// the name lookups fail on this client, so the card falls back to ids
	await assert.rejects(approveAndRun(approvalsFor(client, fakeAsk(['stopped']).ask), 'deploy.remove', ['p1', 't1']), /^Error: Not done: the user stopped the run before answering: Remove p1 from team t1\./);
	assert.equal(calls.length, 1, 'only the approved call reached the client');
});

test('Auto runs an ask with no card, never stays refused, and switching to Auto approves a waiting card', async () => {
	const { client, calls } = scriptedClient({ 'deploy.disable': {}, 'account.deleteAccount': {} });
	const settings = fakeSettings();
	const waiting = fakeAsk(['wait']);
	const running = approveAndRun(approvalsFor(client, waiting.ask, { settings }), 'deploy.disable', ['p1', 't1']);
	await until(() => waiting.cards.length === 1);
	assert.equal(waiting.cards.length, 1, 'the card is waiting');
	settings.set({ mode: 'auto' });
	await running;
	assert.equal(calls.length, 1, 'switching to Auto approved the waiting card');

	const auto = fakeAsk([]);
	const approvals = approvalsFor(client, auto.ask, { settings });
	await approveAndRun(approvals, 'deploy.disable', ['p2', 't1']);
	await assert.rejects(approveAndRun(approvals, 'account.deleteAccount', []), /^Error: account\.deleteAccount is blocked: /);
	assert.equal(auto.cards.length, 0, 'Auto showed no card');
	assert.deepEqual(
		calls.map(([method]) => method),
		['deploy.disable', 'deploy.disable'],
		'deleteAccount never reached the client'
	);
});

test('Always allow turns the grant on, and the checked client refuses an asked call nobody announced', async () => {
	const { client, calls } = scriptedClient({ 'deploy.setSchedule': {}, publishApp: { publish: {} } });
	Object.assign(client, { getOrgId: () => 'org-1' });
	const settings = fakeSettings();
	const always = fakeAsk(['always']);
	await approveAndRun(approvalsFor(client, always.ask, { settings }), 'deploy.setSchedule', ['p1', 'cron_1', null, 't1']);
	assert.deepEqual(always.cards, [{ title: 'Clear the schedule of p1 (cron_1) on team t1', detail: 'It stops running on a schedule.', alwaysLabel: 'Always allow schedule changes' }]);
	assert.deepEqual(settings.granted, ['schedules']);

	const checked = approvalsFor(client, fakeAsk([]).ask).client() as unknown as { publishApp(...params: unknown[]): unknown; getOrgId(): string };
	assert.throws(() => checked.publishApp('acme.a', 4, '@me'), /^Error: publishApp needs the user's OK, and the call that reached it didn't say it would make it/);
	assert.equal(checked.getOrgId(), 'org-1', 'a free sync method stays sync');
	assert.equal(calls.length, 1, 'the unannounced publish never reached the client');
});

test('Stop while a card looks up names refuses at once, without waiting out the lookups', async () => {
	const stop = new AbortController();
	const hang = () => new Promise<never>(() => undefined);
	const stopWhileReading = () => {
		stop.abort();
		return hang();
	};
	const client = { getOrgId: () => 'org-1', account: { listTeams: hang }, deploy: { get: stopWhileReading } } as unknown as RocketRideClient;
	const shown = fakeAsk(['approve']);
	const approving = approvalsFor(client, shown.ask, { signal: stop.signal }).approve({ name: 'deploy.remove', params: ['p1', 't1'] }, async () => 'removed');
	// well inside the 2 s a lookup may take
	const late = new Promise((resolve) => setTimeout(resolve, 500, 'still waiting'));
	await assert.rejects(Promise.race([approving, late]), /^Error: Not done: the user stopped the run before answering: Remove p1 from team t1\.$/);
	assert.deepEqual(shown.cards, [], 'no card was shown');
});

// =============================================================================
// SECRETS — markers in files, redaction at every boundary, pasted keys blocked
// =============================================================================

/**
 * The file tools show markers in place of secret values and put the values
 * back on a write, every tool result passes through redactText, and a key the
 * user pastes never reaches the model. Every key here is synthetic.
 */

/**
 * A pipeline whose model node holds an inline key, the way a user might paste
 * one, beside a placeholder that only names a key.
 *
 * @param key - The inline key.
 * @returns The `.pipe` text.
 */
function inlineKeyPipe(key: string): string {
	return JSON.stringify(
		{
			components: [
				{ id: 'chat_1', provider: 'chat', config: { mode: 'Source' } },
				{ id: 'llm_1', provider: 'llm_openai', config: { apikey: key, fallback: '${ROCKETRIDE_OPENAI_KEY}' } },
			],
		},
		null,
		1
	);
}

/**
 * The marker a text shows, asserting there is one.
 *
 * @param text - A read's result, or a question.
 * @returns The first `«secret:<8 hex>»` in it.
 */
function markerIn(text: string): string {
	const marker = /«secret:[0-9a-f]{8}»/.exec(text)?.[0];
	assert.ok(marker, 'the text shows a marker');
	return marker;
}

/** A model reply: text, or made from the question it answers. */
type Reply = string | ((q: QuestionSpec) => string | Promise<string>);

/**
 * A fake model that answers from a script and keeps every question it was asked.
 *
 * @param replies - The replies, in order; running out throws.
 * @returns The model, with `questions`.
 */
function scriptedModel(replies: Reply[]): ModelCall & { questions: QuestionSpec[] } {
	const queue = [...replies];
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = queue.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		return typeof next === 'function' ? next(q) : next;
	};
	return Object.assign(call, { questions });
}

/** A reply asking for tool calls. */
function plan(...calls: Array<[tool: string, args?: Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args: args ?? {} })) });
}

/** A reply that finishes with `answer`. */
function done(answer: string): string {
	return JSON.stringify({ thought: 'finishing', done: true, answer });
}

/**
 * Runs one agent turn with a scripted model, the way the Agent tab does
 * minus the browser: Monaco only as `opts.markers`, and the chat's "Needs
 * your OK" cards go to `opts.ask`. With no ask there is no chat to ask in, so
 * nothing that asks runs.
 *
 * @param ws - The workspace.
 * @param model - The scripted model.
 * @param opts - The client, the conversation so far, a dev session for check_app, messages the user sends during the turn, the chat's ask, and the markers Monaco holds for daybook's App.tsx.
 * @returns Every chunk the turn streamed, in order.
 */
async function agentTurn(ws: MemoryWorkspace, model: ModelCall, opts: { client?: RocketRideClient; history?: ChatMessage[]; dev?: AgentDevSession; queued?: string[]; ask?: (card: ChatAskCard) => ChatAsking; request?: string; markers?: MarkerInfo[] } = {}): Promise<Array<{ type: string; text: string }>> {
	const host: AgentHost = {
		vfs: ws,
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array(),
		devSession: () => opts.dev ?? null,
	};
	const chunks: Array<{ type: string; text: string }> = [];
	const queued = [...(opts.queued ?? [])];
	const options = { history: opts.history ?? [], prompts: BUILDER_PROMPTS, token: async () => '', signal: new AbortController().signal, takeQueued: () => queued.splice(0), ask: opts.ask };
	const { markers } = opts;
	const source = markers && { modelUris: () => ['file:///daybook/src/App.tsx'], markers: () => markers, onChange: () => () => undefined };
	await runAgent(opts.request ?? 'Describe and tidy the leak pipeline.', (type, text) => chunks.push({ type, text }), options, { host, client: () => opts.client ?? null, model, markers: async () => source ?? null });
	return chunks;
}

/**
 * Makes a memory workspace refuse changes under `.rocketride/` the way the
 * app's workspace does: assertWritable throws for a reference path, and every
 * write runs it first, as StagedFileSystem's mutations do.
 *
 * @param ws - The workspace; it is changed in place.
 * @returns The same workspace.
 */
function withReadOnlyReference(ws: MemoryWorkspace): MemoryWorkspace {
	const refuse = (path: string): void => {
		if (isReferencePath(path)) throw new Error('.rocketride/ is read-only reference. Write under apps/ or pipelines/.');
	};
	const write = ws.write.bind(ws);
	ws.assertWritable = refuse;
	ws.write = async (path, content, origin, expect) => {
		refuse(path);
		await write(path, content, origin, expect);
	};
	return ws;
}

/**
 * A fake file store behind the shell's getClient, so AgentSession can save.
 * The runner's 'shell' module is one stub object (scripts/stub-shell.cjs), so
 * the fake goes onto it. Its `chat` and `use` record a call: the model's
 * pipeline is started with `use` and asked with `chat`. It also installs an
 * agent host in the personal workspace, as rocket-ui does at startup.
 *
 * @returns Every JSON file written, by store path, and the model calls made.
 */
function fakeStore(): { files: Map<string, unknown>; modelCalls: string[] } {
	const shell = createRequire(__filename)('shell') as Record<string, unknown>;
	const files = new Map<string, unknown>();
	const modelCalls: string[] = [];
	shell.ConnectionManager = { getInstance: () => ({ emit: () => undefined }) };
	shell.getClient = () => ({
		fsWriteJson: async (path: string, value: unknown) => {
			files.set(path, value);
		},
		fsReadJson: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return files.get(path);
		},
		chat: async () => {
			modelCalls.push('chat');
			return { answers: [done('unexpected')] };
		},
		use: async () => {
			modelCalls.push('use');
			return { token: 'tk_standin' };
		},
	});
	AgentSession.configure('rocketride.test');
	setAgentHost({ vfs: createMemoryWorkspace({}), scopeKey: '', scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array(), devSession: () => null });
	return { files, modelCalls };
}

/**
 * A chat turn as useChatMessages hands one to AgentSession.execute: no
 * earlier rows, never stopped, nothing queued.
 *
 * @returns The turn.
 */
function chatTurn(): ChatTurn {
	return { history: [], signal: new AbortController().signal, takeQueued: () => [], ask: () => ({ answer: Promise.resolve('stopped'), approve: () => undefined }) };
}

test('a .pipe read shows a marker and a note, and the marker writes the real value back', async () => {
	// No key shape: only the field name says it is a secret.
	const key = 'canary-inline-4d1f9a';
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': inlineKeyPipe(key) });
	const read = await run(ws, 'read_file', { path: 'pipelines/a.pipe' });
	assert.ok(!read.includes(key), 'the key is hidden');
	const marker = markerIn(read);
	assert.match(read, /"fallback": "\$\{ROCKETRIDE_OPENAI_KEY\}"/, 'a placeholder holds no secret, so it stays');
	assert.ok(read.endsWith('\n[1 secret value hidden (components[1].config.apikey). The file stores it in plain text; you see a marker in its place. Keep the marker as it is when you edit this file. A key written in a file should move to Variables: tell the user to set it there and use a ${ROCKETRIDE_<NAME>} placeholder.]'), read);
	assert.equal(markerIn(await run(ws, 'read_file', { path: 'pipelines/a.pipe' })), marker, 'a re-read shows the same marker');

	// edit_file: the anchor holds the marker, and the file keeps the key
	await run(ws, 'edit_file', { path: 'pipelines/a.pipe', oldString: `"apikey": "${marker}"`, newString: `"apikey": "${marker}", "model": "gpt-5"` });
	const config = () => JSON.parse(ws.files.get('pipelines/a.pipe') ?? '').components[1].config;
	assert.deepEqual(config(), { apikey: key, model: 'gpt-5', fallback: '${ROCKETRIDE_OPENAI_KEY}' });

	// write_file: the whole read, changed, goes back with the key in it
	const again = await run(ws, 'read_file', { path: 'pipelines/a.pipe' });
	await run(ws, 'write_file', { path: 'pipelines/a.pipe', content: again.slice(0, again.lastIndexOf('\n[')).replace('gpt-5', 'gpt-5-mini') });
	assert.deepEqual(config(), { apikey: key, model: 'gpt-5-mini', fallback: '${ROCKETRIDE_OPENAI_KEY}' });
});

test('a marker this run did not make is refused, and nothing is written', async () => {
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': inlineKeyPipe('canary-inline-4d1f9a') });
	const marker = markerIn(await run(ws, 'read_file', { path: 'pipelines/a.pipe' }));
	await assert.rejects(run(ws, 'edit_file', { path: 'pipelines/a.pipe', oldString: '"llm_1"', newString: '"«secret:zz99zz99»"' }), /^Error: edit_file refused: «secret:zz99zz99» is not a marker from this run\./);
	await assert.rejects(run(ws, 'write_file', { path: 'pipelines/b.pipe', content: '{"apikey": "«secret:00000000»"}' }), /^Error: write_file refused: «secret:00000000» is not a marker from this run\./); // gitleaks:allow, made-up test value

	// a new run has its own markers: the last run's marker means nothing to it
	const next = toolOf(new FilesystemTools(ws), 'write_file');
	await assert.rejects(next.execute({ path: 'pipelines/c.pipe', content: `{"apikey": "${marker}"}` }), /^Error: write_file refused: «secret:[0-9a-f]{8}» is not a marker from this run\./);
	assert.deepEqual(ws.log, []);
});

test('a guide under .rocketride/docs/ shows as served on read and search, and a write or an edit there is still refused', async () => {
	const key = `sk-canary-guide-${'d'.repeat(12)}`;
	const path = '.rocketride/docs/ROCKETRIDE_SETUP.md';
	const guide = `# Setup\n\nAn example config:\n\n    OPENAI_API_KEY=${key}\n    "apikey": "\${OPENAI_KEY}" does not substitute.\n`;
	const ws = withReadOnlyReference(createMemoryWorkspace({ [path]: guide }));
	// the guide is the server's text: no marker and no note, and a key shape still reaches the model only as [redacted], as every tool result does
	const read = await run(ws, 'read_file', { path });
	assert.equal(read, guide.replace(key, '[redacted]'));
	// a whole-workspace search skips .rocketride/; one that starts inside it reaches the guide, shown the same way
	const found = await run(ws, 'search_files', { pattern: 'OPENAI', path: '.rocketride/docs' });
	assert.equal(found, `2 match(es):\n${path}:5: OPENAI_API_KEY=[redacted]\n${path}:6: "apikey": "\${OPENAI_KEY}" does not substitute.`);

	// the view refuses the path before an anchor is matched, and the error names no value
	await assert.rejects(run(ws, 'write_file', { path, content: read }), /^Error: \.rocketride\/ is read-only reference\./);
	await assert.rejects(run(ws, 'edit_file', { path, oldString: 'OPENAI_API_KEY=[redacted]', newString: 'OPENAI_API_KEY=${ROCKETRIDE_OPENAI_KEY}' }), /^Error: \.rocketride\/ is read-only reference\./);
	await assert.rejects(run(ws, 'write_file', { path: '.rocketride/docs/NEW.md', content: '«secret:00000000»' }), /^Error: write_file refused: «secret:00000000» is not a marker from this run\./); // gitleaks:allow, made-up test value
	assert.equal(ws.files.get(path), guide);
	assert.deepEqual(ws.log, [], 'nothing was written');
});

test("the pipelines guide's Pitfall 6 example reaches the model whole, and a key in a user file is still hidden", async () => {
	const path = '.rocketride/docs/ROCKETRIDE_PIPELINES.md';
	const guide = readFileSync(resolve(__dirname, '../../../../../../docs/agents/context/ROCKETRIDE_PIPELINES.md'), 'utf8');
	const lines = guide.split('\n');
	const at = lines.findIndex((line) => line.includes('"apikey": "${OPENAI_KEY}"'));
	assert.ok(at >= 0, 'the guide has the Pitfall 6 example');
	const key = 'canary-user-pipe-5b8e';
	const ws = withReadOnlyReference(createMemoryWorkspace({ [path]: guide, 'pipelines/a.pipe': inlineKeyPipe(key) }));
	const model = scriptedModel([plan(['read_file', { path, offset: at, limit: 3 }], ['search_files', { pattern: 'wrong prefix', path }], ['read_file', { path: 'pipelines/a.pipe' }]), done('Read.')]);
	await agentTurn(ws, model);

	const context = model.questions[1].context.find((item) => item.startsWith('Previous tool results:\n')) ?? '';
	const [window, search, pipe] = (JSON.parse(context.slice('Previous tool results:\n'.length)) as Array<{ summary?: string }>).map((entry) => entry.summary ?? '');
	assert.equal(window, `[Lines ${at}-${at + 2} of ${lines.length} in ${path}]\n${lines.slice(at - 1, at + 2).join('\n')}`);
	assert.equal(search, `1 match(es):\n${path}:${at + 1}: ${lines[at].trim().slice(0, 200)}`);
	assert.ok(!pipe.includes(key), pipe);
	assert.match(pipe, /"apikey": "«secret:[0-9a-f]{8}»"/); // gitleaks:allow, a marker pattern, not a value
	assert.match(pipe, /1 secret value hidden \(components\[1\]\.config\.apikey\)/);
	assert.ok(!JSON.stringify(model.questions).includes(key), 'the key reached no question');
});

test('a dev password that is a short word is hidden in its own field, and the guide, service names and the answer stay readable', async () => {
	const path = '.rocketride/docs/ROCKETRIDE_PIPELINES.md';
	const lines = readFileSync(resolve(__dirname, '../../../../../../docs/agents/context/ROCKETRIDE_PIPELINES.md'), 'utf8').split('\n');
	const at = lines.findIndex((line) => line.startsWith('### Pattern 28'));
	const pipe = JSON.stringify({ components: [{ provider: 'db_postgres', config: { 'postgresdb.password': 'postgres' } }] }, null, 1);
	const ws = withReadOnlyReference(createMemoryWorkspace({ [path]: lines.join('\n'), 'pipelines/local.pipe': pipe, '.env': 'DB_PASSWORD=password\nADMIN_TOKEN=changeme\n' }));
	const { client } = scriptedClient({ getServices: { services: { db_postgres: {}, postgres: {} } }, getService: { fields: { 'postgresdb.password': {} } } });
	const answer = 'I added a db_postgres node that reads your local postgres database. Change the default changeme token.';
	const model = scriptedModel([plan(['read_file', { path: 'pipelines/local.pipe' }], ['read_file', { path: '.env' }]), plan(['read_file', { path, offset: at + 1, limit: 1 }], ['rocketride_client', { method: 'getServices' }], ['rocketride_client', { method: 'getService', params: ['db_postgres'] }]), done(answer)]);
	const chunks = await agentTurn(ws, model, { client });

	const context = model.questions[2].context.find((item) => item.startsWith('Previous tool results:\n')) ?? '';
	const [pipeRead, envRead, guideRead, services, service] = (JSON.parse(context.slice('Previous tool results:\n'.length)) as Array<{ summary?: string }>).map((entry) => entry.summary ?? '');
	assert.match(pipeRead, /"provider": "db_postgres",\n.*\n.*"postgresdb\.password": "«secret:[0-9a-f]{8}»"\n/);
	assert.match(envRead, /^DB_PASSWORD=«secret:[0-9a-f]{8}»\nADMIN_TOKEN=«secret:[0-9a-f]{8}»\n/);
	assert.equal(guideRead.split('\n')[1], lines[at]);
	assert.equal(services, 'services:\n  db_postgres: {}\n  postgres: {}');
	assert.equal(service, 'fields:   postgresdb.password: {}');
	assert.equal(chunks.at(-1)?.text, answer);
});

test('search_files searches one file when its path names a file, in the workspace or under .rocketride/', async () => {
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': '{\n  "name": "chat"\n}\n', 'pipelines/b.pipe': '{ "name": "chat too" }', '.rocketride/docs/ROCKETRIDE_APPS.md': '# Apps\n\nAn app has a chat.\n' });
	assert.equal(await run(ws, 'search_files', { pattern: 'chat', path: 'pipelines/a.pipe' }), '1 match(es):\npipelines/a.pipe:2: "name": "chat"');
	assert.equal(await run(ws, 'search_files', { pattern: 'chat', path: '.rocketride/docs/ROCKETRIDE_APPS.md' }), '1 match(es):\n.rocketride/docs/ROCKETRIDE_APPS.md:3: An app has a chat.');
	assert.equal(await run(ws, 'search_files', { pattern: 'chat', path: 'pipelines' }), '2 match(es):\npipelines/a.pipe:2: "name": "chat"\npipelines/b.pipe:1: { "name": "chat too" }');
});

test('a key cut by a read window or the search clip is still hidden', async () => {
	// The key starts at character 186 of its line, so the 200-character clip cuts it; it also has a line of its own.
	const key = `sk-${'w'.repeat(40)}`;
	const pipeKey = 'canary-inline-4d1f9a';
	const pipe = inlineKeyPipe(pipeKey);
	const ws = createMemoryWorkspace({ 'notes/setup.md': `${'x'.repeat(170)} OPENAI_API_KEY=${key}\nline two\n${key}\n`, 'pipelines/a.pipe': pipe });
	const results = [await run(ws, 'read_file', { path: 'notes/setup.md', maxBytes: 200 }), await run(ws, 'read_file', { path: 'notes/setup.md', offset: 3, limit: 1 }), await run(ws, 'read_file', { path: 'pipelines/a.pipe', maxBytes: pipe.indexOf(pipeKey) + 6 }), await run(ws, 'search_files', { pattern: 'OPENAI_API_KEY' }), await run(ws, 'search_files', { pattern: 'apikey' })];
	for (const text of results) {
		assert.ok(!text.includes(key.slice(0, 8)) && !text.includes(pipeKey.slice(0, 6)), `part of a key shows in: ${text.slice(-300)}`);
	}
	assert.match(results[1], /^\[Lines 3-3 of 4 in notes\/setup\.md\]\n«secret:[0-9a-f]{8}»\n\[2 secret values hidden \(line 1, line 3\)\./, 'a window shows the marker, and the note names both places the key sits');
	assert.match(await run(ws, 'search_files', { pattern: 'sk-www' }), /^No matches/, 'a search cannot probe a hidden value');
});

test('a request with a bearer token or a secret field reaches the model redacted', async () => {
	// Neither is a sure key shape, so execute does not hold the message back; the run still must not send it.
	const token = 't'.repeat(32);
	const field = 'canary-field-7c2e';
	const model = scriptedModel([done('Done.')]);
	await agentTurn(createMemoryWorkspace({}), model, { request: `Call the API with Authorization: Bearer ${token} and {"password": "${field}"}` });
	const asked = JSON.stringify(model.questions);
	assert.ok(!asked.includes(token) && !asked.includes(field), asked);
	assert.match(asked, /Authorization: Bearer \[redacted\]/);
});

test('a cut that falls inside a credential still hides it', () => {
	const url = 'postgres://admin:hunter2secretpw@db.example.invalid/x';
	const text = `${'x'.repeat(50)}${url}`;
	// The cut lands just before the @, where the clipped part no longer looks like a URL password.
	const cut = clip(text, 'see less', 50 + url.indexOf('@'));
	assert.ok(!cut.includes('hunter2secretpw'), cut);
	// The same through a client result: pad the row so the 32,000-character cut falls just before the @.
	const at = (note: string) => JSON.stringify({ rows: [{ note, url }] }, null, 1).indexOf('@');
	const result = toolText({ rows: [{ note: 'x'.repeat(RESULT_MAX_CHARS - at('')), url }] }, 'see less');
	assert.match(result, /\[TRUNCATED: showing first 32000 of/);
	assert.ok(!result.includes('hunter2secretpw'), result.slice(-300));
});

test('redactText hides each credential shape and keeps placeholders, markers and the run token', () => {
	// blocks: what looksLikeCredential says, so whether a pasted message is held back
	const rows: Array<[text: string, expected: string, blocks: string | null]> = [
		[`key sk-${'a'.repeat(20)} end`, 'key [redacted] end', 'OpenAI-style'],
		[`sk-ant-api03-${'b'.repeat(20)}`, '[redacted]', 'Anthropic-style'],
		[`AKIA${'C'.repeat(16)}`, '[redacted]', 'AWS-style'],
		[`ghp_${'d'.repeat(36)}`, '[redacted]', 'GitHub-style'],
		[`gho_${'d'.repeat(36)}`, '[redacted]', 'GitHub-style'],
		[`ghs_${'d'.repeat(36)}`, '[redacted]', 'GitHub-style'],
		[`github_pat_11ABCDEFG0${'d'.repeat(20)}_${'D'.repeat(59)}`, '[redacted]', 'GitHub-style'],
		[`sk_live_${'s'.repeat(24)}`, '[redacted]', 'Stripe-style'],
		[`rk_live_${'r'.repeat(24)}`, '[redacted]', 'Stripe-style'],
		[`xoxb-${'1'.repeat(10)}-${'e'.repeat(12)}`, '[redacted]', 'Slack-style'],
		[`AIza${'g'.repeat(35)}`, '[redacted]', 'Google-style'],
		[`xai-${'x'.repeat(80)}`, '[redacted]', 'xAI-style'],
		[`pplx-${'p'.repeat(48)}`, '[redacted]', 'Perplexity-style'],
		[`tvly-dev-${'t'.repeat(32)}`, '[redacted]', 'Tavily-style'],
		[`pcsk_${'k'.repeat(6)}_${'K'.repeat(63)}`, '[redacted]', 'Pinecone-style'],
		[`fc-${'0f'.repeat(16)}`, '[redacted]', 'Firecrawl-style'],
		['postgres://admin:hunter2@db.example.invalid/x', 'postgres://admin:[redacted]@db.example.invalid/x', 'a password in a URL'],
		['-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----', '[redacted]', 'a private key'], // gitleaks:allow, made-up test value
		// hidden, but not sure enough to hold a message back: a bearer word and a field name
		[`Authorization: Bearer ${'f'.repeat(24)}.sig`, 'Authorization: Bearer [redacted]', null],
		['{"apikey": "hunter2", "name": "chat"}', '{"apikey": "[redacted]", "name": "chat"}', null], // gitleaks:allow, made-up test value
		['{"password": 12345678}', '{"password": [redacted]}', null],
		['{"password": "12345678", "auth_token": "Zq9mPx4tLrWw"}', '{"password": "[redacted]", "auth_token": "[redacted]"}', null], // gitleaks:allow, made-up test value
		// nothing to hide: a placeholder, a marker, the run token, and words that only look close
		['{"apikey": "${ROCKETRIDE_OPENAI_KEY}"}', '{"apikey": "${ROCKETRIDE_OPENAI_KEY}"}', null],
		['{"apikey": "«secret:0a1b2c3d»"}', '{"apikey": "«secret:0a1b2c3d»"}', null], // gitleaks:allow, made-up test value
		['postgres://admin:«secret:28be2aa3»@db.example.invalid/x', 'postgres://admin:«secret:28be2aa3»@db.example.invalid/x', null],
		['DATABASE_URL: "postgres://admin:«secret:28be2aa3»@db.example.invalid/x"', 'DATABASE_URL: "postgres://admin:«secret:28be2aa3»@db.example.invalid/x"', null],
		['http://host.example.invalid:8080?email=bob@x.example.invalid', 'http://host.example.invalid:8080?email=bob@x.example.invalid', null],
		['{\n "token": "tk_0a1b2c3d4e5f",\n "state": "running"\n}', '{\n "token": "tk_0a1b2c3d4e5f",\n "state": "running"\n}', null], // gitleaks:allow, made-up test value
		['{"model": "gpt-5", "max_tokens": "4096", "tokenizer": "cl100k_base", "token": "4096", "token_limit": "8000"}', '{"model": "gpt-5", "max_tokens": "4096", "tokenizer": "cl100k_base", "token": "4096", "token_limit": "8000"}', null],
		['apps/task-manager-dashboard-ui/src/App.tsx', 'apps/task-manager-dashboard-ui/src/App.tsx', null],
		['interface Options { token: string; apiKey?: string }', 'interface Options { token: string; apiKey?: string }', null],
		['ssh://git@github.com/acme/app.git', 'ssh://git@github.com/acme/app.git', null],
		// a key's prefix in ordinary text, or a key one character short
		[`AIza${'g'.repeat(34)}`, `AIza${'g'.repeat(34)}`, null],
		['xai-grok-4-fast-reasoning', 'xai-grok-4-fast-reasoning', null],
		['pplx-70b-online', 'pplx-70b-online', null],
		['tvly-YOUR_API_KEY', 'tvly-YOUR_API_KEY', null],
		[`pcsk_${'k'.repeat(6)}_${'K'.repeat(62)}`, `pcsk_${'k'.repeat(6)}_${'K'.repeat(62)}`, null],
		['<div class="fc-daygrid-day-frame">', '<div class="fc-daygrid-day-frame">', null],
	];
	for (const [text, expected, blocks] of rows) {
		assert.equal(redactText(text), expected, text);
		assert.equal(looksLikeCredential(text), blocks, text);
	}
});

test('a pasted message is held back only for a key shape, a private key or a URL password', () => {
	// Field names and a bearer word are too unsure to stop the user: these go to the model.
	assert.equal(looksLikeCredential('{"model": "gpt-5", "max_tokens": "4096"}'), null);
	assert.equal(looksLikeCredential('the API wants Bearer token_from_the_login_endpoint'), null);
	assert.equal(looksLikeCredential('my config has {"apikey": "hunter2hunter2"} in it'), null); // gitleaks:allow, made-up test value
	assert.equal(looksLikeCredential(`use ${'sk-proj-'}${'h'.repeat(40)}`), 'OpenAI-style');
	assert.equal(looksLikeCredential('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA'), 'a private key');
	assert.equal(looksLikeCredential('connect to postgres://admin:hunter2@db.example.invalid/app'), 'a password in a URL');
});

test('a field is secret-named by its words: a token field is, a token count is not', () => {
	const secret = ['apikey', 'api_key', 'apiKey', 'x-api-key', 'OPENAI_API_KEY', 'client_secret', 'secretKey', 'SECRET_KEY', 'password', 'passwd', 'dbPassword', 'passphrase', 'credentials', 'credentials_json', 'private_key', 'privateKey', 'aws_access_key_id', 'serviceAccountKey', 'ssh_key', 'bearer', 'auth_value', 'authorizationValue', 'header_value', 'webhook_url', 'connection_string', 'token', 'auth_token', 'access_token', 'refreshToken', 'hf.token', 'BOT_TOKEN'];
	const plain = ['max_tokens', 'maxTokens', 'tokenizer', 'num_tokens', 'token_count', 'token_limit', 'tokens', 'model', 'url', 'user', 'secretary', 'passwordless', 'keyboard', 'monkey'];
	assert.deepEqual(
		secret.filter((name) => !isSecretName(name)),
		[],
		'these hold secrets'
	);
	assert.deepEqual(
		plain.filter((name) => isSecretName(name)),
		[],
		'these do not'
	);
});

test('a client result with a key in free text or a URL is hidden once it passes the boundary', () => {
	// redactSecrets hides fields by name; redactText then hides what has no secret name
	const key = `sk-${'g'.repeat(24)}`;
	const text = redactText(toolText({ apikey: 'hunter2', text: `the run printed ${key}`, url: 'https://user:hunter2@example.invalid', ref: '${ROCKETRIDE_ANTHROPIC_KEY}' }, ''));
	assert.deepEqual(JSON.parse(text), { apikey: '[redacted]', text: 'the run printed [redacted]', url: 'https://user:[redacted]@example.invalid', ref: '${ROCKETRIDE_ANTHROPIC_KEY}' });
});

test('read_file and search_files put a marker, never the key, in the next question', async () => {
	const key = 'canary-inline-4d1f9a';
	const calls: Array<[tool: string, args: Record<string, unknown>]> = [
		['read_file', { path: 'pipelines/a.pipe' }],
		['search_files', { pattern: 'apikey' }],
	];
	for (const call of calls) {
		const model = scriptedModel([plan(call), done('Read.')]);
		await agentTurn(createMemoryWorkspace({ 'pipelines/a.pipe': inlineKeyPipe(key) }), model);
		const next = model.questions[1].context.join('\n');
		assert.ok(!next.includes(key), `${call[0]}: the key reached the model`);
		markerIn(next);
	}
});

/**
 * A read without the note it ends with when it hid anything: the file as the
 * model sees it, ready to be written back whole.
 *
 * @param read - What read_file returned.
 * @returns The text before the note.
 */
function withoutNote(read: string): string {
	return read.replace(/\n\[\d+ secret values? hidden \([\s\S]*\]$/, '');
}

test('writing a whole read back keeps each URL password, after the redaction every result gets', async () => {
	// run() redacts the read as the loop does: a read that showed [redacted] would save it over the password.
	const files: Record<string, string> = {
		'.env': 'DATABASE_URL=postgres://admin:hunter2pass@db.example.invalid:5432/app\n',
		'config/db.yaml': 'database:\n  DATABASE_URL: "postgres://admin:hunter2pass@db.example.invalid/app"\n',
		'pipelines/db.pipe': JSON.stringify({ components: [{ id: 'db_1', provider: 'db_postgres', config: { url: 'postgres://admin:hunter2pass@db.example.invalid/app' } }] }, null, 1),
		'notes/form.md': 'The form posts to http://host.example.invalid:8080?email=bob@x.example.invalid\n',
	};
	const ws = createMemoryWorkspace(files);
	for (const [path, content] of Object.entries(files)) {
		const read = await run(ws, 'read_file', { path });
		assert.ok(!read.includes('hunter2pass') && !read.includes('[redacted]'), read);
		await run(ws, 'write_file', { path, content: withoutNote(read) });
		assert.equal(ws.files.get(path), content, `${path} keeps its password`);
	}
	assert.ok(!(await run(ws, 'read_file', { path: 'notes/form.md' })).includes('«secret:'), 'a port and a query are not a password');
});

test('a quoted YAML value is hidden up to its real closing quote', async () => {
	const text = "db:\n  password: \"pqr\\\"defSECRETTAIL\"\nsmtp:\n  password: 'it''sSECRETTAIL' # the smtp login\nldap:\n  password: '''a''''SECRETTAIL'''\n";
	const ws = createMemoryWorkspace({ 'config/app.yaml': text });
	const read = await run(ws, 'read_file', { path: 'config/app.yaml' });
	assert.ok(!read.includes('SECRETTAIL') && !read.includes('pqr') && !read.includes("it'"), read);
	assert.match(read, /password: "«secret:[0-9a-f]{8}»"\n/);
	assert.match(read, /password: '«secret:[0-9a-f]{8}»' # the smtp login\n/, 'the comment after the quote stays');
	await run(ws, 'write_file', { path: 'config/app.yaml', content: withoutNote(read) });
	assert.equal(ws.files.get('config/app.yaml'), text);
});

test('a YAML value after a tag or an anchor is hidden, and a count under a token name is not', async () => {
	const text = 'a:\n  password: !!str 12345678\nb:\n  password: &pw hunter2hunter2\nc:\n  password: *pw\nmodel:\n  token: 4096\n  max_tokens: 4096\n';
	const ws = createMemoryWorkspace({ 'config/app.yml': text });
	const read = await run(ws, 'read_file', { path: 'config/app.yml' });
	assert.ok(!read.includes('12345678') && !read.includes('hunter2hunter2'), read);
	assert.match(read, /password: !!str «secret:[0-9a-f]{8}»\n/);
	assert.match(read, /password: &pw «secret:[0-9a-f]{8}»\n/);
	assert.match(read, /password: \*pw\n/, 'an alias holds no value');
	assert.match(read, /token: 4096\n {2}max_tokens: 4096\n/, 'a count under a token name stays');
	await run(ws, 'write_file', { path: 'config/app.yml', content: withoutNote(read) });
	assert.equal(ws.files.get('config/app.yml'), text);
});

test('a .env-style file hides the value of each secret-named NAME=value line', async () => {
	// Each row: the files it is read as, the text, and the start of the read with each marker as «M».
	const rows: Array<[paths: string[], text: string, shown: string]> = [
		[['.env', '.env.local', 'docker/app.env', 'config.toml', 'app.ini', 'app.properties', 'scripts/deploy.sh'], `AWS_ACCESS_KEY_ID=AKIA${'Q'.repeat(16)}\nexport AWS_SECRET_ACCESS_KEY = ${'w'.repeat(40)}\nCOHERE_API_KEY = "${'c'.repeat(40)}"\nOPENAI_API_KEY=\${ROCKETRIDE_OPENAI_KEY}\nANTHROPIC_API_KEY=\n`, 'AWS_ACCESS_KEY_ID=«M»\nexport AWS_SECRET_ACCESS_KEY = «M»\nCOHERE_API_KEY = "«M»"\nOPENAI_API_KEY=${ROCKETRIDE_OPENAI_KEY}\nANTHROPIC_API_KEY=\n\n[3 secret values hidden (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, COHERE_API_KEY).'],
		// TOML strings in triple quotes: the literal one holds a quote, and in the basic one a backslash escapes a quote
		[['config.toml'], `COHERE_API_KEY = """${'c'.repeat(40)}"""\nDB_PASSWORD = '''it's-${'p'.repeat(12)}'''\nSMTP_PASSWORD = """a\\"""${'s'.repeat(12)}"""\n`, `COHERE_API_KEY = """«M»"""\nDB_PASSWORD = '''«M»'''\nSMTP_PASSWORD = """«M»"""\n\n[3 secret values hidden (COHERE_API_KEY, DB_PASSWORD, SMTP_PASSWORD).`],
		// in .properties, # starts a comment only at the start of a line, $ is text, and ''' is not a TOML string
		[['app.properties'], `db.password=correct horse #${'b'.repeat(12)}\nmail.password=$${'e'.repeat(12)}\nldap.password='''a''''${'q'.repeat(12)}'''\nsmtp.password= #${'s'.repeat(12)}\n`, "db.password=«M»\nmail.password=«M»\nldap.password='«M»'\nsmtp.password= «M»\n\n[4 secret values hidden (db.password, mail.password, ldap.password, smtp.password)."],
		// each assignment of an export, and $NAME names a variable unless single quotes make it text
		[['.env.local', 'docker/app.env', 'scripts/deploy.sh'], `  export COHERE_API_KEY=${'c'.repeat(40)} OPENAI_API_KEY="\${ROCKETRIDE_OPENAI_KEY}" MISTRAL_API_KEY="${'m'.repeat(32)}" JWT_SECRET='${'j'.repeat(16)}'\nexport API_KEY=$ROCKETRIDE_OPENAI_KEY\nDB_PASSWORD='$${'p'.repeat(12)}'\n`, `  export COHERE_API_KEY=«M» OPENAI_API_KEY="\${ROCKETRIDE_OPENAI_KEY}" MISTRAL_API_KEY="«M»" JWT_SECRET='«M»'\nexport API_KEY=$ROCKETRIDE_OPENAI_KEY\nDB_PASSWORD='«M»'\n\n[4 secret values hidden (COHERE_API_KEY, MISTRAL_API_KEY, JWT_SECRET, DB_PASSWORD).`],
		// a space after = in an export, which dotenv reads: a word after it that sets a name is its own, and one that ends in = is a base64 value
		[['.env'], `export COHERE_API_KEY= ${'c'.repeat(40)}\nexport DEBUG= JWT_SECRET=${'j'.repeat(16)}\nexport DEBUG= SMTP_PASSWORD = ${'s'.repeat(16)}\nexport API_KEY= ${'z'.repeat(30)}== # old key\nexport AUTH_TOKEN= ${'x'.repeat(30)}=\n`, 'export COHERE_API_KEY= «M»\nexport DEBUG= JWT_SECRET=«M»\nexport DEBUG= SMTP_PASSWORD = «M»\nexport API_KEY= «M» # old key\nexport AUTH_TOKEN= «M»\n\n[5 secret values hidden (COHERE_API_KEY, JWT_SECRET, SMTP_PASSWORD, API_KEY, AUTH_TOKEN).'],
		// an export value is the whole shell word, so an escaped quote or '' does not end it
		[['.env'], `export DB_PASSWORD="correct\\"${'h'.repeat(12)}"\nexport SMTP_PASSWORD='it''s-${'p'.repeat(12)}'\n`, `export DB_PASSWORD="«M»"\nexport SMTP_PASSWORD='«M»'\n\n[2 secret values hidden (DB_PASSWORD, SMTP_PASSWORD).`],
		// in an export, a quote left open, unquoted words up to the next name, and a quoted name
		[['.env'], `export API_KEY="${'k'.repeat(20)}\nexport JWT_SECRET='${'j'.repeat(16)}\nexport DB_PASSWORD=correct horse ${'b'.repeat(12)}\nexport "MISTRAL_API_KEY"=${'m'.repeat(32)}\n`, `export API_KEY="«M»\nexport JWT_SECRET='«M»\nexport DB_PASSWORD=«M»\nexport "MISTRAL_API_KEY"=«M»\n\n[4 secret values hidden (API_KEY, JWT_SECRET, DB_PASSWORD, MISTRAL_API_KEY).`],
		// NAME = value after another assignment is its own
		[['.env'], `export FOO=bar API_KEY = ${'k'.repeat(20)}\n`, 'export FOO=bar API_KEY = «M»\n\n[1 secret value hidden (API_KEY).'],
		// dotenv reads a word that sets a name after `NAME= ` as NAME's value, up to the next such word
		[['.env'], `export API_KEY = HOST=${'h'.repeat(16)}\nexport AUTH_TOKEN= HOST=${'t'.repeat(16)} FOO=bar\n`, 'export API_KEY = «M»\nexport AUTH_TOKEN= «M» FOO=bar\n\n[2 secret values hidden (API_KEY, AUTH_TOKEN).'],
		// where that word's own value is hidden too, it stays its own
		[['.env'], `export API_KEY = JWT_SECRET=${'j'.repeat(16)}\n`, 'export API_KEY = JWT_SECRET=«M»\n\n[1 secret value hidden (JWT_SECRET).'],
		// `NAME= # note` is an empty NAME and a comment, and `NAME=#x` sets `#x`
		[['.env', 'scripts/deploy.sh'], `export API_KEY= # optional; leave blank\nAUTH_TOKEN= # unused\nJWT_SECRET=#${'j'.repeat(16)}\n`, 'export API_KEY= # optional; leave blank\nAUTH_TOKEN= # unused\nJWT_SECRET=«M»\n\n[1 secret value hidden (JWT_SECRET).'],
	];
	for (const [paths, text, shown] of rows) {
		for (const path of paths) {
			const read = await run(createMemoryWorkspace({ [path]: text }), 'read_file', { path });
			assert.equal(read.replace(/«secret:[0-9a-f]{8}»/g, '«M»').slice(0, shown.length), shown, path);
		}
	}
});

test('a .pipe mid-edit, missing a comma or a closing quote, still hides each secret', async () => {
	const nested = '"credentials": {"user": "bob", "pw": "nested-secret-1"}';
	const files: Record<string, string> = {
		'pipelines/comma.pipe': `{\n "components": [{\n  "id": "llm_1",\n  "config": {\n   "model": "gpt"\n   ${nested}\n  }\n }]\n}`,
		'pipelines/quote.pipe': `{\n "components": [{\n  "id": "llm_1",\n  "config": {\n   "name": "unclosed,\n   ${nested}\n  }\n }]\n}`,
	};
	const ws = createMemoryWorkspace(files);
	for (const path of Object.keys(files)) {
		const read = await run(ws, 'read_file', { path });
		assert.ok(!read.includes('nested-secret-1') && !read.includes('"bob"'), read);
		assert.match(read, /\[2 secret values hidden \(components\[0\]\.config\.credentials\.user, components\[0\]\.config\.credentials\.pw\)\./);
	}
});

test('a number under a password name is hidden, and a count under a token name is not', async () => {
	const text = JSON.stringify({ db: { password: 12345678, port: 5432 }, llm: { token: '4096', max_tokens: 4096, tokenizer: 'cl100k_base' } }, null, 1);
	const ws = createMemoryWorkspace({ 'pipelines/n.pipe': text });
	const read = await run(ws, 'read_file', { path: 'pipelines/n.pipe' });
	assert.ok(!read.includes('12345678'), read);
	assert.match(read, /"password": «secret:[0-9a-f]{8}»,\n {2}"port": 5432\n/);
	assert.match(read, /"token": "4096",\n {2}"max_tokens": 4096,\n {2}"tokenizer": "cl100k_base"\n/);
	assert.match(read, /\n\[1 secret value hidden \(db\.password\)\./, 'only the password is hidden');
	await run(ws, 'write_file', { path: 'pipelines/n.pipe', content: withoutNote(read) });
	assert.equal(ws.files.get('pipelines/n.pipe'), text);
});

test('search_files hides a value that a later file names as a secret', async () => {
	// No key shape: only b.pipe's field name says it is a secret, and a-notes.md comes first in the walk.
	const value = 'Zq9mPx4tLrWw';
	const ws = createMemoryWorkspace({ 'a-notes.md': `backup login ${value}\n`, 'pipelines/b.pipe': `{"apikey": "${value}"}` });
	const found = await run(ws, 'search_files', { pattern: 'backup login' });
	assert.ok(!found.includes(value), found);
	assert.match(found, /^1 match\(es\):\na-notes\.md:1: backup login «secret:[0-9a-f]{8}»$/);
	assert.match(await run(ws, 'search_files', { pattern: 'Zq9m' }), /^No matches/, 'a search cannot probe the value in either file');
});

test('an edit anchor matches the text the model sees, so it cannot test a guess at a hidden value', async () => {
	const key = 'canary-inline-4d1f9a';
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': inlineKeyPipe(key) });
	const marker = markerIn(await run(ws, 'read_file', { path: 'pipelines/a.pipe' }));
	const before = ws.files.get('pipelines/a.pipe');
	// a right guess at the start of the value misses, and so does part of a marker
	const guesses = ['"apikey": "canary-', `"apikey": "${marker.slice(0, 12)}`]; // gitleaks:allow, made-up test value
	for (const oldString of guesses) {
		await assert.rejects(run(ws, 'edit_file', { path: 'pipelines/a.pipe', oldString, newString: '"apikey": "x' }), /^Error: edit_file: oldString not found in pipelines\/a\.pipe\./, oldString); // gitleaks:allow, made-up test value
	}
	assert.equal(ws.files.get('pipelines/a.pipe'), before, 'nothing was written');
	// the whole marker matches, and the edit lands on the real text
	await run(ws, 'edit_file', { path: 'pipelines/a.pipe', oldString: `"${marker}",`, newString: `"${marker}",\n    "model": "gpt-5",`, replaceAll: true });
	assert.deepEqual(JSON.parse(ws.files.get('pipelines/a.pipe') ?? '').components[1].config, { apikey: key, model: 'gpt-5', fallback: '${ROCKETRIDE_OPENAI_KEY}' });
});

test('a second copy of a hidden value in the same file is hidden on the first read', async () => {
	// Only the apikey field gives the value away; the copy in the description has no field name or shape.
	const value = 'Zq9mPx4tLrWw';
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': JSON.stringify({ description: `backup login ${value}`, components: [{ id: 'llm_1', config: { apikey: value } }] }, null, 1) });
	const read = await run(ws, 'read_file', { path: 'pipelines/a.pipe' });
	assert.ok(!read.includes(value), read);
	assert.match(read, /"description": "backup login («secret:[0-9a-f]{8}»)",[\s\S]*"apikey": "\1"/, 'both copies show the one marker');
});

test('a hidden value shows as its marker outside its field only when it has 16 characters, or 8 and one that is not a letter', () => {
	const rows: Array<[value: string, outside: boolean]> = [
		['abcdefghijklmno', false],
		['abcdefghijklmnop', true],
		['passw0rd', true],
		['contraseña', false],
	];
	for (const [value, outside] of rows) {
		const markers = new SecretMarkers();
		markers.hide('.env', `DB_PASSWORD=${value}\n`);
		assert.equal(markers.hideKnown(`the ${value} node`) !== `the ${value} node`, outside, value);
	}
});

test('generated files: a read writes back whole, passes redactText unchanged, and takes edits where the model saw them', () => {
	// Pieces of keys, fields, quotes, tags and URLs, joined at random with a fixed seed. 300,000 such files passed when this was written.
	const pieces = ['{', '}', '[', ']', ',', ':', ' ', '\n', '"', "'", '\\', '\\"', "''", '#', ' #', '!!str ', '&pw ', '*pw', '|', '- ', '"apikey"', '"password"', '"token"', '"max_tokens"', '"credentials"', '"url"', '"auth_token"', 'password: ', 'token: ', 'DATABASE_URL: ', '"hunter2hunter2"', '12345678', '4096', '-5', '"4096"', '"${ROCKETRIDE_KEY}"', 'Zq9mPx4tLrWw', 'postgres://admin:hunter2@db/x', 'http://h:8080?e=b@x.y', 'https://u:p@h', '://', '@', `sk-${'a'.repeat(20)}`, `sk_live_${'b'.repeat(20)}`, `ghp_${'c'.repeat(36)}`, 'Bearer ', 'd'.repeat(24), `AKIA${'E'.repeat(16)}`, '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', 'é'];
	const paths = ['a.pipe', 'b.json', 'c.yaml', 'd.md', '.env'];
	let seed = 1;
	// mulberry32: a small seeded generator, so a failure reproduces
	const random = (): number => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
	const marker = /«secret:[0-9a-f]{8}»/g;
	for (let n = 0; n < 3000; n++) {
		const markers = new SecretMarkers();
		const path = pick(paths);
		const text = Array.from({ length: 1 + Math.floor(random() * 30) }, () => pick(pieces)).join('');
		const shown = markers.hide(path, text).text;
		const where = `${path} ${JSON.stringify(text)}`;
		assert.equal(markers.reveal(shown, 'write_file'), text, `writes back whole: ${where}`);
		assert.equal(redactText(shown), shown, `redactText changes nothing: ${where}`);

		// an anchor cut from what the model saw matches where it shows, skipping any place it cuts a marker
		const from = Math.floor(random() * shown.length);
		const anchor = shown.slice(from, from + 1 + Math.floor(random() * 12));
		const placed = [...shown.matchAll(marker)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
		const seen: Array<{ start: number; end: number }> = [];
		for (let at = shown.indexOf(anchor); at >= 0; ) {
			const end = at + anchor.length;
			const cuts = placed.some((p) => at < p.end && end > p.start && (at > p.start || end < p.end));
			if (!cuts) seen.push({ start: at, end });
			at = shown.indexOf(anchor, cuts ? at + 1 : end);
		}
		const found = markers.anchors(path, text, anchor);
		assert.equal(found.length, seen.length, `anchor ${JSON.stringify(anchor)} count: ${where}`);
		const edited = found.reduceRight((out, { start, end }) => out.slice(0, start) + 'X' + out.slice(end), text);
		const expected = markers.reveal(
			seen.reduceRight((out, { start, end }) => out.slice(0, start) + 'X' + out.slice(end), shown),
			'edit_file'
		);
		assert.equal(edited, expected, `anchor ${JSON.stringify(anchor)} edit: ${where}`);
	}
});

test('a pasted key never reaches the model, the title, the catalog or the saved session', async () => {
	const store = fakeStore();
	const key = `sk-proj-${'h'.repeat(40)}`;
	// The key starts past the title's 60-character cut: a title cut first would keep part of it.
	const text = `Please build the chat pipeline and use my key: ${key}`;
	const session = AgentSession.newSession();
	const message = 'That message looks like it contains a key (OpenAI-style). I did not send it to the model. Put it in Variables and refer to it as ${ROCKETRIDE_<NAME>}.';
	await assert.rejects(session.execute(text, undefined, chatTurn()), { message });
	assert.deepEqual(store.modelCalls, [], 'the model was never started or asked');
	assert.equal(session.title, 'Please build the chat pipeline and use my key: [redacted]');

	// The chat hook appends the user's row and the error row, then saves; an
	// earlier thinking row with a key in it is saved too.
	const thinking = `- rocketride_client getTaskStatus — error: token rejected: ghp_${'i'.repeat(36)}`;
	const rows: ChatMessage[] = [
		{ id: 1, sender: 'status', sseType: 'thinking', text: thinking, timestamp: '' },
		{ id: 2, sender: 'user', text, timestamp: '' },
		{ id: 3, sender: 'bot', text: message, isError: true, timestamp: '' },
	];
	await session.save(rows);
	const stored = JSON.stringify([...store.files.values()]);
	assert.ok(!stored.includes(key) && !stored.includes('ghp_'), stored);
	assert.match(stored, /"title":"Please build the chat pipeline and use my key: \[redacted\]"/);
	assert.deepEqual(
		session.messages.map((m) => m.text),
		['- rocketride_client getTaskStatus — error: token rejected: [redacted]', 'Please build the chat pipeline and use my key: [redacted]', message],
		'a reopened session starts from the redacted rows'
	);
});

test('a queued message with a key that opens its own turn never reaches the model, and is saved redacted', async () => {
	const store = fakeStore();
	const key = `sk-proj-${'q'.repeat(40)}`;
	const session = AgentSession.newSession();
	// The first turn holds the slot and takes nothing, so the message sent meanwhile opens the next turn.
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let turns = 0;
	const chat = new TurnController({
		request: () => async (text, sink, turn) => {
			if (++turns > 1) return session.execute(text, sink, turn);
			await held;
			return [{ text: 'Done.', key: '' }] as TextResult[];
		},
		now: () => '12:00',
		stopGraceMs: 0,
	});
	chat.send('Build the chat pipeline.');
	chat.send(`Use my key: ${key}`);
	release();
	for (let i = 0; i < 100 && chat.snapshot().phase !== 'idle'; i++) await new Promise((resolve) => setTimeout(resolve, 1));

	const rows = chat.snapshot().messages;
	assert.equal(turns, 2, 'the queued message opened its own turn');
	assert.deepEqual(store.modelCalls, [], 'the model was never started or asked');
	assert.ok(
		rows.some((m) => m.isError && m.text.startsWith('That message looks like it contains a key (OpenAI-style).')),
		'the error row points to Variables'
	);
	await session.save(rows);
	const stored = JSON.stringify([...store.files.values()]);
	assert.ok(!stored.includes(key), stored);
	assert.match(stored, /Use my key: \[redacted\]/);
});

test('a key the user sends never shows in their own row, live or queued, and the chat says where the key goes', async () => {
	const store = fakeStore();
	const midRun = `sk-proj-${'m'.repeat(40)}`;
	const pasted = `sk-proj-${'p'.repeat(40)}`;
	const session = AgentSession.newSession();
	// The first turn waits, then takes the message sent meanwhile; the pasted message later opens its own turn.
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const heard: string[][] = [];
	let turns = 0;
	const chat = new TurnController({
		request: () => async (text, sink, turn) => {
			if (++turns > 1) return session.execute(text, sink, turn);
			await held;
			heard.push(turn.takeQueued());
			return [{ text: 'Done.', key: '' }] as TextResult[];
		},
		now: () => '12:00',
		stopGraceMs: 0,
	});
	// as AgentConversation's handleSend does, with isTyping read before the send
	const send = (text: string): void => {
		const running = chat.snapshot().phase !== 'idle';
		const screened = session.screen(text);
		chat.send(screened.text);
		if (screened.note && running) chat.addSystemMessage(screened.note);
	};
	const settled = async (): Promise<void> => {
		for (let i = 0; i < 100 && chat.snapshot().phase !== 'idle'; i++) await new Promise((resolve) => setTimeout(resolve, 1));
	};
	assert.deepEqual(session.screen('Set max_tokens to 4096.'), { text: 'Set max_tokens to 4096.', note: '' }, 'a message with no key is sent as typed');

	send('Build the chat pipeline.');
	send(`Also use this key: ${midRun}`);
	const queued = chat.snapshot().messages.filter((m) => m.queued);
	assert.deepEqual(
		queued.map((m) => m.text),
		['Also use this key: [redacted]'],
		'the queued row shows no key'
	);
	release();
	await settled();
	send(`Here is my key: ${pasted}`);
	await settled();

	const rows = chat.snapshot().messages;
	assert.deepEqual(heard, [['Also use this key: [redacted]']], 'the running turn read the message without its key');
	assert.deepEqual(
		rows.filter((m) => m.sender === 'user').map((m) => m.text),
		['Build the chat pipeline.', 'Also use this key: [redacted]', 'Here is my key: [redacted]']
	);
	assert.deepEqual(
		rows.filter((m) => m.sender === 'system').map((m) => m.text),
		['I removed a key (OpenAI-style) from your message, so it was not sent. Put it in Variables and refer to it as `${ROCKETRIDE_<NAME>}`.'],
		'a send during a turn gets the note'
	);
	assert.ok(
		rows.some((m) => m.isError && m.text.startsWith('That message looks like it contains a key (OpenAI-style).')),
		'the pasted message opened a turn that was refused, and the error row points to Variables'
	);
	assert.equal(turns, 2);
	assert.deepEqual(store.modelCalls, [], 'the model was never started or asked');
	const shown = JSON.stringify(rows);
	assert.ok(!shown.includes(midRun) && !shown.includes(pasted), shown);
	await session.save(rows);
	const stored = JSON.stringify([...store.files.values()]);
	assert.ok(!stored.includes(midRun) && !stored.includes(pasted), stored);
});

test('leak test: no canary reaches a question, a thinking chunk, an approval card, the answer, the saved session or the catalog', async () => {
	// One canary per way in. pipeField and quotedField have no key shape, so only a field name gives them away.
	const canaries = {
		pipeField: 'canary-pipe-field-7c2e',
		quotedField: 'canary-quoted-field-8d3f',
		freeText: `sk-canary-free-text-${'1'.repeat(8)}`,
		toolError: `ghp_${'2'.repeat(36)}`,
		runResult: `sk-canary-run-result-${'3'.repeat(8)}`,
		consoleRow: `xoxb-canary-console-${'4'.repeat(8)}`,
		history: `AKIA${'5'.repeat(16)}`,
		answer: `sk-ant-api03-canary-answer-${'6'.repeat(8)}`,
		prompt: `sk-proj-canary-prompt-${'7'.repeat(8)}`,
		midRun: `sk-canary-mid-run-${'9'.repeat(8)}`,
		guide: `sk-canary-guide-${'a'.repeat(8)}`,
		cardName: `sk-canary-card-name-${'b'.repeat(8)}`,
		prepareError: `canary-prepare-pw-${'c'.repeat(8)}`,
	};
	const ws = withReadOnlyReference(
		createMemoryWorkspace({
			'pipelines/leak.pipe': inlineKeyPipe(canaries.pipeField),
			'pipelines/quoted.pipe': inlineKeyPipe(canaries.quotedField),
			'notes/setup.md': `Set OPENAI_API_KEY=${canaries.freeText} before you run it.`,
			'apps/daybook-ui/package.json': JSON.stringify({ appManifest: { id: 'daybook', name: 'Daybook' } }),
			'apps/daybook-ui/src/App.tsx': 'export default function App() { return null; }',
			'.rocketride/docs/ROCKETRIDE_SETUP.md': `An example config:\n\n    OPENAI_API_KEY=${canaries.guide}\n`,
		})
	);
	// The store's error quotes a URL with its password; rocketride_client reads the file while it prepares the call.
	const read = ws.read.bind(ws);
	ws.read = async (path) => {
		if (path === 'pipelines/broken.pipe') throw new Error(`the store refused the read: postgres://admin:${canaries.prepareError}@db.example.invalid/store`);
		return read(path);
	};
	// The run prints a key a read hid. The deployment's name, as the server holds it, goes on the schedule card.
	const { client } = scriptedClient({ use: { token: 'tk_run_0001', output: `the run printed ${canaries.runResult} and ${canaries.quotedField}` }, getServices: { services: { chat: {}, llm_openai: {} } }, validate: { errors: [], warnings: [] }, 'deploy.get': { pipelineName: `Nightly digest ${canaries.cardName}` }, 'deploy.setSchedule': {} });
	(client as unknown as Record<string, unknown>).getTaskStatus = async () => {
		throw new Error(`token rejected: ${canaries.toolError}`);
	};
	const history: ChatMessage[] = [
		{ id: 1, sender: 'user', text: `My old AWS key is ${canaries.history}`, timestamp: '' },
		{ id: 2, sender: 'bot', text: 'Noted.', timestamp: '' },
	];
	const model = scriptedModel([
		plan(['read_file', { path: 'pipelines/leak.pipe' }], ['read_file', { path: 'pipelines/quoted.pipe' }], ['read_file', { path: 'notes/setup.md' }], ['search_files', { pattern: 'OPENAI_API_KEY' }], ['rocketride_client', { method: 'getTaskStatus', params: ['tk_run_0001'] }], ['rocketride_client', { method: 'use', params: [{ filepath: 'pipelines/leak.pipe' }] }], ['read_file', { path: '.rocketride/docs/ROCKETRIDE_SETUP.md' }], ['search_files', { pattern: 'OPENAI_API_KEY', path: '.rocketride/docs' }], ['rocketride_client', { method: 'deploy.setSchedule', params: ['p1', 'webhook_1', '0 9 * * *', 't1'] }], ['rocketride_client', { method: 'use', params: [{ filepath: 'pipelines/broken.pipe' }] }]),
		(q) => {
			// the first marker is leak.pipe's: its read is the wave's first result
			const marker = markerIn(JSON.stringify(q));
			return plan(['edit_file', { path: 'pipelines/leak.pipe', oldString: `"apikey": "${marker}"`, newString: `"apikey": "${marker}", "model": "gpt-5"` }], ['check_app', { app: 'daybook-ui' }], ['write_file', { path: '.rocketride/docs/ROCKETRIDE_SETUP.md', content: `{"apikey": "${marker}"}` }]);
		},
		done(`Tidied. A model that echoes a key, like ${canaries.answer}, has it redacted.`),
	]);
	// The user writes again while the turn runs; the first wave takes it.
	const midRun = `Use this key for the model instead: ${canaries.midRun}`;
	// The user denies the schedule card; the chat then adds the card's status row, as the shell does.
	const asked = fakeAsk(['deny']);
	const chunks = await agentTurn(ws, model, { client, history, dev: session({ state: 'ok' }, `Request failed with ${canaries.consoleRow}`), queued: [midRun], ask: asked.ask });
	const cardRows = asked.cards.map((card, i): ChatMessage => ({ id: 80 + i, sender: 'status', sseType: 'approval', text: `Denied: ${card.title}`, timestamp: '' }));

	// The pasted prompt goes through the session, and the whole transcript is saved.
	const store = fakeStore();
	const agentSession = AgentSession.newSession();
	const prompt = `Here is my key: ${canaries.prompt}`;
	await assert.rejects(agentSession.execute(prompt, undefined, chatTurn()), /looks like it contains a key/);
	const rows: ChatMessage[] = [...history, { id: 3, sender: 'user', text: 'Describe and tidy the leak pipeline.', timestamp: '' }, { id: 89, sender: 'user', text: midRun, timestamp: '' }, ...chunks.map((c, i): ChatMessage => (c.type === 'thinking' ? { id: 4 + i, sender: 'status', sseType: 'thinking', text: c.text, timestamp: '' } : { id: 4 + i, sender: 'bot', text: c.text, timestamp: '' })), ...cardRows, { id: 90, sender: 'user', text: prompt, timestamp: '' }, { id: 91, sender: 'bot', text: 'That message looks like it contains a key (OpenAI-style).', isError: true, timestamp: '' }];
	await agentSession.save(rows);

	const seen = {
		questions: JSON.stringify(model.questions),
		thinking: chunks
			.filter((c) => c.type === 'thinking')
			.map((c) => c.text)
			.join('\n'),
		answer: chunks
			.filter((c) => c.type === 'content')
			.map((c) => c.text)
			.join('\n'),
		cards: JSON.stringify(asked.cards),
		session: JSON.stringify([...store.files].filter(([path]) => !path.endsWith('/catalog.json'))),
		catalog: JSON.stringify([...store.files].filter(([path]) => path.endsWith('/catalog.json'))),
	};
	const leaks = Object.entries(seen).flatMap(([where, text]) => Object.entries(canaries).flatMap(([name, canary]) => (text.includes(canary) ? [`${name} in the ${where}`] : [])));
	assert.deepEqual(leaks, []);
	assert.equal(model.questions.length, 3, 'every planned wave ran');
	assert.deepEqual(store.modelCalls, [], 'the pasted prompt never reached the model');
	assert.ok(seen.questions.includes('tk_run_0001'), 'the run token stays readable');
	assert.ok(seen.questions.includes('Use this key for the model instead: [redacted]'), 'the mid-run message reached the model, without its key');
	assert.match(seen.answer, /like \[redacted\], has it redacted/);
	assert.deepEqual(
		asked.cards.map((card) => card.title),
		['Schedule Nightly digest [redacted] (webhook_1) on team t1 to run 0 9 * * *'],
		'the card was shown, without the key'
	);
	assert.ok(seen.questions.includes('The user declined: Schedule Nightly digest [redacted]'), 'the model read the refusal, without the key');
	assert.ok(seen.questions.includes("Cannot read 'pipelines/broken.pipe': the store refused the read: postgres://admin:[redacted]@db.example.invalid/store"), 'the model read the prepare error, without the password');
	assert.ok(seen.questions.includes('.rocketride/ is read-only reference.'), 'the write to the guide was refused');
	assert.deepEqual(JSON.parse(ws.files.get('pipelines/leak.pipe') ?? '').components[1].config, { apikey: canaries.pipeField, model: 'gpt-5', fallback: '${ROCKETRIDE_OPENAI_KEY}' }, 'the file keeps the real key');
	assert.equal(ws.files.get('.rocketride/docs/ROCKETRIDE_SETUP.md'), `An example config:\n\n    OPENAI_API_KEY=${canaries.guide}\n`, 'the guide is unchanged');
});

test('a value a read hid shows as its marker on an approval card, in the Checked line and where a tool cuts a long text', async () => {
	// No key shape: only the .pipe field name gives it away. Each long text repeats it, so every cut lands in a copy, and § shows any part left.
	const key = '§canary-card-and-check-5e1a§';
	const long = key.repeat(2_000);
	const ws = createMemoryWorkspace({
		'pipelines/a.pipe': inlineKeyPipe(key),
		'apps/daybook-ui/package.json': JSON.stringify({ appManifest: { id: 'daybook', name: 'Daybook' } }),
		'apps/daybook-ui/src/App.tsx': 'export default function App() { return null; }',
	});
	// The deployment's name, as the server holds it, and the build error quote the key; the run, the task, the type errors and the build log quote it past their cuts.
	const { client } = scriptedClient({ 'deploy.get': { pipelineName: `Nightly digest ${key}` }, 'deploy.setSchedule': {}, use: { token: 'tk_run_0001', output: long }, getTaskStatus: { log: long }, 'deploy.add': { artifact: { registryVersion: 2 } }, listDeployments: [row(2, 'failed')], buildLog: { log: long } });
	const model = scriptedModel([
		plan(['read_file', { path: 'pipelines/a.pipe' }]),
		plan(['check_app', { app: 'daybook-ui' }], ['rocketride_client', { method: 'deploy.setSchedule', params: ['p1', 'webhook_1', '0 9 * * *', 't1'] }], ['rocketride_client', { method: 'use', params: [{ filepath: 'pipelines/a.pipe' }] }], ['rocketride_client', { method: 'getTaskStatus', params: ['tk_run_0001'] }], ['deploy_app', { app: 'daybook-ui', message: 'Fix the build' }]),
		// the model may write out a value it saw before the read that hid it
		done(`Done. The run printed ${key}.`),
	]);
	const asked = fakeAsk(['deny']);
	const chunks = await agentTurn(ws, model, { client, dev: session({ state: 'error', reason: `config rejected: apikey ${key} ${key.repeat(10)}` }), ask: asked.ask, markers: [{ ...TYPE_ERROR, message: long }] });
	const marker = markerIn(JSON.stringify(model.questions));
	assert.deepEqual(
		asked.cards.map((card) => card.title),
		[`Schedule Nightly digest ${marker} (webhook_1) on team t1 to run 0 9 * * *`]
	);
	assert.ok(chunks.at(-1)?.text.includes(`build failed: config rejected: apikey ${marker}`), chunks.at(-1)?.text);
	const seen = JSON.stringify([model.questions, chunks]);
	assert.ok(!seen.includes('§'), seen.slice(seen.indexOf('§') - 100, seen.indexOf('§') + 20));
});

test('a save note or a console list cut to fit shows no part of a value a read hid', async () => {
	// As above: each long text repeats the key, and § shows any part a cut left.
	const key = '§canary-save-note-7d1c§';
	const long = key.repeat(2_000);
	const ws = createMemoryWorkspace({ 'pipelines/a.pipe': inlineKeyPipe(key), 'apps/daybook-ui/package.json': APP_FILES['apps/daybook-ui/package.json'], 'apps/daybook-ui/src/App.tsx': APP_FILES['apps/daybook-ui/src/App.tsx'] });
	// The first saves' validate and type errors quote the key at length; then both clear, so the run can finish.
	const validation = { errors: [{ message: long }], warnings: [] };
	const markers = [{ ...TYPE_ERROR, message: long }];
	const model = scriptedModel([
		plan(['read_file', { path: 'pipelines/a.pipe' }], ['read_file', { path: 'apps/daybook-ui/src/App.tsx' }]),
		plan(['edit_file', { path: 'pipelines/a.pipe', oldString: '"llm_openai"', newString: '"llm_anthropic"' }], ['write_file', { path: 'apps/daybook-ui/src/App.tsx', content: 'export default function App() { return 1; }' }]),
		() => {
			validation.errors = [];
			markers.length = 0;
			return plan(['edit_file', { path: 'pipelines/a.pipe', oldString: '"llm_anthropic"', newString: '"llm_openai"' }], ['check_app', { app: 'daybook-ui' }]);
		},
		done('Done.'),
	]);
	const chunks = await agentTurn(ws, model, { client: scriptedClient({ getServices: { services: {} }, validate: validation }).client, dev: session({ state: 'ok' }, long), markers });
	assert.match(chunks.at(-1)?.text ?? '', /^Done\./);
	const seen = JSON.stringify(model.questions);
	assert.ok(!seen.includes('§'), seen.slice(seen.indexOf('§') - 100, seen.indexOf('§') + 20));
});

test('a rebuild that cannot run shows no part of a value a read hid in its summary', async () => {
	const key = '§canary-rebuild-2c4e§';
	const fail = (): never => {
		throw new Error(`no build: ${key.repeat(20)}`);
	};
	const hide = (text: string): string => text.replaceAll(key, '«M»');
	for (const dev of [Object.assign(session(), { rebuild: fail }), Object.assign(session(), { subscribeWatch: fail })]) {
		const { report } = await runCheck(appCheck(dev, [], APP_FILES, undefined, hide), 'daybook');
		assert.equal(report.evidence.at(-1)?.summary, `build not run: no build: ${'«M»'.repeat(20)}`);
	}
});

test('known limit: a base64-encoded key reaches the model', { todo: 'redaction matches key shapes and secret-named fields, not encodings' }, async () => {
	const encoded = btoa(`sk-${'8'.repeat(24)}`);
	const model = scriptedModel([plan(['read_file', { path: 'notes/key.txt' }]), done('Read.')]);
	await agentTurn(createMemoryWorkspace({ 'notes/key.txt': encoded }), model);
	assert.ok(!JSON.stringify(model.questions).includes(encoded));
});

test('known limit: a key split across two results reaches the model in halves', { todo: 'neither half has a key shape on its own' }, async () => {
	const key = `sk-${'9'.repeat(24)}`;
	const model = scriptedModel([plan(['read_file', { path: 'notes/a.txt' }], ['read_file', { path: 'notes/b.txt' }]), done('Read.')]);
	await agentTurn(createMemoryWorkspace({ 'notes/a.txt': key.slice(0, 12), 'notes/b.txt': key.slice(12) }), model);
	const asked = JSON.stringify(model.questions);
	assert.ok(!(asked.includes(key.slice(0, 12)) && asked.includes(key.slice(12))));
});

// =============================================================================
// deploy_app
// =============================================================================

test("deploy_app waits for the version it uploaded, not a teammate's newer one", async () => {
	// The upload reply names v5; a teammate's v6 lands beside it and is built first.
	const listings = [[row(4)], [row(6, 'building'), row(5, 'queued'), row(4)], [row(6), row(5, 'building'), row(4)], [row(6), row(5), row(4)]];
	const { client } = fakeClient({ listings, added: { artifact: { registryVersion: 5, buildStatus: 'queued' } } });
	const result = await toolOf(
		appTools(() => client),
		'deploy_app'
	).execute({ app: 'a-ui', message: 'Mine' });
	assert.equal(result, 'Deployed v5; server build OK.');
});

test('a failed server build log cut at its start hides a password the cut splits', async () => {
	const url = 'postgres://admin:hunter2secretpw@db.example.invalid/x';
	// The 8,000-character tail starts inside the URL, after its scheme, where no pattern sees a URL password.
	const log = `${url}${'z'.repeat(8_000 - url.length + 'postgres://ad'.length)}`;
	const listings = [[row(4)], [row(5, 'failed'), row(4)]];
	const { client } = fakeClient({ listings, added: { artifact: { registryVersion: 5, buildStatus: 'queued' } }, log });
	const result = await toolOf(
		appTools(() => client),
		'deploy_app'
	).execute({ app: 'a-ui', message: 'Mine' });
	assert.match(result, /^Deployed v5; server build FAILED:/);
	assert.ok(!result.includes('hunter2secretpw'), result.slice(0, 120));
});

// =============================================================================
// check_app
// =============================================================================

/** Timings small enough for a test. */
const APP_FAST: AppCheckOptions = { build: { buildWaitMs: 1000, settleMs: 20, runtimeGraceMs: 20 }, types: { quietMs: 10, maxMs: 200 } };

/** One healthy app, one whose manifest has no id, one whose package.json no longer parses. */
const APP_FILES = {
	'apps/daybook-ui/package.json': JSON.stringify({ appManifest: { id: 'daybook', name: 'Daybook' } }),
	'apps/daybook-ui/src/App.tsx': 'export default function App() { return null; }',
	'apps/noid-ui/package.json': JSON.stringify({ appManifest: { name: 'No Id' } }),
	'apps/broken-ui/package.json': '{ "appManifest": { "id": "broken", ',
};

/** A TypeScript error in the app's one source file. */
const TYPE_ERROR: MarkerInfo = { uri: 'file:///daybook/src/App.tsx', line: 3, message: "Type 'string' is not assignable to type 'number'.", severity: 8, owner: 'typescript' };

/**
 * A dev session with the Design preview open, whose rebuild goes building, then `end`.
 *
 * @param end - Where the build ends.
 * @param consoleError - A console error the app logs while it builds, if any.
 * @returns The session.
 */
function session(end: WatchStatus = { state: 'ok' }, consoleError?: string): AgentDevSession {
	const watchers = new Set<(s: WatchStatus) => void>();
	const consoles = new Set<(r: ConsoleRow) => void>();
	return {
		appId: 'daybook',
		previewAttached: true,
		rebuild: async () => {
			for (const l of [...watchers]) l({ state: 'building' });
			setTimeout(() => {
				if (consoleError) for (const l of [...consoles]) l({ time: '12:00:00', level: 'error', text: consoleError });
				for (const l of [...watchers]) l(end);
			}, 5);
		},
		subscribeConsole: (l) => {
			consoles.add(l);
			return () => consoles.delete(l);
		},
		subscribeErrors: () => () => undefined,
		subscribeWatch: (l) => {
			l({ state: 'ok' });
			watchers.add(l);
			return () => watchers.delete(l);
		},
	};
}

/**
 * Monaco's own Uri, which the dev session names a model with. The module has
 * no type declarations, hence the cast.
 *
 * @returns The uri a model named from `value` gets, spelled as the marker source spells it.
 */
async function monacoModelUri(): Promise<(value: string) => string> {
	const { URI } = (await import('monaco-editor/esm/vs/base/common/uri.js' as string)) as { URI: { parse(value: string): { toString(skipEncoding?: boolean): string } } };
	return (value) => URI.parse(value).toString(true);
}

/**
 * The check_app toolkit over APP_FILES, with `markers` in the editor, and every report it hands the run.
 *
 * @param dev - The app's dev session.
 * @param markers - The markers Monaco holds.
 * @param files - The workspace's files (default: APP_FILES).
 * @param models - The uri of each model Monaco holds (default: daybook's App.tsx).
 * @param hide - Hides the values the run's file tools hid.
 * @returns The toolkit and the reports it has reported.
 */
function appCheck(dev: AgentDevSession, markers: MarkerInfo[] = [], files: Record<string, string> = APP_FILES, models = ['file:///daybook/src/App.tsx'], hide?: (text: string) => string): { toolkit: AppCheckToolkit; heard: CheckReport[] } {
	const host: AgentHost = {
		vfs: createMemoryWorkspace(files),
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array(),
		devSession: () => dev,
	};
	const heard: CheckReport[] = [];
	const toolkit = new AppCheckToolkit(
		host,
		async () => {
			const modelUri = await monacoModelUri();
			return { modelUris: () => models, modelUri: (appId: string, relPath: string) => modelUri(`file:///${appId}/${relPath}`), markers: () => markers, onChange: () => () => undefined };
		},
		(_folder, report) => heard.push(report),
		{ ...APP_FAST, hide }
	);
	return { toolkit, heard };
}

/**
 * Calls check_app, as the model would.
 *
 * @param check - The toolkit and what it reported.
 * @param app - The app to check.
 * @returns The text the model reads and the report the run heard.
 */
async function runCheck(check: { toolkit: AppCheckToolkit; heard: CheckReport[] }, app: string): Promise<{ text: string; report: CheckReport }> {
	const text = await toolOf(check.toolkit, 'check_app').execute({ app });
	return { text, report: check.heard[0] };
}

/** Each step of a report with its status. */
function steps(report: CheckReport): string[] {
	return report.evidence.map((e) => `${e.step} ${e.status}`);
}

test('type errors fail the app check', async () => {
	const { text, report } = await runCheck(appCheck(session(), [TYPE_ERROR]), 'daybook-ui');
	assert.match(text, /^CHECK FAILED: daybook/);
	assert.deepEqual(steps(report), ['types fail', 'build pass', 'runtime pass']);
});

test('a failed build fails the app check', async () => {
	const { text, report } = await runCheck(appCheck(session({ state: 'error', reason: '"left-pad" is not a declared dependency' })), 'daybook-ui');
	assert.match(text, /^CHECK FAILED: daybook/);
	assert.deepEqual(steps(report), ['types pass', 'build fail']);
});

test("a failed build's summary hides a password the summary cut splits", async () => {
	const url = 'postgres://admin:hunter2secretpw@db.example.invalid/x';
	// The summary keeps 199 characters of the reason, which ends just before the @.
	const reason = `${'r'.repeat(199 - 1 - url.indexOf('@'))} ${url}`;
	const { text, report } = await runCheck(appCheck(session({ state: 'error', reason })), 'daybook-ui');
	assert.deepEqual(steps(report), ['types pass', 'build fail']);
	assert.ok(!JSON.stringify(report).includes('hunter2secretpw'), JSON.stringify(report));
	assert.ok(!text.includes('hunter2secretpw'), text);
});

test('console errors are reported but do not block the app check', async () => {
	const { text, report } = await runCheck(appCheck(session({ state: 'ok' }, 'Warning: Each child in a list should have a unique "key" prop.')), 'daybook-ui');
	assert.match(text, /^CHECK PASSED: daybook/);
	assert.deepEqual(steps(report), ['types pass', 'build pass', 'runtime pass', 'console pass']);
});

test('a broken manifest fails the app check', async () => {
	const cases: Array<[folder: string, summary: string]> = [
		['noid-ui', 'manifest: appManifest has no id'],
		['broken-ui', 'manifest: package.json has no readable appManifest'],
	];
	for (const [folder, summary] of cases) {
		const { text, report } = await runCheck(appCheck(session()), folder);
		assert.match(text, /^CHECK FAILED: /, folder);
		assert.equal(report.evidence[0].summary, summary, folder);
	}
});

test('type errors of a deleted file are ignored and named, matching each file to its model by the name the editor gives it', async () => {
	// step: the dev session names a model with Uri.parse, which decodes each %XX once; the file list keeps the stored name
	const cases = [
		{ stored: 'src/foo%20bar.ts', model: 'src/foo bar.ts' },
		{ stored: 'src/a%2520b.ts', model: 'src/a%20b.ts' },
	];
	for (const { stored, model } of cases) {
		const error: MarkerInfo = { ...TYPE_ERROR, uri: `file:///daybook/${model}` };
		const models = ['file:///daybook/src/App.tsx', error.uri];
		const files = { ...APP_FILES, [`apps/daybook-ui/${stored}`]: 'export const x: number = "wrong";' };
		const kept = await runCheck(appCheck(session(), [error], files, models), 'daybook-ui');
		assert.match(kept.text, /^CHECK FAILED: daybook/, stored);
		assert.ok(kept.report.evidence[0].output.startsWith(`${model}:3 Type 'string'`), `${stored}: the error counts while the file exists`);
		const gone = await runCheck(appCheck(session(), [error], APP_FILES, models), 'daybook-ui');
		assert.match(gone.text, /^CHECK PASSED: daybook/, `${stored}: a run that deleted the file can finish`);
		assert.deepEqual(steps(gone.report), ['types pass', 'build pass', 'runtime pass'], stored);
		assert.ok(gone.report.evidence[0].output.endsWith(`\nIgnored 1 marker for a file that no longer exists: ${model}.`), `${stored}: the error is ignored once the file is deleted`);
	}
});

// =============================================================================
// THE RUN — a whole run over the memory workspace
// =============================================================================

/**
 * Runs the agent once over a workspace with a scripted model, with the
 * unsaved-changes prompt and the open editors, and the run's stop signal.
 * agentTurn covers the chat's cards; this covers the editors' dialog.
 *
 * @param ws - The workspace.
 * @param replies - The model's replies; a function runs when its turn comes and returns the reply.
 * @param markers - Monaco's markers as the run sees them.
 * @param prompt - The user's answers to the unsaved-changes prompt, and the open editors.
 * @param signal - The run's stop signal (the user's Stop).
 * @returns Every question asked, and the answer.
 */
async function runScripted(ws: MemoryWorkspace, replies: Array<string | (() => Promise<string>)>, markers: MarkerSource | null = null, prompt?: { choose: ChoiceFn; editors: Record<string, EditorControl> }, signal: AbortSignal = new AbortController().signal): Promise<{ questions: QuestionSpec[]; answer: string }> {
	const questions: QuestionSpec[] = [];
	let answer = '';
	const host: AgentHost = { vfs: ws, scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array(), devSession: () => null, ...(prompt ? { editor: (path: string) => prompt.editors[path] ?? null } : {}) };
	await runAgent(
		'Do it.',
		(type, text) => {
			if (type === 'content') answer = text;
		},
		{ history: [], prompts: BUILDER_PROMPTS, token: async () => '', signal, takeQueued: () => [] },
		{
			host,
			client: () => null,
			markers: async () => markers,
			...(prompt ? { choose: prompt.choose } : {}),
			model: async (q) => {
				questions.push(q);
				const next = replies.shift();
				if (next === undefined) throw new Error('The scripted model has no reply left.');
				return typeof next === 'string' ? next : next();
			},
		}
	);
	return { questions, answer };
}

test('each wave names the files someone else changed since the agent read them, once', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1', 'b.ts': 'b = 1' });
	const notes = (q: QuestionSpec) => q.context.filter((c) => c.startsWith('Files changed since'));
	const model = scriptedModel([
		plan(['read_file', { path: 'a.ts' }]),
		async () => {
			await ws.write('a.ts', 'a = 2', 'editor');
			return plan(['read_file', { path: 'b.ts' }]);
		},
		plan(['stat_file', { path: 'b.ts' }]),
		done('Read.'),
	]);
	await agentTurn(ws, model);
	assert.deepEqual(model.questions.map(notes), [[], [], ['Files changed since you last read them: a.ts (editor). Read them again before editing.'], []]);
	assert.equal(model.questions[0].instructions, model.questions[2].instructions, 'the cached start is unchanged');
});

test('after Keep mine the model can ask the user at once: a refused change needs no check', async () => {
	const ws = createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ appManifest: { id: 'a', name: 'A' } }), 'apps/a-ui/src/App.tsx': 'export default () => null;' });
	const editor = dirtyEditor(ws, 'apps/a-ui/src/App.tsx', 'export default () => null; // mine');
	const { questions, answer } = await runScripted(ws, [plan(['read_file', { path: 'apps/a-ui/src/App.tsx' }]), plan(['edit_file', { path: 'apps/a-ui/src/App.tsx', oldString: 'null', newString: '1' }]), done('You have unsaved changes in App.tsx. Shall I wait?')], null, { choose: fakeChoice('keep').choose, editors: { 'apps/a-ui/src/App.tsx': editor } });
	assert.match(questions[2].context.join('\n'), /The user kept their unsaved changes in apps\/a-ui\/src\/App\.tsx/);
	assert.equal(questions.length, 3, 'the answer was accepted without a check_app');
	assert.match(answer, /^You have unsaved changes in App\.tsx\. Shall I wait\?/);
	assert.doesNotMatch(answer, /Not checked/);
	assert.deepEqual(ws.log, []);
});

test('after Save mine first a stale write_file still counts as a change: the app needs its check', async () => {
	const ws = createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ appManifest: { id: 'a', name: 'A' } }), 'apps/a-ui/src/App.tsx': 'export default () => null;' });
	const editor = dirtyEditor(ws, 'apps/a-ui/src/App.tsx', 'export default () => null; // mine');
	const { questions } = await runScripted(ws, [plan(['read_file', { path: 'apps/a-ui/src/App.tsx' }]), plan(['write_file', { path: 'apps/a-ui/src/App.tsx', content: 'export default () => 1;' }]), done('Done.'), done('Done.')], null, { choose: fakeChoice('save').choose, editors: { 'apps/a-ui/src/App.tsx': editor } });
	assert.match(questions[2].context.join('\n'), /the user saved their unsaved changes in apps\/a-ui\/src\/App\.tsx first/);
	assert.match(questions[3].context.join('\n'), /check_app/, 'the done was sent back for a check, since the file changed');
	assert.equal(ws.files.get('apps/a-ui/src/App.tsx'), 'export default () => null; // mine');
});

test('the run hands each question a signal that aborts when the run ends', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	const editor = dirtyEditor(ws, 'a.ts', 'a = 1 // mine');
	const signals: Array<AbortSignal | undefined> = [];
	const choose: ChoiceFn = async (_title, _message, signal) => {
		signals.push(signal);
		assert.equal(signal?.aborted, false, 'the run is still on when it asks');
		return 'keep';
	};
	await runScripted(ws, [plan(['read_file', { path: 'a.ts' }]), plan(['edit_file', { path: 'a.ts', oldString: '1', newString: '2' }]), done('Kept.')], null, { choose, editors: { 'a.ts': editor } });
	assert.equal(signals.length, 1);
	assert.equal(signals[0]?.aborted, true);
});

test('a run the user stops closes its open question as Keep mine at once', async () => {
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	const editor = dirtyEditor(ws, 'a.ts', 'a = 1 // mine');
	const stop = new AbortController();
	let closed = false;
	let closedAtStop = false;
	const choose: ChoiceFn = (_title, _message, signal) =>
		new Promise((resolve) => {
			signal?.addEventListener(
				'abort',
				() => {
					closed = true;
					resolve('keep');
				},
				{ once: true }
			);
			// step: the user presses Stop while the dialog is open; the dialog closes then, not once the loop has wound down
			stop.abort();
			closedAtStop = closed;
		});
	await runScripted(ws, [plan(['read_file', { path: 'a.ts' }]), plan(['edit_file', { path: 'a.ts', oldString: '1', newString: '2' }]), done('never asked')], null, { choose, editors: { 'a.ts': editor } }, stop.signal);
	assert.equal(closedAtStop, true, 'the question closed as Keep mine the moment the run was stopped');
	assert.equal(ws.files.get('a.ts'), 'a = 1', 'nothing was written');
});

test("a run's question about unsaved changes holds the call's time limit, so an answer given after the limit still lands", async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
	t.mock.method(performance, 'now', () => Date.now());
	const idle = async (): Promise<void> => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	const ws = createMemoryWorkspace({ 'a.ts': 'a = 1' });
	const editor = dirtyEditor(ws, 'a.ts', 'a = 1 // mine');
	let answer: (choice: UnsavedChoice) => void = () => undefined;
	let asked: () => void = () => undefined;
	const open = new Promise<void>((resolve) => (asked = resolve));
	let closed = false;
	const choose: ChoiceFn = (_title, _message, signal) =>
		new Promise((resolve) => {
			answer = resolve;
			signal?.addEventListener('abort', () => (closed = true), { once: true });
			asked();
		});
	const running = runScripted(ws, [plan(['read_file', { path: 'a.ts' }]), plan(['edit_file', { path: 'a.ts', oldString: 'a = 1', newString: 'a = 2' }]), done('Edited.')], null, { choose, editors: { 'a.ts': editor } });
	// step: the user takes longer than the limit to answer; the clock moves only once the question is open, since the read's hash takes real time
	await open;
	t.mock.timers.tick(TOOL_TIMEOUT_MS + 1000);
	await idle();
	assert.equal(closed, false, 'the question is still open');
	answer('save');
	const { questions } = await running;
	assert.match(questions[2].context.join('\n'), /Replaced 1 occurrence/);
	assert.equal(ws.files.get('a.ts'), 'a = 2 // mine');
});
