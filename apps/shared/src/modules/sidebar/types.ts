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

/**
 * One MY APPS row in the App Builder sidebar mode. Every row is a
 * `.rrapp`-bound working copy found on disk — the list carries no server
 * lifecycle state.
 */
export interface AppListItem {
	/** App id (the appManifest.id binding key, e.g. 'acme.brandy'). */
	id: string;
	/** Display name. */
	name: string;
	/**
	 * Icon URL for the row, already resolved by the host to something the
	 * view can load directly (a data: URI in the VSCode webview; a served
	 * URL on web hosts). Rows without one render the generic app glyph.
	 */
	iconUrl?: string;
	/** Bound workspace folder. */
	folder?: string;
}

/**
 * App Builder sidebar content. PRESENCE of this prop enables the
 * `Pipelines | Apps` mode tabs in the sidebar; hosts that omit it (or
 * pre-App-Builder hosts) render exactly as before.
 */
export interface AppBuilderSidebar {
	/** MY APPS list built from the workspace scan ALONE — one row per
	 *  `.rrapp`-bound working copy on disk. The server catalog is deliberately
	 *  not merged in: the sidebar lists what you can open and edit locally. */
	apps: AppListItem[];
	/** The app whose App Builder screen is open/focused, if any. */
	activeAppId?: string;
	/** Create a new app (runs the scaffolder / new-app flow). */
	onNewApp: () => void;
	/** Open an app's App Builder screen. */
	onOpenApp: (appId: string) => void;
}

/**
 * One agent-session row of the MY SESSIONS list (mirrors the shared
 * AgentSessionMeta shape without importing the agent module — the sidebar
 * renders whatever rows the host supplies).
 */
export interface AgentSessionListItem {
	/** The session's GUID. */
	sessionId: string;
	/** Epoch-ms creation stamp (list is rendered newest-first). */
	date: number;
	/** Display title — the first user request, truncated. */
	title: string;
}

/**
 * Agent sidebar content. PRESENCE of this prop adds the `Agent` mode tab
 * (cloud hosts); hosts that omit it (VS Code) render exactly as before.
 */
export interface AgentSidebar {
	/** MY SESSIONS list, newest first. */
	sessions: AgentSessionListItem[];
	/** The session whose conversation tab is open/focused, if any. */
	activeSessionId?: string;
	/** Start a brand-new session (opens an empty conversation tab). */
	onNewSession: () => void;
	/** Open a session's conversation tab. */
	onOpenSession: (sessionId: string) => void;
	/** Delete a session (host confirms first). */
	onDeleteSession: (sessionId: string) => void;
}

// =============================================================================
// SIDEBAR MODE
// =============================================================================

/**
 * The sidebar's mode tabs. 'agent' exists only when the host wires the
 * agent sidebar; 'apps' only when the host wires the app builder; 'nodes'
 * is the node-builder placeholder shown whenever the mode tabs render.
 */
export type SidebarMode = 'agent' | 'pipelines' | 'apps' | 'nodes' | 'toolStore' | `tool:${string}`;

// =============================================================================
// DEV-TOOL TABS
// =============================================================================

/** One pinned dev tool shown as an icon tab on the mode strip. */
export interface ToolTab {
	/** The tool's app id. */
	id: string;
	/** Display name (the icon tab's tooltip, the panel heading). */
	name: string;
	/** Absolute icon URL for the tab glyph (host-resolved). */
	iconUrl?: string;
	/** Display version for the tool panel. */
	version?: string;
	/** Short description (the modules list's second line). */
	description?: string;
	/** Module Federation container name — set when the host mounts the tool's devToolSidebar. */
	moduleId?: string;
	/** Registry version resolving the remote entry URL. */
	registryVersion?: number;
}

/**
 * Dev-tool tabs capability — presence adds the pinned tools as icon tabs on
 * the mode strip plus a trailing "+" that opens the host's tool picker.
 */
export interface ToolTabsSidebar {
	/** Pinned (installed) tools, in tab order. */
	tools: ToolTab[];
	/**
	 * The full dev-tool catalog (installed or not) — the modules button's
	 * list body, VS Code extensions-view style. Installed state is derived
	 * from membership in `tools`.
	 */
	available: ToolTab[];
	/** Opens (or focuses) the tool's frame in the host's editor area. */
	onOpenTool: (id: string) => void;
	/**
	 * Brings an ALREADY-OPEN window of the tool forward, creating nothing —
	 * the strip-tab selection action. Selecting a tab switches the sidebar
	 * body; it must not spawn editor windows. Hosts that cannot tell the two
	 * apart omit this and the strip falls back to `onOpenTool`.
	 */
	onFocusTool?: (id: string) => void;
	/** Opens the tool's details page (README + Install/Remove) — a modules-list row click. */
	onShowTool: (id: string) => void;
	/** Unpins a tool (removes its tab). */
	onRemoveTool: (id: string) => void;
	/**
	 * Replaces the built-in tool panel (icon/name/version/Open/Remove) with
	 * host-rendered content — the slot where a devToolSidebar mounts.
	 */
	renderToolPanel?: (id: string) => ReactNode;
}

// =============================================================================
// CONNECTION STATE
// =============================================================================

export interface ConnectionInfo {
	state: 'connected' | 'connecting' | 'disconnected';
	mode?: string;
}

