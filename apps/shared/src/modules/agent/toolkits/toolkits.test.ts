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
// TOOLKIT TESTS — read before edit, no overwriting unsaved editor changes, read-only guides,
// the user says yes first, the RocketRide client tool, deploy_app keeps its version, check_app
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';

import type { ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import type { IWorkspaceFileSystem, VfsEntry } from '../../vfs/vfsTypes';
import { GuideFileSystem, guidePathFor } from '../guides';
import type { AgentDevSession, AgentHost } from '../host';
import type { AgentTool } from '../tools';
import { AppCheckToolkit, type AppCheckOptions, type CheckReport, type MarkerInfo } from './appCheck';
import { AppToolkit } from './appTools';
import { declined, NOT_CONNECTED_MESSAGE, type ConfirmFn } from './common';
import { FilesystemTools } from './filesystem';
import { RocketRideClientToolkit } from './rocketrideClient';

// =============================================================================
// MEMORY WORKSPACE — an in-memory IWorkspaceFileSystem for these tests
// =============================================================================

/**
 * A fake workspace that keeps text files in a Map. It satisfies the full
 * IWorkspaceFileSystem view contract so tools and checks run against it
 * unchanged, and it records every mutation in `log` for a test to assert on.
 * The cache and subscription methods do nothing, because an in-memory map has
 * no cache to keep warm.
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
}

/** The workspace class; callers get it through createMemoryWorkspace(). */
class InMemoryWorkspace implements MemoryWorkspace {
	readonly files: Map<string, string>;
	readonly log: MemoryWorkspaceLogEntry[] = [];
	/** Folders made with mkdir(); folders that hold files are implied by their paths. */
	private readonly dirs = new Set<string>();
	private readonly dirty: Set<string>;

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

	// ---- mutations ----

	async write(path: string, content: unknown): Promise<void> {
		if (typeof content !== 'string') throw new Error(`The memory workspace holds text only: ${path}`);
		this.files.set(path, content);
		this.record('write', path);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		if (this.entryType(oldPath) === null) throw new Error(`No such file or directory: ${oldPath}`);
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

	async delete(path: string): Promise<void> {
		if (this.entryType(path) === null) throw new Error(`No such file or directory: ${path}`);
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

/** A tool as these tests call it: prepared, then run, as the loop does once its act is let through. */
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
 * @returns The tool and its call.
 */
function callable(tool: AgentTool): Callable {
	return { tool, execute: async (args) => (await tool.prepare(args)).run() };
}

/** One toolkit per workspace, so reads carry over between calls the way they do within one run. */
const toolkits = new WeakMap<MemoryWorkspace, FilesystemTools>();

/**
 * Runs one filesystem tool by name against a workspace. Calls on the same
 * workspace share one toolkit, as the tools of one agent run do.
 *
 * @param ws - The workspace the tools work on.
 * @param tool - The tool name the model would call.
 * @param args - The tool arguments.
 * @returns The tool result text.
 */
function run(ws: MemoryWorkspace, tool: string, args: Record<string, unknown>): Promise<string> {
	if (!toolkits.has(ws)) toolkits.set(ws, new FilesystemTools(ws));
	const found = toolkits
		.get(ws)
		?.tools()
		.find((t) => t.name === tool);
	if (!found) throw new Error(`No such tool: ${tool}`);
	return callable(found).execute(args);
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
		buildLog: method('buildLog', () => ({ log: '' })),
		publishApp: method('publishApp', () => ({ publish: {} })),
		submitApp: method('submitApp', () => ({ artifact: {} })),
	};
	return { client: client as unknown as RocketRideClient, calls };
}

/**
 * A confirm function that records each title it was asked and answers the same each time.
 *
 * @param answer - What the user says.
 * @returns The function and the titles it was asked.
 */
function fakeConfirm(answer: boolean): { confirm: ConfirmFn; asked: string[] } {
	const asked: string[] = [];
	return {
		confirm: async (title) => {
			asked.push(title);
			return answer;
		},
		asked,
	};
}

/**
 * One of a toolkit's tools by name.
 *
 * @param toolkit - The toolkit.
 * @param name - The tool name.
 * @returns The tool, callable.
 */
function toolOf(toolkit: { tools(): AgentTool[] }, name: string): Callable {
	const found = toolkit.tools().find((t) => t.name === name);
	assert.ok(found, `${name} is mounted`);
	return callable(found);
}

/** The app tools over a fake client and a workspace with one app, `a-ui`, whose manifest id is `acme.a`. */
function appTools(client: RocketRideClient, confirm: ConfirmFn, signal?: AbortSignal): AppToolkit {
	const host: AgentHost = {
		vfs: createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) }),
		guides: { paths: () => [], read: async () => '' },
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array([1, 2, 3]),
		devSession: () => null,
	};
	return new AppToolkit(() => client, host, confirm, { pollMs: 0, buildWaitMs: 50, signal });
}

// =============================================================================
// READ BEFORE EDIT
// =============================================================================

test('edit_file and write_file refuse a file not read, or changed since it was read', async () => {
	const edit = { path: 'a.ts', oldString: 'a', newString: 'b' };
	const write = { path: 'a.ts', content: 'new' };
	const rows: Array<[name: string, tool: string, args: Record<string, unknown>, changed: boolean, message: RegExp]> = [
		['edit, unread', 'edit_file', edit, false, /^Error: edit_file refused: read a\.ts first — edits must start from its current content\.$/],
		['write, unread', 'write_file', write, false, /^Error: write_file refused: read a\.ts first — edits must start from its current content\.$/],
		['edit, changed since read', 'edit_file', edit, true, /^Error: edit_file refused: a\.ts changed since you read it\. Read it again, then redo the edit\.$/],
		['write, changed since read', 'write_file', write, true, /^Error: write_file refused: a\.ts changed since you read it\. Read it again, then redo the edit\.$/],
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

// =============================================================================
// GUIDES — the agent reads guides at .rocketride/ but cannot change them
// =============================================================================

test('the file tools read guides but cannot change them', async () => {
	const base = createMemoryWorkspace({ 'apps/a.ts': 'const a = 1;\n' });
	const guides = { paths: () => ['docs/ROCKETRIDE_APPS.md'], read: async () => '# Apps\nBuild apps here.\n' };
	const tools = new Map(new FilesystemTools(new GuideFileSystem(base, guides)).tools().map((t) => [t.name, t]));
	const run = (name: string, args: Record<string, unknown>) => callable(tools.get(name) as AgentTool).execute(args);
	const guide = '.rocketride/docs/ROCKETRIDE_APPS.md';
	const readOnly = /Guides under \.rocketride\/ are read-only\./;

	assert.match(await run('read_file', { path: guide }), /Build apps here\./);
	await assert.rejects(run('write_file', { path: guide, content: 'x' }), readOnly);
	await assert.rejects(run('edit_file', { path: guide, oldString: 'Apps', newString: 'Mine' }), readOnly);
	await assert.rejects(run('delete_file', { path: guide }), readOnly);
	await assert.rejects(run('rename', { oldPath: guide, newPath: 'a.md' }), readOnly);
	await assert.rejects(run('write_file', { path: '.rocketride/notes.md', content: 'x' }), readOnly);
	await assert.rejects(run('create_directory', { path: '.rocketride/mine' }), readOnly);
	assert.deepEqual(base.log, [], 'nothing reached the workspace');
});

test('the README, CLI and Python guides are not served', async () => {
	const bundle = ['./context/ROCKETRIDE_APPS.md', './context/ROCKETRIDE_README.md', './context/ROCKETRIDE_CLI.md', './context/ROCKETRIDE_python_API.md'];
	const paths = bundle.map((key) => guidePathFor(key)).filter((path): path is string => path !== null);
	const guides = { paths: () => paths, read: async () => '# Apps\n' };
	const tools = new Map(new FilesystemTools(new GuideFileSystem(createMemoryWorkspace({}), guides)).tools().map((t) => [t.name, t]));
	const run = (name: string, args: Record<string, unknown>) => callable(tools.get(name) as AgentTool).execute(args);

	assert.deepEqual(JSON.parse(await run('list_directory', { path: '.rocketride/docs' })), [{ name: 'ROCKETRIDE_APPS.md', type: 'file' }]);
	await assert.rejects(run('read_file', { path: '.rocketride/docs/ROCKETRIDE_README.md' }), /^Error: No guide at \.rocketride\/docs\/ROCKETRIDE_README\.md\. Guides: \.rocketride\/docs\/ROCKETRIDE_APPS\.md$/);
});

// =============================================================================
// THE USER SAYS YES FIRST
// =============================================================================

test('publish_app asks first; a no, or a yes after Stop, publishes nothing', async () => {
	const { client, calls } = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	const { confirm, asked } = fakeConfirm(false);
	const result = await toolOf(appTools(client, confirm), 'publish_app').execute({ app: 'a-ui', target: 'public' });
	assert.equal(asked.length, 1);
	assert.equal(result, declined(asked[0]));
	assert.deepEqual(calls, ['listDeployments'], 'nothing was published or submitted');

	const yes = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	await toolOf(appTools(yes.client, fakeConfirm(true).confirm), 'publish_app').execute({ app: 'a-ui', target: 'public' });
	assert.deepEqual(yes.calls, ['listDeployments', 'publishApp'], 'a yes publishes');

	const stop = new AbortController();
	stop.abort();
	const late = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	await assert.rejects(toolOf(appTools(late.client, fakeConfirm(true).confirm, stop.signal), 'publish_app').execute({ app: 'a-ui', target: 'public' }));
	assert.deepEqual(late.calls, ['listDeployments'], 'a yes after Stop publishes nothing');
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

/** The rocketride_client tool over a client (null for none) and a workspace view. */
function clientTool(client: RocketRideClient | null, vfs: IWorkspaceFileSystem = createMemoryWorkspace({})): Callable {
	return toolOf(new RocketRideClientToolkit(() => client, vfs), 'rocketride_client');
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
	const vfs = new GuideFileSystem(ws, { paths: () => [], read: async () => '' });
	const { client, calls } = scriptedClient({ use: { token: 'tk-1' }, validate: { errors: [], warnings: [] }, 'deploy.add': { artifact: { version: 1 } } });
	const tool = clientTool(client, vfs);

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
		use: { token: 'tk-run-0001', pipeline: { components: [{ id: 'llm_1', config: { apikey: 'sk-fake-not-a-real-key', api_key: '${ROCKETRIDE_OPENAI_KEY}' } }] } },
		'deploy.run': { token: 'tk-run-0002', version: 3 },
		getTasks: [{ token: 'tk-other-0003', name: 'Digest' }],
		getServices: { services, icons: { i1: '<svg/>' }, version: 2 },
	});
	const tool = clientTool(client);

	const used = await tool.execute({ method: 'use', params: [{ pipeline: {} }] });
	assert.match(used, /tk-run-0001/, 'use hands out its run token');
	assert.doesNotMatch(used, /sk-fake-not-a-real-key/);
	assert.match(used, /\[redacted\]/);
	assert.match(used, /\$\{ROCKETRIDE_OPENAI_KEY\}/, 'a placeholder names a key without holding it');
	assert.match(await tool.execute({ method: 'deploy.run', params: ['p1', 'webhook_1', 't1'] }), /tk-run-0002/);
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
// deploy_app
// =============================================================================

test("deploy_app waits for the version it uploaded, not a teammate's newer one", async () => {
	// The upload reply names v5; a teammate's v6 lands beside it and is built first.
	const listings = [[row(4)], [row(6, 'building'), row(5, 'queued'), row(4)], [row(6), row(5, 'building'), row(4)], [row(6), row(5), row(4)]];
	const { client } = fakeClient({ listings, added: { artifact: { registryVersion: 5, buildStatus: 'queued' } } });
	const result = await toolOf(appTools(client, fakeConfirm(true).confirm), 'deploy_app').execute({ app: 'a-ui', message: 'Mine' });
	assert.equal(result, 'Deployed v5; server build OK.');
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
 * The check_app toolkit over APP_FILES, with `markers` in the editor, and every report it hands the run.
 *
 * @param dev - The app's dev session.
 * @param markers - The markers Monaco holds.
 * @returns The toolkit and the reports it has reported.
 */
function appCheck(dev: AgentDevSession, markers: MarkerInfo[] = []): { toolkit: AppCheckToolkit; heard: CheckReport[] } {
	const host: AgentHost = {
		vfs: createMemoryWorkspace(APP_FILES),
		guides: { paths: () => [], read: async () => '' },
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array(),
		devSession: () => dev,
	};
	const heard: CheckReport[] = [];
	const toolkit = new AppCheckToolkit(
		host,
		async () => ({ modelUris: () => ['file:///daybook/src/App.tsx'], markers: () => markers, onChange: () => () => undefined }),
		(_folder, report) => heard.push(report),
		APP_FAST
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
