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
 *   - The real editor documents, four times: a text tab (fileDocument.ts)
 *     and a canvas (canvasDocument.ts with the shell's Documents), each in
 *     auto and manual mode, each in a test file of its own so the test
 *     runner runs them in parallel. The document opens and loads, the user
 *     types, and the agent reads the file. A step types, presses Ctrl+S (a
 *     save can start while another waits its turn), lets the agent edit (it
 *     is refused while the file is unsaved), clicks the banner's or the
 *     stale dialog's Reload or Overwrite, closes the tab (the canvas's close
 *     answers the shell's dialog Don't Save), moves the tab to another group,
 *     releases a held call, or, in auto mode, changes the server copy as a
 *     teammate or makes a held write fail with a network error. On the
 *     canvas a step also picks Save & Run. In manual mode the staging store's
 *     persists are held, so a staged save waits too. The checks: no write
 *     erases a token the file held (an Overwrite may save over what was in
 *     the file or called before its click). After a Reload or the canvas's
 *     Don't Save, no write called later lands with typing that choice
 *     dropped. An open editor with nothing unsaved ends with the stored file
 *     at its version, and a text tab with unsaved typing behind the file
 *     shows the banner. A save with no Reload, Overwrite or close after it is
 *     not dropped and leaves its typing in the file, and a save called before
 *     one of them shows no failure after it. Save & Run runs only a pipeline
 *     the file holds when it runs. No editor stays saving or reloading. A
 *     write the server's copy refuses for a teammate's change moves the
 *     view's version and tells no editor, so a clean editor can end behind
 *     the file for that alone; the explorations count those orders apart, as
 *     they do an editor that is behind only by the versions the view counts
 *     for a write that failed.
 *
 * Each run builds its workspace with rocket-ui's createWorkspace, in a team of
 * its own; the workspace module is loaded again every RUNS_PER_LOAD runs, as a
 * new page does (see buildWorkspace).
 */

import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { Documents } from 'shell/src/components/docs/Documents';

import { fileDocument } from '../../../../rocket-ui/src/surfaces/workspace/fileDocument';
import { stagingScopeKey, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { SaveDroppedError } from '../agent/host';
import { CheckRecord } from '../agent/run';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import { AgentTool } from '../agent/tools';
import { runLoop } from '../agent/wave/loop';
import { FakeStore } from './fakeStore.harness';
import { sha256Hex } from './hash';
import { StaleVersionError, StaleWriteError, type StagedFileSystem } from './stagedFileSystem';
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

/** The tokens of a content: joined by '+', or in a pipeline's `t` field. */
export function tokens(content: string): Set<string> {
	if (content.startsWith('{')) {
		try {
			return new Set(String((JSON.parse(content) as { t?: unknown }).t ?? '').split('+'));
		} catch {
			/* not a pipeline: the raw text's tokens */
		}
	}
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

// =============================================================================
// EDITOR DOCUMENTS — the real text and canvas documents, whose saves queue
// =============================================================================

/** The text file's editor and the pipeline's canvas, as the document explorations name them. */
type DocumentKind = 'text' | 'canvas';

/** The longest order of steps tried in the document explorations. */
const DOCUMENT_DEPTH = 7;

/** The pipeline the canvas exploration opens, as a workspace path and as its document URI. */
const PIPE = 'pipelines/chat.pipe';
const PIPE_URI = 'chat.pipe';

/** The store path of the pipeline in a team. */
function pipeStorePath(team: string): string {
	return `@/Team/=${team}/.projects/${PIPE_URI}`;
}

/** A pipeline whose tokens are its `t` field, stored the way fsWriteJson stores it. */
function pipeline(t: string): string {
	return JSON.stringify({ t }, null, 2);
}

/** rocket-ui's pipeline document. */
type CanvasDocumentModule = typeof import('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument');

/** rocket-ui's project VFS and Documents adapter. */
type ProjectVfsModule = typeof import('../../../../rocket-ui/src/surfaces/workspace/projectVfs');

/** projectVfs.ts imports the workspace module, and canvasDocument.ts imports projectVfs.ts. */
const BOUND_MODULES = { project: require.resolve('../../../../rocket-ui/src/surfaces/workspace/projectVfs'), canvas: require.resolve('../../../../rocket-ui/src/surfaces/pipelines/canvasDocument') };

/** The bound modules, and the load of the workspace module they were loaded with. */
let bound: { load: { module: WorkspaceModule; runs: number }; project: ProjectVfsModule; canvas: CanvasDocumentModule } | null = null;

/**
 * The pipeline document and the project VFS, loaded with the workspace
 * module the last buildWorkspace used. projectVfs.ts finds the current
 * workspace through the workspace module it imported, so each new load of
 * that module loads these two again (see buildWorkspace).
 *
 * @returns The two modules.
 */
function boundModules(): { project: ProjectVfsModule; canvas: CanvasDocumentModule } {
	if (!loaded) throw new Error('No workspace was built.');
	if (bound?.load !== loaded) {
		for (const key of Object.values(BOUND_MODULES)) {
			const old = require.cache[key];
			delete require.cache[key];
			const at = old ? module.children.indexOf(old) : -1;
			if (at >= 0) module.children.splice(at, 1);
		}
		bound = { load: loaded, canvas: require(BOUND_MODULES.canvas) as CanvasDocumentModule, project: require(BOUND_MODULES.project) as ProjectVfsModule };
	}
	return bound;
}

/** A step of a document order. */
type DocumentStep = 'type' | 'save' | 'edit' | 'reload' | 'overwrite' | 'close' | 'move' | 'run' | 'teammate' | `release ${number}` | `fail ${number}`;

/** The rules the document explorations check (see the file header). */
type DocumentFailure = 'erased' | 'dropped-written' | 'not-stored' | 'unflagged' | 'unsaved' | 'move-dropped' | 'ran-unstored' | 'error-after-choice' | 'stuck';

/** What one document run saw. */
interface DocumentOutcome {
	/** The steps that were possible after the last step of the order. */
	next: DocumentStep[];
	/** Each broken rule. */
	failures: Array<{ kind: DocumentFailure; text: string }>;
	/** A clean editor that ends without a teammate's change a refused write revealed, and with nothing else missing; not a broken rule (see the file header). */
	untold: string[];
	/** An editor behind the file only by the versions the view counted for a write that failed; not a broken rule (see the file header). */
	failedUntold: string[];
	/** What the stored file's tokens were at the end. */
	final: string;
}

/** One editor, the text tab's or the canvas's, as a step drives it. */
interface DocumentEditor {
	/** The tokens the editor shows, or null before it loaded and after the canvas closed. */
	buffer(): string | null;
	/** True while it holds unsaved changes. */
	dirty(): boolean;
	/** The user types: the editor now shows the given tokens. */
	type(tokens: string): void;
	/** Ctrl+S. */
	save(): Promise<void>;
	/** The banner's or the dialog's Overwrite. */
	overwrite(): Promise<void>;
	/** The banner's or the dialog's Reload. */
	reload(): Promise<unknown>;
	/** Closes the tab; the canvas's close answers the shell's dialog Don't Save. */
	close(): void;
	/** Unmounts the editor and mounts it again with the document open, as a tab moved to another group does. */
	move(): void;
	/** True while the banner or the dialog offers Reload and Overwrite. */
	stale(): boolean;
	/** The view version the editor holds its content at. */
	version(): number;
	/** True while a save or a reload of the document is under way. */
	busy(): boolean;
}

/**
 * Runs one order of the document exploration, then releases every held call
 * until all is done, then checks the rules.
 *
 * @param order - The steps, in order.
 * @param kind - The text tab (fileDocument.ts) or the canvas (canvasDocument.ts).
 * @param auto - Auto mode (each save writes the store) or manual mode (saves stay staged).
 * @returns What the run saw.
 */
async function runDocument(order: DocumentStep[], kind: DocumentKind, auto: boolean): Promise<DocumentOutcome> {
	runs += 1;
	const team = `doc${runs}`;
	const path = kind === 'text' ? FILE : PIPE;
	const stored = kind === 'text' ? storePath(team) : pipeStorePath(team);
	const store = new FakeStore({ [stored]: kind === 'text' ? ORIGINAL : pipeline(ORIGINAL) }).install();
	for (const path of store.files.keys()) store.watched.add(path);
	const ws: Workspace = await buildWorkspace({ hostAppId: 'ordering.test', autoCommit: auto, scope: { kind: 'team', teamId: team } });
	const staged = ws.view as StagedFileSystem;
	const failures: DocumentOutcome['failures'] = [];
	const fail = (failure: DocumentFailure, text: string): void => {
		if (!failures.some((f) => f.text === text)) failures.push({ kind: failure, text });
	};
	const userTokens = (content: string | null): Set<string> => new Set([...tokens(content ?? '')].filter((t) => t.startsWith('ed')));

	// step: every write through the view, in the order they land. The view's content is the last write that
	// landed; a teammate's change is part of it too in auto mode, where the next write checks the server
	let clock = 0;
	let current = kind === 'text' ? ORIGINAL : pipeline(ORIGINAL);
	const called = new Set<string>();
	const landed: Array<{ at: number; tokens: Set<string>; origin?: string }> = [];
	const choices: Array<{ at: number; what: string; dropped: Set<string>; applied: boolean; appliedAt?: number }> = [];
	const overwrites: Array<{ at: number; shown: Set<string> }> = [];
	let refusedByServer = false;
	let teammateAt = Infinity;
	const failedWrites: Array<{ before: number; after: number }> = [];
	const landedVersions: number[] = [];
	const realWrite = staged.write.bind(staged);
	staged.write = (p: string, content: unknown, origin?: string, expect?: number): Promise<void> => {
		const text = String(content);
		const at = ++clock;
		for (const token of tokens(text)) called.add(token);
		const before = staged.version(p);
		const writing = realWrite(p, content, origin, expect);
		const mine = staged.version(p);
		// step: a write the server's copy refused (not the version check) moves the version and tells no editor (see the file
		// header); so does one that failed, for the versions between its call and its failure
		writing.catch((err: unknown) => {
			if (err instanceof StaleWriteError && !(err instanceof StaleVersionError)) refusedByServer = true;
			else if (!(err instanceof StaleWriteError) && p === path) failedWrites.push({ before, after: staged.version(p) });
		});
		writing.then(
			() => {
				if (p !== path) return;
				// step: a write that drops a token the file held erased someone's work, unless it is the editor's after an Overwrite
				// click and the token was in a write called before that click (Overwrite adopts the version at the click), or is a
				// teammate's change on the server from before the write (Overwrite takes the server's copy as its baseline)
				const after = tokens(text);
				const overwritten = (t: string): boolean => origin === 'editor' && overwrites.some((o) => o.at < at && (o.shown.has(t) || (t === 'teammate' && teammateAt < at)));
				const missing = [...tokens(current)].filter((t) => !after.has(t) && !overwritten(t));
				if (missing.length > 0) fail('erased', `'${[...after].join('+')}' landed on ${path} and erased ${missing.join(', ')}`);
				landed.push({ at, tokens: after, origin });
				landedVersions.push(mine);
				current = text;
			},
			() => undefined
		);
		return writing;
	};

	// step: every save, its tokens at the call, and when it settled. A save the user dropped meanwhile rejects with
	// SaveDroppedError, which is no failure: it is counted apart
	const saves: Array<{ at: number; tokens: Set<string>; settled?: number; rejected?: boolean; dropped?: boolean; what: string }> = [];
	const recordSave = (what: string, buffer: string | null, saving: Promise<void>): Promise<void> => {
		const record: (typeof saves)[number] = { at: ++clock, tokens: userTokens(buffer), what };
		saves.push(record);
		saving.then(
			() => (record.settled = ++clock),
			(err: unknown) => {
				record.settled = ++clock;
				if (err instanceof SaveDroppedError) record.dropped = true;
				else record.rejected = true;
			}
		);
		return saving;
	};
	// step: when the editor moved
	const moves: number[] = [];
	// step: the choices that drop or save over the user's buffer. The dropped tokens are the buffer's that are neither in the file
	// nor in a write already called. A text tab drops its text at once; a canvas drops its pipeline only when its reload puts the
	// stored one on screen (typing during the read keeps the pipeline), and its close drops it at once
	const choose = (what: string, buffer: string | null, drops: boolean, applied = true): void => {
		const shown = tokens(current);
		const dropped = drops ? new Set([...userTokens(buffer)].filter((t) => !shown.has(t) && !called.has(t))) : new Set<string>();
		const at = ++clock;
		choices.push({ at, what, dropped, applied, ...(applied ? { appliedAt: at } : {}) });
	};

	// step: the held calls are released until the work is done (the editor's first load, the canvas's open)
	const released = async <T>(work: Promise<T>): Promise<T> => {
		let done = false;
		void work.then(
			() => (done = true),
			() => (done = true)
		);
		await settle(store);
		while (!done) {
			const held = store.held.shift();
			if (!held) break;
			held.release();
			await settle(store);
		}
		return work;
	};

	// step: the steps' work, which the run waits for before it checks the rules
	const inflight = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>): void => {
		const settled = work.catch(() => undefined);
		inflight.add(settled);
		void settled.then(() => inflight.delete(settled));
	};

	// step: the editor opens and loads, then the user types ed1. A move unmounts it and mounts it again the way
	// FileProvider and useCanvasDocument do: it finds the document, or a new one, which the run then drives
	let editor: DocumentEditor;
	let closed = false;
	const instrumented = new WeakSet<object>();
	let run: (() => Promise<void>) | null = null;
	if (kind === 'text') {
		let doc!: ReturnType<typeof fileDocument>;
		let closeTab!: () => void;
		const mount = (): void => {
			doc = fileDocument(ws.view, FILE);
			if (!instrumented.has(doc)) {
				instrumented.add(doc);
				const mine = doc;
				const save = mine.save.bind(mine);
				mine.save = (overwrite = false) => recordSave(overwrite ? 'an Overwrite' : 'a save', mine.text, save(overwrite));
			}
			closeTab = doc.open();
		};
		mount();
		await released(doc.load());
		editor = {
			buffer: () => doc.text,
			dirty: () => doc.dirty,
			type: (t) => doc.type(t),
			save: () => doc.save(),
			overwrite: () => doc.save(true),
			reload: () => doc.discard(),
			close: () => closeTab(),
			move: () => {
				closeTab();
				mount();
				track(doc.load());
			},
			stale: () => doc.stale,
			version: () => doc.version,
			busy: () => doc.saving,
		};
	} else {
		const { project, canvas } = boundModules();
		const docs = new Documents(project.createDocumentsVfs(store.client as never));
		await released(docs.openDocument(PIPE_URI));
		const projectVfs = project.createProjectVfs(store.client as never);
		const content = () => docs.getState().documents[PIPE_URI]?.content as { t: string } | undefined;
		let doc!: ReturnType<typeof canvas.canvasDocument>;
		let leave!: () => void;
		// step: the stale dialog, as PipelineProvider's performSave and its buttons drive it. It is the mounted canvas's state, so a
		// save that settles after its canvas unmounted shows nothing; performSave shows nothing for a dropped save either
		let dialog = false;
		let mounts = 0;
		const performSave = async (overwrite: boolean): Promise<void> => {
			const mount = mounts;
			try {
				await doc.save(content(), overwrite ? { overwrite: true } : {});
				if (mount === mounts) dialog = false;
			} catch (err) {
				if (!(err instanceof SaveDroppedError) && mount === mounts) dialog = err instanceof StaleWriteError;
				throw err;
			}
		};
		const mount = (): void => {
			doc = canvas.canvasDocument(ws.view, docs, PIPE, PIPE_URI);
			doc.projectVfs = projectVfs;
			if (!instrumented.has(doc)) {
				instrumented.add(doc);
				const mine = doc;
				const save = mine.save.bind(mine);
				mine.save = (pipe, opts = {}) => recordSave(opts.overwrite ? 'an Overwrite' : 'a save', (pipe as { t: string } | undefined)?.t ?? null, save(pipe, opts));
				// step: a reload that started at or after a Reload or Discard mine and put the stored pipeline on screen applied that choice
				const reloadStored = mine.reloadStored.bind(mine);
				mine.reloadStored = (fresh?: boolean) => {
					const started = clock;
					const reloading = reloadStored(fresh);
					// step: the canvas's own reload (a clean canvas following a change, or mounting behind the file) is work the run waits for
					track(reloading);
					void reloading.then((applied) => {
						if (!applied) return;
						const at = ++clock;
						for (const choice of choices) {
							if (choice.at > started) continue;
							choice.applied = true;
							choice.appliedAt ??= at;
						}
					});
					return reloading;
				};
			}
			mounts += 1;
			dialog = false;
			leave = doc.open(() => performSave(false));
		};
		mount();
		// step: Save & Run, as PipelineProvider's handleSaveAndRun makes it: performSave with rethrow, then the run of the
		// pipeline at the click. The run runs a pipeline the store holds when it starts
		run = () => {
			const pipe = content();
			return performSave(false).then(() => {
				const runs = tokens(JSON.stringify(pipe ?? {}));
				const holds = tokens(current);
				if ([...runs].sort().join('+') !== [...holds].sort().join('+')) fail('ran-unstored', `Save & Run ran '${[...runs].join('+')}' while the file held '${[...holds].join('+')}'`);
			});
		};
		editor = {
			buffer: () => content()?.t ?? null,
			dirty: () => docs.getState().documents[PIPE_URI]?.dirty === true,
			type: (t) => docs.updateContent(PIPE_URI, { t }),
			save: () => performSave(false),
			overwrite: () => {
				dialog = false;
				return performSave(true);
			},
			reload: async () => {
				dialog = false;
				const reloaded = await doc.reloadStored();
				if (!reloaded) dialog = true;
				return reloaded;
			},
			close: () => {
				docs.closeEditor(Object.keys(docs.getState().editors)[0]);
				leave();
			},
			move: () => {
				docs.moveEditor(Object.keys(docs.getState().editors)[0], docs.splitGroup(docs.getState().activeGroupId, 'horizontal'));
				leave();
				mount();
			},
			stale: () => dialog,
			version: () => doc.version,
			busy: () => doc.saving || doc.reloading,
		};
	}
	let typed = 1;
	editor.type(`${editor.buffer() ?? ''}+ed1`);
	// step: in manual mode a save stays staged, so the staging store's persist is what a step releases
	if (!auto) store.holdsPersists = true;

	// step: the agent reads the file now, and edits it in its next wave, which waits for the 'edit' step
	let edit!: () => void;
	const editing = new Promise<void>((resolve) => (edit = resolve));
	let edited = false;
	const replies = [plan([['read_file', { path }]]), plan([['edit_file', { path, oldString: ORIGINAL, newString: `${ORIGINAL}+agent` }]])];
	for (let i = 0; i < 3; i++) replies.push(JSON.stringify({ thought: 'finishing', done: true, answer: 'Edited.' }));
	let calls = 0;
	const agent = runLoop({
		request: `Edit ${path}.`,
		history: [],
		prefix: { role: 'You are Wave.', instructions: [] },
		tools: new FilesystemTools(ws.view).tools(),
		model: async () => {
			if (++calls === 2) await editing;
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
	await settle(store, () => `${calls}`);

	// step: the user's steps
	let saved = 0;
	let reloaded = false;
	let overwritten = false;
	let teammateChanged = false;
	let moved = false;
	let started = false;
	let failed = false;
	const possible = (): DocumentStep[] => {
		const steps: DocumentStep[] = store.held.map((_, i) => `release ${i}` as const);
		// step: a held write of the file can fail once, as a network error does; only auto mode writes the file itself
		if (!failed) store.held.forEach((held, i) => held.label === `write ${stored}` && steps.push(`fail ${i}`));
		// step: a teammate's change between a write's freshness check and its store write is out of the page's reach (the store
		// has no conditional write), so it waits while a write is held past its check
		if (auto && !teammateChanged && !store.held.some((h) => h.label.startsWith('write '))) steps.push('teammate');
		if (!edited) steps.push('edit');
		if (closed || editor.buffer() === null) return steps;
		if (typed < 3) steps.push('type');
		if (editor.dirty() && saved < 3) steps.push('save');
		if (editor.stale() && !reloaded) steps.push('reload');
		if (editor.stale() && !overwritten) steps.push('overwrite');
		if (run && editor.dirty() && !started) steps.push('run');
		if (!moved) steps.push('move');
		steps.push('close');
		return steps;
	};
	const progress = (): string => `${calls} ${inflight.size}`;

	for (const step of order) {
		if (!possible().includes(step)) throw new Error(`Step ${step} is not possible after ${order.join(', ')}`);
		clock += 1;
		if (step === 'type') {
			typed += 1;
			editor.type(`${editor.buffer() ?? ''}+ed${typed}`);
		} else if (step === 'save') {
			saved += 1;
			track(editor.save());
		} else if (step === 'edit') {
			edited = true;
			edit();
		} else if (step === 'reload') {
			reloaded = true;
			choose('Reload', editor.buffer(), true, kind === 'text');
			track(editor.reload());
		} else if (step === 'overwrite') {
			overwritten = true;
			choose('Overwrite', editor.buffer(), false);
			overwrites.push({ at: clock, shown: new Set([...tokens(current), ...called]) });
			track(editor.overwrite());
		} else if (step === 'close') {
			closed = true;
			if (kind === 'canvas') choose("the close dialog's Don't Save", editor.buffer(), true);
			editor.close();
		} else if (step === 'move') {
			moved = true;
			moves.push(clock);
			editor.move();
		} else if (step === 'run') {
			started = true;
			track((run as NonNullable<typeof run>)());
		} else if (step === 'teammate') {
			teammateChanged = true;
			teammateAt = clock;
			const content = store.files.get(stored) ?? '';
			const next = kind === 'text' ? `${content}+teammate` : pipeline(`${(JSON.parse(content) as { t: string }).t}+teammate`);
			store.files.set(stored, next);
			current = next;
		} else if (step.startsWith('fail ')) {
			failed = true;
			store.held.splice(Number(step.slice('fail '.length)), 1)[0].fail();
		} else {
			store.held.splice(Number(step.slice('release '.length)), 1)[0].release();
		}
		await settle(store, progress);
	}
	const next = possible();

	// step: finish the run: release what is held, and let the agent edit if no step did
	if (!edited) edit();
	const drive = async (work: Promise<unknown>, what: string): Promise<boolean> => {
		let done = false;
		void work.then(
			() => (done = true),
			() => (done = true)
		);
		await settle(store, progress);
		while (!done) {
			const held = store.held.shift();
			if (!held) {
				fail('stuck', `${what} waits on nothing the store holds`);
				return false;
			}
			held.release();
			await settle(store, progress);
		}
		return true;
	};
	if (!(await drive(Promise.all([agent, ...inflight]), 'the run'))) return { next, failures, untold: [], failedUntold: [], final: '' };
	if (!(await drive(Promise.all([...inflight]), 'the steps'))) return { next, failures, untold: [], failedUntold: [], final: '' };
	if (editor.busy()) fail('stuck', `the ${kind === 'text' ? 'text tab' : 'canvas'} is still saving or reloading with nothing left to do`);

	// step: the stored file, as the view stores it
	const read = staged.readVersioned(path, { stored: true });
	if (!(await drive(read, 'the last read'))) return { next, failures, untold: [], failedUntold: [], final: '' };
	const raw = String((await read).content);
	const final = kind === 'text' ? raw : (JSON.parse(raw) as { t: string }).t;
	const finalTokens = tokens(final);
	const untold: string[] = [];
	const failedUntold: string[] = [];

	// step: an open editor with nothing unsaved shows the stored file, at its version; a text tab with unsaved
	// changes behind the file's version shows the banner
	if (!closed) {
		const buffer = editor.buffer();
		const shows = `the clean ${kind === 'text' ? 'text tab' : 'canvas'} shows '${buffer}' at version ${editor.version()}, and the file holds '${final}' at version ${staged.version(path)}`;
		const withoutTeammate = [...finalTokens].filter((t) => t !== 'teammate').join('+');
		// step: the view counts versions for a write that failed, and tells no editor: an editor at a version from that write's
		// call to its failure, with the file at the version of its failure and no other write landed meanwhile, is behind for
		// that alone (a known limit)
		const behindFailed = failedWrites.some((w) => w.before <= editor.version() && editor.version() < w.after && w.after === staged.version(path) && !landedVersions.some((v) => v > w.before && v <= w.after));
		if (!editor.dirty() && (buffer !== final || editor.version() !== staged.version(path))) {
			// step: the view counts a version when a write is refused for a teammate's change, and tells no editor: one that
			// holds what the view stores, or the file without the teammate's change, is behind for that alone
			const behind = refusedByServer && (buffer === final || (finalTokens.has('teammate') && [...tokens(buffer ?? '')].join('+') === withoutTeammate));
			if (behind) untold.push(shows);
			else if (behindFailed && buffer === final) failedUntold.push(shows);
			else fail('not-stored', shows);
		}
		if (kind === 'text' && editor.dirty() && editor.version() !== staged.version(path) && !editor.stale()) {
			const unflagged = `the text tab holds unsaved '${buffer}' at version ${editor.version()}, behind the file's ${staged.version(path)}, with no banner`;
			if (behindFailed) failedUntold.push(unflagged);
			else fail('unflagged', unflagged);
		}
	}

	// step: after a Reload or the canvas's Don't Save, no write called later carries what that choice dropped
	for (const choice of choices.filter((c) => c.applied && c.dropped.size > 0)) {
		for (const write of landed) {
			const carried = [...write.tokens].filter((t) => choice.dropped.has(t));
			if (write.at > choice.at && carried.length > 0) fail('dropped-written', `'${[...write.tokens].join('+')}' landed on ${path} after ${choice.what}, which dropped ${carried.join(', ')}`);
		}
	}

	// step: a save with no Reload, Overwrite or close after its call is not dropped, and when it settled it left its typing in
	// the file (a canvas's Reload counts from its click and from when it put the stored pipeline on screen). When the editor moved between its call and its end, a break is the move's. A save called before one of those
	// choices shows no failure after it
	for (const save of saves) {
		const after = choices.find((c) => c.at > save.at && save.settled !== undefined && save.settled > c.at);
		if (save.rejected && after) fail('error-after-choice', `${save.what} called before ${after.what} failed after it`);
		if (save.rejected || choices.some((c) => c.at > save.at || (c.appliedAt ?? 0) > save.at)) continue;
		const rule = moves.some((m) => m > save.at && (save.settled === undefined || m < save.settled)) ? 'move-dropped' : 'unsaved';
		if (save.dropped) {
			fail(rule, `${save.what} of ${[...save.tokens].join('+')} was dropped with no choice of the user's after it`);
			continue;
		}
		const missing = [...save.tokens].filter((t) => !finalTokens.has(t));
		if (missing.length > 0) fail(rule, `${save.what} of ${[...save.tokens].join('+')} worked, and the file at the end lacks ${missing.join(', ')}`);
	}

	return { next, failures, untold, failedUntold, final };
}

/**
 * Tries every document order of up to DOCUMENT_DEPTH steps.
 *
 * @param kind - The text tab or the canvas.
 * @param auto - Auto or manual mode.
 * @returns How many orders were tried, each broken rule with its order, and every kind of step tried.
 */
async function exploreDocument(kind: DocumentKind, auto: boolean): Promise<{ tried: number; failures: string[]; byKind: Map<DocumentFailure, number>; untold: string[]; failedUntold: string[]; kinds: Set<string> }> {
	const failures: string[] = [];
	const untold: string[] = [];
	const failedUntold: string[] = [];
	const byKind = new Map<DocumentFailure, number>();
	const kinds = new Set<string>();
	let tried = 0;
	const explore = async (order: DocumentStep[]): Promise<void> => {
		const outcome = await runDocument(order, kind, auto);
		tried += 1;
		for (const step of order) kinds.add(step.split(' ')[0]);
		for (const failure of outcome.failures) {
			failures.push(`${order.join(' > ') || '(no steps)'}: [${failure.kind}] ${failure.text}`);
			byKind.set(failure.kind, (byKind.get(failure.kind) ?? 0) + 1);
		}
		if (outcome.untold.length > 0) untold.push(`${order.join(' > ') || '(no steps)'}: ${outcome.untold[0]}`);
		if (outcome.failedUntold.length > 0) failedUntold.push(`${order.join(' > ')}: ${outcome.failedUntold[0]}`);
		if (order.length < DOCUMENT_DEPTH) for (const step of outcome.next) await explore([...order, step]);
	};
	await explore([]);
	return { tried, failures, byKind, untold, failedUntold, kinds };
}

/**
 * Prints what a document exploration found.
 *
 * @param name - The exploration's name.
 * @param found - What exploreDocument returned.
 */
function reportDocument(name: string, found: Awaited<ReturnType<typeof exploreDocument>>): void {
	const summary = [...found.byKind].map(([kind, n]) => `${kind} ${n}`).join(', ') || 'none';
	console.log(`ordering (${name}): ${found.tried} orders tried, ${found.failures.length} broke a rule (${summary})`);
	for (const kind of found.byKind.keys()) console.log(`  first ${kind}: ${found.failures.find((f) => f.includes(`[${kind}]`))}`);
	if (found.untold.length > 0) console.log(`  known limit: in ${found.untold.length} orders a clean editor was not told of a teammate's change that a refused write revealed; first: ${found.untold[0]}`);
	if (found.failedUntold.length > 0) console.log(`  known limit: in ${found.failedUntold.length} orders an editor was behind only by the versions counted for a write that failed; first: ${found.failedUntold[0]}`);
}

// =============================================================================
// THE DOCUMENT CHECK — one per editor and mode, each in a test file of its own
// =============================================================================

/**
 * Checks the orders of one editor document in one mode: the review findings'
 * orders first, then every order of up to DOCUMENT_DEPTH steps. Each of the
 * four runs in its own test file (ordering.<editor><Mode>.test.ts), so the
 * test runner runs them in parallel.
 *
 * @param kind - The editor: a text tab or a canvas.
 * @param auto - Auto mode (writes go through at once), or manual mode (they are staged).
 */
export async function checkDocumentOrders(kind: DocumentKind, auto: boolean): Promise<void> {
	const mode = auto ? 'auto' : 'manual';
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// step: the second save waits its turn and the tab moves to another group: the save is kept
		const movedSave = await runDocument(['save', 'type', 'save', 'move', 'release 0'], kind, auto);

		// step: depth-first over every order of up to DOCUMENT_DEPTH steps
		const found = await exploreDocument(kind, auto);
		reportDocument(`${kind === 'text' ? 'text tab' : 'canvas'}, ${mode}`, found);
		assert.deepEqual(movedSave.failures, []);
		assert.deepEqual(tokens(movedSave.final), new Set([ORIGINAL, 'ed1', 'ed2']));
		const kinds = ['close', 'edit', 'move', 'overwrite', 'release', 'reload', 'save', 'type', ...(kind === 'canvas' ? ['run'] : []), ...(auto ? ['fail', 'teammate'] : [])];
		assert.deepEqual([...found.kinds].sort(), kinds.sort(), 'every kind of step was tried');
		assert.deepEqual(found.failures.slice(0, 10), [], `${found.failures.length} of ${found.tried} orders broke a rule`);
	} finally {
		mock.timers.reset();
	}
}
