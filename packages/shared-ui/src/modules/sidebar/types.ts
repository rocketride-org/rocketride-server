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
import type { ExplorerFileAction } from '../explorer/types';

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
	/** Full relative path (e.g. 'ingest/analyze.pipe' or 'ingest/dir1'). */
	path: string;
	/** Entry type — 'file' (default) or 'dir'. Dirs are only needed when the
	 *  host supports file management (rocket-ui); VS Code omits them. */
	type?: 'file' | 'dir';
	/** Project UUID parsed from the .pipe JSON (files only). */
	projectId?: string;
	/** Source components parsed from the .pipe JSON (files only). */
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
// APP BUILDER SIDEBAR (MY APPS)
// =============================================================================

/** One MY APPS row in the App Builder sidebar mode. */
export interface AppListItem {
	/** App id (the appManifest.id binding key, e.g. 'acme.brandy'). */
	id: string;
	/** Display name. */
	name: string;
	/**
	 * Lifecycle badge state: 'local' = bound folder with no server record,
	 * 'dev' = live dev-overlay entry, then the marketplace lifecycle
	 * ('pending' renders as "in review"; 'live' = approved with an active
	 * public version).
	 */
	status: 'local' | 'dev' | 'draft' | 'pending' | 'approved' | 'rejected' | 'live';
	/** Bound workspace folder (VSCode hosts; absent for server-only rows). */
	folder?: string;
}

/**
 * App Builder sidebar content. PRESENCE of this prop enables the
 * `Pipelines | Apps` mode tabs in the sidebar; hosts that omit it (or
 * pre-App-Builder hosts) render exactly as before.
 */
export interface AppBuilderSidebar {
	/** Merged MY APPS list (workspace scan ∪ server list_mine, by id). */
	apps: AppListItem[];
	/** The app whose App Builder screen is open/focused, if any. */
	activeAppId?: string;
	/** Create a new app (runs the scaffolder / new-app flow). */
	onNewApp: () => void;
	/** Open an app's App Builder screen. */
	onOpenApp: (appId: string) => void;
}

// =============================================================================
// SIDEBAR MODE
// =============================================================================

/**
 * The sidebar's mode tabs. 'apps' exists only when the host wires the app
 * builder; 'nodes' is the node-builder placeholder shown whenever the mode
 * tabs render.
 */
export type SidebarMode = 'pipelines' | 'apps' | 'nodes';

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

export interface ISidebarViewProps {
	// ── Connection ──────────────────────────────────────────────────────────
	connection: ConnectionInfo;

	/** Whether the user has an active subscription. When false, run/stop icons are hidden. */
	isSubscribed?: boolean;

	// ── File tree ───────────────────────────────────────────────────────────
	/** Flat array of all .pipe files (host-provided). */
	entries: ProjectEntry[];

	// ── Runtime state ───────────────────────────────────────────────────────
	/** Task state keyed by 'projectId.sourceId'. */
	activeTasks: Map<string, ActiveTaskState>;
	/** Server tasks with no matching local .pipe file. */
	unknownTasks?: UnknownTask[];

	// ── Capabilities ────────────────────────────────────────────────────────
	/**
	 * Host-injected content rendered at the TOP of the shared nav section
	 * (above "Monitor" and the mode tabs). Renders nothing — and adds no
	 * spacing — when omitted.
	 * Hosts use this for host-specific nav (e.g. rocket-ui's "Home" button which
	 * switches to the home app). The shared component intentionally knows nothing
	 * about home/dashboard routing, keeping SaaS-shell concepts out of the
	 * VS Code extension bundle.
	 */
	headerSlot?: ReactNode;

	// ── Actions ─────────────────────────────────────────────────────────────
	onNavigate: (target: 'new' | 'monitor' | 'deploy' | 'templates') => void;
	/** Open a file in the editor. */
	onOpenFile: (path: string) => void;
	/**
	 * File management callback — optional.  When provided, enables context
	 * menus (rename/delete), inline rename, inline create, and new file/folder
	 * header buttons.  When absent, the sidebar is display-only.
	 */
	onFileManage?: (action: 'rename' | 'delete' | 'createFolder' | 'createFile', path: string, newName?: string) => void;
	/**
	 * Host-injected extra kebab-menu actions per file row (e.g. Export).
	 * Forwarded to the Explorer. Omitted hosts (VS Code) show none.
	 */
	fileActions?: ExplorerFileAction[];
	onSourceAction: (action: 'run' | 'stop', filePath: string, sourceId: string, projectId?: string) => void;
	onRefresh: () => void;

	// ── Footer ──────────────────────────────────────────────────────────────
	/** Host-provided footer content (e.g. SidebarFooter). */
	footerSlot?: ReactNode;

	// ── Unknown task action ─────────────────────────────────────────────────
	/** Called when the user clicks an unknown task. Opens a status-only view. */
	onOpenUnknownTask?: (projectId: string, sourceId: string, displayName: string) => void;

	// ── Tree UI ─────────────────────────────────────────────────────────────
	/** Currently open file path (for active highlight). */
	activeFilePath?: string;

	// ── App Builder mode ────────────────────────────────────────────────────
	/**
	 * App Builder sidebar content — presence adds the Apps tab to the mode
	 * tabs and enables the MY APPS mode. Omitted → Pipelines only.
	 */
	appBuilder?: AppBuilderSidebar;
	/**
	 * Force the mode tabs visible even with only the Pipelines tab (the web
	 * host: more modes — the node builder — will land on that strip).
	 */
	showModeStrip?: boolean;
	/** Active sidebar mode when the tabs are shown. Defaults to 'pipelines'. */
	sidebarMode?: SidebarMode;
	/** Mode tab selection callback (hosts persist the choice). */
	onSidebarModeChange?: (mode: SidebarMode) => void;
}
