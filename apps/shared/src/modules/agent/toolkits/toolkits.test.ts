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
// the user says yes first, secrets stay out, deploy_app keeps its version, check_app
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';

import type { ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import type { IWorkspaceFileSystem, VfsEntry } from '../../vfs/vfsTypes';
import { GuideFileSystem } from '../guides';
import type { AgentDevSession, AgentHost } from '../host';
import type { AgentTool } from '../tools';
import { AppCheckToolkit, type AppCheckOptions, type CheckReport, type MarkerInfo } from './appCheck';
import { AppToolkit } from './appTools';
import { declined, type ConfirmFn } from './common';
import { FilesystemTools } from './filesystem';
import { PipelineDeployToolkit } from './pipelineDeploy';

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

	async readMany(paths: string[]): Promise<Map<string, unknown>> {
		const out = new Map<string, unknown>();
		for (const path of paths) {
			const content = this.files.get(path);
			if (content !== undefined) out.set(path, content);
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
	return found.execute(args);
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
	/** What `deploy.get` (deploy_status) returns. */
	status?: unknown;
	/** What `listDeployments` returns on each call; the last repeats. */
	listings?: Row[][];
	/** What `deploy.add` returns. */
	added?: unknown;
}

/**
 * A fake client with the deploy and app methods the tools call, cast to the real type.
 *
 * @param answers - What it answers.
 * @returns The client and the name of each method called, in order.
 */
function fakeClient(answers: Answers = {}): { client: RocketRideClient; calls: string[] } {
	const calls: string[] = [];
	const deployment = { teamId: 't1', projectId: 'p1', version: 3, state: 'enabled', schedules: {} };
	const listings = answers.listings ?? [[]];
	let listed = 0;
	const method = (name: string, value: () => unknown) => async () => {
		calls.push(name);
		return value();
	};
	const client = {
		deploy: {
			add: method('add', () => answers.added ?? { artifact: { version: 3 } }),
			deploy: method('deploy', () => deployment),
			get: method('get', () => answers.status ?? deployment),
			enable: method('enable', () => deployment),
			disable: method('disable', () => deployment),
			remove: method('remove', () => deployment),
			setSchedule: method('setSchedule', () => deployment),
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
 * @returns The tool.
 */
function toolOf(toolkit: { tools(): AgentTool[] }, name: string): AgentTool {
	const found = toolkit.tools().find((t) => t.name === name);
	assert.ok(found, `${name} is mounted`);
	return found;
}

/** The deploy tools over a fake client. */
function deployTools(client: RocketRideClient, confirm: ConfirmFn): PipelineDeployToolkit {
	return new PipelineDeployToolkit(() => client, createMemoryWorkspace({}), confirm);
}

/** The app tools over a fake client and a workspace with one app, `a-ui`, whose manifest id is `acme.a`. */
function appTools(client: RocketRideClient, confirm: ConfirmFn): AppToolkit {
	const host: AgentHost = {
		vfs: createMemoryWorkspace({ 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) }),
		guides: { paths: () => [], read: async () => '' },
		scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }),
		packApp: async () => new Uint8Array([1, 2, 3]),
		devSession: () => null,
	};
	return new AppToolkit(() => client, host, confirm, { pollMs: 0, buildWaitMs: 50 });
}

/** A small flat pipeline that is ready to deploy: it has a name and a project id. */
const PIPE = { name: 'Daily digest', components: [{ id: 'webhook_1', provider: 'webhook', config: { mode: 'Source' } }], source: 'webhook_1', project_id: 'p1' };

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
	const run = (name: string, args: Record<string, unknown>) => (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(args);
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

// =============================================================================
// THE USER SAYS YES FIRST
// =============================================================================

test('deploy and schedule actions ask first: a no does nothing, a yes runs once', async () => {
	// Each case: the tool, its arguments, the client method it runs, and the title of its question.
	const cases: Array<[tool: string, args: Record<string, unknown>, method: string, title: string]> = [
		['deploy_to_team', { project_id: 'p1', version: 3, team_id: 't1' }, 'deploy', 'Deploy p1'],
		['deploy_add', { pipeline: PIPE, deploy_to: 't1' }, 'add', 'Deploy p1'],
		['deploy_set_schedule', { project_id: 'p1', source_id: 'webhook_1', schedule: '0 9 * * 1-5', team_id: 't1' }, 'setSchedule', 'Schedule p1'],
		['deploy_enable', { project_id: 'p1', team_id: 't1' }, 'enable', 'Enable p1'],
		['deploy_disable', { project_id: 'p1', team_id: 't1' }, 'disable', 'Disable p1'],
		['deploy_remove', { project_id: 'p1', team_id: 't1' }, 'remove', 'Remove p1'],
	];
	for (const [tool, args, method, title] of cases) {
		for (const yes of [false, true]) {
			const { client, calls } = fakeClient();
			const { confirm, asked } = fakeConfirm(yes);
			const result = await toolOf(deployTools(client, confirm), tool).execute(args);
			assert.deepEqual(asked, [title], `${tool}: the user is asked once`);
			assert.deepEqual(calls, yes ? [method] : [], `${tool}: ${yes ? 'a yes runs it' : 'a no runs nothing'}`);
			if (!yes) assert.equal(result, declined(title), tool);
		}
	}
});

test('publish_app asks first; a no publishes nothing', async () => {
	const { client, calls } = fakeClient({ listings: [[row(4, 'ok', 'ready')]] });
	const { confirm, asked } = fakeConfirm(false);
	const result = await toolOf(appTools(client, confirm), 'publish_app').execute({ app: 'a-ui', target: 'public' });
	assert.equal(asked.length, 1);
	assert.equal(result, declined(asked[0]));
	assert.deepEqual(calls, ['listDeployments'], 'nothing was published or submitted');
});

// =============================================================================
// SECRETS
// =============================================================================

test('results hide secrets but keep placeholders and task_token', async () => {
	const status = { teamId: 't1', projectId: 'p1', task_token: 'tk-fake-0001', schedules: { webhook_1: { apikey: 'sk-fake-not-a-real-key', token: 'tok-fake', api_key: '${ROCKETRIDE_OPENAI_KEY}' } } };
	const { client } = fakeClient({ status });
	const text = await toolOf(deployTools(client, fakeConfirm(false).confirm), 'deploy_status').execute({ project_id: 'p1', team_id: 't1' });
	assert.doesNotMatch(text, /sk-fake-not-a-real-key|tok-fake/);
	assert.match(text, /\[redacted\]/);
	assert.match(text, /\$\{ROCKETRIDE_OPENAI_KEY\}/, 'a placeholder names a key without holding it');
	assert.match(text, /tk-fake-0001/, 'the run tools hand out task_token on purpose');
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
