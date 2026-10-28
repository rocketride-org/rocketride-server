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
// ORDERING TESTS — every order of agent edits, team switch, tool timeout and approval on one file
// =============================================================================

/**
 * A generated-input check. It runs the real pieces: rocket-ui's workspace (its
 * store backend, CachedVfs and StagedFileSystem) over an in-memory store, and
 * the agent's file tools inside the real Wave loop. The store holds every read
 * and write of the file until the test releases it, so each run is one order
 * of events. The test tries every order of up to MAX_DEPTH steps. A step
 * starts the agent, releases one held store call, switches the team, or times
 * out the agent's running tool call. In the second check every edit asks for
 * the user's OK first, as a delete does, and one more step gives the OK.
 *
 * Every file content is a set of tokens joined by '+', and every writer adds
 * its own token to what it read. A write that lands without a token the stored
 * file already holds was computed from an older version than the one current
 * when it was meant, or landed in a team it was not meant for, so it erased
 * someone's work. The test collects every such write and names the steps that
 * led to it. It also collects every OK asked while an edit's work is still on
 * its way: a card must never ask for a call that could land under it.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { createWorkspace, type Workspace } from '../../../../rocket-ui/src/surfaces/workspace/vfs/workspace';
import { CheckRecord } from '../agent/run';
import { FilesystemTools } from '../agent/toolkits/filesystem';
import { AgentTool } from '../agent/tools';
import { runLoop } from '../agent/wave/loop';
import type { IWorkspaceFileSystem } from './vfsTypes';

// =============================================================================
// FIXTURES
// =============================================================================

/** The file every actor works on, as a workspace path. */
const FILE = 'apps/a.ts';

/** What the file holds before anyone writes. */
const ORIGINAL = 'BASE';

/** What the same path holds in the team the user switches to. */
const OTHER_TEAM = 'BETA';

/** The longest order of steps tried; after it, every held call is released in turn. */
const MAX_DEPTH = 6;

/** The tool time limit; the timeout step moves the mocked clock past it. */
const LIMIT_MS = 1000;

/** The store path of the file in a team. */
function storePath(team: string): string {
	return `@/Team/=${team}/.projects/.appdev/${FILE.slice('apps/'.length)}`;
}

/** The tokens of a content. */
function tokens(content: string): Set<string> {
	return new Set(content.split('+'));
}

// =============================================================================
// STORE — an in-memory store client that holds the file's reads and writes
// =============================================================================

/** One held store call. */
interface Held {
	/** What the call does, for the report. */
	label: string;
	/** Lets the call go on. */
	release: () => void;
}

/**
 * The fake client the workspace backend and its staging store talk to. Calls
 * on the watched paths wait in `held` until released; a read sees the store as
 * it is when it is released. Every other path answers at once.
 */
class Store {
	readonly files = new Map<string, string>();
	readonly held: Held[] = [];
	/** Each landed write that erased a token, described. */
	readonly erased: string[] = [];
	private readonly watched: Set<string>;

	/** @param seed - The watched files and what they hold. */
	constructor(seed: Record<string, string>) {
		for (const [path, content] of Object.entries(seed)) this.files.set(path, content);
		this.watched = new Set(Object.keys(seed));
	}

	/** Waits until the call is released, when the path is watched. */
	private gate(label: string, path: string): Promise<void> {
		if (!this.watched.has(path)) return Promise.resolve();
		return new Promise((release) => this.held.push({ label: `${label} ${path}`, release }));
	}

	/** Stores a write, noting any token it erased from a watched file. */
	private land(path: string, content: string): void {
		if (this.watched.has(path)) {
			const after = tokens(content);
			const missing = [...tokens(this.files.get(path) ?? '')].filter((t) => !after.has(t));
			if (missing.length > 0) this.erased.push(`'${content}' landed on ${path} and erased ${missing.join(', ')}`);
		}
		this.files.set(path, content);
	}

	/** The children of a store folder. */
	private children(dir: string): Array<{ name: string; type: 'file' | 'dir' }> {
		const prefix = `${dir.replace(/\/+$/, '')}/`;
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
		}
		return [...names].map(([name, type]) => ({ name, type }));
	}

	readonly client = {
		fsReadString: async (path: string): Promise<string> => {
			await this.gate('read', path);
			const content = this.files.get(path);
			if (content === undefined) throw new Error(`not found: ${path}`);
			return content;
		},
		fsWriteString: async (path: string, content: string): Promise<void> => {
			await this.gate('write', path);
			this.land(path, content);
		},
		fsReadMany: async (paths: string[]) => paths.map((path) => (this.files.has(path) ? { ok: true, data: new TextEncoder().encode(this.files.get(path)) } : { ok: false, error: 'not found' })),
		fsReadJson: async (path: string): Promise<unknown> => {
			const content = this.files.get(path);
			if (content === undefined) throw new Error(`not found: ${path}`);
			return JSON.parse(content);
		},
		fsWriteJson: async (path: string, value: unknown): Promise<void> => {
			this.files.set(path, JSON.stringify(value));
		},
		fsListDir: async (path: string) => ({ entries: this.children(path) }),
		fsStat: async (path: string) => ({ type: this.files.has(path) ? 'file' : 'dir' }),
		fsDelete: async (path: string): Promise<void> => {
			this.files.delete(path);
		},
		fsRmdir: async (): Promise<void> => {},
		fsMkdir: async (): Promise<void> => {},
	};
}

// =============================================================================
// ONE RUN — the agent, and one order of steps
// =============================================================================

/** A step of an order. */
type Step = 'start' | 'switch' | 'timeout' | 'approve' | `release ${number}`;

/** What one run saw. */
interface Outcome {
	/** The steps that were possible after the last step of the order. */
	next: Step[];
	/** Each write that erased a token, and each OK asked while an edit's work was on its way. */
	erased: string[];
	/** What the file held at the end, in the first team. */
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
async function settle(store: Store, waiting: () => number = () => 0): Promise<void> {
	let quiet = 0;
	let seen = -1;
	while (quiet < 4) {
		await new Promise((resolve) => setImmediate(resolve));
		const now = store.held.length + waiting();
		quiet = now === seen && hashing === 0 ? quiet + 1 : 0;
		seen = now;
	}
}

/** A wave reply that asks for tool calls. */
function plan(calls: Array<[string, Record<string, unknown>]>): string {
	return JSON.stringify({ thought: 'working', tool_calls: calls.map(([tool, args]) => ({ tool, args })) });
}

/** Counts runs, so each one roots its workspace in teams of its own. */
let runs = 0;

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
 * Runs one order of steps, then gives every OK and releases every held call
 * in turn until all of them have finished.
 *
 * @param order - The steps, in order.
 * @param asking - Whether every edit asks for an OK first.
 * @returns What the run saw.
 */
async function runOrder(order: Step[], asking = false): Promise<Outcome> {
	runs += 1;
	const [first, second] = [`alpha${runs}`, `beta${runs}`];
	const store = new Store({ [storePath(first)]: ORIGINAL, [storePath(second)]: OTHER_TEAM });
	(globalThis as { __shellTestClient?: unknown }).__shellTestClient = store.client;
	const ws: Workspace = await createWorkspace({ hostAppId: 'ordering.test', autoCommit: true, scope: { kind: 'team', teamId: first } });
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
	const quiet = () => settle(store, () => asks.length);
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
	const possible = (): Step[] => {
		if (!agent) return ['start'];
		const steps: Step[] = store.held.map((_, i) => `release ${i}` as const);
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
			void createWorkspace({ hostAppId: 'ordering.test', autoCommit: true, scope: { kind: 'team', teamId: second } });
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
	return { next, erased: [...store.erased, ...askedOver], final: store.files.get(storePath(first)) ?? '' };
}

// =============================================================================
// THE CHECK
// =============================================================================

/**
 * Tries every order of up to MAX_DEPTH steps, depth first, after checking that
 * both agent edits land when nothing interferes.
 *
 * @param asking - Whether every edit asks for an OK first.
 * @returns How many orders were tried, the kinds of step tried, and each failure with its order.
 */
async function exploreAll(asking: boolean): Promise<{ tried: number; kinds: string[]; failures: string[] }> {
	// step: with nothing in the way, both agent edits land
	const plain = await runOrder(['start'], asking);
	assert.deepEqual(plain.erased, []);
	assert.deepEqual(tokens(plain.final), new Set([ORIGINAL, 'agent', 'agent2']), 'the agent edits land when nothing interferes');

	const failures: string[] = [];
	const kinds = new Set<string>();
	let tried = 0;
	const explore = async (order: Step[]): Promise<void> => {
		const outcome = await runOrder(order, asking);
		tried += 1;
		for (const step of order) kinds.add(step.split(' ')[0]);
		for (const erased of outcome.erased) failures.push(`${order.join(' > ')}: ${erased}`);
		if (order.length < MAX_DEPTH) for (const step of outcome.next) await explore([...order, step]);
	};
	await explore([]);
	return { tried, kinds: [...kinds].sort(), failures };
}

test('no order of agent edits, team switch and tool timeout erases a write', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { tried, kinds, failures } = await exploreAll(false);
		console.log(`ordering: ${tried} orders tried, ${failures.length} erased a write`);
		assert.deepEqual(kinds, ['release', 'start', 'switch', 'timeout'], 'every kind of step was tried');
		assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${tried} orders erased a write`);
	} finally {
		mock.timers.reset();
	}
});

test('no order of approvals, agent edits, team switch and tool timeout erases a write or asks over one', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const { tried, kinds, failures } = await exploreAll(true);
		console.log(`ordering with approvals: ${tried} orders tried, ${failures.length} erased a write or asked over one`);
		assert.deepEqual(kinds, ['approve', 'release', 'start', 'switch', 'timeout'], 'every kind of step was tried');
		assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${tried} orders erased a write or asked over one`);
	} finally {
		mock.timers.reset();
	}
});
