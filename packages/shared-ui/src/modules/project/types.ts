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

export type { ITaskStatus as TaskStatus } from '../../types/project';
export type { IFlowData as FlowData } from '../../types/project';
export { ITaskState as TASK_STATE } from '../../types/project';

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
}

/** Processed trace row for display in Trace component. */
export interface TraceRow {
	id: number;
	docId: number;
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

/** View state — per-view UI state (mode, flowViewMode, viewport, trace level). */
export interface ViewState {
	mode: ProjectViewMode;
	flowViewMode?: 'pipeline' | 'component';
	viewport?: { x: number; y: number; zoom: number };
	/** Pipeline trace level for the next run. Persisted per-document; defaults to 'summary' when unset. */
	pipelineTraceLevel?: TraceLevel;
}

export type ProjectViewMode = 'design' | 'parameters' | 'status' | 'tokens' | 'flow' | 'trace' | 'errors';

/** Base view props (for ServerView, WelcomeView, etc.). */
export interface IViewProps {
	isConnected: boolean;
	initialState?: Record<string, unknown>;
	onStateChange?: (state: Record<string, unknown>) => void;
}
