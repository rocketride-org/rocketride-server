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
// TEST-UI — Types
// =============================================================================

/** Status of a single API method test. */
export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** Cumulative stats for a single API method across all calls. */
export interface ApiTestResult {
	method: string;
	category: string;
	status: TestStatus;
	/** Why this method was skipped (only set when status === 'skipped'). */
	skipReason?: string;
	/** Total calls issued (started). */
	issued: number;
	/** Calls that received a response (success or server error). */
	completed: number;
	/** Calls that failed (network error, unexpected result). */
	errors: number;
	/** Recent latency samples in ms (rolling window capped at
	 *  MAX_LATENCY_SAMPLES in monitor.ts; used for percentile calculation). */
	latencies: number[];
	/** Last error message. */
	lastError?: string;
}

/** Live event in the activity stream. */
export interface TestEvent {
	id: number;
	time: number;
	type: 'pass' | 'fail' | 'warn' | 'info' | 'data' | 'chaos';
	source: string;
	message: string;
}

/** State of a single pipeline in the swarm. */
export type PipelineState = 'idle' | 'starting' | 'running' | 'sending' | 'error' | 'stopped';

export interface PipelineSlot {
	id: number;
	state: PipelineState;
	token?: string;
	/** Which WebSocket connection (client index) owns this pipeline. */
	clientIdx?: number;
	opsCompleted: number;
	avgLatency: number;
	lastError?: string;
}

/** Aggregate metrics for the dashboard. */
export interface TestMetrics {
	passed: number;
	failed: number;
	activePipelines: number;
	opsPerSec: number;
	totalOps: number;
	targetOps: number;
	elapsed: number;
	dataTransferred: number;
	wsConnections: number;
	queuedOps: number;
}

/** Latency sample for the sparkline. */
export interface LatencySample {
	time: number;
	value: number;
	/** What operation produced this sample (e.g. "P-03 send #5", "sweep getServices"). */
	source?: string;
}

/** Configuration for a test run. */
export interface TestConfig {
	pipelines: number;
	sendsPerPipeline: number;
	rampUp: 'instant' | 'linear' | 'exponential' | 'burst';
	randomDelay: number;
	killProbability: number;
	corruptionLevel: 'off' | 'occasional' | 'frequent' | 'extreme';
	payloadSize: 'tiny' | 'medium' | 'large' | 'huge' | 'mixed';
	payloadType: 'text' | 'binary' | 'mixed' | 'malformed' | 'empty';
}

/** Overall engine state. */
export type EngineState = 'idle' | 'running' | 'paused' | 'aborting';

/** A pre-built chaos scenario. */
export interface ChaosScenario {
	id: string;
	name: string;
	description: string;
	tags: Array<{ label: string; color: 'chaos' | 'stress' | 'api' | 'data' | 'conn' }>;
	config: Partial<TestConfig>;
	run: (engine: TestEngine) => Promise<void>;
}

/**
 * Test mode for an API method.
 *
 * - 'happy'    — call with valid args, expect success
 * - 'negative' — call with intentionally bad args, expect server rejection
 *                (pass if the server returns an error, fail if it accepts)
 * - 'skip'     — method exists but can't be safely tested in this context
 */
export type ApiTestMode = 'happy' | 'negative' | 'skip';

/** API method definition for the coverage map. */
export interface ApiMethodDef {
	method: string;
	category: string;
	mode: ApiTestMode;
	/** Human-readable reason when mode is 'skip'. */
	skipReason?: string;
	/** If true, this method only works in SaaS mode (skipped on OSS). */
	saasOnly?: boolean;
}

/** Status of a test phase (displayed in the Phases tab). */
export type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** Result of a single test phase. */
export interface PhaseResult {
	id: string;
	name: string;
	description: string;
	status: PhaseStatus;
	passed: number;
	failed: number;
	duration: number;
	error?: string;
}

/** Forward reference — the actual engine class is in engine.ts. */
export interface TestEngine {
	readonly state: EngineState;
	readonly metrics: TestMetrics;
	readonly events: TestEvent[];
	readonly pipelines: PipelineSlot[];
	readonly apiResults: ApiTestResult[];
	readonly latencyHistory: LatencySample[];
	readonly phases: PhaseResult[];
	readonly worstPing: number;
	readonly worstPingSnapshot: string;

	start(config: TestConfig, selectedPhases?: Set<string>): void;
	pause(): void;
	resume(): void;
	abort(): void;
	clear(): void;
	reset(): void;
	runScenario(scenario: ChaosScenario): void;
	onUpdate(cb: () => void): () => void;
}
