/**
 * Run one pipeline end-to-end against a connected RocketRideClient.
 *
 * Phase 1 deliberate scope: capture the trace, persist it. No classification,
 * no coverage diff, no report. Result bucket is 'pass' if a terminal
 * apaevt_flow op:'end' arrives, 'timeout' otherwise; logic/infra split lands
 * in Phase 2.
 */

import { readFileSync } from 'fs';

import { RocketRideClient } from 'rocketride';
import type { PipelineConfig } from 'rocketride';

import { TraceCollector } from './collector';
import { writeTrace } from './persist';
import type { PipelineResultBucket, TraceFile } from './schema';

/**
 * Subscription type names for the server's monitor command. These map to
 * EVENT_TYPE enum members in packages/client-python/.../types/events.py.
 * Note: subscription names ('FLOW', 'SSE', 'DETAIL', 'TASK') differ from
 * emitted event names on the wire ('apaevt_flow', 'apaevt_sse', etc.).
 */
const MONITOR_TYPES = ['FLOW', 'SSE', 'DETAIL', 'TASK'];

export type PipelineDef = {
	slug: string;
	filePath: string;
	input: { mimeType: string; data: string };
};

export type RunPipelineOptions = {
	runDir: string;
	timeoutMs: number;
};

function loadPipelineConfig(filePath: string): PipelineConfig {
	const raw = readFileSync(filePath, 'utf8');
	return JSON.parse(raw) as PipelineConfig;
}

export async function runPipeline(
	client: RocketRideClient,
	collector: TraceCollector,
	def: PipelineDef,
	options: RunPipelineOptions,
): Promise<TraceFile> {
	const startedAt = new Date();
	const pipelineConfig = loadPipelineConfig(def.filePath);

	let token = '';
	let result: PipelineResultBucket = 'timeout';
	let errorInfo: TraceFile['error'];

	try {
		const useResult = await client.use({ pipeline: pipelineConfig, pipelineTraceLevel: 'full' });
		token = useResult.token;

		await client.addMonitor({ token }, MONITOR_TYPES);

		const pipe = await client.pipe(token, { name: `${def.slug}-input` }, def.input.mimeType);
		await pipe.open();
		await pipe.write(new TextEncoder().encode(def.input.data));

		const closePromise = pipe.close().catch((err: unknown) => {
			errorInfo = {
				message: err instanceof Error ? err.message : String(err),
				raw: err,
			};
			return undefined;
		});

		const collectorResult = await collector.waitForTerminal();
		await closePromise;

		if (collectorResult.timedOut) {
			result = 'timeout';
		} else {
			result = 'pass';
		}

		await client.removeMonitor({ token }, MONITOR_TYPES);

		const endedAt = new Date();

		const trace: TraceFile = {
			pipeline: def.slug,
			run_started: startedAt.toISOString(),
			run_ended: endedAt.toISOString(),
			token,
			prompt: def.input.data,
			sse_events: collectorResult.sse_events,
			runtime_events: collectorResult.runtime_events,
			other_events: collectorResult.other_events,
			result,
			error: errorInfo,
			exercised_nodes: collectorResult.exercised_nodes,
		};

		writeTrace(options.runDir, trace);
		return trace;
	} finally {
		if (token) {
			try {
				await client.terminate(token);
			} catch {
				// Cleanup-best-effort: terminate may fail if pipeline already ended
			}
		}
	}
}
