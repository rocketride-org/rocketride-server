// =============================================================================
// Workspace State
// =============================================================================

import type { PipelineConfig } from 'shell';
import type { ViewState } from 'shared/modules/project';

// Re-export ViewState from shared — single source of truth
export type { ViewState };

// =============================================================================
// DOCUMENT STATE
// =============================================================================

export interface DocumentState {
	dirty: boolean;
	/** True until first save to disk. */
	isNew: boolean;
	/** File name on disk (e.g. "my-chat" or "ingest/pipe1"). Always set — "Untitled-1" for unsaved. Drives tab label. */
	filename: string;
	pipeline: PipelineConfig;
}

// =============================================================================
// DOCUMENT LAYOUT (per-document defaults for new views)
// =============================================================================

export type DocumentLayout = Partial<ViewState>;

// =============================================================================
// WORKSPACE PREFERENCES
// =============================================================================

export interface WorkspacePrefs {
	activeView: string;
	activeActivity: string | null;
	sidePanelOpen: boolean;
	bottomPanelOpen: boolean;
	chatOpen: boolean;
	theme: string;
	[key: string]: unknown;
}

// =============================================================================
// WORKSPACE STATE
// =============================================================================

export interface WorkspaceState {
	version: 1;
	documents: Record<string, DocumentState>;
	/** Legacy persisted tab entries — their `./tabs` ViewItem type died with
	 * the ViewNav-era refactor and nothing reads the field anymore; it
	 * survives untyped so stored version-1 state stays parseable. */
	views: unknown[];
	layouts: Record<string, DocumentLayout>;
	prefs: WorkspacePrefs;
}
