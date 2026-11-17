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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// FAKE ENGINE — the root's RocketRideClient, as the isolation tests need it
// =============================================================================
//
// Only what `registerClientOps` and the root call: `request`, `addMonitor`,
// `removeMonitor`, `log.openEventStream`. Credentials are real-format
// (`tk_` + 32 lowercase hex, `pk_` + 32 lowercase hex, task id = the first 8
// hex of the `tk_` body + `.` + source, as `task_server.py:1533-1540`) and
// fresh per run; response bodies follow the engine's shapes.
// =============================================================================

/// <reference types="node" />

import { randomBytes, randomUUID } from 'node:crypto';
import type { DAPMessage } from 'rocketride';

/** One DAP request the engine received. */
export interface IReceived {
	message: DAPMessage;
	timeout: number | undefined;
}

/** One monitor call the engine received. */
export interface IMonitorCall {
	kind: 'add' | 'remove';
	key: Record<string, unknown>;
	types: string[];
}

/** One run the engine started. */
export interface IFakeRun {
	token: string;
	publicToken: string;
	id: string;
	projectId: string;
	source: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** The fake engine plus its test controls. */
export interface IFakeEngine {
	/** The object `cm.getClient()` returns. */
	client: Record<string, unknown>;
	received: IReceived[];
	monitorCalls: IMonitorCall[];
	runs: IFakeRun[];
	/** Every store handle the engine issued (`fs_open`), in order. */
	fsHandles: string[];
	/** Live monitor refcounts as the SDK keeps them: key JSON -> type -> count. */
	monitors: Map<string, Map<string, number>>;
	/** Messages received for one command (after `since`). */
	messagesFor(command: string, since?: number): IReceived[];
	/** Makes the NEXT response to `command` a `success: false` response. */
	fail(command: string, message: string): void;
	/** Makes the NEXT `request` for `command` THROW (a transport or SDK exception). */
	throwNext(command: string, err: Error): void;
	/** Holds responses to `command` until the returned release function runs. */
	hold(command: string): () => void;
	/** Sets the next `rrext_get_task_status` body fields. */
	setStatus(fields: Record<string, unknown>): void;
	/** A fake engine event body (`apaevt_status_update`), stamped as `task_engine.py:2128-2140`. */
	emitEvent(body: Record<string, unknown>): DAPMessage;
}

/** Creates a fake engine. */
export function createFakeEngine(): IFakeEngine {
	const received: IReceived[] = [];
	const monitorCalls: IMonitorCall[] = [];
	const runs: IFakeRun[] = [];
	const fsHandles: string[] = [];
	const monitors = new Map<string, Map<string, number>>();
	const failures = new Map<string, string>();
	const throws = new Map<string, Error>();
	const holds = new Map<string, Promise<void>>();
	let statusFields: Record<string, unknown> = {};
	let pipeSeq = 0;
	let fsSeq = 0;
	let respSeq = 1000;

	const runByToken = (token: unknown): IFakeRun | undefined => runs.find((r) => r.token === token);

	const bodyFor = (message: DAPMessage): Record<string, unknown> => {
		const args = (message.arguments ?? {}) as Record<string, unknown>;
		const top = message as unknown as Record<string, unknown>;
		switch (message.command) {
			case 'execute': {
				const pipeline = (args.pipeline ?? {}) as Record<string, unknown>;
				const source = String(args.source ?? pipeline.source ?? 'chat_1');
				const tokenHex = hex(16);
				const run: IFakeRun = {
					token: `tk_${tokenHex}`,
					publicToken: `pk_${hex(16)}`,
					id: `${tokenHex.slice(0, 8)}.${source}`,
					projectId: typeof pipeline.project_id === 'string' ? pipeline.project_id : randomUUID(),
					source,
				};
				runs.push(run);
				return { id: run.id, token: run.token, publicToken: run.publicToken, projectId: run.projectId, source: run.source, provider: 'local', reused: false };
			}
			case 'restart': {
				const run = runByToken(args.token ?? top.token);
				if (!run) return {};
				return { id: run.id, token: run.token, publicToken: run.publicToken, projectId: run.projectId, source: run.source, provider: 'local' };
			}
			case 'rrext_get_token': {
				const run = runs.find((r) => r.projectId === args.projectId && (args.source === undefined || r.source === args.source));
				return run ? { token: run.token } : {};
			}
			case 'rrext_get_task_status': {
				const run = runByToken(args.token ?? top.token);
				return { name: 'fake', project_id: run?.projectId ?? randomUUID(), source: run?.source ?? 'chat_1', completed: false, state: 5, startTime: 0, endTime: 0, notes: [], status: 'running', warnings: [], errors: [], ...statusFields };
			}
			case 'rrext_process': {
				if (args.subcommand === 'open') return { pipe_id: ++pipeSeq };
				return {};
			}
			case 'rrext_store': {
				switch (args.subcommand) {
					case 'fs_open': {
						const handle = `fsh-${++fsSeq}-${hex(4)}`;
						fsHandles.push(handle);
						return { handle, size: 0 };
					}
					case 'fs_get_json':
						return { value: { ok: true } };
					case 'fs_stat':
						return { exists: true, type: 'file', size: 1 };
					case 'fs_list_dir':
						return { entries: [], count: 0 };
					case 'fs_write':
						return { bytesWritten: 4 };
					default:
						return {};
				}
			}
			default:
				return {};
		}
	};

	const client: Record<string, unknown> = {
		async request(message: DAPMessage, timeout?: number): Promise<DAPMessage> {
			received.push({ message: structuredClone(message), timeout });
			const command = message.command ?? '';
			const thrown = throws.get(command);
			if (thrown) {
				throws.delete(command);
				throw thrown;
			}
			const held = holds.get(command);
			if (held) await held;
			const base = { type: 'response' as const, seq: ++respSeq, request_seq: message.seq, command };
			const failure = failures.get(command);
			if (failure !== undefined) {
				failures.delete(command);
				return { ...base, success: false, message: failure };
			}
			if (command === 'rrext_store' && (message.arguments as Record<string, unknown> | undefined)?.subcommand === 'fs_read') {
				return { ...base, success: true, arguments: { data: new Uint8Array([1, 2, 3, 4]) } } as DAPMessage;
			}
			return { ...base, success: true, body: bodyFor(message) };
		},
		async addMonitor(key: Record<string, unknown>, types: string[]): Promise<void> {
			monitorCalls.push({ kind: 'add', key: structuredClone(key), types: [...types] });
			const k = JSON.stringify(key);
			const counts = monitors.get(k) ?? new Map<string, number>();
			for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
			monitors.set(k, counts);
		},
		async removeMonitor(key: Record<string, unknown>, types: string[]): Promise<void> {
			monitorCalls.push({ kind: 'remove', key: structuredClone(key), types: [...types] });
			const k = JSON.stringify(key);
			const counts = monitors.get(k);
			if (!counts) return;
			for (const t of types) {
				const n = counts.get(t) ?? 0;
				if (n <= 1) counts.delete(t);
				else counts.set(t, n - 1);
			}
			if (counts.size === 0) monitors.delete(k);
		},
		log: { openEventStream: () => ({ closeEventStream() {} }) },
	};

	return {
		client,
		received,
		monitorCalls,
		runs,
		fsHandles,
		monitors,
		messagesFor: (command, since = 0) => received.slice(since).filter((r) => r.message.command === command),
		fail: (command, message) => void failures.set(command, message),
		throwNext: (command, err) => void throws.set(command, err),
		hold(command) {
			let release!: () => void;
			holds.set(
				command,
				new Promise<void>((resolve) => {
					release = () => {
						holds.delete(command);
						resolve();
					};
				})
			);
			return release;
		},
		setStatus: (fields) => {
			statusFields = fields;
		},
		emitEvent(body) {
			return {
				type: 'event',
				seq: ++respSeq,
				event: 'apaevt_status_update',
				body: { project_id: randomUUID(), source: 'chat_1', runKind: 'dev', teamId: 'local', userId: 'local', ...body },
			} as unknown as DAPMessage;
		},
	};
}
