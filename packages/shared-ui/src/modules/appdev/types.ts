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
// APP BUILDER — SHARED TYPES + THE HOST CONTRACT
// =============================================================================

/**
 * Types for the App Builder view layer (`shared/modules/appdev`).
 *
 * The module owns the App Builder's ENTIRE view surface — DEVELOP | DEPLOY |
 * STORE views, their pane state, forms, and lists. A host integrates it in
 * exactly one of two ways:
 *
 *  1. DIRECT MOUNT — rocket-ui renders `<AppBuilderScreen host={adapter}>`
 *     where the adapter wraps the live client (useShellConnection).
 *  2. BRIDGE — the VSCode `page-app` webview renders the SAME screen where
 *     the adapter routes every accessor/action over useMessaging to the
 *     extension host.
 *
 * Components here never import a client, ConnectionManager, or vscode API —
 * `IAppBuilderHost` is the single seam. Loaders the host does not implement
 * yet render as teaching empty states, so the screen is shippable before
 * every platform capability lands.
 */

// =============================================================================
// APP IDENTITY + STATUS
// =============================================================================

/**
 * App lifecycle badge vocabulary (the mockup's exact set): `local` = bound
 * folder with no server record, `dev` = live dev-overlay entry, then the
 * marketplace lifecycle. `pending` renders as "in review"; `live` is the
 * display state for an approved app with an active public version.
 */
export type AppStatus = 'local' | 'dev' | 'draft' | 'pending' | 'approved' | 'rejected' | 'live';

/** The app the screen is showing — header + trailing-note facts. */
export interface AppSummary {
	/** App id (e.g. "acme.brandy") — the appManifest.id binding key. */
	id: string;
	/** MF container name (dots → underscores). */
	moduleId: string;
	/** Display name. */
	name: string;
	/** Current working version label (e.g. "0.5.0-rc.1"), if known. */
	version?: string;
	/** Lifecycle badge state. */
	status: AppStatus;
	/** Short description (Store listing seed). */
	description?: string;
}

// =============================================================================
// DEPLOY — versions + rungs
// =============================================================================

/** The four rungs of the publish ladder. */
export type RungKind = 'personal' | 'team' | 'org' | 'public';

/** One immutable published version, as rendered on the version rail. */
export interface AppVersionInfo {
	/** Version label (e.g. "0.5.0-rc.1"). */
	version: string;
	/** Publisher display name (denormalized, like deploy-panel). */
	author: string;
	/** Unix seconds of the publish. */
	publishedAt: number;
	/** Content hash (rendered truncated), when known. */
	sha?: string;
	/** Commit-style publish message. */
	message?: string;
	/** Rungs this version is currently pinned to (chip row). */
	rungs: RungKind[];
}

/** One row of the "Where this app is live" reverse index. */
export interface RungPin {
	/** Which rung. */
	rung: RungKind;
	/** Row label ("Personal", "Team", "Org", "Public"). */
	label: string;
	/** Mono handle ("@rod", "@acme/staging", "App Store"). */
	handle: string;
	/** Pinned version label. */
	version: string;
	/** Rung state — internal rungs are enabled; public is approved/pending. */
	state: 'enabled' | 'approved' | 'pending';
	/** Audience line ("on your desktop", "3 testers", "listed"). */
	audience: string;
	/** Unix seconds of the pin move. */
	deployedAt?: number;
	/** A version awaiting review on this rung (public only), if any. */
	pendingVersion?: string;
}

// =============================================================================
// STORE — listing, pre-flight, review
// =============================================================================

/** One pricing tier of the listing's proposal (live on approval). */
export interface PricingTier {
	/** Tier display name ("Basic", "Pro"). */
	nickname: string;
	/** Price in cents. */
	amountCents: number;
	/** ISO currency code. */
	currency: string;
	/** Billing interval ("month", "year"). */
	interval: string;
	/** Credits included per interval, if the tier grants credits. */
	credits?: number;
}

/** The editable Store listing draft (projection of the app record). */
export interface ListingDraft {
	/** App id — read-only projection. */
	appId: string;
	/** Billing mode. */
	mode: 'free' | 'subscription' | 'paywall';
	/** Display name. */
	name: string;
	/** Listing description. */
	description: string;
	/** Pricing proposal tiers (empty for free mode). */
	tiers: PricingTier[];
}

/** One pre-flight submission check row. */
export interface PreflightCheck {
	/** Stable id ("bundle", "contract", "listing", "screenshots", "stripe"). */
	id: string;
	/** Check outcome. */
	state: 'pass' | 'warn' | 'fail';
	/** Row label. */
	label: string;
	/** Supporting note ("./AppDescriptor exposed · 2.4 MB of 10 MB"). */
	note?: string;
}

/** One review-history timeline item (per-version review model). */
export interface ReviewTimelineItem {
	/** Rendered timestamp line ("Jul 7 · 11:20"). */
	when: string;
	/** Bold event line ("v0.4.0 approved"). */
	title: string;
	/** Supporting note under the title. */
	note?: string;
	/** Node state — pending renders the amber dot. */
	state: 'done' | 'pending' | 'rejected';
	/** Reviewer notes blockquote (rejected items). */
	rejectionNotes?: string;
}

// =============================================================================
// DEVELOP — event / console / error feeds
// =============================================================================

/** One shell/platform event row in the Events pane. */
export interface AppEventRow {
	/** Rendered time ("09:12:11"). */
	time: string;
	/** Event name ("shell:manifestRefresh"). */
	name: string;
	/** Compact payload rendering. */
	payload?: string;
}

/** One console line in the Console pane. */
export interface ConsoleRow {
	/** Rendered time. */
	time: string;
	/** Console level. */
	level: 'log' | 'warn' | 'error';
	/** Line text. */
	text: string;
}

/** One error row in the Errors pane. */
export interface AppErrorRow {
	/** Rendered time. */
	time: string;
	/** Error message. */
	message: string;
	/** Offending source location ("src/Dashboard.tsx:42"), when known. */
	source?: string;
}

/** Watch/build state for the DEV badge over the preview. */
export interface WatchStatus {
	/** Watch state word. */
	state: 'idle' | 'building' | 'ok' | 'error';
	/** Last build duration in ms, when known. */
	durationMs?: number;
	/** Where the dev bundle is served from ("localhost:3011"). */
	target?: string;
}

// =============================================================================
// THE HOST CONTRACT
// =============================================================================

/** What the hosting surface can do — selects per-host affordances. */
export interface AppBuilderCapabilities {
	/** Web only: the Code pane (store-backed files + Monaco) exists. */
	hasCodePane: boolean;
	/** VSCode only: files are native — show the native-files strip. */
	hasNativeFiles: boolean;
	/** VSCode only: Debug (F5) launches a real browser. */
	canDebug: boolean;
}

/**
 * The single seam between the shared App Builder views and a host.
 *
 * Everything is data accessors + action callbacks — no React, no client,
 * no transport. Optional members are capabilities the host has not wired
 * yet; the views render teaching empty states in their place.
 */
export interface IAppBuilderHost {
	/** Host affordances (fixed per host, read once). */
	capabilities: AppBuilderCapabilities;

	// ── Develop ──────────────────────────────────────────────────────────
	/** Subscribe to shell/platform events for the Events pane. Returns unsubscribe. */
	subscribeEvents?: (listener: (row: AppEventRow) => void) => () => void;
	/** Subscribe to app console output for the Console pane. Returns unsubscribe. */
	subscribeConsole?: (listener: (row: ConsoleRow) => void) => () => void;
	/** Subscribe to app errors for the Errors pane. Returns unsubscribe. */
	subscribeErrors?: (listener: (row: AppErrorRow) => void) => () => void;
	/** Subscribe to watch/build status for the DEV badge. Returns unsubscribe. */
	subscribeWatch?: (listener: (status: WatchStatus) => void) => () => void;
	/** Reload the preview surface. */
	reloadPreview?: () => void;
	/** Set the preview theme. */
	setPreviewTheme?: (theme: 'light' | 'dark') => void;
	/** Launch the external-browser debug session (capabilities.canDebug). */
	debug?: () => void;
	/** Reveal the app's folder in the native explorer (hasNativeFiles). */
	revealFiles?: () => void;
	/** The preview URL to display in the toolbar (informational). */
	getPreviewUrl?: () => string;

	// ── Deploy ───────────────────────────────────────────────────────────
	/** List published immutable versions, newest first. */
	listVersions?: () => Promise<AppVersionInfo[]>;
	/** Publish (snapshot) the current build as an immutable version. */
	publish?: (message: string) => Promise<void>;
	/** Deploy: pin a rung to a version (update/promote/rollback included). */
	deploy?: (version: string, target: string) => Promise<void>;
	/** The reverse index for the Where-live panel. */
	getWhereLive?: () => Promise<RungPin[]>;

	// ── Store ────────────────────────────────────────────────────────────
	/** Load the current listing draft (null = no server record yet). */
	loadListing?: () => Promise<ListingDraft | null>;
	/** Persist the listing draft. */
	saveListing?: (draft: ListingDraft) => Promise<void>;
	/** Run the pre-flight checks for the current build. */
	runPreflight?: () => Promise<PreflightCheck[]>;
	/** Submit the given version for public review. */
	submitForReview?: (version: string) => Promise<void>;
	/** Load the per-version review history, newest first. */
	loadReviewHistory?: () => Promise<ReviewTimelineItem[]>;
}

// =============================================================================
// VIEW VOCABULARY
// =============================================================================

/** The three activity views. */
export type AppBuilderStage = 'develop' | 'deploy' | 'store';

/** The DEVELOP pill panes (Code is web-only). */
export type DevelopPane = 'preview' | 'code' | 'events' | 'console' | 'errors';
