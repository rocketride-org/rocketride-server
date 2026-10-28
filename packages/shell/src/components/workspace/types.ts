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
import type { ToolChannel } from './toolChannel';

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
	/**
	 * Setting OVERRIDES this partition OWNS (deltas only — a value equal to
	 * the schema default is deleted, never stored). Settings live in their
	 * owning contributor's partition file; the shell partition's live in
	 * global.json. There is no shared settings file.
	 */
	settings?: Record<string, SettingValue>;
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
 * Where a setting's VALUE lives — a partition-routing axis, not new storage:
 *
 * - `'workspace'` (the default when absent) — the contributing owner's
 *   partition file in the current workspace (`<owner>.workspace.json`):
 *   app/project settings.
 * - `'user'` — the shell partition (`global.json`): the person's own
 *   settings within the workspace (theme, appearance).
 * - `'host'` — the running HOST's own store. A VS Code concept only (the
 *   extension's configuration store, for connection/machine settings); the
 *   cloud has no host store, and host-scoped entries never render there.
 */
export type SettingStore = 'host' | 'workspace' | 'user';

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
	/**
	 * Extension keyword: which store holds the value (see {@link SettingStore}).
	 * Absent = `'workspace'`. `'host'`-scoped settings must ALSO be declared in
	 * the VS Code extension's package.json `contributes.configuration` — the
	 * host store is VS Code configuration, and VS Code only stores declared keys.
	 */
	store?: SettingStore;
	/**
	 * Extension keyword: shell editions this setting applies to
	 * ('saas' | 'oss' | 'vscode' — the AppManifestEntry.shells vocabulary).
	 * Absent = every shell. The registry drops entries whose list excludes
	 * the running edition, so host-inapplicable settings never render.
	 */
	shells?: string[];
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
	 * Shell editions this app serves ('saas' | 'oss' | 'vscode'). Absent means
	 * the app works on every shell. Matches the catalog wire's `shell` filter
	 * vocabulary; hosts hide entries that do not name their edition.
	 */
	shells?: string[];
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
	/**
	 * Registry version number the entry resolves to (the scope-walk winner) —
	 * present for published store apps; absent for built-ins and dev overlays.
	 * The desktop's version drop list matches on this (the wire identity),
	 * never the display semver.
	 */
	registryVersion?: number;
	/** True when the entry is a dev-overlay override (live watch build). */
	dev?: boolean;
	/**
	 * When false, the app can run without authentication (e.g. home/landing page).
	 * Defaults to true — most apps require the user to be logged in.
	 */
	authenticated?: boolean;
	/**
	 * The app's MONETIZATION MODEL: 'free' | 'paywall' | 'subscription'
	 * (absent = free). Declared in the app's manifest and passed through the
	 * wire. Distinct from {@link appStatus}, which is THIS account's current
	 * relationship to it — a free app never has subscription state, and a
	 * paid app's status varies per account.
	 */
	mode?: string;
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
	/**
	 * Dev-tool main surface — mounted DIRECTLY by a host workbench (the VS
	 * Code extension's tool panel, rocket-ui's tool document) instead of
	 * booting the full `app`. Declared by apps carrying the `devTool`
	 * manifest category. Must style exclusively via `var(--rr-*)` tokens —
	 * theming is the ambient CSS custom properties of the mounting document.
	 */
	devToolFrame?: React.ComponentType<DevToolProps>;
	/**
	 * Dev-tool sidebar — the tool's CONTROLLER, mounted by the host workbench
	 * in ITS sidebar (behind the tool's tab) while `devToolFrame` runs in the
	 * main surface. The two mounts may live in isolated documents (VS Code
	 * webviews). The controller owns AUTHORITY over the tool's shared state
	 * (refcounted/singleton coordination, owner-realm stores) — never
	 * transport: every realm holds its own working client
	 * (`useShellConnection().client`), and there is ONE socket per host
	 * process behind them all. Ephemeral UI coordination rides `peer`.
	 */
	devToolSidebar?: React.ComponentType<DevToolProps>;
}

// =============================================================================
// DEV TOOL CONTRACT — host-mounted tool components
// =============================================================================

/**
 * Props every dev-tool component receives from its host workbench.
 *
 * NO client member — and none is needed: every mount's realm already holds a
 * working `RocketRideClient` via `useShellConnection().client` (the root's
 * real client, or the realm client whose requests ride the shell bus). There
 * is ONE socket per host process; a controller mount owns AUTHORITY to
 * coordinate its tool's shared state (refcounted endpoints, single-writer
 * stores, shared pollers), never the transport. Everything frame↔controller
 * rides `channel` — ops for that coordination, events for ephemeral UI
 * coordination, retained state for shared snapshots.
 *
 * NO peer member (removed 2026-10-21): the raw post/subscribe pipe is a
 * host-internal transport seam now (IToolPeer — hosts build the channel over
 * it). Tools never correlate or envelope by hand.
 *
 * No theme member: tools are themed by the ambient `--rr-*` CSS custom
 * properties of the document they mount into (the shell's active theme
 * in-browser; the VS Code webview's editor-variable mapping in the editor).
 */
export interface DevToolProps {
	/**
	 * The channel to this tool's OTHER mount (frame ↔ sidebar) — the tool's
	 * ONE transport surface, host-built over its relay (in-memory in-shell;
	 * across webviews in VS Code). Three lanes:
	 *
	 *   - STATE (controller → frames): retained per topic, replayed to late
	 *     subscribers; a publish never summons a window.
	 *   - EVENTS (either direction): fire-and-forget. Direction discipline: a
	 *     sidebar mount sends ONLY in response to a user action (an event to
	 *     a closed frame summons it — a tree click is an implicit "open the
	 *     tool"); the frame PUSHES its state whenever it changes, and the
	 *     host retains the last frame→sidebar payload so a (re)mounted
	 *     sidebar renders without asking. Mount-time handshakes from the
	 *     sidebar side are a bug: every pinned tool's sidebar mount boots
	 *     with the host sidebar, and an ask-on-mount would summon every
	 *     tool's frame.
	 *   - OPS (frame → controller, correlated): the typed request/response
	 *     lane — see toolOps.ts (createToolOpClient / createToolOpServer).
	 */
	channel: ToolChannel;
	/**
	 * Host documents — present on hosts that give one tool MULTIPLE top-level
	 * documents (e.g. one tab per database connection). `open` opens or
	 * focuses the tool document for `docKey` with the given tab title,
	 * mounting `devToolFrame` with that key in {@link DevToolProps.docKey};
	 * `close` closes it. Hosts without the capability omit the member — the
	 * tool falls back to its single-frame behavior (an event summons the
	 * frame).
	 */
	documents?: {
		/** Opens (or focuses) the tool document for one key. */
		open(docKey: string, title: string): void;
		/** Closes the tool document for one key (open elsewhere = no-op). */
		close(docKey: string): void;
	};
	/**
	 * The document key this FRAME mount serves — set when the host opened it
	 * through `documents.open`. Absent on sidebar mounts and on a tool's
	 * single/default frame.
	 */
	docKey?: string;
	/**
	 * For SIDEBAR mounts on hosts with `documents`: the key of this tool's
	 * document currently fronted in the host's editor area, or null when the
	 * active editor is NOT one of this tool's documents (another tool, a
	 * text file). Hosts keep it live across tab switches, so a sidebar can
	 * follow the selection — highlight the fronted document's row, clear
	 * highlight and dependent panels on null. Omitted (undefined) by hosts
	 * that cannot tell and on frame mounts; a sidebar then falls back to its
	 * own signals (e.g. the frame's channel-event pushes).
	 */
	activeDocKey?: string | null;
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
	/**
	 * Logo rendered in the expanded sidebar header.
	 *
	 * An app that supplies one owns the whole header — the shell draws this
	 * INSTEAD of its own wordmark and the app-name label beneath it, not above
	 * them. For an app carrying its own brand rather than sitting under the
	 * platform's.
	 */
	logo?: React.ReactNode;
	/** Compact logo rendered in the collapsed sidebar header. */
	logoCollapsed?: React.ReactNode;
	/**
	 * Whether to keep the announcements ticker out of this app's sidebar.
	 *
	 * The ticker is the platform's channel, not the app's, and it reads as the
	 * host talking over a product that carries its own brand. Opt-in to hiding
	 * rather than opt-out of showing: an app that says nothing keeps it, so
	 * this cannot quietly turn the channel off for everyone.
	 */
	hideAnnouncements?: boolean;
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
