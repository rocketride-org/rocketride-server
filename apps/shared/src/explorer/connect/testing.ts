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
// EXPLORER CONNECT — TEST SUPPORT (fake client, task rows, manual clock)
// =============================================================================
//
// NOT part of the library surface (the barrel does not export it). Shared by
// the discovery, session and store suites (and the apps' own suites) so each
// builds the same fake world: a task listing that returns what the real
// server returns, a `tool` whose behaviour a test scripts per call, and
// `sendFiles` / `chat` for the role channels of a multi-role connection.
// =============================================================================

import type { IExplorerClient, ISendFile } from '../types';
import type { IStoreClock } from './store';

// =============================================================================
// TASK ROWS
// =============================================================================

/** The real server's `getTasks` row keys (verified on a live local engine). */
export interface IFakeRow {
	/** Display name. */
	name: string;
	/** Description. */
	description: string;
	/** Source component id. */
	source: string;
	/** SECRET token — tests give each one a recognisable sentinel. */
	token: string;
	/** Status text. */
	status: string;
	/** Team id. */
	teamId: string;
	/** 'dev' | 'deploy'. */
	runKind: string;
	/** 'user' | 'team'. */
	ownerKind: string;
	/** Owner id. */
	ownerId: string;
	/** The project dict. */
	pipeline: { project_id?: string; name?: string; components?: IFakeComponent[] } | null;
}

/** A pipeline component as the server sends it (config included, which discovery must never copy). */
export interface IFakeComponent {
	/** Component id. */
	id?: string;
	/** Provider. */
	provider?: string;
	/** Display name. */
	name?: string;
	/** Data-lane edges into it. */
	input?: { lane?: string; from?: string }[];
	/** Control edges into it (`{ classType: 'tool', from: <tools source> }`). */
	control?: { classType?: string; from?: string }[];
	/** The node's configuration; tests put a secret sentinel here. */
	config?: Record<string, unknown>;
}

/**
 * Build a task row over a running dev default.
 *
 * @param over - Fields to override.
 * @returns The row.
 */
export function row(over: Partial<IFakeRow> = {}): IFakeRow {
	const source = over.source ?? 'tools_1';
	const projectId = over.pipeline === null ? undefined : over.pipeline?.project_id ?? 'proj-1';
	return {
		name: 'Pipeline A',
		description: 'RocketRide DTC MCP Tool',
		source,
		token: `tk_sentinel_${over.runKind ?? 'dev'}_${over.ownerId ?? 'u1'}_${projectId ?? 'none'}_${source}`,
		status: 'Tools ready - system is ready to accept tool calls',
		teamId: 'team-1',
		runKind: 'dev',
		ownerKind: 'user',
		ownerId: 'u1',
		pipeline: {
			...(projectId !== undefined ? { project_id: projectId } : {}),
			name: 'Pipeline A',
			components: [{ id: 'db_1', provider: 'db_postgres', name: 'Orders DB' }],
		},
		...over,
	};
}

// =============================================================================
// MULTI-ROLE PIPELINES (Vector Explorer shapes)
// =============================================================================

/** A config value no endpoint, snapshot or key may ever contain. */
export const CONFIG_SENTINEL = 'cfg_sentinel_secret';

/**
 * The Vector Explorer template's components: `ingest_1` (dropper), `chat_1`
 * and `tools_1` sources; `store_1` and `embed_1` controlled by `tools_1`;
 * `store_2`, the chat path's second instance of the same store, controlled by
 * nothing.
 *
 * @param store - The store provider.
 * @returns The components.
 */
export function vectorComponents(store = 'qdrant'): IFakeComponent[] {
	const tool = [{ classType: 'tool', from: 'tools_1' }];
	return [
		{ id: 'ingest_1', provider: 'dropper', name: 'Ingest' },
		{ id: 'chat_1', provider: 'chat', name: 'Chat' },
		{ id: 'tools_1', provider: 'tools', name: 'Tools' },
		{ id: 'parse_1', provider: 'parse', input: [{ lane: 'tags', from: 'ingest_1' }] },
		{ id: 'embed_1', provider: 'embedding_transformer', name: 'Embedding', input: [{ lane: 'documents', from: 'parse_1' }], control: tool },
		{ id: 'store_1', provider: store, name: 'Store', input: [{ lane: 'documents', from: 'embed_1' }], control: tool, config: { profile: 'local', local: { apikey: CONFIG_SENTINEL } } },
		{ id: 'store_2', provider: store, name: 'Store (chat)', input: [{ lane: 'questions', from: 'embed_1' }], config: { apikey: CONFIG_SENTINEL } },
		{ id: 'llm_1', provider: 'llm_openai_api', name: 'LLM', input: [{ lane: 'questions', from: 'store_2' }], config: { apikey: CONFIG_SENTINEL } },
	];
}

/**
 * The stock "RAG Chat" template's components: a `webhook_1` ingest source and
 * a `chat_1` source, one store, no Tools source.
 *
 * @param store - The store provider.
 * @returns The components.
 */
export function ragComponents(store = 'qdrant'): IFakeComponent[] {
	return [
		{ id: 'webhook_1', provider: 'webhook', name: 'Webhook' },
		{ id: 'parse_1', provider: 'parse', input: [{ lane: 'tags', from: 'webhook_1' }] },
		{ id: 'embedding_transformer_1', provider: 'embedding_transformer', input: [{ lane: 'questions', from: 'chat_1' }] },
		{ id: 'store_1', provider: store, input: [{ lane: 'documents', from: 'embedding_transformer_1' }], config: { apikey: CONFIG_SENTINEL } },
		{ id: 'chat_1', provider: 'chat', name: 'Chat' },
		{ id: 'llm_1', provider: 'llm_openai', input: [{ lane: 'questions', from: 'store_1' }] },
	];
}

/**
 * One running task row per source of one multi-role project (each with its
 * own token), all sharing the same pipeline.
 *
 * @param sources - The running source ids.
 * @param components - The pipeline's components.
 * @param over - Fields to override on every row (owner, run kind, project...).
 * @returns The rows.
 */
export function projectRows(sources: readonly string[], components: IFakeComponent[] = vectorComponents(), over: Partial<IFakeRow> & { projectId?: string | null } = {}): IFakeRow[] {
	const { projectId = 'vp', ...rest } = over;
	return sources.map((source) => row({
		name: 'Vector docs',
		...rest,
		source,
		pipeline: { ...(projectId === null ? {} : { project_id: projectId }), name: 'Vector docs', components },
	}));
}

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** One recorded tool call. */
export interface IToolCall {
	/** The token the call rode on. */
	token: string;
	/** The tool. */
	tool: string;
	/** The target node. */
	nodeId: string | undefined;
	/** Its input. */
	input: Record<string, unknown> | undefined;
	/** The SDK timeout the call asked for. */
	timeout: number | undefined;
}

/** A fake client plus everything it saw. */
export interface IFakeWorld {
	/** The client handed to the library. */
	client: IExplorerClient;
	/** The rows `getTasks` returns next (mutate to simulate starts and stops). */
	rows: IFakeRow[];
	/** Every tool call, in order. */
	calls: IToolCall[];
	/** How many times getTasks was called. */
	getTasksCalls: number;
	/** Tokens passed to getTaskPipeline. */
	pipelineFetches: string[];
	/** Decides each tool call's outcome; throw to fail it. */
	behave: (call: IToolCall, index: number) => unknown;
	/** Overrides getTasks (e.g. to make it throw). */
	getTasksImpl?: () => Promise<Array<Record<string, unknown>>>;
	/** Pipelines getTaskPipeline answers with, by token. */
	pipelines: Record<string, Record<string, unknown> | undefined | 'throw'>;
	/** Current and peak number of in-flight tool calls. */
	inFlight: { now: number; peak: number };
	/** Every `sendFiles` call, in order. */
	uploads: IUploadCall[];
	/** Decides each `sendFiles` outcome (default: one `complete` result per file); throw to fail it. */
	uploadBehave: (call: IUploadCall, index: number) => unknown;
	/** Every `chat` call, in order. */
	chats: IChatCall[];
	/** Decides each `chat` outcome (default: one answer); throw to fail it. */
	chatBehave: (call: IChatCall, index: number) => unknown;
}

/** One recorded `sendFiles` call. */
export interface IUploadCall {
	/** The token the upload rode on. */
	token: string;
	/** The files. */
	files: ISendFile[];
	/** The concurrency asked for. */
	maxConcurrent: number | undefined;
}

/** One recorded `chat` call. */
export interface IChatCall {
	/** The token the question rode on. */
	token: string;
	/** The question. */
	question: unknown;
	/** Whether an SSE callback was passed. */
	onSSE: ((type: string, data: Record<string, unknown>) => Promise<void>) | undefined;
}

/**
 * Build a fake world.
 *
 * @param rows - Initial task rows.
 * @param behave - Tool behaviour (default: `dialect` answers a postgres node, anything else `{}`).
 * @returns The world.
 */
export function fakeWorld(rows: IFakeRow[] = [], behave?: IFakeWorld['behave']): IFakeWorld {
	const world: IFakeWorld = {
		rows,
		calls: [],
		getTasksCalls: 0,
		pipelineFetches: [],
		pipelines: {},
		inFlight: { now: 0, peak: 0 },
		behave: behave ?? ((call) => (call.tool === 'dialect' ? { dialect: 'postgres' } : {})),
		uploads: [],
		uploadBehave: (call) => call.files.map((f) => ({ action: 'complete', filepath: f.file.name, bytes_sent: f.file.size, file_size: f.file.size, upload_time: 0 })),
		chats: [],
		chatBehave: () => ({ answers: ['[fake] answer'] }),
		client: undefined as unknown as IExplorerClient,
	};
	world.client = {
		getTasks: async () => {
			world.getTasksCalls += 1;
			if (world.getTasksImpl) return world.getTasksImpl();
			return world.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, unknown>>;
		},
		getTaskPipeline: async (token: string) => {
			world.pipelineFetches.push(token);
			const answer = world.pipelines[token];
			if (answer === 'throw') throw new Error('task went away');
			return answer;
		},
		tool: async (options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }) => {
			const call: IToolCall = { token: options.token, tool: options.tool, nodeId: options.nodeId, input: options.input, timeout: options.timeout };
			world.calls.push(call);
			world.inFlight.now += 1;
			world.inFlight.peak = Math.max(world.inFlight.peak, world.inFlight.now);
			try {
				return await Promise.resolve(world.behave(call, world.calls.length - 1));
			} finally {
				world.inFlight.now -= 1;
			}
		},
		sendFiles: async (files: ISendFile[], token: string, maxConcurrent?: number) => {
			const call: IUploadCall = { token, files, maxConcurrent };
			world.uploads.push(call);
			return Promise.resolve(world.uploadBehave(call, world.uploads.length - 1));
		},
		chat: async (options: { token: string; question: unknown; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }) => {
			const call: IChatCall = { token: options.token, question: options.question, onSSE: options.onSSE };
			world.chats.push(call);
			return Promise.resolve(world.chatBehave(call, world.chats.length - 1));
		},
	} as unknown as IExplorerClient;
	return world;
}

/**
 * An error shaped like the SDK's DAPException: an Error with a string `code`.
 *
 * @param message - The message.
 * @param code - The server's machine-readable code.
 * @returns The error.
 */
export function codedError(message: string, code?: string): Error {
	return Object.assign(new Error(message), code === undefined ? {} : { code });
}

// =============================================================================
// MANUAL CLOCK
// =============================================================================

/** A clock the test advances by hand, and the timers it owns. */
export interface IManualClock extends IStoreClock {
	/** Move time forward, firing due timers in order, letting promises settle after each. */
	advance(ms: number): Promise<void>;
	/** Let pending promise continuations run without moving time. */
	settle(): Promise<void>;
	/** Number of timers still scheduled. */
	pending(): number;
}

/**
 * Create a manual clock starting at an arbitrary epoch.
 *
 * @param start - The starting epoch ms.
 * @returns The clock.
 */
export function manualClock(start = 1_000_000): IManualClock {
	let current = start;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	// A MACROtask turn (not a microtask): every promise continuation already
	// queued runs before the timer fires, however deep the chain. `setTimeout`
	// rather than Node's `setImmediate`, because this file is type-checked with
	// the browser libs only (shell:freeze compiles apps/shared without Node types).
	const turn = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 10; i += 1) await turn();
	};
	return {
		now: () => current,
		setTimer(fn, ms) {
			const id = nextId;
			nextId += 1;
			timers.set(id, { at: current + ms, fn });
			return id;
		},
		clearTimer(handle) {
			timers.delete(handle as number);
		},
		async advance(ms) {
			// Let work already in flight reach its next timer BEFORE time moves:
			// a chain that has not yet scheduled its wait would otherwise find the
			// clock already past it.
			await settle();
			const target = current + ms;
			for (;;) {
				let nextTimerId: number | null = null;
				let nextAt = Number.POSITIVE_INFINITY;
				for (const [id, timer] of timers) {
					if (timer.at <= target && timer.at < nextAt) {
						nextAt = timer.at;
						nextTimerId = id;
					}
				}
				if (nextTimerId === null) break;
				const timer = timers.get(nextTimerId)!;
				timers.delete(nextTimerId);
				current = Math.max(current, timer.at);
				timer.fn();
				await settle();
			}
			current = target;
			await settle();
		},
		settle,
		pending: () => timers.size,
	};
}
