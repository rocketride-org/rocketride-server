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

import type { ConnectResult } from 'rocketride';

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

// =============================================================================
// WORKSPACE PREFERENCES (per-app)
// =============================================================================

/**
 * Persisted preferences for a single app instance.
 *
 * Some fields (`theme`, `sidePanelOpen`) are also written to `global.json` so
 * they survive app switches — see `useWorkspaceState.writeGlobalPrefs`.
 * The index signature allows apps to stash additional preference keys without
 * extending this interface.
 */
export interface WorkspacePrefs {
	/** ID of the currently active view or panel within the app. */
	activeView: string;
	/** ID of the currently active sidebar activity (e.g. 'explorer', 'search'). */
	activeActivity: string | null;
	/** Whether the sidebar zone is expanded. Mirrored to global.json. */
	sidePanelOpen: boolean;
	/** Current theme ID. Mirrored to global.json. */
	theme: string;
	/** Extensible — apps can store additional preference keys. */
	[key: string]: unknown;
}

// =============================================================================
// PER-APP WORKSPACE STATE
// =============================================================================

/**
 * Complete persisted state for one app.
 *
 * Written to `<workspaceDir>/<appId>.workspace.json`.  At runtime each app's
 * slice lives under `WorkspaceState.apps[appId]`.
 *
 * `prefs` holds shell-managed preferences.  `appState` is an opaque blob
 * owned entirely by the app (or the Documents component library) — the shell
 * persists it but never reads its contents.
 */
export interface AppWorkspaceState {
	/** Shell-managed preferences (theme, active view, sidebar state). */
	prefs: WorkspacePrefs;
	/** Opaque app-owned state. Used by the Documents library to persist open docs, editors, groups, etc. */
	appState: Record<string, unknown>;
}

// =============================================================================
// WORKSPACE STATE (persisted — version 3)
// =============================================================================

/**
 * Top-level workspace state shape.
 *
 * Only `activeAppId` is stored in `global.json`; individual app data lives in
 * per-app files.  The `apps` map is the in-memory union of all loaded app
 * states during a session.
 */
export interface WorkspaceState {
	version: 3;
	activeAppId: string;
	apps: Record<string, AppWorkspaceState>;
}

// =============================================================================
// APP SETTING DEFINITION
// =============================================================================

/**
 * Declares a single runtime configuration setting that an app requires.
 *
 * Declared in the app's `package.json` under `appManifest.settings` so the
 * shell can render the Settings page without loading the app bundle.  The
 * shell aggregates settings from all subscribed apps, deduplicates by `key`,
 * and persists values to `settings.json` on disk.
 */
export interface AppSettingDefinition {
	/** Key name — also used as the ShellApiConfig key (e.g. 'ROCKETRIDE_OPENAI_KEY'). */
	key: string;
	/** Human-readable label shown in the settings UI. */
	label: string;
	/** Optional description shown below the field. */
	description?: string;
	/** Default value used when the user has not configured this setting. */
	default?: string;
	/** If true and no value is set, the shell highlights this as missing. */
	required?: boolean;
	/**
	 * Field type.  Defaults to `'text'` (a regular text input).
	 *
	 * - `'text'`    — standard text / password input (default)
	 * - `'select'`  — dropdown with fixed options from the `options` array
	 * - `'service'` — dropdown populated from the cached service catalog,
	 *                  filtered by `classType`.  When selected the shell
	 *                  automatically shows a companion API-key field whose
	 *                  key follows the `ROCKETRIDE_<SUFFIX>_KEY` convention.
	 * - `'envkey'`  — text input for a raw API key, or dropdown to pick a
	 *                  server-side environment variable (from account env keys).
	 */
	type?: 'text' | 'select' | 'service' | 'envkey';
	/**
	 * Fixed options for `type: 'select'` — each entry is `{ value, label }`.
	 */
	options?: { value: string; label: string }[];
	/**
	 * Service class filter — only used when `type` is `'service'`.
	 * The dropdown is populated with services whose `classType` array
	 * includes this value (e.g. `'llm'`).
	 */
	classType?: string;
}

// =============================================================================
// APP MANIFEST ENTRY — lightweight, JSON-compatible, build-time generated
// =============================================================================

/**
 * Lightweight descriptor for an app, available at boot before the app's
 * JavaScript bundle has been loaded.
 *
 * Generated at build time from each app's `package.json` `appManifest` field.
 * The `load` function is the only non-JSON field — it is synthesised at
 * runtime by `bootstrap.tsx` to trigger the dynamic MF import.
 */
export interface AppManifestEntry {
	/** Stable unique identifier — matches the AppDescriptor id. */
	id: string;
	/**
	 * Module Federation container name.  Derived from id by replacing
	 * non-identifier characters with underscores (e.g. 'rocketride.pipeBuilder' → 'rocketride_pipeBuilder').
	 * Populated at build time by the registerApp script; not declared in package.json.
	 */
	moduleId: string;
	/** Publisher name shown in the app store (e.g. 'Aparavi Software AG'). */
	publisher?: string;
	/** Display name shown in the app switcher. */
	name: string;
	/** Short description shown in the app store. */
	description?: string;
	/** URL to the app's icon (e.g. /apps/rocket-ui/icon.svg). */
	icon?: string;
	/** Markdown description shown on the app detail card. */
	readme?: string;
	/** Categories for filtering/grouping in the app store. */
	categories?: string[];
	/** Settings required by this app. Available at boot from the manifest. */
	settings?: AppSettingDefinition[];
	/**
	 * When false, the app can run without authentication (e.g. home/landing page).
	 * Defaults to true — most apps require the user to be logged in.
	 */
	authenticated?: boolean;
	/**
	 * When false, the shell header (app name/icon bar in the sidebar) is hidden,
	 * allowing the app to render its own header. Defaults to true.
	 */
	showHeader?: boolean;
	/**
	 * When false, the status bar is hidden for this app.
	 * Defaults to true — most apps show the status bar.
	 */
	showStatusBar?: boolean;
	/** App lifecycle status: auth | free | unsubscribed | subscribed | trialing | past_due | canceled. */
	appStatus?: string;
	/** Whether this app is on the user's desktop. */
	onDesktop?: boolean;
	/** Async loader — dynamically imports and returns the full AppDescriptor. */
	load: () => Promise<AppDescriptor>;
}

// =============================================================================
// APP DESCRIPTOR — what each app plugin contributes
// =============================================================================

/**
 * Full descriptor contributed by each app plugin bundle.
 *
 * The shell stores one of these per app in `WorkspaceContext.loadedApps` once
 * the dynamic import triggered by `AppManifestEntry.load()` resolves.
 *
 * The `components` object provides the React components the shell mounts in
 * its screen zones.  The `exports` bag holds additional components that other
 * apps can load via Module Federation for cross-app composition.
 */
export interface AppDescriptor {
	/** Unique stable identifier — used as the workspace file key. */
	id: string;
	/** Display name shown in the app switcher. */
	name: string;
	/** Optional icon shown in the app switcher list. */
	icon?: React.ReactNode;
	/** Branding tokens (logo, welcome text) for the app. */
	branding: ShellBrandingConfig;
	/**
	 * Component catalog.  The shell mounts well-known components in its
	 * screen zones:
	 *
	 * - `App`     — required, mounted in the client area.
	 * - `Sidebar` — optional, mounted in the sidebar zone.  If absent the
	 *               sidebar zone is hidden for this app.
	 *
	 * Any additional components (e.g. `Canvas`, `Toolbar`) are ignored by
	 * the shell but available for cross-app loading via `useAppComponent()`.
	 */
	components: {
		App: React.ComponentType<ShellAppProps>;
		Sidebar?: React.ComponentType<ShellSidebarProps>;
		[key: string]: React.ComponentType<any> | undefined;
	};
}

// =============================================================================
// SHELL BRANDING CONFIG
// =============================================================================

/**
 * Branding tokens for a specific app or the login screen.
 *
 * All fields except `appName` are optional React nodes or strings that the
 * shell renders in designated branding slots (sidebar logo, welcome screen,
 * etc.).
 */
export interface ShellBrandingConfig {
	/** App display name used in the sidebar header and tab bar. */
	appName: string;
	/** Logo rendered in the expanded sidebar header. */
	logo?: React.ReactNode;
	/** Compact logo rendered in the collapsed sidebar header. */
	logoCollapsed?: React.ReactNode;
	/**
	 * Theme-aware icon for the sidebar header.
	 * The shell picks iconDark on dark palettes, iconLight on light palettes.
	 * Falls back to the manifest `icon` SVG, then to a 2-letter monogram.
	 */
	iconDark?: React.ReactNode;
	/** Light-palette variant of the sidebar header icon. */
	iconLight?: React.ReactNode;
	/** Single icon used when iconDark/iconLight are not provided. */
	icon?: React.ReactNode;
	/** Logo rendered on the welcome/loading screen. */
	welcomeLogo?: React.ReactNode;
	/** Title text on the welcome/loading screen. */
	welcomeTitle?: string;
	/** Subtitle text on the welcome/loading screen. */
	welcomeSubtitle?: string;
}

// =============================================================================
// SHELL THEME CONFIG
// =============================================================================

/**
 * A single theme option shown in the shell's theme picker.
 */
export interface ShellThemeOption {
	/** CSS theme bundle identifier (e.g. 'rocketride-light'). */
	id: string;
	/** Human-readable display name (e.g. 'RocketRide Light'). */
	name: string;
}

/**
 * Theme configuration supplied by the host (cloud) app.
 *
 * `options` populates the theme picker list.  `onThemeChange` is called after
 * the shell updates `prefs.theme` — used for fetching and applying theme CSS.
 */
export interface ShellThemeConfig {
	/** Ordered list of theme choices shown in the theme picker. */
	options: ShellThemeOption[];
	/** Called after shell updates prefs.theme, for fetching/applying theme CSS. */
	onThemeChange?: (themeId: string) => void;
}

// =============================================================================
// SHELL ACCOUNT CONFIG
// =============================================================================

/**
 * Account information and logout callback provided by the host shell.
 *
 * The shell uses these to populate the account overlay and wire up the logout
 * button.  All fields are optional to allow partial or deferred availability.
 */
export interface ShellAccountConfig {
	/** Display name of the authenticated user. */
	userName?: string;
	/** Email address of the authenticated user. */
	userEmail?: string;
	/** Callback to trigger the logout flow. */
	onLogout?: () => void;
}

// =============================================================================
// SHELL API CONFIG
// =============================================================================

/**
 * All runtime configuration — passed as one flat object from the host (cloud)
 * through ShellConfig into every remote app via useShellApiConfig().
 *
 * All keys are RR_* so they mirror the .env variable names exactly.
 * Remote apps never read process.env directly.
 */
export interface ShellApiConfig {
	/** Base URI for the RocketRide WebSocket server. */
	ROCKETRIDE_URI?: string;
	/** Hard-coded API key for service accounts / dev; bypasses OAuth2 when present. */
	RR_APIKEY?: string;
	/** Stripe publishable key — required for Stripe Elements checkout. */
	RR_STRIPE_PUBLISHABLE_KEY?: string;
	/** Zitadel instance base URL — required for PKCE OAuth login. */
	RR_ZITADEL_URL?: string;
	/** Zitadel application client ID — required for PKCE OAuth login. */
	RR_ZITADEL_CLIENT_ID?: string;
	/** Additional runtime settings loaded from .workspace/settings.json. */
	[key: string]: string | undefined;
}

// =============================================================================
// SHELL CONFIG
// =============================================================================

/**
 * Root configuration object passed to `<ShellApp>` by the cloud host.
 *
 * This is the primary integration point: the host assembles one `ShellConfig`
 * and hands it to the shell.  The shell never imports from the host directly —
 * all host-specific behaviour is injected through this object.
 */
export interface ShellConfig {
	/** App registry — loaded lazily when each app is first activated. */
	apps: AppManifestEntry[];
	/** Server capability tags: ['oss'] for open-source, ['saas'] for cloud. */
	capabilities?: string[];
	/** All RR_* runtime config — passed through to remote apps via useShellApiConfig(). */
	apiConfig: ShellApiConfig;
	/** Branding shown on the loading screen before any app is mounted. */
	loginBranding?: {
		appName?: string;
		logo?: React.ReactNode;
		welcomeTitle?: string;
		welcomeSubtitle?: string;
	};
	/** Theme picker options and change callback. */
	themeConfig: ShellThemeConfig;
	/** Authenticated user info and logout callback. */
	account: ShellAccountConfig;
	/** Directory for workspace state files. Default: ".workspace". */
	workspaceDir?: string;
	/** Called once on mount before auth — use for initial theme application etc. */
	onInit?: () => void;
}
