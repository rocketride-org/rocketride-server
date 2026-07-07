// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// APP SDK TYPES
// =============================================================================
//
// Type definitions for the RocketRide shell-ui app plugin system.
//
// These mirror shell-ui/src/workspace/types.ts so that third-party apps can
// import them from `rocketride/app-sdk` without depending on the shell-ui
// monorepo package.  At runtime, Module Federation replaces stub implementations
// with the real singletons from the shell host.
// =============================================================================

import type * as React from 'react';

// =============================================================================
// SHELL COMPONENT PROP CONTRACTS
// =============================================================================

/**
 * Props injected by the shell into the app's main `<App />` component.
 *
 * The shell passes connection and identity state so the app can react to
 * auth and connectivity changes without subscribing to the event bus.
 */
export interface ShellAppProps {
	/** Whether the RocketRide WebSocket is currently connected. */
	isConnected: boolean;
	/** Authenticated user identity, or null when not logged in. */
	identity: ConnectResult | null;
}

/**
 * Props injected by the shell into the app's `<Sidebar />` component.
 *
 * The sidebar zone is collapsible; apps should hide or simplify their
 * sidebar content when `collapsed` is true.
 */
export interface ShellSidebarProps {
	/** True when the sidebar is in collapsed (icon-only) mode. */
	collapsed: boolean;
}

/**
 * Authenticated user identity returned by the RocketRide server after
 * a successful connection.  Includes profile, org, and subscription info.
 */
export interface ConnectResult {
	/** User token for subsequent requests. */
	userToken?: string;
	/** User's display name. */
	displayName?: string;
	/** User's email address. */
	email?: string;
	/** User's unique ID. */
	userId?: string;
	/** Organizations the user belongs to. */
	organizations?: { id: string; name: string }[];
	/** Apps on the user's desktop — full manifest entries with appStatus + onDesktop. */
	apps?: { id: string; moduleId: string; name: string; entry: string; appStatus?: string; onDesktop?: boolean; [key: string]: unknown }[];
	/** Open-ended additional fields. */
	[key: string]: unknown;
}

// =============================================================================
// WORKSPACE PREFERENCES
// =============================================================================

/**
 * Persisted preferences for a single app instance.
 *
 * Some fields (theme, sidePanelOpen) are mirrored to global.json so they
 * survive app switches.  The index signature allows apps to stash
 * additional preference keys.
 */
export interface WorkspacePrefs {
	/** ID of the currently active view or panel within the app. */
	activeView: string;
	/** ID of the currently active sidebar activity. */
	activeActivity: string | null;
	/** Whether the sidebar zone is expanded. */
	sidePanelOpen: boolean;
	/** Current theme ID. */
	theme: string;
	/** Extensible — apps can store additional preference keys. */
	[key: string]: unknown;
}

// =============================================================================
// APP SETTING DEFINITION
// =============================================================================

/**
 * Declares a single runtime configuration setting that an app requires.
 *
 * Declared in the app's `package.json` under `appManifest.settings` so the
 * shell can render the Settings page without loading the app bundle.
 */
export interface AppSettingDefinition {
	/** Key name — also used as the ShellApiConfig key. */
	key: string;
	/** Human-readable label shown in the settings UI. */
	label: string;
	/** Optional description shown below the field. */
	description?: string;
	/** Default value when the user has not configured this setting. */
	default?: string;
	/** If true and no value is set, the shell highlights this as missing. */
	required?: boolean;
}

// =============================================================================
// APP MANIFEST ENTRY
// =============================================================================

/**
 * Lightweight descriptor for an app, available at boot before the app's
 * JavaScript bundle has been loaded.
 *
 * Generated at build time from each app's `package.json` `appManifest` field.
 */
export interface AppManifestEntry {
	/** Stable unique identifier (e.g. 'rocketride.myApp'). */
	id: string;
	/** Module Federation container name (derived from id). */
	moduleId: string;
	/** Publisher name shown in the app store. */
	publisher?: string;
	/** Display name shown in the app switcher. */
	name: string;
	/** Short description shown in the app store. */
	description?: string;
	/** URL to the app's icon. */
	icon?: string;
	/** Markdown description for the app detail page. */
	readme?: string;
	/** Categories for filtering/grouping in the app store. */
	categories?: string[];
	/** Settings required by this app. */
	settings?: AppSettingDefinition[];
	/** When false, the app runs without authentication. Default: true. */
	authenticated?: boolean;
	/** When false, the status bar is hidden for this app. Default: true. */
	statusBar?: boolean;
	/** Async loader — dynamically imports and returns the full AppDescriptor. */
	load: () => Promise<AppDescriptor>;
}

// =============================================================================
// APP DESCRIPTOR
// =============================================================================

/**
 * Branding tokens for a specific app shown in the shell.
 */
export interface ShellBrandingConfig {
	/** App display name used in the sidebar header. */
	appName: string;
	/** Logo rendered in the expanded sidebar header. */
	logo?: React.ReactNode;
	/** Compact logo rendered in the collapsed sidebar header. */
	logoCollapsed?: React.ReactNode;
	/** Logo rendered on the welcome/loading screen. */
	welcomeLogo?: React.ReactNode;
	/** Title text on the welcome/loading screen. */
	welcomeTitle?: string;
	/** Subtitle text on the welcome/loading screen. */
	welcomeSubtitle?: string;
}

/**
 * Full descriptor contributed by each app plugin bundle.
 *
 * The shell stores one of these per app once the dynamic import triggered
 * by `AppManifestEntry.load()` resolves.
 *
 * The `components` object provides React components the shell mounts in
 * its screen zones.  `App` and `Sidebar` are well-known; any additional
 * keys are available for cross-app loading via `useAppComponent()`.
 */
export interface AppDescriptor {
	/** Unique stable identifier — must match the manifest id. */
	id: string;
	/** Display name shown in the app switcher. */
	name: string;
	/** Optional icon shown in the app switcher list. */
	icon?: React.ReactNode;
	/** Branding tokens (logo, welcome text) for the app. */
	branding: ShellBrandingConfig;
	/**
	 * Component catalog.
	 *
	 * - `App`     — required, mounted in the client area.
	 * - `Sidebar` — optional, mounted in the sidebar zone.
	 *               If absent the sidebar zone is hidden.
	 * - Any other keys — available for cross-app loading.
	 */
	components: {
		App: React.ComponentType<ShellAppProps>;
		Sidebar?: React.ComponentType<ShellSidebarProps>;
		[key: string]: React.ComponentType<any> | undefined;
	};
}

// =============================================================================
// SHELL THEME CONFIG
// =============================================================================

/** A single theme option shown in the shell's theme picker. */
export interface ShellThemeOption {
	/** CSS theme bundle identifier (e.g. 'rocketride-light'). */
	id: string;
	/** Human-readable display name. */
	name: string;
}

/** Theme configuration supplied by the host app. */
export interface ShellThemeConfig {
	/** Ordered list of theme choices. */
	options: ShellThemeOption[];
	/** Called after the shell updates prefs.theme. */
	onThemeChange?: (themeId: string) => void;
}

// =============================================================================
// SHELL API CONFIG
// =============================================================================

/**
 * All runtime configuration — passed from the host through the shell
 * into every remote app via useShellApiConfig().
 *
 * Keys are RR_* format so they mirror the .env variable names exactly.
 * Remote apps never read process.env directly.
 */
export interface ShellApiConfig {
	/** Base URI for the RocketRide WebSocket server. */
	ROCKETRIDE_URI?: string;
	/** Hard-coded API key for dev; bypasses OAuth2 when present. */
	RR_APIKEY?: string;
	/** Stripe publishable key. */
	RR_STRIPE_PUBLISHABLE_KEY?: string;
	/** Zitadel instance base URL for PKCE OAuth login. */
	RR_ZITADEL_URL?: string;
	/** Zitadel application client ID. */
	RR_ZITADEL_CLIENT_ID?: string;
	/** Additional runtime settings from .workspace/settings.json. */
	[key: string]: string | undefined;
}

// =============================================================================
// WORKSPACE CONTEXT
// =============================================================================

/**
 * Context object returned by useWorkspace().
 *
 * Provides access to workspace state, preferences, settings, the app
 * manifest, and the event bus.
 */
export interface IWorkspaceContext {
	/** True once the initial workspace load from disk has completed. */
	loaded: boolean;
	/** True while the active app's descriptor is being dynamically loaded. */
	appLoading: boolean;
	/** The active app's preferences. */
	prefs: WorkspacePrefs;
	/** Opaque app-owned state (used by Documents library). */
	appState: Record<string, unknown>;
	/** Update the opaque app-owned state via a functional updater. */
	updateAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
	/** ID of the currently active app. */
	activeAppId: string;
	/** Lightweight manifest entries for all apps. */
	appManifest: AppManifestEntry[];
	/** Fully loaded AppDescriptors, keyed by appId. */
	loadedApps: Record<string, AppDescriptor>;
	/** Persisted settings keyed by setting key. */
	settings: Record<string, string>;
	/** Persist a single setting value. */
	updateSetting: (key: string, value: string) => void;
	/** Update the active app's workspace preferences. */
	updatePrefs: (patch: Partial<WorkspacePrefs>) => void;
	/** @deprecated Use `updatePrefs` for prefs, `connectionManager.emit('shell:switchApp')` for app switches. */
	dispatch: (action: { type: string; [key: string]: unknown }) => void;
	/** Emit a named event to all subscribers. */
	emit: (event: string, payload: any) => void;
	/** Subscribe to a named event. Returns an unsubscribe function. */
	on: (event: string, handler: (payload: any) => void) => () => void;
}


// =============================================================================
// VIRTUAL FILE SYSTEM
// =============================================================================

/**
 * Virtual file system interface — the single abstraction for all file I/O.
 *
 * Created by the hosting container and passed to both the Documents
 * singleton and the Explorer component.
 */
export interface IVirtualFileSystem {
	/** Lists the contents of a directory. */
	list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]>;
	/** Reads file content. Returns any serializable value. */
	read(path: string): Promise<unknown>;
	/** Writes content to a file. */
	write(path: string, content: unknown): Promise<void>;
	/** Renames a file or directory. */
	rename(oldPath: string, newPath: string): Promise<void>;
	/** Deletes a file or directory. */
	delete(path: string): Promise<void>;
	/** Creates a directory. */
	mkdir(path: string): Promise<void>;
}

// =============================================================================
// DOCUMENTS MODEL
// =============================================================================

/** A single open document. One per URI. Content held in memory. */
export interface Document {
	/** Unique file path / identifier. */
	uri: string;
	/** In-memory content — any serializable value, stored and returned as-is. */
	content: unknown;
	/** True if the document has unsaved changes. */
	dirty: boolean;
	/** Monotonically increasing version counter. */
	version: number;
	/** Number of editors currently viewing this document. */
	editorCount: number;
	/** True if the document has never been saved to disk. */
	isNew: boolean;
}

/** An editor — a view onto a Document with independent viewport state. */
export interface Editor {
	/** Unique editor instance ID. */
	id: string;
	/** URI of the document this editor views. */
	documentUri: string;
	/** Scroll position (pixels from top). */
	scrollTop: number;
	/** Scroll position (pixels from left). */
	scrollLeft: number;
	/** Cursor line number (1-based). */
	cursorLine: number;
	/** Cursor column number (1-based). */
	cursorColumn: number;
	/** Display label for the tab. */
	label: string;
}

/** Split orientation for editor groups. */
export type SplitOrientation = 'horizontal' | 'vertical';

/** An editor group — a pane container holding ordered editors. */
export interface EditorGroup {
	/** Unique group ID. */
	id: string;
	/** Ordered list of editor IDs in this group. */
	editorIds: string[];
	/** Index of the currently active editor. */
	activeEditorIndex: number;
	/** Split orientation relative to sibling groups. */
	orientation: SplitOrientation;
	/** Relative size as a flex ratio. */
	size: number;
}

/** Complete documents model state. */
export interface DocumentsState {
	/** All open documents keyed by URI. */
	documents: Record<string, Document>;
	/** All editor instances keyed by editor ID. */
	editors: Record<string, Editor>;
	/** All editor groups keyed by group ID. */
	groups: Record<string, EditorGroup>;
	/** Ordered list of group IDs defining the layout order. */
	groupOrder: string[];
	/** ID of the currently focused group. */
	activeGroupId: string;
}

// =============================================================================
// SHELL EVENT MAP
// =============================================================================

/**
 * Typed map of all shell event names to their payload shapes.
 *
 * Augment via module declaration merging to add app-specific events:
 *
 * ```ts
 * declare module 'rocketride/app-sdk' {
 *   interface ShellEventMap {
 *     'myapp:dataUpdated': { recordId: string };
 *   }
 * }
 * ```
 */
/**
 * Plan payload for the `shell:subscribe` event. Mirrors the `AppPrice` row from
 * the `app_prices` table (see the client billing types) so the preselected-plan
 * checkout flow is type-checked end to end rather than passing an opaque value.
 */
export interface CheckoutPlan {
	/** Internal price UUID. */
	id: string;
	/** App identifier. */
	appId: string;
	/** Stripe price_* identifier. */
	stripePriceId: string;
	/** Human-readable tier label (e.g. "Starter", "Pro"). */
	nickname: string;
	/** Price in smallest currency unit (e.g. cents for USD). */
	amountCents: number;
	/** ISO 4217 currency code. */
	currency: string;
	/** Billing interval. */
	interval: 'month' | 'year' | 'one_time' | '';
	/** Full plan metadata (description, action, order, kind, credits, etc.). */
	metadata?: Record<string, unknown> | null;
	/** Whether the price is active. */
	isActive: boolean;
	/** ISO 8601 creation timestamp. */
	createdAt: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ShellEventMap {
	'shell:connected': Record<string, never>;
	'shell:disconnected': { reason: string; hasError: boolean };
	'shell:login': { user: ConnectResult };
	'shell:logout': Record<string, never>;
	'shell:loginRequest': { appId?: string };
	'shell:logoutRequest': Record<string, never>;
	'shell:switchApp': { appId: string };
	'shell:subscribe': { app: AppManifestEntry; plan?: CheckoutPlan };
	'shell:myApps': Record<string, never>;
	'shell:accountUpdate': ConnectResult;
	'shell:sidebarCollapsing': Record<string, never>;
	'shell:themeChange': { tokens: Record<string, string> };
	'shell:statusChange': { message: string | null };
	'shell:event': { event: unknown };
}
