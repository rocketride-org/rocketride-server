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



// =============================================================================
// TOOLS/APPDEV — sidebar data types
// =============================================================================
//
// The App Builder tool's MY APPS shapes (moved from modules/sidebar).

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
