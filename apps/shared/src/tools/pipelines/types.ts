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

// SDK-native names, aliased to this module's public vocabulary. Importing
// them from 'rocketride' (not the 'shell' barrel) keeps this module pure:
// the VS Code extension host compiles it under Node16, and the SDK's d.ts
// surface is digestible there while the shell's UI source is not.
export type { TASK_STATUS as TaskStatus } from 'rocketride';
export type { TASK_STATUS_FLOW as FlowData } from 'rocketride';
export { TASK_STATE } from 'rocketride';

// =============================================================================
// TRACE TYPES — owned by the trace COMPONENT; re-exported here so existing
// pipeline consumers keep their import path.
// =============================================================================

// Deep import ON PURPOSE — the trace barrel is index.tsx and this file is
// compiled by the VS Code EXTENSION HOST (no --jsx). types.ts is a pure leaf.
export type { TraceEvent, TraceRow, TraceLevel } from 'shared/components/trace/types';

// =============================================================================
// VIEW TYPES
// =============================================================================

/** View state — per-view UI state (mode, flowViewMode, viewport). */
/**
 * The workspace partition the pipeline editor owns. It is a built-in TOOL, so
 * its state lives in the tool's own partition — not in the shell bag, and not
 * in the bag of whatever pipeline happens to be open. Both halves are used:
 *
 *   prefs    — the cloud-prompt dismissal. The ONE genuine preference here:
 *              "Don't show again" means never, anywhere.
 *   appState — per-DOCUMENT view state, keyed by document URI (page, flow
 *              view, viewport, toolbar position, navigation mode, canvas
 *              layout). Moving the toolbar in one pipeline must not move it
 *              in all of them, which makes these view state, not prefs.
 */
export const PIPELINE_PARTITION = 'app:rocketride.pipeBuilder';

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
