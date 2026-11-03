// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Trace types — OWNED by the trace component, not by any tool.
 *
 * The pipelines tool re-exports these from its own `types.ts` so existing
 * pipeline consumers are unchanged; the dependency runs tool -> component,
 * never the reverse. A second consumer (the MCP trace-viewer widget) uses
 * them without depending on the pipelines tool at all.
 */

/** Raw trace event as received from the server/host. */
export interface TraceEvent {
	pipelineId: number;
	op: 'begin' | 'enter' | 'leave' | 'end';
	pipes: string[];
	/** Component this op refers to (for 'leave', the leaving component). Used to pair enter/leave by identity under reentrancy. */
	component?: string;
	trace: {
		lane?: string;
		data?: Record<string, unknown>;
		result?: string;
		error?: string;
	};
	/** Final pipeline result — present when op === 'end' and trace level >= summary. */
	pipelineResult?: Record<string, unknown>;
	/** Source node ID (e.g. "chat_1") — identifies which pipeline source generated this event. */
	source?: string;
	/** Server-stamped emission time (epoch SECONDS, float) — stamped once at engine-stdout ingress; identical live and on run-log replay. */
	eventTime: number;
	/** Server-stamped continuum sequence — catalog-seeded (fresh stream starts at 1, reopen continues at lastSeq + 1), strictly monotonic per task across runs/restarts. */
	seq: number;
}

/** Processed trace row for display in Trace component. */
export interface TraceRow {
	id: number;
	docId: number;
	/**
	 * The trace's PERMANENT identity — its BEGIN event's continuum seq.
	 * This is the id the log API's getTrace resolves. `docId` is only the
	 * fold's client-side grouping counter, and the flow events' pipe/slot
	 * id is reused across documents — neither can name a trace.
	 */
	beginSeq?: number;
	completed: boolean;
	lane: string;
	filterName: string;
	depth: number;
	entryData?: Record<string, unknown>;
	exitData?: Record<string, unknown>;
	result?: string;
	error?: string;
	timestamp: number;
	endTimestamp?: number;
	objectName: string;
	/** Source node ID that generated this trace. */
	source?: string;
	/** Final pipeline result — present on the sentinel row emitted for op === 'end'. */
	pipelineResult?: Record<string, unknown>;
}

/** Pipeline trace level passed to the engine on run (matches the SDK `client.use` option). */
export type TraceLevel = 'none' | 'metadata' | 'summary' | 'full';

