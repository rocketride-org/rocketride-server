// =============================================================================
// Workspace State
// =============================================================================

import type { PipelineConfig } from 'shell';
import type { ViewItem } from './tabs';
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
	views: ViewItem[];
	layouts: Record<string, DocumentLayout>;
	prefs: WorkspacePrefs;
}
