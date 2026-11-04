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

import type { PipelineConfig, ServiceDefinition, ValidationResult } from 'rocketride';
import { ExplorerToolError } from '../errors';
import type { IExplorerClient } from '../types';
import {
	GET_TASK_PIPELINE_TIMEOUT_MS,
	GET_TASKS_TIMEOUT_MS,
	LIST_TASKS_TIMEOUT_MS,
	MONITOR_TIMEOUT_MS,
	ENVIRONMENT_KEYS_DEADLINE_MS,
	GET_SERVICE_DEADLINE_MS,
	GET_TASK_TOKEN_DEADLINE_MS,
	PREFS_FS_DEADLINE_MS,
	TERMINATE_DEADLINE_MS,
	USE_DEADLINE_MS,
	VALIDATE_DEADLINE_MS,
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

/** The generic SDK calls an Explorer's controller makes besides discovery and tools (see {@link createExplorerAdmin}). */
export interface IAdminCalls {
	/** Start (or reuse) a pipeline and get its task token. */
	use(options: {
		token?: string;
		filepath?: string;
		pipeline?: PipelineConfig;
		source?: string;
		threads?: number;
		useExisting?: boolean;
		args?: string[];
		ttl?: number;
		pipelineTraceLevel?: 'none' | 'metadata' | 'summary' | 'full';
		name?: string;
		env?: Record<string, string>;
	}): Promise<Record<string, unknown> & { token: string }>;
	/** The token of a running task for a project and source, if any. */
	getTaskToken(options: { projectId: string; source: string; teamId?: string }): Promise<string | undefined>;
	/** Terminate a running pipeline. */
	terminate(token: string): Promise<void>;
	/** One service's definition. */
	getService(service: string): Promise<ServiceDefinition>;
	/** Validate a pipeline. */
	validate(options: { pipeline: PipelineConfig | Record<string, unknown>; source?: string }): Promise<ValidationResult>;
	/** The account namespace (`client.account`). */
	account: { getEnvironmentKeys(): Promise<string[]> };
}

/** The part of a RocketRideClient (root or realm proxy) this library calls. */
export interface IRealmClient extends IPrefsFs, IAdminCalls {
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
 * The client of a realm, or the refusal that says nothing was sent. The one
 * guard every call of this module goes through; a lane's own SDK calls use it
 * too, so a realm with no client answers the same way everywhere.
 *
 * @param get - The realm's client getter.
 * @param what - The request, for the message.
 * @returns The client.
 * @throws ExplorerToolError (kind `unavailable`) when the realm has none yet.
 */
export function requireRealmClient<C>(get: RealmClientGetter<C>, what: string): C {
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
			const rows = await withDeadline(() => requireRealmClient(get, 'getTasks').getTasks(), GET_TASKS_TIMEOUT_MS, 'getTasks');
			if (!Array.isArray(rows)) throw new Error('getTasks answered with something that is not a list of tasks.');
			return rows;
		},
		listTasks(req) {
			return withDeadline(() => requireRealmClient(get, 'listTasks').listTasks(req), LIST_TASKS_TIMEOUT_MS, 'listTasks');
		},
		async getTaskPipeline(token) {
			const pipeline = await withDeadline(() => requireRealmClient(get, 'getTaskPipeline').getTaskPipeline(token), GET_TASK_PIPELINE_TIMEOUT_MS, 'getTaskPipeline');
			return pipeline !== null && typeof pipeline === 'object' && !Array.isArray(pipeline) ? pipeline : undefined;
		},
		tool<T>(options: { token: string; tool: string; nodeId?: string; input?: Record<string, unknown>; timeout?: number }): Promise<T> {
			// The SDK's own timeout bounds it (and, in a proxy, the bus above it).
			const timeout = toolSdkTimeoutMs(options.timeout);
			return Promise.resolve().then(() => requireRealmClient(get, 'tool').tool<T>({ ...options, timeout }));
		},
		addMonitor(key, types) {
			return withDeadline(() => requireRealmClient(get, 'addMonitor').addMonitor(key, types), MONITOR_TIMEOUT_MS, 'addMonitor');
		},
		removeMonitor(key, types) {
			return withDeadline(() => requireRealmClient(get, 'removeMonitor').removeMonitor(key, types), MONITOR_TIMEOUT_MS, 'removeMonitor');
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
		fsStat: (path) => withDeadline(() => requireRealmClient(get, 'fsStat').fsStat(path), deadlineMs, 'fsStat'),
		fsReadJson: <T>(path: string) => withDeadline(() => requireRealmClient(get, 'fsReadJson').fsReadJson<T>(path), deadlineMs, 'fsReadJson'),
		fsMkdir: (path) => withDeadline(() => requireRealmClient(get, 'fsMkdir').fsMkdir(path), deadlineMs, 'fsMkdir'),
		fsWriteJson: (path, obj) => withDeadline(() => requireRealmClient(get, 'fsWriteJson').fsWriteJson(path, obj), deadlineMs, 'fsWriteJson'),
	};
}

/** The deadlines of {@link createExplorerAdmin}, each overridable. */
export interface IAdminDeadlines {
	use?: number;
	getTaskToken?: number;
	terminate?: number;
	getService?: number;
	validate?: number;
	getEnvironmentKeys?: number;
}

/** The generic SDK calls, each bounded by an application deadline. */
export interface IExplorerAdmin {
	use: IAdminCalls['use'];
	getTaskToken: IAdminCalls['getTaskToken'];
	terminate: IAdminCalls['terminate'];
	getService: IAdminCalls['getService'];
	validate: IAdminCalls['validate'];
	getEnvironmentKeys(): Promise<string[]>;
}

/**
 * The generic SDK calls a controller makes besides discovery and tools:
 * `use`, `getTaskToken`, `terminate`, `getService`, `validate` and
 * `account.getEnvironmentKeys`. None has an SDK timeout, so each carries an
 * application deadline (an expiry reports "not cancelled, may still
 * complete"). SDK errors pass through untouched, and a realm with no client
 * rejects as `unavailable` (nothing sent). NOTHING IS EVER RETRIED here:
 * `use` and `terminate` change what runs on the engine, and an expired
 * deadline does not tell whether they happened, so a caller that wants a
 * second attempt must look at the engine first.
 *
 * @param get - The realm's client getter.
 * @param deadlines - Deadline overrides, in ms.
 * @returns The calls.
 */
export function createExplorerAdmin(get: RealmClientGetter<IAdminCalls>, deadlines: IAdminDeadlines = {}): IExplorerAdmin {
	return {
		use: (options) => withDeadline(() => requireRealmClient(get, 'use').use(options), deadlines.use ?? USE_DEADLINE_MS, 'use'),
		getTaskToken: (options) => withDeadline(() => requireRealmClient(get, 'getTaskToken').getTaskToken(options), deadlines.getTaskToken ?? GET_TASK_TOKEN_DEADLINE_MS, 'getTaskToken'),
		terminate: (token) => withDeadline(() => requireRealmClient(get, 'terminate').terminate(token), deadlines.terminate ?? TERMINATE_DEADLINE_MS, 'terminate'),
		getService: (service) => withDeadline(() => requireRealmClient(get, 'getService').getService(service), deadlines.getService ?? GET_SERVICE_DEADLINE_MS, 'getService'),
		validate: (options) => withDeadline(() => requireRealmClient(get, 'validate').validate(options), deadlines.validate ?? VALIDATE_DEADLINE_MS, 'validate'),
		getEnvironmentKeys: () => withDeadline(() => requireRealmClient(get, 'getEnvironmentKeys').account.getEnvironmentKeys(), deadlines.getEnvironmentKeys ?? ENVIRONMENT_KEYS_DEADLINE_MS, 'getEnvironmentKeys'),
	};
}
