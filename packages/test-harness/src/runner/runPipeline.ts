/**
 * Run one pipeline end-to-end against a connected RocketRideClient.
 *
 * Subscribes to FLOW/SSE/DETAIL/TASK, writes input via a streaming pipe,
 * waits for the terminal apaevt_flow op:'end' (or timeout), classifies the
 * result, and persists the trace JSON.
 */

import { readFileSync } from 'fs';

import { RocketRideClient } from 'rocketride';
import type { PipelineConfig } from 'rocketride';

import { classifyError } from '../classify/infraSignatures';
import { TraceCollector } from './collector';
import { writeTrace } from './persist';
import type { ApaevtAnyEvent, ApaevtFlowEvent, PipelineResultBucket, TraceFile } from './schema';

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

/**
 * Pipeline JSONs identify nodes by component `id` (e.g. `llm_openai_1`) but the
 * authoritative node-class registry from `/services` uses `provider` names
 * (e.g. `llm_openai`). Coverage tracking matches against `provider`, so we
 * resolve `pipes[]` IDs via the loaded pipeline config.
 */
function buildIdToProvider(pipelineConfig: PipelineConfig): Map<string, string> {
	const map = new Map<string, string>();
	for (const component of pipelineConfig.components ?? []) {
		if (component && typeof component.id === 'string' && typeof component.provider === 'string') {
			map.set(component.id, component.provider);
		}
	}
	return map;
}

function resolveProviders(componentIds: string[], idToProvider: Map<string, string>): string[] {
	const providers = new Set<string>();
	for (const id of componentIds) {
		const provider = idToProvider.get(id);
		if (provider) providers.add(provider);
	}
	return Array.from(providers).sort();
}

function extractFlowErrors(events: ApaevtFlowEvent[]): string[] {
	const errors: string[] = [];
	for (const ev of events) {
		const trace = ev.body?.trace;
		if (trace?.result === 'error' && typeof trace.error === 'string' && trace.error.length > 0) {
			errors.push(trace.error);
		}
	}
	return errors;
}

function extractStatusErrors(events: ApaevtAnyEvent[]): string[] {
	const errors: string[] = [];
	for (const ev of events) {
		if (ev.event === 'apaevt_status_error') {
			const body = ev.body ?? {};
			const msg = (body.message ?? body.error ?? JSON.stringify(body)) as string;
			if (typeof msg === 'string' && msg.length > 0) {
				errors.push(msg);
			}
		}
	}
	return errors;
}

type Classification = {
	result: PipelineResultBucket;
	error?: TraceFile['error'];
	infra_signature?: string;
};

function classify(args: {
	timedOut: boolean;
	closeError?: TraceFile['error'];
	flowEvents: ApaevtFlowEvent[];
	otherEvents: ApaevtAnyEvent[];
}): Classification {
	const flowErrors = extractFlowErrors(args.flowEvents);
	const statusErrors = extractStatusErrors(args.otherEvents);
	const allErrors = [...flowErrors, ...statusErrors];
	if (args.closeError?.message) allErrors.push(args.closeError.message);

	for (const msg of allErrors) {
		const hit = classifyError(msg);
		if (hit) {
			return {
				result: 'infra_failure',
				infra_signature: hit.signature,
				error: { message: hit.rawError },
			};
		}
	}

	if (allErrors.length > 0) {
		return {
			result: 'logic_failure',
			error: { message: allErrors[0] },
		};
	}

	if (args.timedOut) {
		return { result: 'timeout' };
	}

	return { result: 'pass' };
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
	let closeError: TraceFile['error'];

	const idToProvider = buildIdToProvider(pipelineConfig);

	try {
		const useResult = await client.use({ pipeline: pipelineConfig, pipelineTraceLevel: 'full' });
		token = useResult.token;

		await client.addMonitor({ token }, MONITOR_TYPES);

		const pipe = await client.pipe(token, { name: `${def.slug}-input` }, def.input.mimeType);
		await pipe.open();
		await pipe.write(new TextEncoder().encode(def.input.data));

		const closePromise = pipe.close().catch((err: unknown) => {
			closeError = {
				message: err instanceof Error ? err.message : String(err),
				raw: err,
			};
			return undefined;
		});

		const collectorResult = await collector.waitForTerminal();
		await closePromise;

		await client.removeMonitor({ token }, MONITOR_TYPES);

		const classification = classify({
			timedOut: collectorResult.timedOut,
			closeError,
			flowEvents: collectorResult.runtime_events,
			otherEvents: collectorResult.other_events,
		});

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
			result: classification.result,
			error: classification.error,
			infra_signature: classification.infra_signature,
			exercised_nodes: resolveProviders(collectorResult.exercised_nodes, idToProvider),
			exercised_components: collectorResult.exercised_nodes,
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
