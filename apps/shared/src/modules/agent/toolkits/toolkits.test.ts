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
// TOOLKIT TESTS — the agent never writes over the user's work and a Stop stops,
// the user says yes first, secrets stay out of the model, deploy_app keeps its
// version, check_app fails a broken app, and Auto stops only its own runs
// =============================================================================

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import type { RocketRideClient } from 'rocketride';
import type { ChatMessage } from 'shell';
import type { ChatAskAnswer, ChatAskCard, ChatAsking } from 'shell/src/components/chat/types';

import { CachedVfs } from 'shell/src/modules/explorer/CachedVfs';

import type { ConsoleRow, WatchStatus } from '../../../tools/appdev/types';
import { sha256Hex } from '../../vfs/hash';
import { isReferencePath } from '../../vfs/referenceTree';
import { StaleVersionError, StaleWriteError, StagedFileSystem } from '../../vfs/stagedFileSystem';
import type { IWorkspaceFileSystem, VfsEntry } from '../../vfs/vfsTypes';
import { AgentSession } from '../agent';
import { setAgentHost, type AgentDevSession, type AgentHost, type ApprovalPrefs, type ApprovalSettings, type EditorControl, type Grant } from '../host';
import { BUILDER_PROMPTS } from '../prompts';
import { runAgent } from '../run';
import type { AgentTool } from '../tools';
import type { ModelCall, QuestionSpec } from '../wave/plan';
import { AppCheckToolkit, type CheckReport, type MarkerInfo } from './appCheck';
import { Approvals } from './approval';
import { AppToolkit } from './appTools';
import { redactText, type ChoiceFn } from './common';
import { FilesystemTools } from './filesystem';
import { RocketRideClientToolkit } from './rocketrideClient';
import { RunLedger } from './runs';

/** An in-memory IWorkspaceFileSystem. Each write or delete counts one version of its path, as the staged view's do; a test that sets `files` directly changes content without a version, the way another browser tab would. */
class MemoryWorkspace implements IWorkspaceFileSystem {
	readonly files: Map<string, string>;
	/** Every write and delete, in order. */
	readonly log: string[] = [];
	/** Refuses a path, as the app's view refuses `.rocketride/`; every mutation runs it first. */
	assertWritable?: (path: string) => void;
	/** Each dirty path, with the unsaved buffer reads see (none: reads see the stored text). */
	private readonly dirty = new Map<string, string | undefined>();
	private readonly versions = new Map<string, number>();
	private readonly writers = new Map<string, string>();

	constructor(files: Record<string, string>, dirty: string[] = []) {
		this.files = new Map(Object.entries(files));
		for (const path of dirty) this.dirty.set(path, undefined);
	}

	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const base = dir.replace(/\/+$/, '');
		if (base && this.entryType(base) !== 'dir') throw new Error(`No such directory: ${dir}`);
		const prefix = base ? `${base}/` : '';
		return this.listEntries().flatMap(({ path, type }) => (path.startsWith(prefix) && !path.slice(prefix.length).includes('/') ? [{ name: path.slice(prefix.length), type }] : []));
	}

	async read(path: string): Promise<unknown> {
		const buffer = this.dirty.get(path);
		if (buffer !== undefined) return buffer;
		if (!this.files.has(path)) throw new Error(`No such file: ${path}`);
		return this.files.get(path);
	}

	async readVersioned(path: string, opts: { stored?: boolean } = {}): Promise<{ content: unknown; version: number }> {
		const version = this.version(path);
		return { content: opts.stored ? this.files.get(path) : await this.read(path), version };
	}

	listEntries(): VfsEntry[] {
		const folders = [...this.files.keys()].flatMap((path) =>
			path
				.split('/')
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join('/'))
		);
		return [...new Set([...folders, ...this.files.keys()])].sort().map((path) => ({ path, type: this.files.has(path) ? 'file' : 'dir' }));
	}

	entryType(path: string): 'file' | 'dir' | null {
		if (this.files.has(path)) return 'file';
		return path === '' || [...this.files.keys()].some((p) => p.startsWith(`${path}/`)) ? 'dir' : null;
	}

	async write(path: string, content: unknown, origin?: string, expect?: number): Promise<void> {
		this.assertWritable?.(path);
		if (expect !== undefined && expect !== this.version(path)) throw new StaleVersionError(path, { expected: expect, actual: this.version(path), lastWriter: this.lastWriter(path) });
		if (typeof content !== 'string') throw new Error(`The memory workspace holds text only: ${path}`);
		this.bump(path, origin);
		this.files.set(path, content);
		this.log.push(`write ${path}`);
	}

	async delete(path: string, origin?: string, anchor?: string): Promise<void> {
		this.assertWritable?.(path);
		if (!this.files.has(path)) throw new Error(`No such file: ${path}`);
		if (anchor !== undefined && (await sha256Hex(this.files.get(path) ?? '')) !== anchor) throw new StaleWriteError(path);
		this.bump(path, origin);
		this.files.delete(path);
		this.log.push(`delete ${path}`);
	}

	/** Marks a path dirty, with the buffer reads then see, or clean, the way an editor overlay flips. */
	setDirty(path: string, dirty: boolean, buffer?: string): void {
		if (dirty) this.dirty.set(path, buffer);
		else this.dirty.delete(path);
	}

	readMany = async (paths: string[]): Promise<Record<string, unknown>> => Object.fromEntries(paths.filter((path) => this.files.has(path)).map((path) => [path, this.files.get(path)]));
	stat = async (path: string): Promise<'file' | 'dir' | null> => this.entryType(path);
	cachedContent = (path: string): unknown => this.files.get(path);
	peekBase = (path: string): Promise<unknown> => this.read(path);
	version = (path: string): number => this.versions.get(path) ?? 0;
	lastWriter = (path: string): string | undefined => this.writers.get(path);
	isDirty = (path: string): boolean => this.dirty.has(path);
	dirtyPaths = (): Set<string> => new Set(this.dirty.keys());
	// no test here moves a file or makes an empty folder, and a map has no cache to keep warm or anyone to tell
	rename = (): Promise<void> => Promise.reject(new Error('The memory workspace does not model moves.'));
	mkdir = (): Promise<void> => Promise.reject(new Error('The memory workspace does not model empty folders.'));
	refresh = async (): Promise<void> => undefined;
	upsert = (): void => undefined;
	prime = (): void => undefined;
	invalidate = (): void => undefined;
	registerOverlay = (): (() => void) => () => undefined;
	subscribe = (): (() => void) => () => undefined;
	notify = (): void => undefined;

	private bump(path: string, origin?: string): void {
		this.versions.set(path, this.version(path) + 1);
		if (origin) this.writers.set(path, origin);
	}
}

/** A workspace with one app, `a-ui`, whose manifest id is `acme.a`, named Alpha. */
const ALPHA = { 'apps/a-ui/package.json': JSON.stringify({ name: 'x', appManifest: { id: 'acme.a', name: 'Alpha' } }) };

/** The daybook app; Monaco holds its one source file. */
const DAYBOOK = { 'apps/daybook-ui/package.json': JSON.stringify({ appManifest: { id: 'daybook', name: 'Daybook' } }), 'apps/daybook-ui/src/App.tsx': 'export default function App() { return null; }' };

/** An agent host over `vfs`; `extra` adds or replaces its parts. */
const hostFor = (vfs: IWorkspaceFileSystem, extra: Partial<AgentHost> = {}): AgentHost => ({ vfs, scaffoldApp: async () => ({ appId: 'x', folder: 'x-ui' }), packApp: async () => new Uint8Array([1, 2, 3]), devSession: () => null, ...extra });

/** A tool, and its call as the loop makes it: prepared, let through by `approvals` (every act, without them), then run. */
function toolOf(toolkit: { tools(): AgentTool[] }, name: string, approvals?: Approvals): { tool: AgentTool; execute(args: Record<string, unknown>): Promise<string> } {
	const tool = toolkit.tools().find((t) => t.name === name);
	assert.ok(tool, `${name} is mounted`);
	return {
		tool,
		execute: async (args) => {
			const step = await tool.prepare(args);
			const work = step.act && approvals ? await approvals.approve(step.act, () => step.run()) : () => step.run();
			return work();
		},
	};
}

/** One toolkit per workspace, so reads carry over between calls as they do within one run. */
const toolkits = new WeakMap<MemoryWorkspace, FilesystemTools>();

/** Runs one file tool on `ws`. The result passes through redactText, as the loop's do, so this is what the model sees. */
async function run(ws: MemoryWorkspace, tool: string, args: Record<string, unknown>): Promise<string> {
	if (!toolkits.has(ws)) toolkits.set(ws, new FilesystemTools(ws));
	return redactText(await toolOf(toolkits.get(ws) as FilesystemTools, tool).execute(args));
}

/** Opens an editor with unsaved typing. Its save writes the buffer at the version it loaded, as the Monaco tab does. */
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

/** A client that answers each method, by its dotted name, from a table (a function answers from the params) and records every call. A method called without its object throws, as a real one does. */
function scriptedClient(answers: Record<string, unknown>): { client: RocketRideClient; calls: Array<[method: string, params: unknown[]]> } {
	const calls: Array<[method: string, params: unknown[]]> = [];
	const root: Record<string, unknown> = {};
	for (const [method, answer] of Object.entries(answers)) {
		const [first, second] = method.split('.');
		const holder = (second === undefined ? root : (root[first] ??= {})) as Record<string, unknown>;
		holder[second ?? first] = async function (this: unknown, ...params: unknown[]) {
			if (this !== holder) throw new Error(`${method} was called without its object`);
			calls.push([method, params]);
			return typeof answer === 'function' ? answer(...params) : answer;
		};
	}
	return { client: root as unknown as RocketRideClient, calls };
}

/** A chat ask that answers each card in turn from `answers`; past the end, 'deny'. */
function fakeAsk(answers: ChatAskAnswer[]): { ask: (card: ChatAskCard) => ChatAsking; cards: ChatAskCard[] } {
	const cards: ChatAskCard[] = [];
	const ask = (card: ChatAskCard): ChatAsking => {
		cards.push(card);
		return { answer: Promise.resolve(answers.shift() ?? 'deny'), approve: () => undefined };
	};
	return { ask, cards };
}

/** Approval settings in `mode`; every grant the run turns on is recorded. */
function fakeSettings(mode: ApprovalPrefs['mode'] = 'ask'): ApprovalSettings & { granted: Grant[] } {
	const granted: Grant[] = [];
	return { read: () => ({ mode, grants: { schedules: false, deploymentToggles: false } }), subscribe: () => () => undefined, grant: (kind) => granted.push(kind), granted };
}

/** One run's approvals over a client, in the ALPHA workspace; with no `ask`, every card is denied. */
function approvalsFor(client: RocketRideClient | null, ask = fakeAsk([]).ask, settings?: ApprovalSettings): Approvals {
	return new Approvals({ client: () => client, vfs: new MemoryWorkspace(ALPHA), ask, settings, signal: new AbortController().signal });
}

/** The rocketride_client tool over a client, let through by a run's approvals: the user approves every card unless `ask` says otherwise. */
function clientTool(client: RocketRideClient, ask = (): ChatAsking => ({ answer: Promise.resolve('approve'), approve: () => undefined }), settings?: ApprovalSettings): ReturnType<typeof toolOf> {
	const approvals = approvalsFor(client, ask, settings);
	return toolOf(new RocketRideClientToolkit(approvals.client, new MemoryWorkspace({})), 'rocketride_client', approvals);
}

/** A model that answers from a script, made at once or from the question, and keeps every question. */
function scriptedModel(replies: Array<string | ((q: QuestionSpec) => string)>): ModelCall & { questions: QuestionSpec[] } {
	const questions: QuestionSpec[] = [];
	const call: ModelCall = async (q) => {
		questions.push(q);
		const next = replies.shift();
		if (next === undefined) throw new Error('scriptedModel: no reply left');
		return typeof next === 'function' ? next(q) : next;
	};
	return Object.assign(call, { questions });
}

/** A reply asking for tool calls. */
const plan = (...calls: Array<[tool: string, args?: Record<string, unknown>]>): string => JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args: args ?? {} })) });

/** A reply that finishes with `answer`. */
const done = (answer: string): string => JSON.stringify({ thought: 'finishing', done: true, answer });

/** Runs one agent turn as the Agent tab does, minus the browser: the chat's cards go to `ask`, the unsaved-changes dialog to `choose`. */
async function agentTurn(ws: MemoryWorkspace, model: ModelCall, opts: { client?: RocketRideClient; history?: ChatMessage[]; dev?: AgentDevSession; queued?: string[]; ask?: (card: ChatAskCard) => ChatAsking; signal?: AbortSignal; choose?: ChoiceFn; editors?: Record<string, EditorControl> } = {}): Promise<Array<{ type: string; text: string }>> {
	const { editors } = opts;
	const host = hostFor(ws, { devSession: () => opts.dev ?? null, ...(editors ? { editor: (path: string) => editors[path] ?? null } : {}) });
	const chunks: Array<{ type: string; text: string }> = [];
	const queued = [...(opts.queued ?? [])];
	const options = { history: opts.history ?? [], prompts: BUILDER_PROMPTS, token: async () => '', signal: opts.signal ?? new AbortController().signal, takeQueued: () => queued.splice(0), ask: opts.ask };
	await runAgent('Describe and tidy the leak pipeline.', (type, text) => chunks.push({ type, text }), options, { host, client: () => opts.client ?? null, model, markers: async () => null, choose: opts.choose });
	return chunks;
}

// =============================================================================
// THE USER'S WORK — read before edit, unsaved changes, the save race, Stop
// =============================================================================

test('edit_file and write_file refuse a file not read, or changed since it was read, until it is read again', async () => {
	const rows: Array<[name: string, tool: string, args: Record<string, unknown>, changed: boolean, message: RegExp]> = [
		['edit, unread', 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' }, false, /read a\.ts first/],
		['write, unread', 'write_file', { path: 'a.ts', content: 'new' }, false, /read a\.ts first/],
		['write, changed since read', 'write_file', { path: 'a.ts', content: 'new' }, true, /a\.ts changed since you read it/],
		['edit, changed since read, anchor gone', 'edit_file', { path: 'a.ts', oldString: '1', newString: '3' }, true, /a\.ts changed since you read it/],
	];
	for (const [name, tool, args, changed, message] of rows) {
		const ws = new MemoryWorkspace({ 'a.ts': 'a = 1' });
		if (changed) {
			await run(ws, 'read_file', { path: 'a.ts' });
			ws.files.set('a.ts', 'a = 2');
		}
		await assert.rejects(run(ws, tool, args), message, name);
		assert.deepEqual(ws.log, [], `${name}: nothing written`);
	}

	// step: once read again, the edit lands on the current content
	const ws = new MemoryWorkspace({ 'a.ts': 'a = 1' });
	await run(ws, 'read_file', { path: 'a.ts' });
	ws.files.set('a.ts', 'a = 2');
	await run(ws, 'read_file', { path: 'a.ts' });
	await run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' });
	assert.equal(ws.files.get('a.ts'), 'b = 2');
});

test('a dirty file is refused when no editor can save it, and Save mine first saves before the edit lands on top', async () => {
	const ws = new MemoryWorkspace({ 'a.ts': 'a = 1' }, ['a.ts']);
	await run(ws, 'read_file', { path: 'a.ts' });
	await assert.rejects(run(ws, 'edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' }), /a\.ts has unsaved editor changes/);
	await assert.rejects(run(ws, 'write_file', { path: 'a.ts', content: 'b' }), /a\.ts has unsaved editor changes/);
	assert.deepEqual(ws.log, []);

	const saved = new MemoryWorkspace({ 'a.ts': 'title = 1;\n' });
	const editor = dirtyEditor(saved, 'a.ts', 'title = 1;\nmine = 2;\n');
	const tools = new FilesystemTools(saved, undefined, undefined, { choose: async () => 'save', editor: () => editor });
	await toolOf(tools, 'read_file').execute({ path: 'a.ts' });
	await toolOf(tools, 'edit_file').execute({ path: 'a.ts', oldString: 'title = 1', newString: 'title = 3' });
	assert.deepEqual(editor.did, ['save']);
	assert.equal(saved.files.get('a.ts'), 'title = 3;\nmine = 2;\n', 'both the user and the agent kept their change');
});

test("a user's save that lands while the agent edits is kept, and the agent is told to read again", async () => {
	const store = new MemoryWorkspace({ 'apps/a.ts': 'const a = 1;' });
	const vfs = new StagedFileSystem(new CachedVfs(store), null, { writeThrough: true });
	const tools = new FilesystemTools(vfs);
	await toolOf(tools, 'read_file').execute({ path: 'apps/a.ts' });
	// step: the user saves in the gap between the edit's read of the file and its write
	const original = vfs.readVersioned.bind(vfs);
	vfs.readVersioned = async (path) => {
		const value = await original(path);
		vfs.readVersioned = original;
		await vfs.write('apps/a.ts', 'const a = 100;', 'editor');
		return value;
	};
	await assert.rejects(toolOf(tools, 'edit_file').execute({ path: 'apps/a.ts', oldString: '1', newString: '2' }), /^RefusedError: edit_file refused: apps\/a\.ts changed since you read it .*Read it again/);
	assert.equal(store.files.get('apps/a.ts'), 'const a = 100;');
});

test('a run the user stops closes its open unsaved-changes question as Keep mine at once', async () => {
	const ws = new MemoryWorkspace({ 'a.ts': 'a = 1' });
	const editor = dirtyEditor(ws, 'a.ts', 'a = 1 // mine');
	const stop = new AbortController();
	let closedAtStop = false;
	const choose: ChoiceFn = (_title, _message, signal) =>
		new Promise((resolve) => {
			signal?.addEventListener('abort', () => resolve('keep'));
			// step: the user presses Stop while the dialog is open; it closes then, not once the loop has wound down
			stop.abort();
			closedAtStop = signal?.aborted === true;
		});
	const model = scriptedModel([plan(['read_file', { path: 'a.ts' }]), plan(['edit_file', { path: 'a.ts', oldString: '1', newString: '2' }]), done('never asked')]);
	await agentTurn(ws, model, { choose, editors: { 'a.ts': editor }, signal: stop.signal });
	assert.equal(closedAtStop, true, 'the question closed the moment the run was stopped');
	assert.deepEqual([ws.files.get('a.ts'), ws.log, editor.did], ['a = 1', [], []], 'nothing was written, saved or discarded');
});

// =============================================================================
// THE USER SAYS YES FIRST
// =============================================================================

/** A version row of an app, as `listDeployments` returns it: built and private unless told otherwise. */
const row = (registryVersion: number, buildStatus = 'ok', state = 'private') => ({ registryVersion, buildStatus, state });

test('publish_app and delete_file name their exact act, and only an approved one acts', async () => {
	const publish = { app: 'a-ui', target: 'public' };
	const { client, calls } = scriptedClient({ listDeployments: [row(4, 'ok', 'ready')], publishApp: { publish: {} } });
	const free = new AppToolkit(() => client, hostFor(new MemoryWorkspace(ALPHA)));
	const step = await toolOf(free, 'publish_app').tool.prepare(publish);
	assert.deepEqual(step.act, { name: 'publishApp', params: ['acme.a', 4, '@public'] });

	// through a run's approvals the publish reaches the client only by the checked view, so its act must match its call
	const publishWith = (answer: ChatAskAnswer) => {
		const approvals = approvalsFor(client, fakeAsk([answer]).ask);
		return toolOf(new AppToolkit(approvals.client, hostFor(new MemoryWorkspace(ALPHA))), 'publish_app', approvals).execute(publish);
	};
	await assert.rejects(publishWith('deny'), /declined/);
	await publishWith('approve');
	assert.equal(calls.filter(([method]) => method === 'publishApp').length, 1, 'only the approved publish reached the client');

	const ws = new MemoryWorkspace({ 'apps/a-ui/a.ts': 'a' });
	const remove = (answer: ChatAskAnswer) => toolOf(new FilesystemTools(ws), 'delete_file', approvalsFor(null, fakeAsk([answer]).ask)).execute({ path: 'apps/a-ui/a.ts' });
	await assert.rejects(remove('deny'), /declined/);
	assert.deepEqual(ws.log, [], 'a denied delete deletes nothing');
	await remove('approve');
	assert.equal(ws.files.has('apps/a-ui/a.ts'), false);
});

test('an asked call runs only after Approve; Deny and Stop run nothing', async () => {
	const { client, calls } = scriptedClient({ 'deploy.remove': {} });
	const remove = (answer: ChatAskAnswer) => clientTool(client, fakeAsk([answer]).ask).execute({ method: 'deploy.remove', params: ['p1', 't1'] });
	await assert.rejects(remove('deny'), /declined/);
	await assert.rejects(remove('stopped'), /stopped the run/);
	assert.deepEqual(calls, [], 'a denied or stopped call never reached the client');
	await remove('approve');
	assert.equal(calls.length, 1);
});

test('Always allow turns the grant on, and the checked client refuses an asked call nobody announced', async () => {
	const { client, calls } = scriptedClient({ 'deploy.setSchedule': {}, publishApp: { publish: {} } });
	const settings = fakeSettings();
	await clientTool(client, fakeAsk(['always']).ask, settings).execute({ method: 'deploy.setSchedule', params: ['p1', 'cron_1', null, 't1'] });
	assert.deepEqual(settings.granted, ['schedules']);

	const checked = approvalsFor(client).client() as unknown as { publishApp(...params: unknown[]): unknown };
	assert.throws(() => checked.publishApp('acme.a', 4, '@me'), /publishApp needs the user's OK/);
	assert.equal(calls.length, 1, 'the unannounced publish never reached the client');
});

test('rocketride_client refuses every blocked method without reaching the client', async () => {
	const blocked = ['getApiKey', 'getAccountInfo', 'account.getProfile', 'connect', 'login', 'account.getEnv', 'account.createKey', 'billing.createCheckoutSession', 'billing.purchaseTopup', 'billing.createPortalSession', 'call', 'request', 'fsReadString', 'fsWriteString'];
	const { client, calls } = scriptedClient(Object.fromEntries(blocked.map((method) => [method, 'rr_fake_session'])));
	for (const method of blocked) await assert.rejects(clientTool(client).execute({ method }), /is blocked/, method);
	assert.deepEqual(calls, []);
});

test('rocketride_client results hide secrets but keep the run token', async () => {
	const { client } = scriptedClient({
		// run tokens carry the engine's tk_ prefix, which redactText keeps (common.ts RUN_TOKEN_PREFIX)
		use: { token: 'tk_run_0001', pipeline: { components: [{ id: 'llm_1', config: { apikey: 'sk-fake-not-a-real-key', api_key: '${ROCKETRIDE_OPENAI_KEY}' } }] } },
		'deploy.run': { token: 'tk_run_0002', version: 3 },
		getTasks: [{ token: 'tk-other-0003', name: 'Digest' }],
	});
	const tool = clientTool(client);
	const used = await tool.execute({ method: 'use', params: [{ pipeline: {} }] });
	assert.match(used, /tk_run_0001/, 'use hands out its run token');
	assert.doesNotMatch(used, /sk-fake-not-a-real-key/);
	assert.match(used, /\$\{ROCKETRIDE_OPENAI_KEY\}/, 'a placeholder names a key without holding it');
	assert.match(await tool.execute({ method: 'deploy.run', params: ['p1', 'webhook_1', 't1'] }), /tk_run_0002/);
	assert.doesNotMatch(await tool.execute({ method: 'getTasks' }), /tk-other-0003/, 'a token anywhere else stays hidden');
});

// =============================================================================
// SECRETS — markers in files, redaction at every boundary, pasted keys held back
// =============================================================================

/** A pipeline whose model node holds an inline key beside a placeholder that only names one. */
function inlineKeyPipe(key: string): string {
	const pipeline = {
		components: [
			{ id: 'chat_1', provider: 'chat', config: { mode: 'Source' } },
			{ id: 'llm_1', provider: 'llm_openai', config: { apikey: key, fallback: '${ROCKETRIDE_OPENAI_KEY}' } },
		],
	};
	return JSON.stringify(pipeline, null, 1);
}

/** The first `«secret:<8 hex>»` marker in a text, asserting there is one. */
function markerIn(text: string): string {
	const marker = /«secret:[0-9a-f]{8}»/.exec(text)?.[0];
	assert.ok(marker, 'the text shows a marker');
	return marker;
}

test('read_file and search_files put a marker, never the key, in the next question, for a .pipe and a .env, and the marker writes the real value back', async () => {
	// no key shape: only the field name says it is a secret
	const pipeKey = 'canary-inline-4d1f9a';
	const envKey = `sk-proj-canary-env-${'e'.repeat(24)}`;
	const files = { 'pipelines/a.pipe': inlineKeyPipe(pipeKey), '.env': `DEBUG=1\nOPENAI_API_KEY=${envKey}\n` };
	const calls: Array<[tool: string, args: Record<string, unknown>]> = [
		['read_file', { path: 'pipelines/a.pipe' }],
		['search_files', { pattern: 'apikey' }],
		['read_file', { path: '.env' }],
	];
	for (const call of calls) {
		const model = scriptedModel([plan(call), done('Read.')]);
		await agentTurn(new MemoryWorkspace(files), model);
		const next = model.questions[1].context.join('\n');
		assert.ok(!next.includes(pipeKey) && !next.includes(envKey), `${call[0]} ${JSON.stringify(call[1])}: a key reached the model`);
		markerIn(next);
	}

	// step: a marker the model writes back with edit_file or write_file saves the real value
	const ws = new MemoryWorkspace(files);
	const config = () => JSON.parse(ws.files.get('pipelines/a.pipe') ?? '').components[1].config;
	const marker = markerIn(await run(ws, 'read_file', { path: 'pipelines/a.pipe' }));
	await run(ws, 'edit_file', { path: 'pipelines/a.pipe', oldString: `"apikey": "${marker}"`, newString: `"apikey": "${marker}", "model": "gpt-5"` });
	assert.deepEqual(config(), { apikey: pipeKey, model: 'gpt-5', fallback: '${ROCKETRIDE_OPENAI_KEY}' });

	// step: the whole read, without the note it ends with, goes back with the key in it
	const again = await run(ws, 'read_file', { path: 'pipelines/a.pipe' });
	await run(ws, 'write_file', { path: 'pipelines/a.pipe', content: again.slice(0, again.lastIndexOf('\n[')).replace('gpt-5', 'gpt-5-mini') });
	assert.deepEqual(config(), { apikey: pipeKey, model: 'gpt-5-mini', fallback: '${ROCKETRIDE_OPENAI_KEY}' });
});

/** A file store behind the shell's getClient (the runner's 'shell' stub, scripts/stub-shell.cjs), so AgentSession can save; `chat` and `use` record a model call. */
function fakeStore(): { files: Map<string, unknown>; modelCalls: string[] } {
	const shell = createRequire(__filename)('shell') as Record<string, unknown>;
	const files = new Map<string, unknown>();
	const modelCalls: string[] = [];
	const model = (name: string) => async () => void modelCalls.push(name);
	shell.ConnectionManager = { getInstance: () => ({ emit: () => undefined }) };
	shell.getClient = () => ({
		fsWriteJson: async (path: string, value: unknown) => void files.set(path, value),
		fsReadJson: async (path: string) => {
			if (!files.has(path)) throw new Error(`File not found: ${path}`);
			return files.get(path);
		},
		chat: model('chat'),
		use: model('use'),
	});
	AgentSession.configure('rocketride.test');
	setAgentHost(hostFor(new MemoryWorkspace({}), { scopeKey: '' }));
	return { files, modelCalls };
}

/** A dev session with the Design preview open, whose rebuild goes building, then `end`, logging `consoleError` on the way. */
function devSession(end: WatchStatus = { state: 'ok' }, consoleError?: string): AgentDevSession {
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

test('leak test: no canary reaches a question, a thinking chunk, an approval card, the answer, the title, the saved session or the catalog', async () => {
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
	const ws = new MemoryWorkspace({
		'pipelines/leak.pipe': inlineKeyPipe(canaries.pipeField),
		'pipelines/quoted.pipe': inlineKeyPipe(canaries.quotedField),
		'notes/setup.md': `Set OPENAI_API_KEY=${canaries.freeText} before you run it.`,
		...DAYBOOK,
		'.rocketride/docs/ROCKETRIDE_SETUP.md': `An example config:\n\n    OPENAI_API_KEY=${canaries.guide}\n`,
	});
	ws.assertWritable = (path) => {
		if (isReferencePath(path)) throw new Error('.rocketride/ is read-only reference.');
	};
	// the store's error quotes a URL with its password; rocketride_client reads the file while it prepares the call
	const read = ws.read.bind(ws);
	ws.read = async (path) => {
		if (path === 'pipelines/broken.pipe') throw new Error(`the store refused the read: postgres://admin:${canaries.prepareError}@db.example.invalid/store`);
		return read(path);
	};
	// the run prints a key a read hid; the deployment's name, as the server holds it, goes on the schedule card
	const { client } = scriptedClient({
		use: { token: 'tk_run_0001', output: `the run printed ${canaries.runResult} and ${canaries.quotedField}` },
		getTaskStatus: () => Promise.reject(new Error(`token rejected: ${canaries.toolError}`)),
		getServices: { services: { chat: {}, llm_openai: {} } },
		validate: { errors: [], warnings: [] },
		'deploy.get': { pipelineName: `Nightly digest ${canaries.cardName}` },
		'deploy.setSchedule': {},
	});
	const history: ChatMessage[] = [{ id: 1, sender: 'user', text: `My old AWS key is ${canaries.history}`, timestamp: '' }];
	const model = scriptedModel([
		plan(['read_file', { path: 'pipelines/leak.pipe' }], ['read_file', { path: 'pipelines/quoted.pipe' }], ['read_file', { path: 'notes/setup.md' }], ['search_files', { pattern: 'OPENAI_API_KEY' }], ['rocketride_client', { method: 'getTaskStatus', params: ['tk_run_0001'] }], ['rocketride_client', { method: 'use', params: [{ filepath: 'pipelines/leak.pipe' }] }], ['read_file', { path: '.rocketride/docs/ROCKETRIDE_SETUP.md' }], ['search_files', { pattern: 'OPENAI_API_KEY', path: '.rocketride/docs' }], ['rocketride_client', { method: 'deploy.setSchedule', params: ['p1', 'webhook_1', '0 9 * * *', 't1'] }], ['rocketride_client', { method: 'use', params: [{ filepath: 'pipelines/broken.pipe' }] }]),
		(q) => {
			// the first marker is leak.pipe's: its read is the wave's first result
			const marker = markerIn(JSON.stringify(q));
			return plan(['edit_file', { path: 'pipelines/leak.pipe', oldString: `"apikey": "${marker}"`, newString: `"apikey": "${marker}", "model": "gpt-5"` }], ['check_app', { app: 'daybook-ui' }], ['write_file', { path: '.rocketride/docs/ROCKETRIDE_SETUP.md', content: `{"apikey": "${marker}"}` }]);
		},
		done(`Tidied. A model that echoes a key, like ${canaries.answer}, has it redacted.`),
	]);
	// the user writes again while the turn runs, and denies the schedule card; the chat then adds the card's status row
	const midRun = `Use this key for the model instead: ${canaries.midRun}`;
	const asked = fakeAsk(['deny']);
	const chunks = await agentTurn(ws, model, { client, history, dev: devSession({ state: 'ok' }, `Request failed with ${canaries.consoleRow}`), queued: [midRun], ask: asked.ask });
	const cardRows = asked.cards.map((card, i): ChatMessage => ({ id: 80 + i, sender: 'status', sseType: 'approval', text: `Denied: ${card.title}`, timestamp: '' }));

	// the user pastes a key in a new chat, and the whole transcript is saved; the key starts past the title's 60-character cut, so a title cut first would keep part of it
	const store = fakeStore();
	const agentSession = AgentSession.newSession();
	const prompt = `Please build the chat pipeline and use my key: ${canaries.prompt}`;
	await assert.rejects(agentSession.execute(prompt, undefined, { history: [], signal: new AbortController().signal, takeQueued: () => [], ask: () => ({ answer: Promise.resolve('stopped'), approve: () => undefined }) }), /looks like it contains a key/);
	const rows: ChatMessage[] = [...history, { id: 3, sender: 'user', text: 'Describe and tidy the leak pipeline.', timestamp: '' }, { id: 89, sender: 'user', text: midRun, timestamp: '' }, ...chunks.map((c, i): ChatMessage => (c.type === 'thinking' ? { id: 4 + i, sender: 'status', sseType: 'thinking', text: c.text, timestamp: '' } : { id: 4 + i, sender: 'bot', text: c.text, timestamp: '' })), ...cardRows, { id: 90, sender: 'user', text: prompt, timestamp: '' }, { id: 91, sender: 'bot', text: 'That message looks like it contains a key (OpenAI-style).', isError: true, timestamp: '' }];
	await agentSession.save(rows);

	const seen = {
		questions: JSON.stringify(model.questions),
		thinking: JSON.stringify(chunks.filter((c) => c.type === 'thinking')),
		answer: JSON.stringify(chunks.filter((c) => c.type === 'content')),
		cards: JSON.stringify(asked.cards),
		title: agentSession.title,
		// what was written, and the rows a reopened session starts from
		session: JSON.stringify([[...store.files].filter(([path]) => !path.endsWith('/catalog.json')), agentSession.messages]),
		catalog: JSON.stringify([...store.files].filter(([path]) => path.endsWith('/catalog.json'))),
	};
	const leaks = Object.entries(seen).flatMap(([where, text]) => Object.entries(canaries).flatMap(([name, canary]) => (text.includes(canary) ? [`${name} in the ${where}`] : [])));
	assert.deepEqual(leaks, []);
	assert.ok(!seen.title.includes('sk-proj'), `no part of the pasted key is in the title: ${seen.title}`);
	// each way in was taken, so no canary is missing for want of a path
	assert.equal(model.questions.length, 3, 'every planned wave ran');
	assert.deepEqual(store.modelCalls, [], 'the pasted prompt never reached the model');
	assert.equal(asked.cards.length, 1, 'the schedule card was shown');
	assert.ok(seen.questions.includes('Use this key for the model instead: [redacted]'), 'the mid-run message reached the model');
	assert.ok(seen.questions.includes('the store refused the read: postgres://admin:[redacted]@'), 'the model read the prepare error');
	assert.match(seen.answer, /like \[redacted\], has it redacted/);
});

// =============================================================================
// DEPLOY, CHECK AND RUN OWNERSHIP
// =============================================================================

test("deploy_app waits for the version it uploaded, not a teammate's newer one", async () => {
	// the upload reply names v5; a teammate's v6 lands beside it and is built first
	const listings = [[row(4)], [row(6, 'building'), row(5, 'queued'), row(4)], [row(6), row(5, 'building'), row(4)], [row(6), row(5), row(4)]];
	const { client } = scriptedClient({ 'deploy.add': { artifact: { registryVersion: 5, buildStatus: 'queued' } }, listDeployments: () => (listings.length > 1 ? listings.shift() : listings[0]) });
	const tools = new AppToolkit(() => client, hostFor(new MemoryWorkspace(ALPHA)), { pollMs: 0, buildWaitMs: 50 });
	assert.equal(await toolOf(tools, 'deploy_app').execute({ app: 'a-ui', message: 'Mine' }), 'Deployed v5; server build OK.');
});

test('check_app fails an app with type errors, and one whose build fails', async () => {
	const typeError: MarkerInfo = { uri: 'file:///daybook/src/App.tsx', line: 3, message: "Type 'string' is not assignable to type 'number'.", severity: 8, owner: 'typescript' };
	const cases: Array<[dev: AgentDevSession, markers: MarkerInfo[], steps: string[]]> = [
		[devSession(), [typeError], ['types fail', 'build pass', 'runtime pass']],
		[devSession({ state: 'error', reason: '"left-pad" is not a declared dependency' }), [], ['types pass', 'build fail']],
	];
	for (const [dev, markers, steps] of cases) {
		const heard: CheckReport[] = [];
		const source = { modelUris: () => ['file:///daybook/src/App.tsx'], markers: () => markers, onChange: () => () => undefined };
		const toolkit = new AppCheckToolkit(
			hostFor(new MemoryWorkspace(DAYBOOK), { devSession: () => dev }),
			async () => source,
			(_folder, report) => heard.push(report),
			{ build: { buildWaitMs: 1000, settleMs: 20, runtimeGraceMs: 20 }, types: { quietMs: 10, maxMs: 200 } }
		);
		assert.match(await toolOf(toolkit, 'check_app').execute({ app: 'daybook-ui' }), /^CHECK FAILED: daybook/, steps.join());
		const evidence = heard[0].evidence.map((e) => `${e.step} ${e.status}`);
		assert.deepEqual(evidence, steps);
	}
});

test("Auto stops the conversation's own run after a fresh status read, and refuses any other: one it did not start, a token now holding a later run, a gone status, another team", async () => {
	const MINE = 'tk_mine0123456789';
	const OTHER = 'tk_other123456789';
	const mine = { project_id: 'p1', source: 'chat_1', startTime: 1001, name: 'chat_1' };
	const runs = new Map([[OTHER, { project_id: 'p9', source: 'webhook_1', startTime: 7, name: 'Daily digest' }]]);
	const { client, calls } = scriptedClient({
		use: () => {
			runs.set(MINE, mine);
			return { token: MINE, projectId: 'p1', source: 'chat_1', reused: false };
		},
		getTaskStatus: (token: string) => (runs.has(token) ? { ...runs.get(token), completed: false, state: 2 } : Promise.reject(new Error(`Task ${token} not found`))),
		terminate: (token: string) => runs.delete(token),
	});
	const scope = { now: '' };
	const ledger = new RunLedger([], { client: () => client, scopeKey: '', currentScope: () => scope.now, conversationId: 'conv-1' });
	const asked = fakeAsk([]);
	const vfs = new MemoryWorkspace({});
	const approvals = new Approvals({ client: () => client, vfs, ask: asked.ask, settings: fakeSettings('auto'), signal: new AbortController().signal, runs: ledger });
	const tool = toolOf(new RocketRideClientToolkit(approvals.client, vfs, undefined, ledger), 'rocketride_client', approvals);
	await tool.execute({ method: 'use', params: [{ pipeline: {} }] });

	await assert.rejects(tool.execute({ method: 'terminate', params: [OTHER] }), /did not start the pipeline run Daily digest .*Call ask_user/);
	// step: another use of the same project and source after the old run ended: same token, later start
	runs.set(MINE, { ...mine, startTime: 99_999 });
	await assert.rejects(tool.execute({ method: 'terminate', params: [MINE] }), (err: Error) => err.name === 'RefusedError' && /a different run holds its token now/.test(err.message));
	runs.delete(MINE);
	await assert.rejects(tool.execute({ method: 'terminate', params: [MINE] }), /its status could not be read/);
	runs.set(MINE, mine);
	scope.now = 'team-b';
	await assert.rejects(tool.execute({ method: 'terminate', params: [MINE] }), /the workspace switched to another team/);
	assert.ok(!calls.some(([method]) => method === 'terminate'), 'nothing was terminated');

	scope.now = '';
	calls.length = 0;
	await tool.execute({ method: 'terminate', params: [MINE] });
	assert.deepEqual(
		calls.map(([method]) => method),
		['getTaskStatus', 'terminate'],
		'the status was read again right before the call'
	);
	assert.equal(asked.cards.length, 0, 'Auto showed no card');
});
