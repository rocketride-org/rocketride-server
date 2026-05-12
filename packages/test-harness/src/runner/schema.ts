/**
 * Trace file shape persisted per pipeline run.
 *
 * Greenfield format. The collector buffers apaevt_flow + apaevt_sse events
 * for a token-scoped monitor and emits one TraceFile per pipeline.
 */

export type ApaevtFlowOp = 'begin' | 'enter' | 'leave' | 'end';

export type ApaevtFlowEvent = {
	event: 'apaevt_flow';
	seq?: number;
	body: {
		id: number;
		op: ApaevtFlowOp;
		pipes: string[];
		trace?: {
			lane?: string;
			data?: unknown;
			result?: string;
			error?: string;
		};
		result?: string;
		project_id: string;
		source: string;
	};
};

export type ApaevtSseEvent = {
	event: 'apaevt_sse';
	seq?: number;
	body: {
		pipe_id?: number;
		type?: string;
		data?: unknown;
		[k: string]: unknown;
	};
};

export type ApaevtAnyEvent = {
	event: string;
	seq?: number;
	body?: Record<string, unknown>;
	[k: string]: unknown;
};

export type PipelineResultBucket = 'pass' | 'logic_failure' | 'infra_failure' | 'timeout';

export type TraceFile = {
	pipeline: string;
	run_started: string;
	run_ended: string;
	token: string;
	prompt?: unknown;
	sse_events: ApaevtSseEvent[];
	runtime_events: ApaevtFlowEvent[];
	other_events: ApaevtAnyEvent[];
	result: PipelineResultBucket;
	infra_signature?: string;
	error?: { message: string; raw?: unknown };
	/** Provider class names exercised (matches /services registry). */
	exercised_nodes: string[];
	/** Raw component IDs from apaevt_flow.body.pipes[-1]; preserved for forensics. */
	exercised_components: string[];
};
