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
// TOOLS/CORE/CHROME — strip + tool-tab types
// =============================================================================
//
// The chrome's mode/tab contracts (moved from modules/sidebar).

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
	 *
	 * `null` means the host has NO ANSWER yet (fetch in flight, or no
	 * connected server to ask) and the panel renders "Loading tools…": an
	 * empty array would otherwise claim this server publishes none, which is
	 * wrong at exactly the moment the sidebar first opens. Hosts whose
	 * catalog is synchronous always pass an array.
	 */
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
	 * Builtin tools listed in the Dev Tools panel with an Enable/Disable
	 * toggle (they are resident — never installed or removed). Hosts omit
	 * this to hide the section.
	 */
	builtins?: { id: string; name: string; description?: string; enabled: boolean }[];
	/** Flips one builtin tool's enabled state. */
	onToggleBuiltin?: (id: string, enabled: boolean) => void;
	/**
	 * The Dev Tools panel's RESET: re-fetch the app registry (manifests,
	 * versions) from the server and reload every already-loaded tool —
	 * the recovery action after publishing a new tool version, which a
	 * live MF realm cannot pick up by itself. Hosts without the capability
	 * omit this and the panel shows no Refresh affordance.
	 */
	onRefreshTools?: () => void;
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

