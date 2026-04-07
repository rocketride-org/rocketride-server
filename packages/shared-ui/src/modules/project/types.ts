// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Project module types — re-exports shared types, defines message protocol,
 * and declares view props.
 */

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type { ITaskStatus as TaskStatus } from '../../types/project';
export type { IFlowData as FlowData } from '../../types/project';
export { ITaskState as TASK_STATE } from '../../types/project';

export interface Pipeline {
	id: number;
	stages: string[];
}

// =============================================================================
// TRACE TYPES
// =============================================================================

/** Raw trace event as received from the server/host. */
export interface TraceEvent {
	pipelineId: number;
	op: 'begin' | 'enter' | 'leave' | 'end';
	pipes: string[];
	trace: {
		lane?: string;
		data?: Record<string, unknown>;
		result?: string;
		error?: string;
	};
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
}

// =============================================================================
// MESSAGE PROTOCOL — PER COMPONENT
// =============================================================================

/** Canvas component messages. */
export type CanvasIncoming = { type: 'canvas:update'; project: any } | { type: 'canvas:services'; services: Record<string, any> } | { type: 'canvas:validateResponse'; requestId: number; result: any; error?: string };

export type CanvasOutgoing = { type: 'canvas:contentChanged'; project: any } | { type: 'canvas:validate'; requestId: number; pipeline: any } | { type: 'canvas:requestSave' };

/** Status component messages. */
export type StatusIncoming = { type: 'status:update'; taskStatus: TaskStatus };

export type StatusOutgoing = { type: 'status:pipelineAction'; action: 'run' | 'stop' | 'restart'; source?: string };

/** Trace component messages. */
export type TraceIncoming = { type: 'trace:event'; event: TraceEvent };

export type TraceOutgoing = { type: 'trace:clear' };

/** View state — per-view UI state (mode, flowViewMode, viewport). */
export interface ViewState {
	mode: ProjectViewMode;
	flowViewMode?: 'pipeline' | 'component';
	viewport?: { x: number; y: number; zoom: number };
}

// =============================================================================
// MESSAGE PROTOCOL — COMPOSED
// =============================================================================

/** Combined load message — sets all state atomically for a document switch. */
export interface ProjectLoadMessage {
	type: 'project:load';
	project: any;
	viewState: ViewState;
	prefs: Record<string, unknown>;
	services: Record<string, any>;
	isConnected: boolean;
	statuses?: Record<string, TaskStatus>;
}

/** All messages the host can send to ProjectView. */
export type ProjectViewIncoming = CanvasIncoming | StatusIncoming | TraceIncoming | ProjectLoadMessage | { type: 'project:connectionState'; isConnected: boolean } | { type: 'project:initialState'; state: ViewState } | { type: 'project:initialPrefs'; prefs: Record<string, unknown> } | { type: 'project:themeChange'; tokens: Record<string, string> };

/** All messages ProjectView can send to the host. */
export type ProjectViewOutgoing = CanvasOutgoing | StatusOutgoing | TraceOutgoing | { type: 'project:viewStateChange'; viewState: ViewState } | { type: 'project:prefsChange'; prefs: Record<string, unknown> } | { type: 'project:requestSave' };

// =============================================================================
// VIEW TYPES
// =============================================================================

export type ProjectViewMode = 'design' | 'status' | 'tokens' | 'flow' | 'trace' | 'errors';

/** ProjectView ref handle — imperative API for the host bridge. */
export interface ProjectViewRef {
	handleMessage: (msg: ProjectViewIncoming) => void;
}

/** ProjectView props — outgoing callbacks only. All incoming data flows via ref.handleMessage. */
export interface IProjectViewProps {
	/** Send outgoing messages back to the host. */
	onMessage?: (msg: ProjectViewOutgoing) => void;
}

/** Base view props (for ServerView, WelcomeView, etc.). */
export interface IViewProps {
	isConnected: boolean;
	initialState?: Record<string, unknown>;
	onStateChange?: (state: Record<string, unknown>) => void;
}
