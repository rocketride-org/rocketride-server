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
// SETTING SCHEMA — VSCode contributes.configuration compatible
// =============================================================================

/** Value types a setting may hold — mirrors the JSON primitive types. */
export type SettingValue = string | number | boolean;

/**
 * JSON-Schema-style declaration of a single setting.
 *
 * The shape is 100% format-compatible with a property entry in the VSCode
 * extension specification's `contributes.configuration` section, so anyone who
 * has written a VSCode extension already knows how to declare a RocketRide
 * setting.  RocketRide-specific editors are expressed through the JSON-Schema
 * `format` keyword (unknown formats are legal JSON Schema), keeping the
 * structural compatibility intact.
 *
 * The display label is DERIVED from the setting key, VSCode-style:
 * 'rocketride.pipeBuilder.pipelineTraceLevel' renders as
 * "Pipeline Builder: Pipeline Trace Level" — there is no label field.
 * Key casing is therefore label casing (use 'pipelineTTL' for "Pipeline TTL").
 */
export interface SettingSchema {
	/** JSON type of the value. Drives the rendered control. */
	type: 'string' | 'number' | 'integer' | 'boolean';
	/**
	 * Default value when the user has not set this key.  Defaults live ONLY in
	 * the schema — `settings.json` stores deltas and never contains defaults.
	 */
	default?: SettingValue;
	/** Plain-text description shown below the setting label. */
	description?: string;
	/** Markdown variant of the description (preferred when both are present). */
	markdownDescription?: string;
	/**
	 * Fixed value choices — renders as a dropdown. Typed string[] per the
	 * frozen v0 contract; integer/number schemas may carry numeric entries in
	 * the manifest JSON at runtime, so render through String() and coerce the
	 * selected value back via `type`.
	 */
	enum?: Array<string | number>;
	/** Per-choice descriptions aligned with `enum`. */
	enumDescriptions?: string[];
	/** Ordering hint within the section (lower renders first). */
	order?: number;
	/**
	 * RocketRide editor extension via the JSON-Schema `format` keyword:
	 *
	 * - `'rocketride.envkey'`  — the value is the NAME of a server-side
	 *   Variable (never the secret itself); renders as a Variable picker.
	 * - `'rocketride.service'` — the value is a service id from the cached
	 *   service catalog; renders as a service dropdown (see `classType`).
	 */
	format?: string;
	/** Service classType filter — only used with format 'rocketride.service'. */
	classType?: string;
	/** Extension keyword: highlight the setting as required when unset. */
	required?: boolean;
	/** Extension keyword: placeholder text for empty string inputs. */
	placeholder?: string;
}

/**
 * An app's settings contribution — the exact shape of the
 * `contributes.configuration` section in the VSCode extension manifest
 * specification.
 *
 * Declared in the app's package.json under
 * `appManifest.contributes.configuration` and delivered to the shell on the
 * manifest's `configuration` field.  Keys are dotted and prefixed with the
 * app id (e.g. 'rocketride.pipeBuilder.pipelineTraceLevel') so they are
 * globally unique and self-identify their owning app.
 */
export interface AppConfiguration {
	/**
	 * Section title shown in the settings page nav.  Defaults to the app name.
	 * Apps that declare the SAME title are merged into one section (shared
	 * settings across a family of apps, e.g. games).
	 */
	title?: string;
	/** Setting declarations keyed by full dotted setting key. */
	properties: Record<string, SettingSchema>;
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
	/**
	 * The app's settings contribution (VSCode `contributes.configuration`
	 * shape).  Available at boot from the manifest — the settings registry is
	 * flattened from the configurations of all desktop apps.
	 */
	configuration?: AppConfiguration;
	/**
	 * Resolved app version (semver) for the desktop tile version chip —
	 * a built-in's package version, a marketplace app's active version, or
	 * a deployed pin's appVersion. Absent when the server sent none.
	 */
	version?: string;
	/** True when the entry is a dev-overlay override (live watch build). */
	dev?: boolean;
	/**
	 * When false, the app can run without authentication (e.g. home/landing page).
	 * Defaults to true — most apps require the user to be logged in.
	 */
	authenticated?: boolean;
	/** App lifecycle status: auth | free | unsubscribed | subscribed | trialing | past_due | canceled. */
	appStatus?: string;
	/** Whether this app is on the user's desktop. */
	onDesktop?: boolean;
	/**
	 * The shell-api contract version this app was built against (stamped into
	 * apps.json by the registration step from shell's apiver.ts). The lowest
	 * value across all registered apps is the oldest frozen version still in use,
	 * which is what can be safely pruned once nothing depends on it.
	 */
	shellApiVersion?: number;
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
	 * The app's ONE mount point, rendered raw in the client area. The app
	 * composes its own layout inside with `<AppLayout>` (one column, sidebar,
	 * status bar — declared as props from the app's single tree).
	 */
	app: React.ComponentType<ShellAppProps>;
	/**
	 * How this app would like the shell's sidebar to open.
	 *
	 * `'collapsed'` opens the rail collapsed each time the app becomes active;
	 * the person can still expand it, and expanding it lasts until they leave
	 * and come back. Absent means the app has no opinion and the sidebar is
	 * left exactly as it is — an app that says nothing can never disturb the
	 * state another app or the person chose.
	 *
	 * For an app whose own content is the reason to open the sidebar rather
	 * than the shell's navigation: a chat list is worth a column when you want
	 * it and a stolen quarter of the window when you do not.
	 *
	 * Ignored below the compact breakpoint, where the sidebar is a drawer and
	 * "collapsed" has no meaning.
	 */
	sidebar?: 'expanded' | 'collapsed';
	/**
	 * Optional cross-app component catalog. Never mounted by the shell —
	 * entries are loadable by other apps via `useAppComponent()`.
	 */
	components?: {
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
	/**
	 * The server's resolved API address from the pre-auth probe
	 * (endpoints.api). Empty/absent = window.location.origin. Differs from
	 * the page origin only on split deployments where the probe redirects
	 * live traffic off the serving host (e.g. CDN-served UI, direct API).
	 */
	serverUri?: string;
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
