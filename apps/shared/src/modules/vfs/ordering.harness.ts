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
// ORDERING HARNESS — the actors and the runs behind every ordering exploration
// =============================================================================

/**
 * The actors and the runs of the ordering tests (ordering.test.ts), a
 * generated-input check of the save race. The check runs the real pieces:
 * rocket-ui's workspace (its store backend, CachedVfs and StagedFileSystem)
 * over an in-memory store, the agent's file tools inside the real Wave loop,
 * and an editor that saves the buffer it loaded, the way the Monaco tab does.
 * The store holds every read and write of the watched files until the test
 * releases it, so each run is one order of events, and the test tries every
 * order of up to a few steps.
 *
 * Every file content is a set of tokens joined by '+', and every writer adds
 * its own token to what it read. A write that lands without a token the
 * stored file already holds was computed from an older version than the one
 * current when it was meant, or landed in a team it was not meant for, so it
 * erased someone's work.
 *
 * The runs:
 *
 *   - Auto mode, one file: the agent edits it twice in one wave, and an
 *     editor saves it. A teammate can change the stored file meanwhile, and
 *     a second tab's Reload can drop the cached copy and read the server's.
 *   - Auto mode, one file in two teams: the agent's edits, a team switch and
 *     a timed-out tool call, with and without an OK asked before each edit.
 *     With OKs it also collects every OK asked while an edit's work is still
 *     on its way.
 *   - Manual mode, two files, each open in an editor with unsaved typing, so
 *     the agent's edit of a file is refused until the user saves it. A step
 *     starts the agent, releases a held store call, saves or types in the
 *     first editor, or runs Commit all, Discard all, a discard of one file, or
 *     a rollback to the checkpoint an earlier turn left. Beyond erased writes
 *     it checks four things. A write that worked and was not discarded
 *     reaches the store after a last commit. A Commit all that met no
 *     conflict carried every write that worked and was called before it,
 *     unless a discard called between the two took it out. A write called
 *     before a discard or rollback that covers its file is not left in the
 *     view after it. And an editor's save is refused as stale, or an editor's
 *     version falls behind its file's, only after a change to the file landed
 *     since the editor loaded or saved it (an agent write that worked, or a
 *     discard or rollback that took the file out).
 *   - The same, from a working layer the page restored after a reload, and
 *     with the first editor's first read slow (see ManualOptions).
 *
 * Each run builds its workspace with rocket-ui's createWorkspace, in a team of
 * its own; the workspace module is loaded again every RUNS_PER_LOAD runs, as a
 * new page does (see buildWorkspace).
 */

import { mock } from 'node:test';

import { stagingScopeKey, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { CheckRecord } from '../agent/run';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import { AgentTool } from '../agent/tools';
import { runLoop } from '../agent/wave/loop';
import { FakeStore } from './fakeStore.harness';
import { sha256Hex } from './hash';
import { StaleWriteError, type StagedFileSystem } from './stagedFileSystem';
import { StagingStore } from './staging';
import type { IWorkspaceFileSystem } from './vfsTypes';

// =============================================================================
// FIXTURES
// =============================================================================

/** The file every actor works on, as a workspace path. */
export const FILE = 'apps/a.ts';

/** What the file holds before anyone writes. */
export const ORIGINAL = 'BASE';

/** What the same path holds in the team the user switches to. */
const OTHER_TEAM = 'BETA';

/** The longest order of steps tried; after it, every held call is released in turn. */
export const MAX_DEPTH = 6;

/** The tool time limit; a timeout step moves the mocked clock past it. */
const LIMIT_MS = 1000;

/** The second file, in the manual-mode exploration. */
const FILE_B = 'apps/b.ts';

/** What the second file holds before anyone writes. */
const ORIGINAL_B = 'BBASE';

/** The longest order of steps tried in manual mode. */
const MANUAL_DEPTH = 6;

/** The store path of a workspace file (FILE by default) in a team. */
function storePath(team: string, file = FILE): string {
	return `@/Team/=${team}/.projects/.appdev/${file.slice('apps/'.length)}`;
}

/** The tokens of a content, joined by '+'. */
export function tokens(content: string): Set<string> {
	return new Set(content.split('+'));
}

/** Each write that landed on one of `paths` without a token the file held. */
function erasures(store: FakeStore, paths: Set<string> = store.watched): string[] {
	return store.landed.flatMap(({ path, before, content }) => {
		if (!paths.has(path)) return [];
		const after = tokens(content);
		const missing = [...tokens(before ?? '')].filter((t) => !after.has(t));
		return missing.length > 0 ? [`'${content}' landed on ${path} and erased ${missing.join(', ')}`] : [];
	});
}

// =============================================================================
// WORKSPACES — rocket-ui's createWorkspace, loaded again every RUNS_PER_LOAD runs
// =============================================================================

/** rocket-ui's workspace module. */
type WorkspaceModule = typeof import('../../../../rocket-ui/src/surfaces/workspace/vfs/workspace');

/** The workspace module's key in require.cache. */
const WORKSPACE_MODULE = require.resolve('../../../../rocket-ui/src/surfaces/workspace/vfs/workspace');

/** How many runs build their workspace with one load of the workspace module. */
const RUNS_PER_LOAD = 500;

/** The workspace module as loaded now, and how many runs built with it. */
let loaded: { module: WorkspaceModule; runs: number } | null = null;

/**
 * Builds a run's workspace with rocket-ui's createWorkspace. The module keeps
 * what it builds for the page's life: each build holds the one before it
 * (known-bugs.md item 2), so one load would keep every run's workspace, and
 * the explorations would run out of memory. So every RUNS_PER_LOAD runs the
 * module is loaded again, as on a new page, and nothing keeps the old load.
 */
function buildWorkspace(options: Parameters<WorkspaceModule['createWorkspace']>[0]): Promise<Workspace> {
	if (!loaded || loaded.runs >= RUNS_PER_LOAD) {
		// step: the cache and this module's children both keep a load, so it leaves both
		const old = require.cache[WORKSPACE_MODULE];
		delete require.cache[WORKSPACE_MODULE];
		const at = old ? module.children.indexOf(old) : -1;
		if (at >= 0) module.children.splice(at, 1);
		loaded = { module: require(WORKSPACE_MODULE) as WorkspaceModule, runs: 0 };
	}
	loaded.runs += 1;
	return loaded.module.createWorkspace(options);
}

/** Switches the team of the run that built the last workspace, with the same load of the workspace module, as the page's team switcher does. */
function switchWorkspace(options: Parameters<WorkspaceModule['createWorkspace']>[0]): Promise<Workspace> {
	if (!loaded) throw new Error('No workspace was built to switch from.');
	return loaded.module.createWorkspace(options);
}

// =============================================================================
// ONE RUN — the actors, and one order of steps
// =============================================================================

/** A step of an order. */
export type Step = 'start' | 'save' | 'teammate' | 'reload' | `release ${number}`;

/** What one run saw. */
interface Outcome {
	/** The steps that were possible after the last step of the order. */
	next: Step[];
	/** Each write that erased a token. */
	erased: string[];
	/** What the file held at the end. */
	final: string;
}

/**
 * Hashes finish off the event loop (crypto.subtle), so a run is only still
 * when none is pending. The count is all this wrapper adds; the hash is real.
 */
let hashing = 0;
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>): Promise<ArrayBuffer> => {
	hashing += 1;
	try {
		return await realDigest(...args);
	} finally {
		hashing -= 1;
	}
};

/** Lets every promise that can move, move, until nothing changes for a while and no hash is pending. */
async function settle(store: FakeStore, progress: () => string = () => ''): Promise<void> {
	let quiet = 0;
	let seen = '';
	while (quiet < 4) {
		await new Promise((resolve) => setImmediate(resolve));
		const now = `${store.held.length} ${progress()}`;
		quiet = now === seen && hashing === 0 ? quiet + 1 : 0;
		seen = now;
	}
}

/** A wave reply that asks for tool calls. */
function plan(calls: Array<[string, Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args })) });
}

/** Counts runs, so each one roots its workspace in a team of its own. */
let runs = 0;

/** Runs one order of steps, then releases every held call in turn until all of them have finished. */
export async function runOrder(order: Step[]): Promise<Outcome> {
	runs += 1;
	const first = `alpha${runs}`;
	const store = new FakeStore({ [storePath(first)]: ORIGINAL }).install();
	for (const path of store.files.keys()) store.watched.add(path);
	const ws: Workspace = await buildWorkspace({ hostAppId: 'ordering.test', autoCommit: true, scope: { kind: 'team', teamId: first } });
	const view: IWorkspaceFileSystem = ws.view;

	// step: the editor opens the file first; its read is released at once
	const loading = loadEditor(view);
	await settle(store);
	store.held.splice(0).forEach((h) => h.release());
	const editor = await loading;

	// step: the agent reads the file, then edits it twice in one wave; the
	// model then says it is done, and stops answering after a few tries
	const replies = [
		plan([['read_file', { path: FILE }]]),
		plan([
			['edit_file', { path: FILE, oldString: ORIGINAL, newString: `${ORIGINAL}+agent` }],
			['edit_file', { path: FILE, oldString: ORIGINAL, newString: `${ORIGINAL}+agent2` }],
		]),
	];
	for (let i = 0; i < 3; i++) replies.push(JSON.stringify({ thought: 'finishing', done: true, answer: 'Edited.' }));
	let agent: Promise<unknown> | null = null;
	let agentDone = false;
	let saved = false;
	let teammate = false;
	let reloaded = false;
	const startAgent = () =>
		runLoop({
			request: 'Edit apps/a.ts.',
			history: [],
			prefix: { role: 'You are Wave.', instructions: [] },
			tools: new FilesystemTools(view).tools(),
			model: async () => {
				const next = replies.shift();
				if (next === undefined) throw new Error('The scripted model has no reply left.');
				return next;
			},
			finish: new CheckRecord(async () => null),
			emit: () => undefined,
			timeoutMs: () => LIMIT_MS,
			signal: new AbortController().signal,
			takeQueued: () => [],
			approve: async (_act, run) => run,
		})
			.catch(() => undefined)
			.finally(() => {
				agentDone = true;
			});

	/** The steps possible now. */
	const possible = (): Step[] => {
		const steps: Step[] = store.held.map((_, i) => `release ${i}` as const);
		if (!agent) steps.push('start');
		if (!saved) steps.push('save');
		// step: a teammate's change between a write's freshness check and its store write is out of the page's reach (no conditional write)
		if (!teammate && !store.held.some((h) => h.label.startsWith('write '))) steps.push('teammate');
		if (!reloaded) steps.push('reload');
		return steps;
	};

	for (const step of order) {
		if (!possible().includes(step)) throw new Error(`Step ${step} is not possible after ${order.join(', ')}`);
		if (step === 'start') agent = startAgent();
		else if (step === 'save') {
			saved = true;
			void editor.save().catch(() => undefined);
		} else if (step === 'teammate') {
			teammate = true;
			store.files.set(storePath(first), `${store.files.get(storePath(first))}+teammate`);
		} else if (step === 'reload') {
			reloaded = true;
			view.invalidate(FILE);
			void view.readVersioned(FILE).catch(() => undefined);
		} else {
			store.held.splice(Number(step.slice('release '.length)), 1)[0].release();
		}
		await settle(store);
	}
	const next = possible();

	// step: release everything in turn until the agent has finished and nothing is held
	if (!agent) agent = startAgent();
	await settle(store);
	while (store.held.length > 0 || !agentDone) {
		const held = store.held.shift();
		if (!held) throw new Error(`The run is stuck after ${order.join(', ') || 'no steps'}: the agent waits on nothing the store holds.`);
		held.release();
		await settle(store);
	}
	return { next, erased: erasures(store), final: store.files.get(storePath(first)) ?? '' };
}

/** An editor tab: it loads the file, the user types a token, and save writes the buffer. */
async function loadEditor(view: IWorkspaceFileSystem): Promise<{ save: () => Promise<void> }> {
	const loaded = await view.readVersioned(FILE);
	const buffer = `${String(loaded.content)}+editor`;
	return { save: () => view.write(FILE, buffer, 'editor', loaded.version) };
}

// =============================================================================
// TEAM SWITCH — the agent's edits, a team switch and a timed-out tool call
// =============================================================================

/** A step of a team switch order. */
export type SwitchStep = 'start' | 'switch' | 'timeout' | 'approve' | `release ${number}`;

/** What one team switch run saw. */
interface SwitchOutcome {
	/** The steps that were possible after the last step of the order. */
	next: SwitchStep[];
	/** Each write that erased a token, and each OK asked while an edit's work was on its way. */
	erased: string[];
	/** What the file held at the end, in the first team. */
	final: string;
}

/**
 * The agent's file tools, with edit_file asking for an OK first when `asking`:
 * its step names an act, as delete_file's does. `work` counts edits whose work
 * has started and not ended.
 */
function agentTools(view: IWorkspaceFileSystem, asking: boolean, work: { running: number }): AgentTool[] {
	const tools = new FilesystemTools(view).tools();
	if (!asking) return tools;
	return tools.map((tool) =>
		tool.name !== 'edit_file'
			? tool
			: new AgentTool({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					prepare: async (args) => {
						const step = await tool.prepare(args);
						return {
							act: { name: 'edit_file', params: [args.path] },
							run: async () => {
								work.running += 1;
								try {
									return await step.run();
								} finally {
									work.running -= 1;
								}
							},
						};
					},
				})
	);
}

/**
 * Runs one team switch order, then gives every OK and releases every held
 * call in turn until all of them have finished.
 */
export async function runSwitchOrder(order: SwitchStep[], asking = false): Promise<SwitchOutcome> {
	runs += 1;
	const [first, second] = [`alpha${runs}`, `beta${runs}`];
	const store = new FakeStore({ [storePath(first)]: ORIGINAL, [storePath(second)]: OTHER_TEAM }).install();
	for (const path of store.files.keys()) store.watched.add(path);
	const ws: Workspace = await buildWorkspace({ hostAppId: 'ordering.test', autoCommit: true, scope: { kind: 'team', teamId: first } });
	const view: IWorkspaceFileSystem = ws.view;

	// step: the agent reads the file, then edits it twice in one wave; the
	// model then says it is done, and stops answering after a few tries
	const replies = [
		plan([['read_file', { path: FILE }]]),
		plan([
			['edit_file', { path: FILE, oldString: ORIGINAL, newString: `${ORIGINAL}+agent` }],
			['edit_file', { path: FILE, oldString: ORIGINAL, newString: `${ORIGINAL}+agent2` }],
		]),
	];
	for (let i = 0; i < 3; i++) replies.push(JSON.stringify({ thought: 'finishing', done: true, answer: 'Edited.' }));
	let agent: Promise<unknown> | null = null;
	let agentDone = false;
	let switched = false;
	let timedOut = false;
	// step: each OK the agent waits for, oldest first; asking while an edit's work runs is a failure
	const asks: Array<() => void> = [];
	const work = { running: 0 };
	const askedOver: string[] = [];
	const quiet = () => settle(store, () => String(asks.length));
	const startAgent = () =>
		runLoop({
			request: 'Edit apps/a.ts.',
			history: [],
			prefix: { role: 'You are Wave.', instructions: [] },
			tools: agentTools(view, asking, work),
			model: async () => {
				const next = replies.shift();
				if (next === undefined) throw new Error('The scripted model has no reply left.');
				return next;
			},
			finish: new CheckRecord(async () => null),
			emit: () => undefined,
			timeoutMs: () => LIMIT_MS,
			signal: new AbortController().signal,
			takeQueued: () => [],
			approve: (act, run) => {
				if (work.running > 0) askedOver.push(`an OK for ${act.name} was asked while an edit's work was on its way`);
				return new Promise((resolve) => asks.push(() => resolve(run)));
			},
		})
			.catch(() => undefined)
			.finally(() => {
				agentDone = true;
			});

	/** The steps possible now. */
	const possible = (): SwitchStep[] => {
		if (!agent) return ['start'];
		const steps: SwitchStep[] = store.held.map((_, i) => `release ${i}` as const);
		if (asks.length > 0) steps.push('approve');
		if (!switched) steps.push('switch');
		// time can pass while a call runs or while the user is asked
		if (!timedOut && (store.held.length > 0 || asks.length > 0)) steps.push('timeout');
		return steps;
	};

	for (const step of order) {
		if (!possible().includes(step)) throw new Error(`Step ${step} is not possible after ${order.join(', ')}`);
		if (step === 'start') agent = startAgent();
		else if (step === 'switch') {
			switched = true;
			void switchWorkspace({ hostAppId: 'ordering.test', autoCommit: true, scope: { kind: 'team', teamId: second } });
		} else if (step === 'timeout') {
			timedOut = true;
			mock.timers.tick(LIMIT_MS);
		} else if (step === 'approve') {
			asks.shift()?.();
		} else {
			store.held.splice(Number(step.slice('release '.length)), 1)[0].release();
		}
		await quiet();
	}
	const next = possible();

	// step: give every OK and release everything in turn until the agent has finished and nothing is held
	if (!agent) agent = startAgent();
	await quiet();
	while (store.held.length > 0 || asks.length > 0 || !agentDone) {
		const ask = asks.shift();
		if (ask) {
			ask();
			await quiet();
			continue;
		}
		const held = store.held.shift();
		if (!held) throw new Error(`The run is stuck after ${order.join(', ') || 'no steps'}: the agent waits on nothing the store holds.`);
		held.release();
		await quiet();
	}
	return { next, erased: [...erasures(store), ...askedOver], final: store.files.get(storePath(first)) ?? '' };
}

// =============================================================================
// MANUAL MODE — Commit all, the discards and a rollback, with editors that hold unsaved typing
// =============================================================================

/** The third file: an earlier turn staged it and was sealed as a checkpoint, which the rollback step returns to. */
const FILE_C = 'apps/c.ts';

/** The id of the earlier turn's checkpoint in a restored start. */
const EARLIER_TURN = 'earlier-turn';

/**
 * Puts in the staging store what a restored start finds there: the earlier
 * turn's checkpoint, and above it a working layer with a saved change to each
 * file.
 */
async function persistRestored(team: string): Promise<void> {
	const write = async (content: string, before: string | null) => ({ kind: 'write' as const, content, before, baseHash: before === null ? null : await sha256Hex(before), stamp: 1 });
	await new StagingStore('ordering.test', stagingScopeKey({ kind: 'team', teamId: team })).persist([
		{ id: EARLIER_TURN, label: 'earlier turn', entries: new Map([[FILE_C, await write('C1', null)]]) },
		{
			id: 'restored',
			label: 'Working',
			entries: new Map([
				[FILE, await write(`${ORIGINAL}+saved`, ORIGINAL)],
				[FILE_B, await write(`${ORIGINAL_B}+savedb`, ORIGINAL_B)],
			]),
		},
	]);
}

/** A step of a manual-mode order. */
type ManualStep = 'start' | 'save' | 'type' | 'commit' | 'discard' | 'discard-file' | 'rollback' | `release ${number}`;

/** The rules the manual exploration checks (see the file header). */
type FailureKind = 'erased' | 'lost' | 'not-committed' | 'left-after-discard' | 'false-stale' | 'stuck';

/** What one manual run saw. */
interface ManualOutcome {
	/** The steps that were possible after the last step of the order. */
	next: ManualStep[];
	failures: Array<{ kind: FailureKind; text: string }>;
	/** What each file held in the store after the last commit. */
	final: Map<string, string>;
}

/** How a manual run is set up. */
interface ManualOptions {
	/**
	 * Start from a working layer the page restored, as after a reload: saved
	 * changes to both files wait in it, above the earlier turn's checkpoint.
	 * The store holds the staging store's persists too, so a discard can be
	 * slow to finish, and the per-file discard drops the second file, so a
	 * save of the first can land while it waits.
	 */
	restored?: boolean;
	/**
	 * The first editor's first read is slow: the store reads the file at the
	 * call and answers when a step releases it, and holds no other call. A
	 * load that lands behind the file's version loads again, as a clean tab
	 * follows its file.
	 */
	slowRead?: boolean;
}

/** A write through the view: the token it adds, when it was called, and whether it worked. */
interface WriteRecord {
	path: string;
	token: string;
	at: number;
	ok: boolean;
}

/** An editor tab with unsaved typing, as the Monaco tab keeps it. */
interface Tab {
	path: string;
	buffer: string;
	dirty: boolean;
	saving: boolean;
	/** The version it loaded or last saved at. */
	loaded: number;
	/** The clock at the call of its last load or save. */
	since: number;
	/** The token the user typed last. */
	token: string;
	/** False until its first load has landed. */
	ready?: boolean;
}

/** The view's private drop step, which the checks watch to learn what each discard really took out (see runManual). */
type DropInTurn = (paths: string[], foreseen: Map<string, boolean>, drop: () => { dropped: Map<string, boolean>; settle: () => Promise<void> }, ...rest: unknown[]) => Promise<void>;

/**
 * Runs one manual-mode order, then releases every held call until all is
 * done, then checks the rules.
 */
export async function runManual(order: ManualStep[], opts: ManualOptions = {}): Promise<ManualOutcome> {
	runs += 1;
	const team = `manual${runs}`;
	const store = new FakeStore({ [storePath(team)]: ORIGINAL, [storePath(team, FILE_B)]: ORIGINAL_B }).install();
	for (const path of store.files.keys()) store.watched.add(path);
	const seeded = new Set(store.watched);
	if (opts.restored) await persistRestored(team);
	const ws: Workspace = await buildWorkspace({ hostAppId: 'ordering.test', autoCommit: false, scope: { kind: 'team', teamId: team } });
	const staged = ws.view as StagedFileSystem;
	const failures: ManualOutcome['failures'] = [];
	const fail = (kind: FailureKind, text: string): void => {
		failures.push({ kind, text });
	};

	// step: what the checks need: when each write and drop was called, the changes to each
	// file that landed (an agent write that worked, a drop that took the file out), and for
	// each file the call of the last drop that covered it
	let clock = 0;
	let final = false;
	const writes: WriteRecord[] = [];
	const changes = new Map<string, number[]>([
		[FILE, []],
		[FILE_B, []],
	]);
	const lastDrop = new Map<string, number>([
		[FILE, 0],
		[FILE_B, 0],
	]);
	const drops: Array<{ at: number; paths: string[] }> = [];
	const refusedSaves: Array<{ path: string; at: number; since: number; content: string }> = [];
	const tabs = new Map<string, Tab>();
	const view = new Proxy(ws.view, {
		get(target, prop) {
			if (prop === 'write') {
				return (path: string, content: unknown, origin?: string, expect?: number): Promise<void> => {
					const token = origin === 'editor' ? (tabs.get(path)?.token ?? '') : path === FILE ? 'agent' : 'agentb';
					const record: WriteRecord = { path, token, at: ++clock, ok: false };
					writes.push(record);
					const writing = target.write(path, content, origin, expect);
					writing.then(
						() => {
							record.ok = true;
							if (origin !== 'editor') changes.get(path)?.push(record.at);
						},
						() => undefined
					);
					return writing;
				};
			}
			const value: unknown = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as IWorkspaceFileSystem;

	// step: every discard, per-file discard and rollback runs its drop through dropInTurn; the
	// checks hear what the drop really took out, at the clock of the call that asked for it
	const internals = staged as unknown as { dropInTurn: DropInTurn };
	const realDrop = internals.dropInTurn.bind(staged);
	internals.dropInTurn = (paths, foreseen, drop, ...rest) => {
		const at = ++clock;
		return realDrop(
			paths,
			foreseen,
			() => {
				const out = drop();
				drops.push({ at, paths });
				for (const path of [FILE, FILE_B]) {
					if (paths[0] !== '' && !paths.includes(path)) continue;
					lastDrop.set(path, Math.max(lastDrop.get(path) ?? 0, at));
					if (out.dropped.has(path)) changes.get(path)?.push(at);
				}
				return out;
			},
			...rest
		);
	};

	// step: an earlier turn staged apps/c.ts and was sealed as a checkpoint. A restored start
	// has the two saved changes above it, staged before any step, and holds the persists from here
	let checkpoint: string | null = EARLIER_TURN;
	if (opts.restored) {
		writes.push({ path: FILE, token: 'saved', at: ++clock, ok: true }, { path: FILE_B, token: 'savedb', at: ++clock, ok: true });
		store.holdsPersists = true;
	} else {
		await ws.view.write(FILE_C, 'C1', 'agent');
		checkpoint = await staged.checkpoint('earlier turn');
	}
	const discardsFile = opts.restored ? FILE_B : FILE;

	// step: the editors: a load and a save at the loaded version (a version is taken when its
	// call is made, so the clock is too)
	const load = async (tab: Tab): Promise<void> => {
		const since = ++clock;
		const read = await view.readVersioned(tab.path);
		// step: typing that landed during the read stays
		if (tab.dirty) return;
		tab.buffer = String(read.content);
		tab.loaded = read.version;
		tab.since = since;
	};
	const save = async (tab: Tab): Promise<void> => {
		tab.saving = true;
		const content = tab.buffer;
		const since = tab.since;
		const at = ++clock;
		try {
			const writing = view.write(tab.path, content, 'editor', tab.loaded);
			const mine = view.version(tab.path);
			await writing;
			tab.loaded = mine;
			tab.dirty = false;
			tab.since = at;
		} catch (err) {
			if (err instanceof StaleWriteError) refusedSaves.push({ path: tab.path, at, since, content });
			throw err;
		} finally {
			tab.saving = false;
		}
	};

	// step: both editors load their file (the loads are released at once), then the user types in each.
	// With opts.slowRead the first editor's load is the slow read, which a step releases: until it lands
	// that editor holds nothing, and the user types in the second only
	const opened = (path: string): Tab => {
		const tab: Tab = { path, buffer: '', dirty: false, saving: false, loaded: 0, since: 0, token: '' };
		tabs.set(path, tab);
		return tab;
	};
	const slowLoad = opts.slowRead ? opened(FILE) : null;
	const loading = Promise.all(
		(slowLoad ? [FILE_B] : [FILE, FILE_B]).map(async (path) => {
			const tab = opened(path);
			await load(tab);
			tab.ready = true;
		})
	);
	await settle(store);
	store.held.splice(0).forEach((h) => h.release());
	await loading;
	for (const [path, tab] of tabs) {
		ws.view.registerOverlay(path, { getContent: () => tab.buffer, isDirty: () => tab.dirty && !final });
		if (tab === slowLoad) continue;
		tab.token = path === FILE ? 'ed1' : 'edb';
		tab.buffer = `${tab.buffer}+${tab.token}`;
		tab.dirty = true;
	}
	ws.view.notify();
	const tabA = tabs.get(FILE) as Tab;

	// step: the agent reads both files, then edits both in one wave; a file with unsaved typing refuses its edit
	const replies = [
		plan([
			['read_file', { path: FILE }],
			['read_file', { path: FILE_B }],
		]),
		plan([
			['edit_file', { path: FILE, oldString: ORIGINAL, newString: `${ORIGINAL}+agent` }],
			['edit_file', { path: FILE_B, oldString: ORIGINAL_B, newString: `${ORIGINAL_B}+agentb` }],
		]),
	];
	for (let i = 0; i < 3; i++) replies.push(JSON.stringify({ thought: 'finishing', done: true, answer: 'Edited.' }));
	let agent: Promise<unknown> | null = null;
	const startAgent = () =>
		runLoop({
			request: 'Edit both files.',
			history: [],
			prefix: { role: 'You are Wave.', instructions: [] },
			tools: new FilesystemTools(view).tools(),
			model: async () => {
				const next = replies.shift();
				if (next === undefined) throw new Error('The scripted model has no reply left.');
				return next;
			},
			finish: new CheckRecord(async () => null),
			emit: () => undefined,
			timeoutMs: () => LIMIT_MS,
			signal: new AbortController().signal,
			takeQueued: () => [],
			approve: async (_act, run) => run,
		}).catch(() => undefined);

	// step: the user's steps
	let saves = 0;
	let typed = false;
	let committed = false;
	let discarded = false;
	let discardedFile = false;
	let rolledBack = false;
	const inflight = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>): void => {
		const settled = work.catch(() => undefined);
		inflight.add(settled);
		void settled.then(() => inflight.delete(settled));
	};
	if (slowLoad) {
		// step: from here the store holds only this read's answer, which comes back with the file as it was
		store.watched.clear();
		store.heldAnswers.add(storePath(team));
		const follow = async (tab: Tab): Promise<void> => {
			await load(tab);
			while (!tab.dirty && view.version(tab.path) !== tab.loaded) await load(tab);
			tab.ready = true;
		};
		track(follow(slowLoad));
		await settle(store);
		store.heldAnswers.delete(storePath(team));
	}
	const possible = (): ManualStep[] => {
		const steps: ManualStep[] = store.held.map((_, i) => `release ${i}` as const);
		if (!agent) steps.push('start');
		if (tabA.dirty && !tabA.saving && saves < 2) steps.push('save');
		if (!typed && tabA.ready && !tabA.dirty && !tabA.saving) steps.push('type');
		if (!committed) steps.push('commit');
		if (!discarded) steps.push('discard');
		if (!discardedFile) steps.push('discard-file');
		if (!rolledBack && checkpoint) steps.push('rollback');
		return steps;
	};

	for (const step of order) {
		if (!possible().includes(step)) throw new Error(`Step ${step} is not possible after ${order.join(', ')}`);
		if (step === 'start') agent = startAgent();
		else if (step === 'save') {
			saves += 1;
			track(save(tabA));
		} else if (step === 'type') {
			typed = true;
			tabA.token = 'ed2';
			tabA.buffer = `${tabA.buffer}+ed2`;
			tabA.dirty = true;
			ws.view.notify();
		} else if (step === 'commit') {
			committed = true;
			// step: a commit that met no conflict carries every write that worked and was called before it,
			// unless a discard or rollback called between the two took that write out first
			const at = ++clock;
			track(
				staged.commit().then((result) => {
					if (result.conflicts.length > 0) return;
					for (const w of writes) {
						if (!w.ok || w.at > at || drops.some((d) => d.at > w.at && d.at < at && (d.paths[0] === '' || d.paths.includes(w.path)))) continue;
						if (!tokens(store.files.get(storePath(team, w.path)) ?? '').has(w.token)) fail('not-committed', `'${w.token}' was written to ${w.path} before Commit all, and the commit did not carry it`);
					}
				})
			);
		} else if (step === 'discard') {
			discarded = true;
			track(staged.discard());
		} else if (step === 'discard-file') {
			discardedFile = true;
			track(staged.discardPath(discardsFile));
		} else if (step === 'rollback') {
			rolledBack = true;
			track(staged.rollback(checkpoint as string));
		} else {
			store.held.splice(Number(step.slice('release '.length)), 1)[0].release();
		}
		await settle(store);
	}
	const next = possible();

	// step: finish the run: release what is held
	const drive = async <T>(work: Promise<T>, what: string): Promise<T | undefined> => {
		let done = false;
		void work.then(
			() => (done = true),
			() => (done = true)
		);
		await settle(store);
		while (!done) {
			const held = store.held.shift();
			if (!held) {
				fail('stuck', `${what} waits on nothing the store holds`);
				return undefined;
			}
			held.release();
			await settle(store);
		}
		return work;
	};
	// step: an editor save refused as stale, or an editor left behind the file's version, needs a
	// change to its file that landed after the editor loaded or saved it (a commit is not one)
	const landedSince = (path: string, since: number, until = Infinity): boolean => (changes.get(path) ?? []).some((at) => at > since && at < until);
	const checkEditors = (): void => {
		for (const refused of refusedSaves.splice(0)) {
			if (!landedSince(refused.path, refused.since, refused.at)) fail('false-stale', `the editor's save of '${refused.content}' to ${refused.path} was refused as stale, though no change to it landed since the editor loaded or saved it`);
		}
		for (const tab of tabs.values()) {
			const now = view.version(tab.path);
			const text = `the editor of ${tab.path} is behind (version ${tab.loaded}, now ${now}), though no change to it landed since it loaded or saved`;
			if (now !== tab.loaded && !landedSince(tab.path, tab.since) && !failures.some((f) => f.text === text)) fail('false-stale', text);
		}
	};
	// step: when the order never started the agent, the steps' own work finishes and the editors
	// are checked before the agent runs, since its edits would hide a version counted for nothing
	if (!agent) {
		await drive(
			Promise.all([...inflight]).then(() => undefined),
			'the steps'
		);
		checkEditors();
		agent = startAgent();
	}
	await drive(
		Promise.all([agent, ...inflight]).then(() => undefined),
		'the run'
	);
	if (failures.some((f) => f.kind === 'stuck')) return { next, failures, final: new Map() };
	checkEditors();

	// step: the view with no editor buffers, then a last commit, then the store
	final = true;
	ws.view.notify();
	const original = (path: string) => (path === FILE ? ORIGINAL : ORIGINAL_B);
	for (const path of [FILE, FILE_B]) {
		const shownNow = tokens(String((await drive(view.read(path), `reading ${path}`).catch(() => '')) ?? ''));
		const stored = tokens(store.files.get(storePath(team, path)) ?? '');
		const since = new Set(writes.filter((w) => w.path === path && w.ok && w.at > (lastDrop.get(path) ?? 0)).map((w) => w.token));
		for (const token of shownNow) {
			if (token !== original(path) && !stored.has(token) && !since.has(token)) fail('left-after-discard', `${path} still shows '${token}', written before a discard that covered it and never committed`);
		}
	}
	const last = await drive(staged.commit(), 'the last commit');
	if (last && last.conflicts.length > 0) fail('lost', `the last commit met conflicts: ${last.conflicts.map((c) => `${c.path} ${c.reason}`).join(', ')}`);
	const finalStore = new Map([FILE, FILE_B].map((path) => [path, store.files.get(storePath(team, path)) ?? '']));
	for (const w of writes) {
		if (w.ok && w.at > (lastDrop.get(w.path) ?? 0) && !tokens(finalStore.get(w.path) ?? '').has(w.token)) fail('lost', `'${w.token}' was written to ${w.path} and never reached the store`);
	}
	for (const erased of erasures(store, seeded)) fail('erased', erased);
	return { next, failures, final: finalStore };
}

/** Tries every manual-mode order of up to MANUAL_DEPTH steps. */
export async function exploreManual(opts: ManualOptions = {}): Promise<{ tried: number; failures: string[]; byKind: Map<FailureKind, number>; kinds: Set<string> }> {
	const failures: string[] = [];
	const byKind = new Map<FailureKind, number>();
	const kinds = new Set<string>();
	let tried = 0;
	const explore = async (order: ManualStep[]): Promise<void> => {
		const outcome = await runManual(order, opts);
		tried += 1;
		for (const step of order) kinds.add(step.split(' ')[0]);
		for (const failure of outcome.failures) {
			failures.push(`${order.join(' > ') || '(no steps)'}: [${failure.kind}] ${failure.text}`);
			byKind.set(failure.kind, (byKind.get(failure.kind) ?? 0) + 1);
		}
		if (order.length < MANUAL_DEPTH) for (const step of outcome.next) await explore([...order, step]);
	};
	await explore([]);
	return { tried, failures, byKind, kinds };
}

/** Prints what an exploration found. */
export function report(name: string, found: Awaited<ReturnType<typeof exploreManual>>): void {
	const summary = [...found.byKind].map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none';
	console.log(`ordering (${name}): ${found.tried} orders tried, ${found.failures.length} broke a rule (${summary})`);
	for (const kind of found.byKind.keys()) console.log(`  first ${kind}: ${found.failures.find((f) => f.includes(`[${kind}]`))}`);
}
