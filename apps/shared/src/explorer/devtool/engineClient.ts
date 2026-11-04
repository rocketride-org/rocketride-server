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

// =============================================================================
// EXPLORER DEV TOOL — ENGINE CLIENT (the controller's view of the realm client)
// =============================================================================
//
// Every realm's `useShellConnection().client` is a real RocketRideClient: the
// root's socket-owning instance, or a RocketRideClientProxy whose requests ride
// the shell bus to the root's one socket. It is null until the realm can answer
// truthfully. This module narrows it to what an Explorer needs and nothing
// more: an {@link IExplorerClient} (discovery and tool calls) plus the file
// store calls the history accessor uses ({@link IPrefsFs}).
//
//   - It takes a GETTER, not a client: the realm's client is read at call time,
//     so a client that is not there yet (or was replaced) is never captured. A
//     null client rejects with kind `unavailable` BEFORE anything is sent.
//   - `tool` passes its `timeout` straight to the SDK (the one method that has
//     one); a deliberately unbounded call passes the 24 h cap, because a
//     timeout-less request through a proxy falls back to the 120 s bus
//     default (timeouts.ts).
//   - Every other method has no SDK timeout, so each is bounded by an
//     APPLICATION deadline (withDeadline). On expiry the caller stops waiting
//     and is told so honestly: the request was NOT cancelled and may still
//     complete. A late answer, or a late failure, is swallowed.
//   - SDK errors pass through untouched (class and `code`); nothing is parsed
//     out of a message.
//
// `IRealmClient` is STRUCTURAL, so this module imports nothing from 'shell' or
// 'rocketride' at runtime and runs under node:test. A type-only test pins that
// the SDK's RocketRideClient is assignable to it.
// =============================================================================

import { ExplorerToolError } from '../errors';
import type { IExplorerClient } from '../types';
import {
	GET_TASK_PIPELINE_TIMEOUT_MS,
	GET_TASKS_TIMEOUT_MS,
	LIST_TASKS_TIMEOUT_MS,
	MONITOR_TIMEOUT_MS,
	PREFS_FS_DEADLINE_MS,
	assertTimeoutMs,
	toolSdkTimeoutMs,
} from './timeouts';

/** A monitor key, as the SDK's addMonitor takes it. */
export interface IMonitorKey {
	token?: string;
	projectId?: string;
	source?: string;
}

/** The file-store calls of the realm client the history accessor uses. */
export interface IPrefsFs {
	/** Metadata of a store path; `exists: false` for a missing file or folder. */
	fsStat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir'; size?: number; modified?: number }>;
	/** Read a JSON file. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fsReadJson<T = any>(path: string): Promise<T>;
	/** Create a folder (idempotent in practice). */
	fsMkdir(path: string): Promise<void>;
	/** Write a whole JSON document in one request. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fsWriteJson(path: string, obj: any): Promise<void>;
}

/** The part of a RocketRideClient (root or realm proxy) this library calls. */
export interface IRealmClient extends IPrefsFs {
	getTasks(): Promise<Array<Record<string, unknown>>>;
	listTasks(req?: { page_size?: number; filters?: Record<string, string | string[]>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }> }): Promise<unknown>;
	getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tool<T = any>(options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }): Promise<T>;
	addMonitor(key: IMonitorKey, types: string[]): Promise<void>;
	removeMonitor(key: IMonitorKey, types: string[]): Promise<void>;
}

/** Where a realm's client comes from: null until the realm can answer truthfully. */
export type RealmClientGetter<C> = () => C | null | undefined;

/**
 * Bound a request that has no timeout of its own.
 *
 * @param run - Starts the request.
 * @param deadlineMs - How long the caller waits.
 * @param what - Names the request in the message and as the error's `tool`.
 * @returns What the request answered.
 * @throws ExplorerToolError (kind `timeout`) when it did not answer in time; anything the request itself threw, untouched.
 */
export function withDeadline<T>(run: () => Promise<T>, deadlineMs: number, what: string): Promise<T> {
	const wait = assertTimeoutMs(deadlineMs, `${what} deadline`);
	return new Promise<T>((resolve, reject) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			reject(new ExplorerToolError({
				kind: 'timeout',
				tool: what,
				message: `'${what}' did not answer within ${Math.round(wait / 1000)}s; the request was not cancelled and may still complete.`,
			}));
		}, wait);
		let started: Promise<T>;
		try {
			started = run();
		} catch (error) {
			done = true;
			clearTimeout(timer);
			reject(error);
			return;
		}
		started.then(
			(value) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * The client of a realm, or the refusal that says nothing was sent.
 *
 * @param get - The realm's client getter.
 * @param what - The request, for the message.
 * @returns The client.
 * @throws ExplorerToolError (kind `unavailable`) when the realm has none yet.
 */
function need<C>(get: RealmClientGetter<C>, what: string): C {
	const client = get();
	if (client === null || client === undefined) {
		throw new ExplorerToolError({ kind: 'unavailable', tool: what, message: `This window is not connected to a server yet, so '${what}' was not sent.` });
	}
	return client;
}

/**
 * The library's engine client over the realm's RocketRideClient.
 *
 * @param get - The realm's client getter (production: the latest `useShellConnection().client`).
 * @returns The client; every call reads the getter again.
 */
export function createExplorerClient(get: RealmClientGetter<IRealmClient>): IExplorerClient {
	return {
		async getTasks() {
			const rows = await withDeadline(() => need(get, 'getTasks').getTasks(), GET_TASKS_TIMEOUT_MS, 'getTasks');
			if (!Array.isArray(rows)) throw new Error('getTasks answered with something that is not a list of tasks.');
			return rows;
		},
		listTasks(req) {
			return withDeadline(() => need(get, 'listTasks').listTasks(req), LIST_TASKS_TIMEOUT_MS, 'listTasks');
		},
		async getTaskPipeline(token) {
			const pipeline = await withDeadline(() => need(get, 'getTaskPipeline').getTaskPipeline(token), GET_TASK_PIPELINE_TIMEOUT_MS, 'getTaskPipeline');
			return pipeline !== null && typeof pipeline === 'object' && !Array.isArray(pipeline) ? pipeline : undefined;
		},
		tool<T>(options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> {
			// The SDK's own timeout bounds it (and, in a proxy, the bus above it).
			const timeout = toolSdkTimeoutMs(options.timeout);
			return Promise.resolve().then(() => need(get, 'tool').tool<T>({ ...options, timeout }));
		},
		addMonitor(key, types) {
			return withDeadline(() => need(get, 'addMonitor').addMonitor(key, types), MONITOR_TIMEOUT_MS, 'addMonitor');
		},
		removeMonitor(key, types) {
			return withDeadline(() => need(get, 'removeMonitor').removeMonitor(key, types), MONITOR_TIMEOUT_MS, 'removeMonitor');
		},
	};
}

/**
 * The file-store calls over the realm's client, each bounded by an application deadline.
 *
 * @param get - The realm's client getter.
 * @param deadlineMs - The deadline of each request (default {@link PREFS_FS_DEADLINE_MS}).
 * @returns The store calls; a null client rejects with kind `unavailable` (not sent).
 */
export function createPrefsFs(get: RealmClientGetter<IPrefsFs>, deadlineMs: number = PREFS_FS_DEADLINE_MS): IPrefsFs {
	return {
		fsStat: (path) => withDeadline(() => need(get, 'fsStat').fsStat(path), deadlineMs, 'fsStat'),
		fsReadJson: <T>(path: string) => withDeadline(() => need(get, 'fsReadJson').fsReadJson<T>(path), deadlineMs, 'fsReadJson'),
		fsMkdir: (path) => withDeadline(() => need(get, 'fsMkdir').fsMkdir(path), deadlineMs, 'fsMkdir'),
		fsWriteJson: (path, obj) => withDeadline(() => need(get, 'fsWriteJson').fsWriteJson(path, obj), deadlineMs, 'fsWriteJson'),
	};
}
