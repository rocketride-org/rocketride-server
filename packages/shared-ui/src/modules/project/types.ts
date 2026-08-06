// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Project module types — shared data types for ProjectView and its consumers.
 *
 * Transport / message protocol types live in the VS Code extension, not here.
 */

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type { ITaskStatus as TaskStatus } from 'shell/src/types/project';
export type { IFlowData as FlowData } from 'shell/src/types/project';
export { ITaskState as TASK_STATE } from 'shell/src/types/project';

// =============================================================================
// TRACE TYPES
// =============================================================================

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

// =============================================================================
// VIEW TYPES
// =============================================================================

/** Pipeline trace level passed to the engine on run (matches the SDK `client.use` option). */
export type TraceLevel = 'none' | 'metadata' | 'summary' | 'full';

/** View state — per-view UI state (mode, flowViewMode, viewport). */
export interface ViewState {
	mode: ProjectViewMode;
	flowViewMode?: 'pipeline' | 'component';
	viewport?: { x: number; y: number; zoom: number };
}

/**
 * Top-level document pages (UI direction v5): DESIGN edits the canvas,
 * DEVELOPMENT monitors + replays the dev continuum, DEPLOY the deploy
 * continuum (plus, when the deploy feature lands, its lifecycle card).
 * The former per-view modes (status/tokens/flow/trace/errors) became
 * per-source pills inside each page's SourcePanels.
 */
export type ProjectViewMode = 'design' | 'development' | 'deploy';

/** Base view props (for ServerView, WelcomeView, etc.). */
export interface IViewProps {
	isConnected: boolean;
	initialState?: Record<string, unknown>;
	onStateChange?: (state: Record<string, unknown>) => void;
}
