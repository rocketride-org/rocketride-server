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
// API MONITOR — Pure timing/counting layer for RocketRideClient API calls
// =============================================================================
//
// Two layers, cleanly separated:
//
// 1. TIMING (this file): ApiMonitor tracks issued/completed/latency for every
//    method. MonitoredClient wraps a real client so every call is timed.
//    The monitor does NOT interpret success or failure — it just measures.
//
// 2. OUTCOME (caller): The test engine decides whether a result was expected.
//    If unexpected, the caller calls monitor.recordError() to mark it.
// =============================================================================

import type { ApiTestResult } from './types';

// =============================================================================
// CATEGORY INFERENCE
// =============================================================================

/** Category lookup by method name or prefix. */
function inferCategory(method: string): string {
	if (method.startsWith('account.')) return 'Account';
	if (method.startsWith('billing.')) return 'Billing';
	if (method.startsWith('deploy.')) return 'Deploy';
	if (method.startsWith('fs')) return 'FileStore';
	if (method.startsWith('cprofile')) return 'Profiling';
	if (method.startsWith('database.')) return 'Database';
	if (method.startsWith('pipe.') || method === 'pipe') return 'Data';
	if (['connect', 'attach', 'login', 'detach', 'logout', 'disconnect',
		'ping', 'identify', 'getServerInfo', 'isConnected', 'isAttached',
		'isAuthenticated', 'getConnectionInfo', 'getAccountInfo',
		'getOrgId', 'getApiKey'].includes(method)) return 'Connection';
	if (['use', 'terminate', 'restart', 'getTaskStatus', 'getTaskToken',
		'getTaskPipeline', 'validate'].includes(method)) return 'Pipeline';
	if (['send', 'sendFiles', 'chat'].includes(method)) return 'Data';
	if (['addMonitor', 'removeMonitor', 'clearAllMonitors',
		'getDashboard'].includes(method)) return 'Events';
	if (['saveTemplate', 'getTemplate', 'deleteTemplate',
		'getAllTemplates'].includes(method)) return 'Templates';
	if (['saveLog', 'getLog', 'deleteLog', 'listLogs'].includes(method)) return 'Logs';
	if (['getServices', 'getService'].includes(method)) return 'Services';
	if (method === 'tool') return 'Tool';
	return 'Other';
}

// =============================================================================
// API MONITOR — Pure timing and counting
// =============================================================================

/**
 * Rolling-window cap for per-method latency samples. High-frequency
 * methods (send, ping) run thousands-to-millions of times during long
 * stress runs; unbounded arrays would bloat memory and slow every panel
 * that recomputes percentiles. 500 recent samples keep stats meaningful.
 */
export const MAX_LATENCY_SAMPLES = 500;

/**
 * Global API call monitor. Records issued/completed/latency for every method.
 * Does NOT interpret success or failure — the caller decides that.
 *
 * Callers use recordError() to mark unexpected outcomes after inspecting
 * the result themselves.
 */
export class ApiMonitor {
	/** Method name -> cumulative stats. */
	readonly results = new Map<string, ApiTestResult>();

	/** Currently in-flight API calls (method names with active count). */
	private readonly _inflight = new Map<string, number>();

	/** Worst ping latency and what was running at that moment. */
	worstPing = 0;
	worstPingSnapshot = '';

	/**
	 * Optional callback fired on every completed API call.
	 * Used by the engine to feed latency samples into the sparkline chart.
	 */
	onLatency: ((method: string, latency: number) => void) | null = null;

	/** Get or create a result entry for a method. */
	get(method: string): ApiTestResult {
		let r = this.results.get(method);
		if (!r) {
			r = {
				method,
				category: inferCategory(method),
				status: 'pending',
				issued: 0,
				completed: 0,
				errors: 0,
				latencies: [],
			};
			this.results.set(method, r);
		}
		return r;
	}

	/**
	 * Push a latency sample onto a result's rolling window.
	 * Evicts the oldest sample beyond MAX_LATENCY_SAMPLES so per-method
	 * arrays stay bounded across long-running stress runs.
	 */
	pushLatency(r: ApiTestResult, latency: number): void {
		r.latencies.push(latency);
		if (r.latencies.length > MAX_LATENCY_SAMPLES) r.latencies.shift();
	}

	/**
	 * Record the start of an API call.
	 *
	 * Increments issued count and tracks in-flight state.
	 * Returns t0 timestamp for use with end().
	 */
	begin(method: string): number {
		const r = this.get(method);
		r.issued++;
		if (r.status === 'pending' || r.status === 'skipped') {
			r.status = 'running';
		}
		this._inflight.set(method, (this._inflight.get(method) || 0) + 1);
		return performance.now();
	}

	/**
	 * Record the completion of an API call (success OR error).
	 *
	 * Increments completed count, records latency, updates chart.
	 * Does NOT interpret whether the outcome was expected — that's
	 * the caller's job.
	 *
	 * @returns The measured latency in ms.
	 */
	end(method: string, t0: number): number {
		const r = this.get(method);
		const latency = performance.now() - t0;
		r.completed++;
		this.pushLatency(r, latency);

		// Update in-flight tracking
		const count = this._inflight.get(method) || 1;
		if (count <= 1) this._inflight.delete(method);
		else this._inflight.set(method, count - 1);

		// If no errors have been recorded, mark as passed
		if (r.errors === 0 && r.status !== 'skipped') {
			r.status = 'passed';
		}

		// Feed the latency chart
		this.onLatency?.(method, latency);

		return latency;
	}

	/**
	 * Record an unexpected outcome for a method.
	 *
	 * Called by the test engine when a call's result doesn't match
	 * expectations (e.g. expected success but got error, or expected
	 * rejection but server accepted).
	 */
	recordError(method: string, message: string): void {
		const r = this.get(method);
		r.errors++;
		r.lastError = message;
		r.status = 'failed';
	}

	/**
	 * Snapshot the currently in-flight API calls.
	 * Returns a string like "send(12) use(3) pipe.write(4)".
	 */
	getInflightSnapshot(): string {
		if (this._inflight.size === 0) return '(idle)';
		const parts: string[] = [];
		for (const [method, count] of this._inflight) {
			if (method === 'ping') continue;
			parts.push(count > 1 ? `${method}(${count})` : method);
		}
		return parts.length > 0 ? parts.join(' ') : '(idle)';
	}

	/** Clear all recorded data. */
	clear(): void {
		this.results.clear();
		this._inflight.clear();
		this.worstPing = 0;
		this.worstPingSnapshot = '';
	}
}

// =============================================================================
// MONITORED CLIENT — Proxy that times every method (no outcome interpretation)
// =============================================================================

/** Methods that are internal and should not be tracked. */
const SKIP = new Set([
	'constructor', 'onUpdate', 'onEvent', 'onConnected', 'onDisconnected',
	'onConnectError', 'onReceive', 'debugMessage', 'request', 'call',
	'buildRequest', 'buildResponse', 'buildError', 'buildEvent',
	'getNextSeq', 'did_fail', 'didFail', 'raiseException',
	'validateStorePath', 'validateId', 'setEvents',
]);

/**
 * Wrap a method call with timing. Works for both sync and async methods.
 * On entry: monitor.begin(). On exit (success or error): monitor.end().
 * Errors are re-thrown unchanged — the caller interprets them.
 */
function wrapMethod(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	thisArg: any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	fn: (...args: any[]) => any,
	methodName: string,
	monitor: ApiMonitor,
) {
	return function wrappedMethod(...args: unknown[]) {
		const t0 = monitor.begin(methodName);
		try {
			const ret = fn.apply(thisArg, args);

			// Async — track promise settlement
			if (ret && typeof ret === 'object' && typeof ret.then === 'function') {
				return ret.then(
					(resolved: unknown) => {
						monitor.end(methodName, t0);
						// If this was pipe(), wrap the returned DataPipe
						if (methodName === 'pipe' && resolved && typeof resolved === 'object') {
							return proxyWithMonitor(resolved, monitor, 'pipe.');
						}
						return resolved;
					},
					(err: unknown) => {
						monitor.end(methodName, t0);
						throw err;
					},
				);
			}

			// Sync
			monitor.end(methodName, t0);
			return ret;
		} catch (err) {
			monitor.end(methodName, t0);
			throw err;
		}
	};
}

/**
 * Create a Proxy that wraps an object's methods with timing.
 * Handles sub-namespace objects (account, billing, deploy, database)
 * by prefixing their method names (e.g. "account.getProfile").
 */
function proxyWithMonitor(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	obj: any,
	monitor: ApiMonitor,
	prefix: string = '',
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
	const subProxies = new Map<string, unknown>();

	return new Proxy(obj, {
		get(target, prop, receiver) {
			const key = String(prop);
			const val = Reflect.get(target, prop, receiver);

			// Sub-namespaces: wrap once and cache
			if (typeof val === 'object' && val !== null && !Array.isArray(val) &&
				['account', 'billing', 'deploy', 'database'].includes(key)) {
				if (!subProxies.has(key)) {
					subProxies.set(key, proxyWithMonitor(val, monitor, `${key}.`));
				}
				return subProxies.get(key);
			}

			// Non-function — pass through
			if (typeof val !== 'function') return val;

			// Internal/skip — pass through
			if (SKIP.has(key) || key.startsWith('_')) return val.bind(target);

			// Wrap with timing
			const methodName = `${prefix}${key}`;
			return wrapMethod(receiver, val, methodName, monitor);
		},
	});
}

/**
 * MonitoredClient: drop-in replacement for `new RocketRideClient(config)`.
 *
 * Creates a real RocketRideClient and wraps it with a timing Proxy.
 * All API calls are timed and counted in the shared ApiMonitor.
 * Errors are passed through unchanged — the caller decides if the
 * outcome was expected.
 *
 * Usage:
 *   const client = MonitoredClient.create(monitor, { uri, auth, ... });
 *   await client.connect();       // timed as "connect"
 *   await client.send(token, d);  // timed as "send"
 *   await client.account.getProfile(); // timed as "account.getProfile"
 */
export const MonitoredClient = {
	/**
	 * Create a new monitored RocketRideClient instance.
	 *
	 * @param RRClient - The RocketRideClient constructor (passed to avoid import issues).
	 * @param monitor  - The shared ApiMonitor instance.
	 * @param config   - RocketRideClient constructor config.
	 * @returns A proxied client that records all API calls.
	 */
	create(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		RRClient: any,
		monitor: ApiMonitor,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		config: Record<string, any>,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	): any {
		const raw = new RRClient(config);
		return proxyWithMonitor(raw, monitor);
	},

	/**
	 * Wrap an existing client instance with monitoring.
	 * Use for the shell client (already connected, can't re-create).
	 */
	wrap(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		client: any,
		monitor: ApiMonitor,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	): any {
		return proxyWithMonitor(client, monitor);
	},
};
