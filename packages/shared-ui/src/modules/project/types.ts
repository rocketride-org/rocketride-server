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
// MESSAGE PROTOCOL — PER COMPONENT
// =============================================================================

/** Canvas component messages (project:* naming). */
export type CanvasIncoming = { type: 'project:update'; project: any } | { type: 'project:services'; services: Record<string, any> } | { type: 'project:validateResponse'; requestId: number; result: any; error?: string };

export type CanvasOutgoing = { type: 'project:contentChanged'; project: any } | { type: 'project:validate'; requestId: number; pipeline: any } | { type: 'project:requestSave' };

/** Status component messages. */
export type StatusOutgoing = { type: 'status:pipelineAction'; action: 'run' | 'stop' | 'restart'; source?: string };

/** Trace component messages. */
export type TraceOutgoing = { type: 'trace:clear' };

/** Raw server event — ProjectView filters apaevt_status_update and apaevt_flow. */
export type ServerEventIncoming = { type: 'server:event'; event: unknown };

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
	statuses?: Record<string, import('../../types/project').ITaskStatus>;
	/** Server host URL for {host} placeholder replacement in endpoint URLs. */
	serverHost?: string;
}

/** All messages the host can send to ProjectView. */
export type ProjectViewIncoming = CanvasIncoming | ServerEventIncoming | ProjectLoadMessage | { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean } | { type: 'shell:viewActivated'; viewId: string } | { type: 'project:initialState'; state: ViewState } | { type: 'project:initialPrefs'; prefs: Record<string, unknown> } | { type: 'project:dirtyState'; isDirty: boolean; isNew: boolean };

/** All messages ProjectView can send to the host. */
export type ProjectViewOutgoing = CanvasOutgoing | StatusOutgoing | TraceOutgoing | { type: 'project:viewStateChange'; viewState: ViewState } | { type: 'project:prefsChange'; prefs: Record<string, unknown> } | { type: 'project:openLink'; url: string; displayName?: string } | { type: 'view:initialized' };

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
