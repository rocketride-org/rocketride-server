// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP TYPES — the shared desktop page's public type surface
// =============================================================================
//
// The desktop (greeting + subtitle + rotating quote + app-card grid) is ONE
// shared component consumed by every host that shows a launcher: the OSS
// hello app, the SaaS home app, and rocket-ui's Desktop document page. The
// component is self-contained for server interactions — version rails,
// overrides, desktop remove, unsubscribe, subscription status — through an
// internal default adapter; hosts only supply the app list and chrome.

import type { CSSProperties } from 'react';

// =============================================================================
// APP SHAPE
// =============================================================================

/**
 * The app facts the desktop renders — a structural subset of BOTH manifest
 * entry shapes in play (the workspace's `AppManifestEntry` and the SDK's
 * ConnectResult entry), so `useWorkspace().appManifest` and
 * `useSubscriptions().desktopApps` assign unchanged.
 */
export interface DesktopApp {
	/** Stable unique app identifier. */
	id: string;
	/** Module Federation container name. */
	moduleId: string;
	/** Display name. */
	name: string;
	/** Short description shown on the card. */
	description?: string;
	/** URL to the app's icon. */
	icon?: string;
	/** Categories; the first one becomes the card's sublabel. */
	categories?: string[];
	/** Resolved app version (semver) for the version chip. */
	version?: string;
	/** Registry version number the entry resolves to (the current marker). */
	registryVersion?: number;
	/** True when the entry is a dev-overlay override (live watch build). */
	dev?: boolean;
}

// =============================================================================
// QUOTES
// =============================================================================

/** One rotating header quote with its attribution. */
export interface DesktopQuote {
	/** The quote text (rendered inside typographic quotes). */
	quote: string;
	/** Who said it. */
	who: string;
	/** Where it was said (venue, publication, platform). */
	audience: string;
	/** When (display string, e.g. "March 2023"). */
	date: string;
}

// =============================================================================
// VERSION SWITCHER
// =============================================================================

/** One deduplicated row of the version drop list. */
export interface DesktopVersionRow {
	/** Registry version number (the launch key — monotonic, never semver-compared). */
	registryVersion: number;
	/** Artifact semver for display. */
	appVersion: string;
	/** Rung handles pinning this version (e.g. '@team', 'in review'). */
	handles: string[];
}

/** A session version override as the desktop reads/writes it. */
export interface DesktopVersionOverride {
	/** Registry version number to serve. */
	version: number;
	/** Display semver of that version. */
	appVersion?: string;
}

// =============================================================================
// ADAPTER
// =============================================================================

/**
 * Server/runtime operations behind the desktop's affordances.
 *
 * The component builds an internal default from the shell runtime (the
 * ConnectionManager client + session version overrides); hosts normally never
 * pass one. Every member is optional — a missing member hides only the
 * affordance it powers (e.g. no `applyVersionOverride` → the version chip is
 * a plain label).
 */
export interface DesktopAdapter {
	/** Built, servable versions for an app, newest first. */
	listVersions?(appId: string): Promise<DesktopVersionRow[]>;
	/** The caller org's developer id ('' when none is claimed). */
	getDeveloperId?(): Promise<string>;
	/**
	 * Subscribe to events that invalidate the developer id (org switch,
	 * sign-in/out). Returns the unsubscribe function.
	 */
	onDeveloperIdChanged?(resolve: () => void): () => void;
	/** Read an app's session version override, if any. */
	getVersionOverride?(appId: string): DesktopVersionOverride | null;
	/**
	 * Apply (or clear, with null) a session version override. May return
	 * 'reload-required' when only a fresh boot can register the change.
	 */
	applyVersionOverride?(appId: string, moduleId: string, override: DesktopVersionOverride | null): string | void;
	/** Remove an app from the user's desktop (keeps any subscription). */
	removeApp?(appId: string): void;
	/** Cancel a paid app's subscription (also removes it from the desktop). */
	unsubscribeApp?(appId: string): void;
	/** Subscription status for an app ('past_due' blocks launch). */
	getStatus?(appId: string): string | undefined;
}

// =============================================================================
// VIEW PROPS
// =============================================================================

/** Props for the shared DesktopView component. */
export interface DesktopViewProps {
	/** Apps to show, in render order (hosts filter/sort before passing). */
	apps: DesktopApp[];
	/**
	 * Launch handler. Default: emit `shell:switchApp` on the connection
	 * manager — correct for every in-shell host.
	 */
	onLaunch?: (appId: string) => void;
	/** First name for the greeting; omitted → the nameless greeting pools. */
	greetingName?: string;
	/** Fixed header text replacing the greeting (e.g. a logged-out welcome). */
	greetingOverride?: string;
	/** Show the rotating quote column (default true). */
	showQuote?: boolean;
	/**
	 * Show the header row entirely (greeting + subtitle + quote; default
	 * true). False renders just the card grid — picker/compact surfaces.
	 */
	showHeader?: boolean;
	/**
	 * Allow the hover X + remove/unsubscribe popover (default true; the
	 * popover also needs the adapter's removeApp/unsubscribeApp members).
	 */
	allowRemove?: boolean;
	/** Theme-adaptive icon override; default is each app's manifest icon. */
	resolveIcon?: (app: DesktopApp) => string | undefined;
	/** Server adapter override; omit to use the built-in shell-runtime one. */
	adapter?: DesktopAdapter;
	/**
	 * CSS selector of the host's sticky header, used as the top boundary when
	 * placing the version drop list (absent → the viewport top).
	 */
	popoverBoundarySelector?: string;
	/** Message for the zero-apps state. */
	emptyMessage?: string;
	/** Extra styles merged onto the root (padding/width belong to the host). */
	style?: CSSProperties;
}
