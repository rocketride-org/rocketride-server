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
// TEST-UI — Test Engine (v2)
// =============================================================================
//
// Exhaustive stress and chaos test engine that genuinely tries to break the
// RocketRide backend. Uses multiple independent WebSocket connections, real
// server-side kills, response validation, backpressure flooding, pipe
// streaming, concurrent API hammering, and resource exhaustion tests.
//
// Phases:
//   1. API Sweep        — happy + negative tests for every API method
//   2. Multi-socket     — N independent WebSocket connections with pipelines
//   3. Backpressure     — flood sends with zero delay to find server limits
//   4. Pipe streaming   — open/write/close DataPipe with large chunks
//   5. Chaos injection  — real server-side terminate() mid-send, connection
//                         churn, cross-client contention, zombie detection
//   6. Concurrent API   — hammer multiple methods in parallel from all clients
// =============================================================================

import { RocketRideClient, Question } from 'shell/client';
import { getClient } from 'shell';
import { API_METHODS } from './apiMethods';
import {
	getEchoPipeline,
	getChatPipeline,
	getStressPipeline,
} from './pipelines';
import { generateTextChunk, generateBatchedText } from './generators';
import { ApiMonitor, MonitoredClient } from './monitor';
import type {
	TestEngine,
	EngineState,
	TestConfig,
	TestMetrics,
	TestEvent,
	PipelineSlot,
	LatencySample,
	ChaosScenario,
	PipelineState,
	PhaseResult,
} from './types';

// =============================================================================
// HELPERS
// =============================================================================

let nextEventId = 1;

/**
 * Format an error for display. Includes server-side file:lineno from
 * DAPException when available.
 */
function errMsg(err: unknown): string {
	if (err instanceof Error) {
		const e = err as Error & { file?: string; lineno?: number };
		if (e.file) return `${err.message} (${e.file}:${e.lineno})`;
		return err.message;
	}
	return String(err);
}

/**
 * Create a timestamped event for the activity stream.
 *
 * @param type  - Event severity/category
 * @param source - Origin label (e.g. 'sweep', 'P-03', 'chaos')
 * @param message - Human-readable description
 */
function makeEvent(
	type: TestEvent['type'],
	source: string,
	message: string,
): TestEvent {
	return { id: nextEventId++, time: Date.now(), type, source, message };
}

/**
 * Sleep for a random duration up to maxMs.
 * Returns immediately if maxMs <= 0.
 */
function randomDelay(maxMs: number): Promise<void> {
	if (maxMs <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, Math.random() * maxMs));
}

/** Max bytes crypto.getRandomValues() accepts per call (Web Crypto spec). */
const RANDOM_CHUNK_BYTES = 65_536;

/**
 * Fill a buffer of arbitrary size with random bytes.
 *
 * The Web Crypto spec caps getRandomValues() at 65,536 bytes per call
 * (QuotaExceededError above that), so large buffers are filled in
 * 64 KiB chunks. subarray() clamps the final chunk automatically.
 */
function randomBytes(byteLength: number): Uint8Array {
	const buf = new Uint8Array(byteLength);
	for (let i = 0; i < byteLength; i += RANDOM_CHUNK_BYTES) {
		crypto.getRandomValues(buf.subarray(i, i + RANDOM_CHUNK_BYTES));
	}
	return buf;
}

/**
 * Generate a test payload of the requested size and type.
 *
 * Sizes:  tiny=100B, medium=10KB, large=1MB, huge=100MB
 * Types:  text, binary, mixed, malformed, empty
 *
 * Text payloads use realistic NLP content (business/tech/medical words)
 * so that NLP pipeline nodes (langchain, NER, embedding) do real work.
 */
let payloadCounter = 0;

function generatePayload(
	size: string,
	type: string,
): string | Uint8Array {
	const sizes: Record<string, number> = {
		tiny: 100,
		medium: 10_000,
		large: 1_000_000,
		huge: 100_000_000,
	};
	let bytes = sizes[size] ?? sizes.medium;
	// Mixed picks a random size per call
	if (size === 'mixed') {
		bytes = sizes[['tiny', 'medium', 'large'][Math.floor(Math.random() * 3)]];
	}

	if (type === 'empty') return '';
	if (type === 'malformed') {
		return '{"broken: [' + 'x'.repeat(Math.min(bytes, 100_000)) + ']}}{';
	}
	if (type === 'binary' || (type === 'mixed' && Math.random() < 0.5)) {
		return randomBytes(bytes);
	}
	// Realistic text payload — use NLP-grade content for pipeline stress
	const idx = payloadCounter++;
	const wordCount = Math.max(10, Math.floor(bytes / 6)); // ~6 chars/word avg
	if (bytes > 50_000) {
		// Large payloads: batched chunks (exercises langchain splitting)
		return generateBatchedText(idx, Math.ceil(wordCount / 100), 100);
	}
	return generateTextChunk(idx, wordCount);
}

/** Payload byte length regardless of type. */
function payloadSize(payload: string | Uint8Array): number {
	return typeof payload === 'string' ? payload.length : payload.byteLength;
}

// =============================================================================
// ENGINE IMPLEMENTATION
// =============================================================================

export function createTestEngine(): TestEngine {
	let state: EngineState = 'idle';
	const listeners: Array<() => void> = [];
	const events: TestEvent[] = [];
	const pipelines: PipelineSlot[] = [];
	const latencyHistory: LatencySample[] = [];
	const phases: PhaseResult[] = [];
	let abortController: AbortController | null = null;
	let startTime = 0;
	let opsCounter = 0;
	let opsWindow: number[] = [];
	let dataTransferred = 0;

	// Independent client pool (each has its own WebSocket)
	let clientPool: RocketRideClient[] = [];

	// Global API monitor — every MonitoredClient records here
	const apiMonitor = new ApiMonitor();

	// Feed monitor latency samples into the sparkline chart.
	// Excludes noisy/internal methods that would flood the chart.
	const CHART_EXCLUDE = new Set(['send', 'ping', 'isConnected', 'isAttached']);
	apiMonitor.onLatency = (method, latency) => {
		if (CHART_EXCLUDE.has(method)) return;
		latencyHistory.push({ time: Date.now(), value: latency, source: method });
		if (latencyHistory.length > 300) latencyHistory.shift();
	};

	const metrics: TestMetrics = {
		passed: 0,
		failed: 0,
		activePipelines: 0,
		opsPerSec: 0,
		totalOps: 0,
		targetOps: 0,
		elapsed: 0,
		dataTransferred: 0,
		wsConnections: 0,
		queuedOps: 0,
	};

	// Pool members whose connect succeeded and incremented the wsConnections
	// gauge — destroyPool subtracts exactly this set, so a member dropped
	// mid-phase (isConnected() now false) still brings the gauge back down.
	const countedClients = new WeakSet<RocketRideClient>();

	// =========================================================================
	// INTERNAL UTILITIES
	// =========================================================================

	/** Notify all UI subscribers of a state change. */
	function notify() {
		for (const cb of listeners) cb();
	}

	/** Push an event to the activity stream (capped at 1000). */
	function pushEvent(evt: TestEvent) {
		events.unshift(evt);
		if (events.length > 1000) events.length = 1000;
	}

	/**
	 * Record an operation result for global metrics.
	 *
	 * Tracks ops/sec, pass/fail counts, elapsed time. Latency chart
	 * is handled by the monitor's onLatency callback — not here.
	 */
	function recordOp(passed: boolean) {
		opsCounter++;
		const now = Date.now();
		opsWindow.push(now);
		// Sliding 1-second window for ops/sec
		opsWindow = opsWindow.filter((t) => now - t < 1000);
		if (passed) metrics.passed++;
		else metrics.failed++;
		metrics.totalOps = opsCounter;
		metrics.opsPerSec = opsWindow.length;
		metrics.elapsed = (now - startTime) / 1000;
		metrics.dataTransferred = dataTransferred;
	}

	/** Update pipeline slot state. */
	function setPipelineState(
		idx: number,
		pState: PipelineState,
		extra?: Partial<PipelineSlot>,
	) {
		if (pipelines[idx]) {
			pipelines[idx].state = pState;
			if (extra) Object.assign(pipelines[idx], extra);
		}
	}

	// =========================================================================
	// PHASE TRACKING
	// =========================================================================

	/** Phase definitions for the full test suite. */
	const PHASE_DEFS: Array<{ id: string; name: string; description: string }> = [
		{ id: 'sweep', name: 'API Sweep', description: 'Happy + negative tests for every SDK method' },
		{ id: 'stress', name: 'Multi-Socket Stress', description: 'Pipelines across multiple WebSocket connections' },
		{ id: 'flood', name: 'Backpressure Flood', description: 'Zero-delay sends to find server limits' },
		{ id: 'pipe', name: 'Pipe Streaming', description: 'DataPipe open/write/close with large chunks' },
		{ id: 'chaos', name: 'Chaos Injection', description: 'Server-side kills, connection churn, contention' },
		{ id: 'hammer', name: 'Concurrent API Hammer', description: 'Parallel API calls to find race conditions' },
	];

	/** Initialize all phases to pending. */
	function initPhases() {
		phases.length = 0;
		for (const def of PHASE_DEFS) {
			phases.push({
				id: def.id,
				name: def.name,
				description: def.description,
				status: 'pending',
				passed: 0,
				failed: 0,
				duration: 0,
			});
		}
	}

	/** Get a phase by id. */
	function getPhase(id: string): PhaseResult | undefined {
		return phases.find((p) => p.id === id);
	}

	/**
	 * Run a phase function, tracking its pass/fail counts and duration.
	 * Metrics.passed/failed are snapshot before and after to isolate
	 * the phase's contribution.
	 */
	async function runPhase(
		id: string,
		fn: () => Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		const phase = getPhase(id);
		if (!phase) return;
		if (signal.aborted) {
			phase.status = 'skipped';
			notify();
			return;
		}

		phase.status = 'running';
		notify();

		const startPassed = metrics.passed;
		const startFailed = metrics.failed;
		const t0 = performance.now();

		try {
			await fn();
			phase.duration = (performance.now() - t0) / 1000;
			phase.passed = metrics.passed - startPassed;
			phase.failed = metrics.failed - startFailed;
			phase.status = phase.failed > 0 ? 'failed' : 'passed';
		} catch (err) {
			phase.duration = (performance.now() - t0) / 1000;
			phase.passed = metrics.passed - startPassed;
			phase.failed = metrics.failed - startFailed;
			phase.status = 'failed';
			phase.error = errMsg(err);
		}

		if (signal.aborted) {
			phase.status = 'skipped';
		}
		notify();
	}

	/** Check if the engine is paused and wait until resumed or aborted. */
	async function waitIfPaused(signal: AbortSignal): Promise<void> {
		while (state === 'paused' && !signal.aborted) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	// =========================================================================
	// PING HEARTBEAT — continuous ping measurement for the entire test run
	// =========================================================================

	/**
	 * Start a ping heartbeat using a dedicated RocketRideClient connection.
	 * Pings every 100ms for the lifetime of the test run.  Latency spikes
	 * reveal server event-loop stalls caused by other test phases.
	 */
	async function startPingHeartbeat(
		signal: AbortSignal,
	): Promise<{ stop: () => Promise<void> }> {
		// 5s request timeout — a stalled ping must fail fast so the 100ms
		// heartbeat keeps sampling; matches the >5000ms classification below.
		const client = await createClient('ping', 5000);
		let running = true;

		// Ping loop runs in the background
		const loop = (async () => {
			while (running && !signal.aborted) {
				const t0 = performance.now();
				try {
					await client.call('rrext_ping');
					const latency = performance.now() - t0;

					// Record ping in the monitor
					const r = apiMonitor.get('ping');
					r.issued++;
					r.completed++;
					apiMonitor.pushLatency(r, latency);
					if (r.errors === 0) r.status = 'passed';

					// Snapshot in-flight and update worst ping
					const snapshot = apiMonitor.getInflightSnapshot();
					if (latency > apiMonitor.worstPing) {
						apiMonitor.worstPing = latency;
						apiMonitor.worstPingSnapshot = snapshot;
					}
				} catch (err) {
					const latency = performance.now() - t0;
					const r = apiMonitor.get('ping');
					r.issued++;
					r.errors++;
					r.lastError = latency > 5000
						? `Ping timeout: ${latency.toFixed(0)}ms (>5000ms)`
						: `Ping error: ${errMsg(err)}`;
					r.status = 'failed';
				}

				// Sleep 100ms between pings
				if (running && !signal.aborted) {
					await new Promise((r) => setTimeout(r, 100));
				}
			}
		})();

		return {
			stop: async () => {
				running = false;
				await loop;
				await client.disconnect().catch(() => {});
				// Mirror createClient's increment — the dedicated heartbeat
				// connection is gone, so the gauge must come back down.
				metrics.wsConnections = Math.max(0, metrics.wsConnections - 1);
			},
		};
	}

	// =========================================================================
	// CREDENTIALS — borrowed from shell once, used by all phases
	// =========================================================================

	/** Get server URI and API key from the shell's existing connection. */
	function getCredentials(): { uri: string; apiKey: string | undefined } {
		const shellClient = getClient();
		if (!shellClient) throw new Error('Shell client not available');
		const connInfo = shellClient.getConnectionInfo();
		const uri = connInfo?.uri;
		if (!uri) throw new Error('No server URI from shell connection');
		return { uri, apiKey: shellClient.getApiKey() || undefined };
	}

	/**
	 * Create a single monitored client, connected and ready to use.
	 */
	async function createClient(label = 'worker', timeout = 300_000): Promise<RocketRideClient> {
		const { uri, apiKey } = getCredentials();
		const client = MonitoredClient.create(RocketRideClient, apiMonitor, {
			uri,
			auth: apiKey,
			persist: false,
			requestTimeout: timeout,
		});
		await client.connect();
		client.identify(`Test - ${label}`).catch(() => {});
		metrics.wsConnections++;
		return client;
	}

	// =========================================================================
	// CLIENT POOL — multiple independent WebSocket connections
	// =========================================================================

	/**
	 * Create N independent clients, each with its own WebSocket.
	 * Each phase that needs clients calls this and cleans up with destroyPool().
	 */
	async function createPool(
		count: number,
		label: string,
		signal: AbortSignal,
	): Promise<RocketRideClient[]> {
		const { uri, apiKey } = getCredentials();

		pushEvent(
			makeEvent(
				'info',
				label,
				`Creating ${count} independent WebSocket connections...`,
			),
		);
		notify();

		const pool: RocketRideClient[] = [];
		const connectPromises: Promise<void>[] = [];
		for (let i = 0; i < count; i++) {
			if (signal.aborted) break;
			const client = MonitoredClient.create(RocketRideClient, apiMonitor, {
				uri,
				auth: apiKey || undefined,
				persist: false,
				requestTimeout: 300_000, // 5 min — pipeline starts can take a while
			});
			pool.push(client);

			// Connect each client independently
			connectPromises.push(
				pool[i]
					.connect()
					.then(() => {
						metrics.wsConnections++;
						// Mark the member as counted: destroyPool subtracts by
						// this membership, not by isConnected() at teardown.
						countedClients.add(pool[i]);
						pool[i].identify(`Test - ${label}`).catch(() => {});
						pushEvent(
							makeEvent('pass', label, `WS-${i} connected`),
						);
						notify();
					})
					.catch((err) => {
						pushEvent(
							makeEvent(
								'fail',
								label,
								`WS-${i} connect failed: ${errMsg(err)}`,
							),
						);
						notify();
					}),
			);
		}

		await Promise.allSettled(connectPromises);
		const connected = pool.filter((c) => c.isConnected()).length;
		pushEvent(
			makeEvent(
				'info',
				label,
				`Pool ready: ${connected}/${count} connected`,
			),
		);
		notify();
		return pool;
	}

	/** Disconnect and destroy a pool of clients. */
	async function destroyPool(pool: RocketRideClient[]): Promise<void> {
		// Subtract what was INCREMENTED: countedClients marks the members
		// whose connect succeeded and bumped the gauge. A member dropped
		// mid-phase (isConnected() now false) must still come back down,
		// and members whose connect failed never went up.
		const countedInPool = pool.filter((c) => countedClients.has(c)).length;
		const disconnectPromises = pool.map((c) =>
			c.disconnect().catch(() => {}),
		);
		await Promise.allSettled(disconnectPromises);
		metrics.wsConnections = Math.max(0, metrics.wsConnections - countedInPool);
	}

	/**
	 * Run a function with a fresh client pool. Creates the pool before,
	 * destroys it after. Makes each phase standalone.
	 */
	async function withPool(
		count: number,
		label: string,
		signal: AbortSignal,
		fn: () => Promise<void>,
	): Promise<void> {
		clientPool = await createPool(count, label, signal);
		try {
			await fn();
		} finally {
			await destroyPool(clientPool);
			clientPool = [];
		}
	}

	/** Get a connected client from the pool by index (round-robin). */
	function getPoolClient(idx: number): RocketRideClient | null {
		const connected = clientPool.filter((c) => c.isConnected());
		if (connected.length === 0) return null;
		return connected[idx % connected.length];
	}

	/**
	 * Get the client that owns a pipeline via its recorded pool slot.
	 *
	 * Unlike getPoolClient(), this never re-maps to a different WebSocket
	 * when other pool clients drop — a pipeline must keep talking on the
	 * connection that started it. Returns null when the owning client is
	 * gone or disconnected. Falls back to round-robin selection only for
	 * pipelines that never recorded a slot (start failed before assignment).
	 */
	function getPipelineClient(idx: number): RocketRideClient | null {
		const clientIdx = pipelines[idx]?.clientIdx;
		if (clientIdx === undefined) return getPoolClient(idx);
		const client = clientPool[clientIdx];
		return client && client.isConnected() ? client : null;
	}

	// =========================================================================
	// PHASE 1: API SWEEP — happy + negative tests for every API method
	// =========================================================================

	/**
	 * Run every API method once, sequentially. Happy-path methods expect
	 * success; negative methods expect server rejection.
	 */
	async function runApiSweep(signal: AbortSignal) {
		let client: RocketRideClient;
		try {
			client = await createClient('sweep');
		} catch (err) {
			pushEvent(makeEvent('fail', 'sweep', `Could not connect: ${errMsg(err)}`));
			return;
		}

		// Detect OSS vs SaaS from the connection's capabilities
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const accountInfo = (client as any).getAccountInfo?.();
		const capabilities: string[] = accountInfo?.capabilities || [];
		const isSaaS = capabilities.includes('saas');

		// Count non-skipped methods for targetOps
		const sweepCount = API_METHODS.filter((d) => {
			if (d.mode === 'skip') return false;
			if (d.saasOnly && !isSaaS) return false;
			return true;
		}).length;
		metrics.targetOps += sweepCount;

		pushEvent(
			makeEvent('info', 'sweep', `Phase 1: API coverage sweep (${isSaaS ? 'SaaS' : 'OSS'} mode, ${sweepCount} methods)...`),
		);
		notify();

		// Shared context populated by methods as the sweep runs
		const ctx: SweepContext = {};

		for (const def of API_METHODS) {
			// break, not return: the post-loop cleanup (terminate the sweep
			// pipeline + disconnect the sweep client) must still run on abort.
			if (signal.aborted) break;
			await waitIfPaused(signal);

			// Seed the monitor entry so skipped methods appear in the table
			const result = apiMonitor.get(def.method);

			// Skip SaaS-only methods when running against OSS
			if (def.saasOnly && !isSaaS) {
				if (result.issued === 0) result.status = 'skipped';
				result.skipReason = 'SaaS only (not available on OSS server)';
				pushEvent(makeEvent('info', 'sweep', `${def.method} -> skipped: SaaS only`));
				notify();
				continue;
			}

			// Skip methods that the sweep can't safely test directly
			if (def.mode === 'skip') {
				if (result.issued === 0) result.status = 'skipped';
				result.skipReason = def.skipReason;
				pushEvent(makeEvent('info', 'sweep', `${def.method} -> skipped: ${def.skipReason || 'no reason'}`));
				notify();
				continue;
			}

			// ─── Call the method and interpret the outcome ───
			// The Proxy handles begin/end timing. We just check whether
			// the outcome matches the expected mode (happy vs negative).
			try {
				await callApiMethod(client, def.method, signal, ctx);

				// Method succeeded
				if (def.mode === 'negative') {
					// Expected rejection but server accepted — that's a bug
					apiMonitor.recordError(def.method, 'Server accepted bad input (expected rejection)');
					recordOp(false);
					pushEvent(makeEvent('fail', 'sweep', `${def.method} -> accepted bad input (expected rejection)`));
				} else {
					recordOp(true);
					pushEvent(makeEvent('pass', 'sweep', `${def.method} -> OK`));
				}
			} catch (err) {
				const errorText = errMsg(err);

				// Method threw
				if (def.mode === 'negative') {
					// Expected rejection — server correctly refused
					recordOp(true);
					pushEvent(makeEvent('pass', 'sweep', `${def.method} -> rejected: ${errorText}`));
				} else {
					// Expected success but got error
					apiMonitor.recordError(def.method, errorText);
					recordOp(false);
					pushEvent(makeEvent('fail', 'sweep', `${def.method} -> ${errorText}`));
				}
			}
			notify();
		}

		// Cleanup sweep pipeline if still active
		if (ctx.pipelineToken) {
			await client.terminate(ctx.pipelineToken).catch(() => {});
		}

		// Cleanup sweep client
		await client.disconnect().catch(() => {});
		metrics.wsConnections = Math.max(0, metrics.wsConnections - 1);

		pushEvent(
			makeEvent(
				'info',
				'sweep',
				`API sweep done: ${metrics.passed} passed, ${metrics.failed} failed`,
			),
		);
		notify();
	}

	/** Shared state across sweep method calls — populated as the sweep runs. */
	interface SweepContext {
		/** Pipeline token from use() — available for pipeline-dependent methods. */
		pipelineToken?: string;
		/** Log entry name from saveLog() — available for getLog/deleteLog. */
		logName?: string;
		/** Service name from getServices() — available for getService. */
		serviceName?: string;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async function callApiMethod(
		client: any,
		method: string,
		signal: AbortSignal,
		ctx: SweepContext = {},
	): Promise<void> {
		if (signal.aborted) throw new Error('Aborted');

		switch (method) {
			// Connection — safe read-only calls
			case 'connect':
			case 'attach':
			case 'login':
				if (!client.isConnected()) throw new Error('Not connected');
				return;
			case 'detach':
			case 'logout':
			case 'disconnect':
				if (typeof client[method] !== 'function')
					throw new Error(`${method} not found`);
				return;
			case 'isConnected': {
				const r = client.isConnected();
				if (typeof r !== 'boolean') throw new Error('Bad return');
				return;
			}
			case 'isAttached': {
				const r = client.isAttached();
				if (typeof r !== 'boolean') throw new Error('Bad return');
				return;
			}
			case 'isAuthenticated': {
				const r = client.isAuthenticated();
				if (typeof r !== 'boolean') throw new Error('Bad return');
				return;
			}
			case 'ping':
				await client.ping();
				return;
			case 'getServerInfo': {
				// Static method — not on the client instance, so the Proxy
				// can't intercept it. Track it manually.
				const uri = client.getConnectionInfo()?.uri;
				if (!uri) throw new Error('No URI');
				const t0 = apiMonitor.begin('getServerInfo');
				try {
					const r = await RocketRideClient.getServerInfo(uri);
					apiMonitor.end('getServerInfo', t0);
					if (!r) throw new Error('No result');
				} catch (err) {
					apiMonitor.end('getServerInfo', t0);
					throw err;
				}
				return;
			}
			case 'getAccountInfo': {
				const r = client.getAccountInfo();
				if (!r) throw new Error('No account');
				return;
			}
			case 'getConnectionInfo': {
				const r = client.getConnectionInfo();
				if (!r) throw new Error('No info');
				return;
			}
			case 'getOrgId': {
				client.getOrgId();
				return;
			}
			case 'getApiKey': {
				client.getApiKey();
				return;
			}
			case 'identify':
				// App identity is handled by the shell workspace on connect/app-switch
				return;

			// Pipeline — use() starts the shared sweep pipeline, stored in ctx
			case 'use': {
				const pipe = getEchoPipeline();
				const r = await client.use({
					pipeline: pipe,
					source: pipe.source,
					name: 'test-sweep',
				});
				// Store token for subsequent pipeline-dependent methods
				ctx.pipelineToken = r?.token;
				return;
			}
			case 'terminate': {
				// Terminate the sweep pipeline and start a fresh one so
				// subsequent methods still have a token to work with
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.terminate(ctx.pipelineToken);
				const pipe = getEchoPipeline();
				const r = await client.use({
					pipeline: pipe,
					source: pipe.source,
					name: 'test-sweep-2',
				});
				ctx.pipelineToken = r?.token;
				return;
			}
			case 'restart': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				const pipe = getEchoPipeline();
				await client.restart({
					token: ctx.pipelineToken,
					projectId: '__test__',
					source: pipe.source,
					pipeline: pipe,
				});
				return;
			}
			case 'getTaskStatus': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.getTaskStatus(ctx.pipelineToken);
				return;
			}
			case 'getTaskToken': {
				await client.getTaskToken({
					projectId: '__nonexistent__',
					source: '__test__',
				});
				return;
			}
			case 'getTaskPipeline': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.getTaskPipeline(ctx.pipelineToken);
				return;
			}
			case 'validate': {
				await client.validate({ pipeline: getEchoPipeline() });
				return;
			}

			// Data — uses the sweep pipeline token
			case 'send': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.send(ctx.pipelineToken, 'test-ui sweep payload');
				return;
			}
			case 'sendFiles':
				return; // skip — requires File objects not available in test context
			case 'pipe.open':
			case 'pipe.write':
			case 'pipe.close':
				return; // tested as a group in the pipe() case below
			case 'pipe.tool':
				return; // requires @tool_function node
			case 'chat': {
				const chatPipe = getChatPipeline();
				const chatResult = await client.use({
					pipeline: chatPipe,
					source: chatPipe.source,
					name: 'test-chat',
				});
				if (chatResult?.token) {
					const q = new Question();
					q.addQuestion('test question from test-ui');
					await client
						.chat({ token: chatResult.token, question: q })
						.catch(() => {});
					await client
						.terminate(chatResult.token)
						.catch(() => {});
				}
				return;
			}

			// Events — uses the sweep pipeline token
			case 'addMonitor': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.addMonitor(
					{ token: ctx.pipelineToken },
					['STATUS'],
				);
				return;
			}
			case 'removeMonitor': {
				if (!ctx.pipelineToken) throw new Error('No pipeline token');
				await client.removeMonitor(
					{ token: ctx.pipelineToken },
					['STATUS'],
				);
				return;
			}
			case 'clearAllMonitors':
				await client.clearAllMonitors();
				return;
			case 'getDashboard': {
				const r = await client.getDashboard();
				if (!r) throw new Error('No dashboard');
				return;
			}

			// Templates
			case 'saveTemplate': {
				await client.saveTemplate({
					templateId: '__test_tpl__',
					pipeline: { components: [] },
				});
				return;
			}
			case 'getTemplate': {
				await client.getTemplate({ templateId: '__test_tpl__' });
				return;
			}
			case 'deleteTemplate': {
				await client.deleteTemplate({ templateId: '__test_tpl__' });
				return;
			}
			case 'getAllTemplates': {
				await client.getAllTemplates();
				return;
			}

			// Logs — saveLog stores the entry name for getLog/deleteLog
			case 'saveLog': {
				const logId = await client.saveLog({
					projectId: '__test__',
					source: 'test',
					contents: { test: true },
				});
				ctx.logName = logId;
				return;
			}
			case 'getLog': {
				// Create a valid log entry first, then retrieve it
				const logId = await client.saveLog({
					projectId: '__test__',
					source: 'test',
					contents: { body: { startTime: Date.now() }, test: true },
				});
				ctx.logName = logId;
				await client.getLog({ projectId: '__test__', name: logId });
				return;
			}
			case 'deleteLog': {
				// Use the log entry from getLog, or create one
				if (!ctx.logName) {
					ctx.logName = await client.saveLog({
						projectId: '__test__',
						source: 'test',
						contents: { body: { startTime: Date.now() }, test: true },
					});
				}
				await client.deleteLog({ projectId: '__test__', name: ctx.logName });
				ctx.logName = undefined;
				return;
			}
			case 'listLogs': {
				await client.listLogs({ projectId: '__test__' });
				return;
			}

			// File Store
			case 'fsMkdir':
				await client.fsMkdir('__test_ui__');
				return;
			case 'fsWriteString':
				await client.fsWriteString(
					'__test_ui__/test.txt',
					'hello test-ui',
				);
				return;
			case 'fsReadString': {
				await client.fsReadString('__test_ui__/test.txt');
				return;
			}
			case 'fsWriteJson':
				await client.fsWriteJson('__test_ui__/test.json', {
					test: true,
				});
				return;
			case 'fsReadJson': {
				await client.fsReadJson('__test_ui__/test.json');
				return;
			}
			case 'fsStat': {
				await client.fsStat('__test_ui__/test.txt');
				return;
			}
			case 'fsListDir': {
				await client.fsListDir('__test_ui__');
				return;
			}
			case 'fsRename': {
				await client.fsRename(
					'__test_ui__/test.txt',
					'__test_ui__/test2.txt',
				);
				return;
			}
			case 'fsGetUrl': {
				await client.fsGetUrl('__test_ui__/test2.txt');
				return;
			}
			case 'fsOpen': {
				const { handle } = await client.fsOpen(
					'__test_ui__/test2.txt',
					'r',
				);
				await client.fsClose(handle, 'r');
				return;
			}
			case 'fsRead': {
				const { handle } = await client.fsOpen(
					'__test_ui__/test2.txt',
					'r',
				);
				await client.fsRead(handle);
				await client.fsClose(handle, 'r');
				return;
			}
			case 'fsWrite': {
				const { handle } = await client.fsOpen(
					'__test_ui__/write_test.bin',
					'w',
				);
				await client.fsWrite(handle, new Uint8Array([1, 2, 3]));
				await client.fsClose(handle, 'w');
				return;
			}
			case 'fsClose':
				return;
			case 'fsDelete': {
				await client.fsDelete('__test_ui__/write_test.bin');
				return;
			}
			case 'fsRmdir': {
				await client.fsRmdir('__test_ui__', true);
				return;
			}

			// Account
			case 'account.getProfile': {
				await client.account.getProfile();
				return;
			}
			case 'account.updateProfile':
				return;
			case 'account.setDefaultTeam':
			case 'account.setDefaultOrg':
				return;
			case 'account.getOrg': {
				await client.account.getOrg();
				return;
			}
			case 'account.updateOrgName':
				return;
			case 'account.listKeys': {
				await client.account.listKeys();
				return;
			}
			case 'account.createKey':
			case 'account.revokeKey':
				return;
			case 'account.listMembers': {
				const org = client.getOrgId();
				if (org) await client.account.listMembers(org);
				return;
			}
			case 'account.inviteMember':
			case 'account.updateMemberRole':
			case 'account.removeMember':
			case 'account.resendInvite':
				return;
			case 'account.listTeams': {
				const org = client.getOrgId();
				if (org) await client.account.listTeams(org);
				return;
			}
			case 'account.getTeamDetail':
				return;
			case 'account.createTeam':
			case 'account.deleteTeam':
				return;
			case 'account.addTeamMember':
			case 'account.updateTeamMemberPerms':
			case 'account.removeTeamMember':
				return;
			case 'account.getEnvironmentKeys': {
				await client.account.getEnvironmentKeys();
				return;
			}
			case 'account.getEnv': {
				await client.account.getEnv('user');
				return;
			}
			case 'account.setEnv':
				return;

			// Billing
			case 'billing.getDetails': {
				const org = client.getOrgId();
				if (org) await client.billing.getDetails(org);
				return;
			}
			case 'billing.getProductPrices':
				return;
			case 'billing.getCreditBalance': {
				const org = client.getOrgId();
				if (org) await client.billing.getCreditBalance(org);
				return;
			}
			case 'billing.listCreditPacks': {
				await client.billing.listCreditPacks();
				return;
			}
			case 'billing.getTransactions': {
				const org = client.getOrgId();
				if (org) await client.billing.getTransactions(org);
				return;
			}
			case 'billing.getUsageByUser': {
				const org = client.getOrgId();
				if (org) await client.billing.getUsageByUser(org);
				return;
			}
			case 'billing.getUsageByTeam': {
				const org = client.getOrgId();
				if (org) await client.billing.getUsageByTeam(org);
				return;
			}

			// Deploy
			case 'deploy.list': {
				await client.deploy.list();
				return;
			}
			case 'deploy.add':
			case 'deploy.remove':
			case 'deploy.status':
			case 'deploy.update':
				return;

			// Services — getServices stores a service name for getService
			case 'getServices': {
				await client.getServices();
				ctx.serviceName = 'parse';
				return;
			}
			case 'getService': {
				if (!ctx.serviceName) throw new Error('No service name (getServices must run first)');
				await client.getService(ctx.serviceName);
				return;
			}

			// Profiling — pass pipeline token as target in SaaS mode
			case 'cprofileStatus': {
				await client.cprofileStatus(ctx.pipelineToken || null);
				return;
			}
			case 'cprofileStart': {
				await client.cprofileStart(ctx.pipelineToken || null);
				return;
			}
			case 'cprofileStop': {
				await client.cprofileStop(ctx.pipelineToken || null);
				return;
			}
			case 'cprofileReport': {
				await client.cprofileReport(ctx.pipelineToken || null);
				return;
			}
			case 'cprofileReportTree': {
				await client.cprofileReportTree(ctx.pipelineToken || null);
				return;
			}

			// Database
			case 'database.query':
			case 'database.dialect':
				return;

			// Tool
			case 'tool':
				return;

			default:
				throw new Error(`Unknown method: ${method}`);
		}
	}

	// =========================================================================
	// PHASE 2: MULTI-SOCKET STRESS — independent connections + pipelines
	// =========================================================================

	/**
	 * Start pipelines across the client pool. Each pipeline is owned by a
	 * specific WebSocket connection, distributing load across multiple sockets.
	 * Then send data concurrently from each pipeline's owning connection.
	 */
	async function runMultiSocketStress(
		cfg: TestConfig,
		signal: AbortSignal,
	) {
		metrics.targetOps += cfg.pipelines * cfg.sendsPerPipeline;

		// Initialize pipeline slots
		pipelines.length = 0;
		for (let i = 0; i < Math.max(cfg.pipelines, 64); i++) {
			pipelines.push({
				id: i,
				state: 'idle',
				opsCompleted: 0,
				avgLatency: 0,
			});
		}
		notify();

		const tokens: string[] = [];

		// Start pipelines distributed across the client pool
		pushEvent(
			makeEvent(
				'info',
				'stress',
				`Phase 2: Starting ${cfg.pipelines} pipelines across ${clientPool.filter((c) => c.isConnected()).length} WebSocket connections (ramp: ${cfg.rampUp})...`,
			),
		);
		notify();

		const startPromises: Promise<void>[] = [];
		for (let i = 0; i < cfg.pipelines; i++) {
			if (signal.aborted) break;
			await waitIfPaused(signal);

			startPromises.push(startPipeline(i, cfg, tokens, signal));

			// Ramp-up delays between pipeline starts
			if (cfg.rampUp === 'linear') await randomDelay(1000);
			else if (cfg.rampUp === 'exponential')
				await randomDelay(Math.pow(2, Math.min(i, 10)));
			else if (cfg.rampUp === 'burst') {
				if (i % 8 === 7) await randomDelay(2000);
			}
			// instant: no delay
		}
		await Promise.allSettled(startPromises);

		if (signal.aborted) return;

		// Send data to all pipelines concurrently
		const activeCount = tokens.filter(Boolean).length;
		pushEvent(
			makeEvent(
				'info',
				'stress',
				`${activeCount} pipelines active. Sending ${cfg.sendsPerPipeline} payloads each...`,
			),
		);
		notify();

		const sendPromises: Promise<void>[] = [];
		for (let i = 0; i < cfg.pipelines; i++) {
			if (!tokens[i]) continue;
			sendPromises.push(
				runPipelineSends(i, tokens[i], cfg, signal),
			);
		}
		await Promise.allSettled(sendPromises);

		// Cleanup — terminate all pipelines server-side.
		// Server returns success even for already-dead pipelines (by design),
		// so we just call terminate on everything and expect success.
		pushEvent(makeEvent('info', 'stress', 'Terminating pipelines...'));
		notify();
		for (let i = 0; i < tokens.length; i++) {
			if (!tokens[i]) continue;
			const client = getPipelineClient(i);
			if (!client) continue;
			const label = `P-${String(i).padStart(2, '0')}`;

			try {
				await client.terminate(tokens[i]);
			} catch (err) {
				// Terminate failed — unexpected, log it
				pushEvent(
					makeEvent('fail', label, `terminate failed: ${errMsg(err)}`),
				);
			}
			setPipelineState(i, 'stopped');
		}
		notify();
	}

	/**
	 * Start a single pipeline on a client from the pool.
	 * Each slot gets a different pipeline variant (echo, chain, fan-out, etc.).
	 */
	async function startPipeline(
		idx: number,
		_cfg: TestConfig,
		tokens: string[],
		signal: AbortSignal,
	) {
		if (signal.aborted) return;
		const client = getPoolClient(idx);
		if (!client) {
			setPipelineState(idx, 'error', {
				lastError: 'No connected client',
			});
			pushEvent(
				makeEvent(
					'fail',
					`P-${String(idx).padStart(2, '0')}`,
					'No connected client in pool',
				),
			);
			notify();
			return;
		}

		const clientIdx =
			clientPool.indexOf(client);
		setPipelineState(idx, 'starting', { clientIdx });
		notify();

		const label = `P-${String(idx).padStart(2, '0')}`;
		try {
			const pipe = getStressPipeline(idx);
			const r = await client.use({
				pipeline: pipe,
				source: pipe.source,
				name: `stress-${idx}`,
			});
			tokens[idx] = r?.token;
			setPipelineState(idx, 'running', { token: r?.token });
			metrics.activePipelines++;
			pushEvent(
				makeEvent(
					'info',
					label,
					`use() -> token ${(r?.token || '').slice(0, 8)}... (WS-${clientIdx})`,
				),
			);
		} catch (err) {
			setPipelineState(idx, 'error', {
				lastError:
					errMsg(err),
			});
			pushEvent(
				makeEvent(
					'fail',
					label,
					`start failed: ${errMsg(err)}`,
				),
			);
		}
		notify();
	}

	/**
	 * Send payloads to a running pipeline with chaos injection.
	 * Uses the pipeline's owning client connection.
	 */
	async function runPipelineSends(
		idx: number,
		token: string,
		cfg: TestConfig,
		signal: AbortSignal,
	) {
		const label = `P-${String(idx).padStart(2, '0')}`;
		const client = getPipelineClient(idx);
		if (!client) return;

		const corruptionPct =
			cfg.corruptionLevel === 'off'
				? 0
				: cfg.corruptionLevel === 'occasional'
					? 5
					: cfg.corruptionLevel === 'frequent'
						? 25
						: 50;

		for (let s = 0; s < cfg.sendsPerPipeline; s++) {
			if (signal.aborted) break;
			await waitIfPaused(signal);

			// Chaos: random delay (can be 0 for backpressure flooding)
			if (cfg.randomDelay > 0) await randomDelay(cfg.randomDelay);

			// Chaos: server-side kill — actually terminate the pipeline
			if (
				cfg.killProbability > 0 &&
				Math.random() * 100 < cfg.killProbability
			) {
				pushEvent(
					makeEvent(
						'chaos',
						label,
						`Server-side kill (${cfg.killProbability}% roll) — terminating pipeline`,
					),
				);
				// Real server-side terminate
				await client.terminate(token).catch(() => {});
				setPipelineState(idx, 'stopped');
				metrics.activePipelines = Math.max(
					0,
					metrics.activePipelines - 1,
				);
				notify();
				return;
			}

			// Chaos: data corruption
			let payload = generatePayload(cfg.payloadSize, cfg.payloadType);
			if (corruptionPct > 0 && Math.random() * 100 < corruptionPct) {
				payload =
					'\x00\xFF\xFE' +
					String(payload).slice(0, 100) +
					'\x00\x00';
				pushEvent(
					makeEvent('chaos', label, `Corrupted payload for send #${s}`),
				);
			}

			setPipelineState(idx, 'sending');
			notify();

			const t0 = performance.now();
			try {
				// client.send accepts string | Uint8Array — pass binary
				// payloads through untranslated.
				const result = await client.send(token, payload);
				const latency = performance.now() - t0;
				dataTransferred += payloadSize(payload);
				pipelines[idx].opsCompleted++;
				pipelines[idx].avgLatency =
					(pipelines[idx].avgLatency *
						(pipelines[idx].opsCompleted - 1) +
						latency) /
					pipelines[idx].opsCompleted;
				recordOp(true);
				setPipelineState(idx, 'running');

				// Validate response — a null/undefined result means the
				// server silently dropped the data
				if (result === undefined || result === null) {
					pushEvent(
						makeEvent(
							'warn',
							label,
							`send #${s} -> no result (server may have dropped data)`,
						),
					);
				}
			} catch (err) {
				recordOp(false);
				setPipelineState(idx, 'error', {
					lastError:
						errMsg(err),
				});
				pushEvent(
					makeEvent(
						'fail',
						label,
						`send #${s} -> ${errMsg(err)}`,
					),
				);
			}
			notify();
		}

		setPipelineState(idx, 'running');
		notify();
	}

	// =========================================================================
	// PHASE 3: BACKPRESSURE FLOOD — zero-delay sends to find server limits
	// =========================================================================

	/**
	 * Fire sends as fast as possible from every connected client simultaneously,
	 * with zero delay. Tests server backpressure handling and queue limits.
	 */
	async function runBackpressureFlood(signal: AbortSignal) {
		const connected = clientPool.filter((c) => c.isConnected());
		if (connected.length === 0) return;

		pushEvent(
			makeEvent(
				'info',
				'flood',
				`Phase 3: Backpressure flood from ${connected.length} clients (zero delay)...`,
			),
		);
		notify();

		// Each client gets its own echo pipeline
		const clientTokens: string[] = [];
		for (let i = 0; i < connected.length; i++) {
			// break, not return: the post-loop cleanup (terminate the flood
			// pipelines already created) must still run on abort.
			if (signal.aborted) break;
			try {
				const pipe = getEchoPipeline();
				const r = await connected[i].use({
					pipeline: pipe,
					source: pipe.source,
					name: `flood-${i}`,
				});
				clientTokens.push(r?.token || '');
			} catch {
				clientTokens.push('');
			}
		}

		// Flood: 100 sends per client, zero delay, medium payload
		const FLOOD_COUNT = 100;
		metrics.targetOps += connected.length * FLOOD_COUNT;

		const floodPromises = connected.map((client, cidx) => {
			const token = clientTokens[cidx];
			if (!token) return Promise.resolve();

			return (async () => {
				for (let s = 0; s < FLOOD_COUNT; s++) {
					if (signal.aborted) break;
					await waitIfPaused(signal);

					const payload = generatePayload('medium', 'text');
					try {
						// client.send accepts string | Uint8Array — pass binary
						// payloads through untranslated.
						await client.send(token, payload);
						dataTransferred += payloadSize(payload);
						recordOp(true);
					} catch (err) {
						recordOp(false);
						pushEvent(
							makeEvent(
								'fail',
								`flood-${cidx}`,
								`send #${s} -> ${errMsg(err)}`,
							),
						);
						notify();
					}
				}
			})();
		});

		await Promise.allSettled(floodPromises);

		// Cleanup flood pipelines
		for (let i = 0; i < connected.length; i++) {
			if (clientTokens[i]) {
				await connected[i].terminate(clientTokens[i]).catch(() => {});
			}
		}

		pushEvent(makeEvent('info', 'flood', 'Backpressure flood complete'));
		notify();
	}

	// =========================================================================
	// PHASE 4: PIPE STREAMING — open/write/close with large chunks
	// =========================================================================

	/**
	 * Test the DataPipe streaming API: open a pipe, write multiple large
	 * chunks, and validate the close result. Tests chunked transfer and
	 * server-side reassembly.
	 */
	async function runPipeStreaming(signal: AbortSignal) {
		const connected = clientPool.filter((c) => c.isConnected());
		if (connected.length === 0) return;

		pushEvent(
			makeEvent(
				'info',
				'pipe',
				`Phase 4: Pipe streaming test (${connected.length} clients)...`,
			),
		);
		notify();

		const CHUNKS_PER_PIPE = 10;
		const CHUNK_SIZE = 50_000; // 50KB per chunk = 500KB total per pipe
		metrics.targetOps += connected.length * CHUNKS_PER_PIPE;

		const pipePromises = connected.map((client, cidx) =>
			(async () => {
				if (signal.aborted) return;
				await waitIfPaused(signal);

				// Start a pipeline for this client's pipe test
				let token: string | undefined;
				try {
					const pipeline = getEchoPipeline();
					const r = await client.use({
						pipeline,
						source: pipeline.source,
						name: `pipe-test-${cidx}`,
					});
					token = r?.token;
				} catch (err) {
					pushEvent(
						makeEvent(
							'fail',
							`pipe-${cidx}`,
							`use() failed: ${errMsg(err)}`,
						),
					);
					notify();
					return;
				}

				if (!token) return;

				try {
					// Open a data pipe
					const pipe = await client.pipe(
						token,
						{ name: `test-stream-${cidx}.bin`, size: CHUNKS_PER_PIPE * CHUNK_SIZE },
						'application/octet-stream',
					);
					await pipe.open();

					// Write large chunks
					for (let c = 0; c < CHUNKS_PER_PIPE; c++) {
						if (signal.aborted) break;
						await waitIfPaused(signal);

						const chunk = new Uint8Array(CHUNK_SIZE);
						crypto.getRandomValues(chunk);

						try {
							await pipe.write(chunk);
							dataTransferred += CHUNK_SIZE;
							recordOp(true);
						} catch (err) {
							recordOp(false);
							pushEvent(
								makeEvent(
									'fail',
									`pipe-${cidx}`,
									`write chunk #${c} -> ${errMsg(err)}`,
								),
							);
							notify();
						}
					}

					// Close and validate result
					const result = await pipe.close();
					if (result === undefined || result === null) {
						pushEvent(
							makeEvent(
								'warn',
								`pipe-${cidx}`,
								'pipe.close() returned no result',
							),
						);
					} else {
						pushEvent(
							makeEvent(
								'pass',
								`pipe-${cidx}`,
								`Pipe stream complete (${CHUNKS_PER_PIPE} chunks, ${Math.round((CHUNKS_PER_PIPE * CHUNK_SIZE) / 1024)}KB)`,
							),
						);
					}
				} catch (err) {
					pushEvent(
						makeEvent(
							'fail',
							`pipe-${cidx}`,
							`Pipe error: ${errMsg(err)}`,
						),
					);
				}

				// Cleanup
				await client.terminate(token).catch(() => {});
				notify();
			})(),
		);

		await Promise.allSettled(pipePromises);
		pushEvent(makeEvent('info', 'pipe', 'Pipe streaming tests complete'));
		notify();
	}

	// =========================================================================
	// PHASE 5: CHAOS — real server-side kills, connection churn, contention
	// =========================================================================

	/**
	 * Run chaos tests that genuinely stress the server:
	 * - Rapid use/terminate cycling (pipeline churn)
	 * - Send to already-terminated pipelines (should fail gracefully)
	 * - Cross-client contention (two clients hitting same pipeline)
	 * - Connection churn (connect/disconnect cycling)
	 * - Zombie detection (use() then never terminate)
	 */
	async function runChaosTests(signal: AbortSignal) {
		pushEvent(
			makeEvent('info', 'chaos', 'Phase 5: Chaos injection tests...'),
		);
		notify();

		// Chaos test 1: rapid pipeline churn (use -> terminate -> use -> ...)
		await chaosRapidChurn(signal);
		if (signal.aborted) return;
		await waitIfPaused(signal);

		// Chaos test 2: send to terminated pipeline
		await chaosSendAfterTerminate(signal);
		if (signal.aborted) return;
		await waitIfPaused(signal);

		// Chaos test 3: cross-client contention
		await chaosCrossClientContention(signal);
		if (signal.aborted) return;
		await waitIfPaused(signal);

		// Chaos test 4: connection churn
		await chaosConnectionChurn(signal);
		if (signal.aborted) return;
		await waitIfPaused(signal);

		// Chaos test 5: zombie pipelines
		await chaosZombiePipelines(signal);

		pushEvent(
			makeEvent('info', 'chaos', 'Chaos injection tests complete'),
		);
		notify();
	}

	/**
	 * Chaos 1: Rapid pipeline churn — use() and terminate() as fast as
	 * possible to stress pipeline lifecycle management.
	 */
	async function chaosRapidChurn(signal: AbortSignal) {
		const client = getPoolClient(0);
		if (!client) return;

		const CYCLES = 20;
		metrics.targetOps += CYCLES * 2; // use + terminate per cycle
		pushEvent(
			makeEvent(
				'chaos',
				'churn',
				`Rapid pipeline churn: ${CYCLES} use/terminate cycles...`,
			),
		);
		notify();

		for (let i = 0; i < CYCLES; i++) {
			if (signal.aborted) break;
			await waitIfPaused(signal);

			try {
				const pipe = getEchoPipeline();
				const r = await client.use({
					pipeline: pipe,
					source: pipe.source,
					name: `churn-${i}`,
				});
				recordOp(true);

				if (r?.token) {
					await client.terminate(r.token);
					recordOp(true);
				}
			} catch (err) {
				recordOp(false);
				pushEvent(
					makeEvent(
						'fail',
						'churn',
						`Cycle ${i}: ${errMsg(err)}`,
					),
				);
				notify();
			}
		}

		pushEvent(
			makeEvent('pass', 'churn', `${CYCLES} churn cycles complete`),
		);
		notify();
	}

	/**
	 * Chaos 2: Send to a terminated pipeline. The server should reject
	 * the send gracefully, not crash.
	 */
	async function chaosSendAfterTerminate(signal: AbortSignal) {
		const client = getPoolClient(0);
		if (!client) return;

		metrics.targetOps += 5;
		pushEvent(
			makeEvent(
				'chaos',
				'zombie-send',
				'Sending to terminated pipeline (expect rejection)...',
			),
		);
		notify();

		try {
			const pipe = getEchoPipeline();
			const r = await client.use({
				pipeline: pipe,
				source: pipe.source,
				name: 'zombie-test',
			});
			const token = r?.token;
			if (!token) return;

			// Terminate first
			await client.terminate(token);

			// Now send 5 times to the dead pipeline — each should fail
			for (let i = 0; i < 5; i++) {
				if (signal.aborted) break;
				try {
					await client.send(token, 'data to dead pipeline');
					// If we get here, the server accepted data to a dead
					// pipeline — that's unexpected
					recordOp(false);
					pushEvent(
						makeEvent(
							'fail',
							'zombie-send',
							`Send #${i} to dead pipeline was accepted (expected rejection)`,
						),
					);
				} catch {
					// Expected — server correctly rejected
					recordOp(true);
				}
				notify();
			}
			pushEvent(
				makeEvent(
					'pass',
					'zombie-send',
					'Dead pipeline sends correctly rejected',
				),
			);
		} catch (err) {
			pushEvent(
				makeEvent(
					'fail',
					'zombie-send',
					`Setup failed: ${errMsg(err)}`,
				),
			);
		}
		notify();
	}

	/**
	 * Chaos 3: Two clients start the same pipeline token with useExisting,
	 * then both send data concurrently. Tests multiplexing and seq collision
	 * handling.
	 */
	async function chaosCrossClientContention(signal: AbortSignal) {
		const clientA = getPoolClient(0);
		const clientB = getPoolClient(1);
		if (!clientA || !clientB || clientA === clientB) {
			pushEvent(
				makeEvent(
					'info',
					'contention',
					'Skipped: need 2+ independent clients',
				),
			);
			notify();
			return;
		}

		const SENDS = 20;
		metrics.targetOps += SENDS * 2; // both clients send
		pushEvent(
			makeEvent(
				'chaos',
				'contention',
				`Cross-client contention: 2 clients, ${SENDS} sends each...`,
			),
		);
		notify();

		try {
			// Client A starts the pipeline
			const pipe = getEchoPipeline();
			const rA = await clientA.use({
				pipeline: pipe,
				source: pipe.source,
				name: 'contention-test',
			});
			const token = rA?.token;
			if (!token) return;

			// Client B joins the same pipeline
			await clientB.use({
				pipeline: pipe,
				source: pipe.source,
				name: 'contention-test',
				useExisting: true,
			});

			// Both clients send concurrently to the same pipeline
			const sendFromClient = async (
				client: any,
				label: string,
			) => {
				for (let i = 0; i < SENDS; i++) {
					if (signal.aborted) break;
					await waitIfPaused(signal);
					try {
						await client.send(
							token,
							`${label} send #${i} @ ${Date.now()}`,
						);
						recordOp(true);
					} catch (err) {
						recordOp(false);
						pushEvent(
							makeEvent(
								'fail',
								'contention',
								`${label} send #${i}: ${errMsg(err)}`,
							),
						);
						notify();
					}
				}
			};

			await Promise.all([
				sendFromClient(clientA, 'A'),
				sendFromClient(clientB, 'B'),
			]);

			// Cleanup
			await clientA.terminate(token).catch(() => {});
			pushEvent(
				makeEvent(
					'pass',
					'contention',
					'Cross-client contention test complete',
				),
			);
		} catch (err) {
			pushEvent(
				makeEvent(
					'fail',
					'contention',
					`Failed: ${errMsg(err)}`,
				),
			);
		}
		notify();
	}

	/**
	 * Chaos 4: Rapid connect/disconnect cycling on fresh clients.
	 * Tests server-side connection cleanup and resource release.
	 */
	async function chaosConnectionChurn(signal: AbortSignal) {
		const { uri, apiKey } = getCredentials();

		const CYCLES = 10;
		metrics.targetOps += CYCLES * 2; // connect + disconnect per cycle
		pushEvent(
			makeEvent(
				'chaos',
				'conn-churn',
				`Connection churn: ${CYCLES} connect/disconnect cycles...`,
			),
		);
		notify();

		for (let i = 0; i < CYCLES; i++) {
			if (signal.aborted) break;
			await waitIfPaused(signal);

			const ephemeral = MonitoredClient.create(RocketRideClient, apiMonitor, {
				uri,
				auth: apiKey,
				persist: false,
				requestTimeout: 30_000,
			});

			try {
				await ephemeral.connect();
				recordOp(true);

				await ephemeral.disconnect();
				recordOp(true);
			} catch (err) {
				recordOp(false);
				pushEvent(
					makeEvent(
						'fail',
						'conn-churn',
						`Cycle ${i}: ${errMsg(err)}`,
					),
				);
				// Ensure cleanup even on failure
				await ephemeral.disconnect().catch(() => {});
				notify();
			}
		}

		pushEvent(
			makeEvent(
				'pass',
				'conn-churn',
				`${CYCLES} connection churn cycles complete`,
			),
		);
		notify();
	}

	/**
	 * Chaos 5: Start pipelines and never terminate them. After a delay,
	 * check the dashboard to see how many orphaned tasks remain. Tests
	 * whether the server leaks resources for abandoned pipelines.
	 */
	async function chaosZombiePipelines(signal: AbortSignal) {
		const client = getPoolClient(0);
		if (!client) return;

		const ZOMBIES = 5;
		metrics.targetOps += ZOMBIES;
		pushEvent(
			makeEvent(
				'chaos',
				'zombie',
				`Creating ${ZOMBIES} zombie pipelines (no terminate)...`,
			),
		);
		notify();

		const zombieTokens: string[] = [];
		for (let i = 0; i < ZOMBIES; i++) {
			if (signal.aborted) break;
			try {
				const pipe = getEchoPipeline();
				const r = await client.use({
					pipeline: pipe,
					source: pipe.source,
					name: `zombie-${i}`,
				});
				if (r?.token) zombieTokens.push(r.token);
				recordOp(true);
			} catch (err) {
				recordOp(false);
				pushEvent(
					makeEvent(
						'fail',
						'zombie',
						`Zombie ${i}: ${errMsg(err)}`,
					),
				);
				notify();
			}
		}

		// Check dashboard for active task count
		try {
			const dashboard = await client.getDashboard();
			const taskCount =
				typeof dashboard === 'object' && dashboard !== null
					? Object.keys(dashboard).length
					: 0;
			pushEvent(
				makeEvent(
					'info',
					'zombie',
					`Dashboard shows ${taskCount} active tasks (${zombieTokens.length} are zombies)`,
				),
			);
		} catch {
			pushEvent(
				makeEvent('warn', 'zombie', 'Could not read dashboard'),
			);
		}

		// Cleanup — terminate the zombies to be responsible
		for (const token of zombieTokens) {
			await client.terminate(token).catch(() => {});
		}
		pushEvent(
			makeEvent(
				'pass',
				'zombie',
				`${zombieTokens.length} zombie pipelines cleaned up`,
			),
		);
		notify();
	}

	// =========================================================================
	// PHASE 6: CONCURRENT API HAMMER — parallel calls to find race conditions
	// =========================================================================

	/**
	 * Fire multiple API methods concurrently from all clients to find race
	 * conditions, deadlocks, and concurrency bugs in the server.
	 */
	async function runConcurrentApiHammer(signal: AbortSignal) {
		const connected = clientPool.filter((c) => c.isConnected());
		if (connected.length === 0) return;

		pushEvent(
			makeEvent(
				'info',
				'hammer',
				`Phase 6: Concurrent API hammer (${connected.length} clients)...`,
			),
		);
		notify();

		// Each client fires these concurrently
		const hammerMethods = [
			'getServices',
			'getDashboard',
			'getAllTemplates',
			'clearAllMonitors',
		];
		const ROUNDS = 5;
		metrics.targetOps += connected.length * hammerMethods.length * ROUNDS;

		for (let round = 0; round < ROUNDS; round++) {
			if (signal.aborted) break;
			await waitIfPaused(signal);

			// All clients fire all methods simultaneously
			const promises: Promise<void>[] = [];
			for (const client of connected) {
				for (const method of hammerMethods) {
					promises.push(
						(async () => {
							try {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								const c = client as any;
								switch (method) {
									case 'getServices':
										await c.getServices();
										break;
									case 'getDashboard':
										await c.getDashboard();
										break;
									case 'getAllTemplates':
										await c.getAllTemplates();
										break;
									case 'clearAllMonitors':
										await c.clearAllMonitors();
										break;
								}
								recordOp(true);
							} catch (err) {
								recordOp(false);
								pushEvent(
									makeEvent(
										'fail',
										'hammer',
										`${method}: ${errMsg(err)}`,
									),
								);
								notify();
							}
						})(),
					);
				}
			}

			await Promise.allSettled(promises);
		}

		pushEvent(
			makeEvent(
				'pass',
				'hammer',
				`${ROUNDS} rounds of concurrent API hammer complete`,
			),
		);
		notify();
	}

	// =========================================================================
	// PUBLIC API
	// =========================================================================

	// Initialize phases immediately so the UI can show them before a run
	initPhases();

	const engine: TestEngine = {
		get state() {
			return state;
		},
		get metrics() {
			return { ...metrics };
		},
		get events() {
			return events;
		},
		get pipelines() {
			return pipelines;
		},
		get apiResults() {
			return Array.from(apiMonitor.results.values());
		},
		get latencyHistory() {
			return latencyHistory;
		},
		get phases() {
			return phases;
		},
		get worstPing() {
			return apiMonitor.worstPing;
		},
		get worstPingSnapshot() {
			return apiMonitor.worstPingSnapshot;
		},

		/**
		 * Start the full test suite: API sweep, multi-socket stress,
		 * backpressure flood, pipe streaming, chaos, and concurrent hammer.
		 */
		start(cfg: TestConfig, selectedPhases?: Set<string>) {
			// Only an idle engine may start: a paused/aborting run still owns
			// metrics, clientPool, and abortController.
			if (state !== 'idle') return;
			state = 'running';
			startTime = Date.now();
			abortController = new AbortController();

			initPhases();

			// Mark deselected phases as skipped immediately
			const allIds = new Set(PHASE_DEFS.map((d) => d.id));
			const active = selectedPhases ?? allIds;
			for (const phase of phases) {
				if (!active.has(phase.id)) phase.status = 'skipped';
			}

			pushEvent(makeEvent('info', 'engine', 'Test run started'));
			notify();

			const signal = abortController.signal;

			// Number of independent WebSocket connections per phase
			const wsCount = Math.max(2, Math.min(Math.ceil(cfg.pipelines / 8), 8));

			// Helper: only run if the phase is selected
			const run = (id: string, fn: () => Promise<void>) =>
				active.has(id) ? runPhase(id, fn, signal) : Promise.resolve();

			(async () => {
				// Start a background ping heartbeat for the entire run.
				// Ping latency spikes reveal event loop stalls on the server.
				let pingHeartbeat: { stop: () => Promise<void> } | null = null;
				try {
					pingHeartbeat = await startPingHeartbeat(signal);
					pushEvent(makeEvent('info', 'engine', 'Ping heartbeat started (100ms interval)'));
					notify();
				} catch (err) {
					pushEvent(makeEvent('warn', 'engine', `Ping heartbeat failed to start: ${errMsg(err)}`));
					notify();
				}

				try {
					// Each phase is standalone — creates/destroys its own client pool
					await run('sweep', () => runApiSweep(signal));
					await waitIfPaused(signal);

					await run('stress', () => withPool(wsCount, 'stress', signal, () => runMultiSocketStress(cfg, signal)));
					await waitIfPaused(signal);

					await run('flood', () => withPool(wsCount, 'flood', signal, () => runBackpressureFlood(signal)));
					await waitIfPaused(signal);

					await run('pipe', () => withPool(wsCount, 'pipe', signal, () => runPipeStreaming(signal)));
					await waitIfPaused(signal);

					await run('chaos', () => withPool(wsCount, 'chaos', signal, () => runChaosTests(signal)));
					await waitIfPaused(signal);

					await run('hammer', () => withPool(wsCount, 'hammer', signal, () => runConcurrentApiHammer(signal)));
				} catch (err) {
					pushEvent(
						makeEvent(
							'fail',
							'engine',
							`Engine error: ${errMsg(err)}`,
						),
					);
				} finally {
					// Stop the ping heartbeat
					if (pingHeartbeat) {
						await pingHeartbeat.stop();
					}
					state = 'idle';
					metrics.activePipelines = 0;
					pushEvent(
						makeEvent('info', 'engine', 'Test run complete'),
					);
					notify();
				}
			})();
		},

		/** Pause the engine — all phases check this and wait. */
		pause() {
			if (state !== 'running') return;
			state = 'paused';
			pushEvent(makeEvent('warn', 'engine', 'Paused'));
			notify();
		},

		/** Resume from pause. */
		resume() {
			if (state !== 'paused') return;
			state = 'running';
			pushEvent(makeEvent('info', 'engine', 'Resumed'));
			notify();
		},

		/** Abort the run and clean up. */
		abort() {
			if (state === 'idle') return;
			state = 'aborting';
			abortController?.abort();
			pushEvent(makeEvent('warn', 'engine', 'Aborting...'));
			notify();
		},

		/** Clear all run data. Settings are view-owned and unaffected. */
		clear() {
			// Only an idle engine may clear: aborting still owns clientPool
			// and metrics — clearing mid-cleanup strands undisconnected
			// sockets (destroyPool would tear down an emptied pool).
			if (state !== 'idle') return;
			opsCounter = 0;
			opsWindow = [];
			dataTransferred = 0;
			metrics.passed = 0;
			metrics.failed = 0;
			metrics.activePipelines = 0;
			metrics.opsPerSec = 0;
			metrics.totalOps = 0;
			metrics.targetOps = 0;
			metrics.elapsed = 0;
			metrics.dataTransferred = 0;
			metrics.wsConnections = 0;
			metrics.queuedOps = 0;
			events.length = 0;
			apiMonitor.clear();
			latencyHistory.length = 0;
			pipelines.length = 0;
			clientPool = [];
			initPhases();
			notify();
		},

		/**
		 * Reset the engine. Engine-side this is identical to clear() —
		 * settings live in the view layer (TestSessionView restores its
		 * own config and phase selection when handling the reset action).
		 */
		reset() {
			engine.clear();
		},

		/** Run a pre-built chaos scenario with custom config overrides. */
		runScenario(scenario: ChaosScenario) {
			const cfg: TestConfig = {
				pipelines: 16,
				sendsPerPipeline: 50,
				rampUp: 'instant',
				randomDelay: 100,
				killProbability: 0,
				corruptionLevel: 'off',
				payloadSize: 'medium',
				payloadType: 'text',
				...scenario.config,
			};
			pushEvent(
				makeEvent(
					'info',
					'engine',
					`Running scenario: ${scenario.name}`,
				),
			);
			notify();
			engine.start(cfg);
		},

		/** Subscribe to engine state changes. Returns unsubscribe function. */
		onUpdate(cb: () => void) {
			listeners.push(cb);
			return () => {
				const idx = listeners.indexOf(cb);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
	};

	return engine;
}
