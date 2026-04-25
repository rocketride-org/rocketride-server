// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sidebar types — shared between VS Code webview and rocket-ui hosts.
 *
 * The host builds a flat array of ProjectEntry (one per .pipe file) and
 * passes it into <SidebarMain>.  The component derives the directory
 * hierarchy on the fly via path parsing (S3-style).
 */

import type { ReactNode } from 'react';

// =============================================================================
// DATA TYPES
// =============================================================================

/** A parsed source component inside a pipeline file. */
export interface ProjectSource {
	/** Component ID (e.g. 'chat_1'). */
	id: string;
	/** Human-readable name (e.g. 'Chat'). */
	name: string;
	/** Provider type (e.g. 'chat', 'webhook'). */
	provider?: string;
}

/**
 * A pipeline file entry — stored in a flat array, hierarchy derived from path.
 *
 * The host is responsible for finding all .pipe files and reading each one
 * to extract projectId and sources before passing them here.
 */
export interface ProjectEntry {
	/** Full relative path (e.g. 'ingest/analyze.pipe'). */
	path: string;
	/** Project UUID parsed from the .pipe JSON. */
	projectId?: string;
	/** Source components parsed from the .pipe JSON. */
	sources?: ProjectSource[];
}

/** Synthesized directory node — returned by getChildren, never stored. */
export interface DirEntry {
	/** Directory name (e.g. 'ingest'). */
	name: string;
	/** Full directory path (e.g. 'ingest/dir1'). */
	path: string;
	/** Always 'dir'. */
	type: 'dir';
}

/** Runtime state for a single source (keyed by 'projectId.sourceId'). */
export interface ActiveTaskState {
	running: boolean;
	errors: string[];
	warnings: string[];
}

/** An unknown task running on the server with no local .pipe file. */
export interface UnknownTask {
	projectId: string;
	sourceId: string;
	displayName: string;
	projectLabel: string;
}

// =============================================================================
// CONNECTION STATE
// =============================================================================

export interface ConnectionInfo {
	state: 'connected' | 'connecting' | 'disconnected';
	mode?: string;
}

// =============================================================================
// COMPONENT PROPS
// =============================================================================

export interface ISidebarMainProps {
	// ── Connection ──────────────────────────────────────────────────────────
	connection: ConnectionInfo;

	// ── File tree ───────────────────────────────────────────────────────────
	/** Flat array of all .pipe files (host-provided). */
	entries: ProjectEntry[];

	// ── Runtime state ───────────────────────────────────────────────────────
	/** Task state keyed by 'projectId.sourceId'. */
	activeTasks: Map<string, ActiveTaskState>;
	/** Server tasks with no matching local .pipe file. */
	unknownTasks?: UnknownTask[];

	// ── Actions (consolidated) ──────────────────────────────────────────────
	onNavigate: (target: 'new' | 'monitor' | 'deploy' | 'templates') => void;
	onFileAction: (action: 'open' | 'rename' | 'delete' | 'createFolder', path: string) => void;
	onSourceAction: (action: 'run' | 'stop', filePath: string, sourceId: string, projectId?: string) => void;
	onRefresh: () => void;

	// ── Footer ──────────────────────────────────────────────────────────────
	onOpenSettings?: () => void;
	onOpenDocs?: () => void;
	onToggleConnection?: () => void;
	/** Host-specific footer content (AccountButton in rocket-ui, ConnectionStatus in VS Code). */
	footerSlot?: ReactNode;

	// ── Tree UI ─────────────────────────────────────────────────────────────
	/** Currently open file path (for active highlight). */
	activeFilePath?: string;
}
