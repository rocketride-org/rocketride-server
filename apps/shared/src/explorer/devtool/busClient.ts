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
// EXPLORER DEV TOOL — BUS CLIENT (the controller's engine connection)
// =============================================================================
//
// Dev-tool mounts receive no client (DevToolProps has none), and a VS Code
// webview realm has no socket at all: every engine call in every realm rides
// the shell bus, `ConnectionManager.request('client.<op>', params, opts)`,
// against the fixed allowlist in the shell's clientOps.ts. This module is the
// library's IExplorerClient over that bus, for the CONTROLLER (sidebar) mount;
// frames never hold one (R1).
//
// Every request names its own bus timeout (timeouts.ts); none relies on the
// bus's 120 s default. Failures pass through untouched: in a realm that owns
// the client the SDK error (and its `code`) arrives as thrown; across the VS
// Code bridge only its message survives (busBridge.ts), and no code is ever
// reconstructed from that text (R10).
//
// `cm` is STRUCTURAL ({@link IExplorerBus}), so this module imports no value
// from 'shell' and runs under node:test; any realm's ConnectionManager fits.
// =============================================================================

import type { ClientOpMap, ShellOpParams, ShellOpResult } from 'shell';
import { isPlainObject } from '../checks';
import type { IExplorerClient } from '../types';
import {
	GET_TASK_PIPELINE_TIMEOUT_MS,
	GET_TASKS_TIMEOUT_MS,
	LIST_TASKS_TIMEOUT_MS,
	MONITOR_TIMEOUT_MS,
	assertTimeoutMs,
	busToolTimeoutMs,
} from './timeouts';

/** What the bus client needs from a realm's ConnectionManager. */
export interface IExplorerBus {
	/** Invoke an addressed bus op (connection.ts `request`). */
	request(op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** The brokered client ops, by wire name. */
export type ClientOp = keyof ClientOpMap & string;

/**
 * Call one brokered `client.*` op with an explicit bus timeout. For the ops
 * the IExplorerClient does not cover (`fs*`, `use`, `getEnvironmentKeys`, …).
 *
 * @param cm - The realm's bus.
 * @param op - The op's wire name.
 * @param params - Its params (typed by the shell's ClientOpMap).
 * @param timeoutMs - The bus timeout: REQUIRED (see timeouts.ts).
 * @returns The op's result.
 * @throws RangeError (synchronously) when the timeout is not a usable delay.
 */
export function busRequest<K extends ClientOp>(cm: IExplorerBus, op: K, params: ShellOpParams<ClientOpMap, K>, timeoutMs: number): Promise<ShellOpResult<ClientOpMap, K>> {
	const wait = assertTimeoutMs(timeoutMs, `${op} timeoutMs`);
	return cm.request(op, params, { timeoutMs: wait }) as Promise<ShellOpResult<ClientOpMap, K>>;
}

/**
 * Build the library's client over the bus.
 *
 * @param cm - The realm's bus (its ConnectionManager).
 * @returns The client. Prefer {@link getBusExplorerClient} for a stable identity.
 */
export function createBusExplorerClient(cm: IExplorerBus): IExplorerClient {
	return {
		async getTasks() {
			const rows = await busRequest(cm, 'client.getTasks', {}, GET_TASKS_TIMEOUT_MS);
			if (!Array.isArray(rows)) throw new Error('client.getTasks answered with something that is not a list of tasks.');
			return rows as Array<Record<string, unknown>>;
		},
		async listTasks(req) {
			return busRequest(cm, 'client.listTasks', req, LIST_TASKS_TIMEOUT_MS);
		},
		async getTaskPipeline(token) {
			const pipeline = await busRequest(cm, 'client.getTaskPipeline', { token }, GET_TASK_PIPELINE_TIMEOUT_MS);
			return isPlainObject(pipeline) ? pipeline : undefined;
		},
		async tool<T>(options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> {
			const params: ShellOpParams<ClientOpMap, 'client.tool'> = { token: options.token, tool: options.tool };
			if (options.nodeId !== undefined) params.nodeId = options.nodeId;
			if (options.input !== undefined) params.input = options.input;
			if (options.timeout !== undefined) params.timeout = options.timeout;
			return (await busRequest(cm, 'client.tool', params, busToolTimeoutMs(options.timeout))) as T;
		},
		async addMonitor(key, types) {
			await busRequest(cm, 'client.addMonitor', { key: key as ShellOpParams<ClientOpMap, 'client.addMonitor'>['key'], types }, MONITOR_TIMEOUT_MS);
		},
		async removeMonitor(key, types) {
			await busRequest(cm, 'client.removeMonitor', { key: key as ShellOpParams<ClientOpMap, 'client.removeMonitor'>['key'], types }, MONITOR_TIMEOUT_MS);
		},
	};
}

/** One client per bus: React effects and stores compare clients by identity. */
const clients = new WeakMap<IExplorerBus, IExplorerClient>();

/**
 * The bus client for a realm, one stable instance per bus.
 *
 * @param cm - The realm's bus (its ConnectionManager).
 * @returns The client.
 */
export function getBusExplorerClient(cm: IExplorerBus): IExplorerClient {
	let client = clients.get(cm);
	if (client === undefined) {
		client = createBusExplorerClient(cm);
		clients.set(cm, client);
	}
	return client;
}
