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
 * The module owns the App Builder's ENTIRE view surface — DASHBOARD |
 * DESIGN | STORE | DEPLOY views, their pane state, forms, and lists. A host
 * integrates it in exactly one of two ways:
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

/** The rungs of the publish ladder: @me (personal), @team, @public.
 * (There is no org rung — "org-wide" is an org-admin-maintained team.) */
export type RungKind = 'personal' | 'team' | 'public';

/** One immutable published version, as rendered on the version rail. */
export interface AppVersionInfo {
	/** Registry version int — THE wire identity (unique, immutable); every
	 * action addresses versions by this, never by the display semver. */
	registryVersion: number;
	/** The app's semver from the package.json top level (display only —
	 * may repeat across deploys, and is '' on legacy rows). */
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
	/** The deployment's per-version review state: private (draft, internally
	 * publishable), submit (in review), ready (approved for the store),
	 * rejected, or failed. */
	state?: 'private' | 'submit' | 'ready' | 'rejected' | 'failed';
	/** SERVER build status of the version — a separate axis from the review
	 * state: '' or 'ok' = servable bytes exist, 'failed' = the build broke
	 * (the version can never serve), anything else is an in-flight ticker
	 * word ('queued', 'building', ...). A 'private' review state says
	 * nothing about servability — this does. */
	buildStatus?: string;
}

/** One row of the "Where this app is live" reverse index. */
export interface RungPin {
	/** Which rung. */
	rung: RungKind;
	/** Row label ("Personal", "Team", "Org", "Public"). */
	label: string;
	/** Mono handle ('@me', '@team/<name>', '@public') — doubles as the
	 * wire target for publish/remove verbs. */
	handle: string;
	/** Pinned registry version int (the wire identity). */
	registryVersion: number;
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

/**
 * One billing plan of the manifest's `appManifest.billing.plans` — the
 * Stripe-shaped pricing proposal that rides every deploy (the packed
 * package.json is the listing truth) and goes live on store approval.
 */
export interface BillingPlan {
	/** Plan display name ("Starter", "Pro"). */
	nickname: string;
	/** Price in cents. */
	amountCents: number;
	/** ISO currency code. */
	currency: string;
	/** Billing interval ("month", "year", "one_time"). */
	interval: string;
	/**
	 * Opaque plan metadata (credits, seats, features, ordering, display
	 * overrides) — preserved verbatim on the save round-trip, never edited
	 * by the listing form.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * The editable app-manifest draft — a direct projection of the app's
 * `package.json` appManifest. package.json is the storage: loading reads
 * it, saving writes it back. The PACKAGE tab edits the identity/packaging
 * fields (name, description, icon, readme, include); the STORE tab edits
 * the commerce fields (mode, billing.plans) — one draft, disjoint editors.
 */
export interface ListingDraft {
	/** App id — read-only projection. */
	appId: string;
	/** Billing mode (appManifest.mode). */
	mode: 'free' | 'subscription' | 'paywall';
	/** Display name (appManifest.name). */
	name: string;
	/** Listing description (appManifest.description). */
	description: string;
	/** Pricing plans (appManifest.billing.plans; empty for free mode). */
	plans: BillingPlan[];
	/** App-folder-relative icon path (appManifest.icon), '' = undeclared. */
	icon?: string;
	/** App-folder-relative README path (appManifest.readme), '' = undeclared. */
	readme?: string;
	/** Extra WORKSPACE-relative roots packed with the app and installed by
	 * the server build (appManifest.include) — the directories the app's
	 * imports need beyond its own folder. */
	include?: string[];
	/** Whether the server build verifies the app with its own tsconfig
	 * before bundling (appManifest.typecheck; absent = true). Off = the
	 * app deploys even with type errors — a visible waiver, not a default. */
	typecheck?: boolean;
}

/** One pre-flight readiness check row. */
export interface PreflightCheck {
	/** Stable id ("manifest", "appid", "name", "icon", "readme", "include", "desc", "pricing"). */
	id: string;
	/** Check outcome. */
	state: 'pass' | 'warn' | 'fail';
	/** Row label. */
	label: string;
	/** Supporting note ("2 include paths resolve"). */
	note?: string;
	/** Which bar the check belongs to: 'package' = complete/buildable app
	 * (the personal-publish bar, PACKAGE tab); 'store' = additional store
	 * submission requirements (STORE tab). Absent = 'package'. */
	tier?: 'package' | 'store';
}


// =============================================================================
// DASHBOARD — history stream + review thread
// =============================================================================

/**
 * One row of the app's deployment history — the audit stream and the review
 * thread in one. Machine rows (deploy, publish, review verdicts) and human
 * 'reply' rows ride the same append-only stream; the Dashboard paints replies
 * as chat bubbles and review transitions as system lines, so this type keeps
 * the SEMANTIC fields (action, side) rather than pre-rendered strings — the
 * one deliberate departure from the {@link ReviewTimelineItem} idiom.
 */
export interface AppHistoryEntry {
	/** Stable append-order key — the row identity (oldest first as loaded). */
	seq: number;
	/** Unix timestamp (seconds). */
	at: number;
	/** Machine action ('publish', 'deploy', 'request', 'approved', ...) or the human row 'reply'. */
	action: string;
	/** Registry version the row refers to (absent on thread-only rows). */
	version?: number;
	/** Denormalized actor record. */
	actor?: { userId?: string; display?: string; email?: string };
	/** Row payload — self-describing by contract (the stream renders without
	 * a second lookup). Human 'reply' rows carry {side, message}. Audience
	 * rows (publish binds, removed/disabled/enabled) carry {audience} with
	 * the server-dereferenced display facts (name, handle); a repoint adds
	 * previousVersion (the version it moved OFF of). A 'publish' row WITHOUT
	 * an audience is the registry write — the DEPLOY, per the settled
	 * vocabulary — and rides the developer's deploy comment. Review
	 * transitions carry both endpoints {from, to}. */
	data?: {
		side?: 'admin' | 'developer';
		message?: string;
		audience?: { type?: string; id?: string; name?: string; handle?: string };
		previousVersion?: number;
		comment?: string;
		from?: string;
		to?: string;
	};
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
	state: 'idle' | 'installing' | 'building' | 'ok' | 'error';
	/** Last build duration in ms, when known. */
	durationMs?: number;
	/** Where the dev bundle is served from ("localhost:3011"). */
	target?: string;
	/**
	 * WHY the state is 'error', human-readable ("Not connected to a
	 * RocketRide server — ...", the failing pnpm line, ...). Every error
	 * producer must supply one: "see the log" is not an error message.
	 */
	reason?: string;
}

/** One server build-status ticker word for a version ('' = clear). */
export interface BuildStatusTick {
	/** The registry version the word belongs to. */
	version?: number;
	/** The display word, rendered verbatim; '' clears the card text. */
	status: string;
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
	/**
	 * Subscribe to the SERVER build-status ticker (apaevt_build_status): one
	 * short display word per build-lifecycle transition of this app's
	 * versions — 'uploaded', 'preparing', 'installing', 'checking',
	 * 'building', 'publishing', 'failed', 'queued' — rendered verbatim
	 * beside the version card's state badge; '' clears it (the success
	 * terminal). A late subscriber replays the latest word per version.
	 * Returns unsubscribe.
	 */
	subscribeBuildStatus?: (listener: (tick: BuildStatusTick) => void) => () => void;
	/** Reload the preview surface. */
	reloadPreview?: () => void;
	/**
	 * Toggle session inheritance for the preview (the "Inherit Auth"
	 * checkbox). Inheriting hands the HOST's signed-in session to the
	 * preview shell; not inheriting clears it so the preview runs its own
	 * OAuth cycle. Presence renders the checkbox.
	 */
	setInheritAuth?: (inherit: boolean) => void;
	/** Set the preview theme. */
	setPreviewTheme?: (theme: 'light' | 'dark') => void;
	/** Launch the external-browser debug session (capabilities.canDebug). */
	debug?: () => void;
	/** Reveal the app's folder in the native explorer (hasNativeFiles). */
	revealFiles?: () => void;
	/** The preview URL to display in the toolbar (informational). */
	getPreviewUrl?: () => string;
	/**
	 * Read a persisted App Builder UI preference (preview layout, device
	 * resolutions, zoom, Inherit Auth…) from the host's per-workspace
	 * storage. Must be synchronous — the host loads its bag before the
	 * views mount (VSCode: workspaceState delivered with appdev:init).
	 * undefined = never persisted; the view falls back to its default.
	 */
	getPref?: (key: string) => unknown;
	/** Persist an App Builder UI preference to per-workspace storage. */
	setPref?: (key: string, value: unknown) => void;

	// ── Deploy ───────────────────────────────────────────────────────────
	/** List deployed immutable versions, newest first. */
	listVersions?: () => Promise<AppVersionInfo[]>;
	/** Deploy: snapshot the current build as the next immutable registry
	 * version (DEPLOY = copy code to the server). Binds nothing — that is the
	 * separate publish step. */
	deploy?: (message: string) => Promise<void>;
	/** Publish: bind a version to an audience (@me/@team/@public) — the one
	 * verb for first publish, update, promote, and rollback. Addressed by the
	 * REGISTRY version int (display semvers may repeat across deploys). */
	publish?: (version: number, target: string) => Promise<void>;
	/** Remove an audience binding (SOFT — republishing revives it). The
	 * target is the pin's handle ('@me' | '@team/<name>' | '@public'). */
	removePublish?: (target: string) => Promise<void>;
	/** The caller's team roster — the publish picker's team rows. */
	listTeams?: () => Promise<Array<{ id: string; name: string }>>;
	/** The reverse index for the Where-live panel. */
	getWhereLive?: () => Promise<RungPin[]>;
	/** One version's durable server build log — the full phase output the
	 * build worker stores beside the version's artifacts ('' = no log).
	 * The Deploy card's "failed" badge opens it. */
	loadBuildLog?: (version: number) => Promise<string>;
	/** The org's registered developer id ('' = not a developer yet). An app can
	 * only deploy inside a claimed developer namespace (`<developerId>.<name>`). */
	getDeveloperId?: () => Promise<string>;
	/** Claim the org's developer id slug (org.admin, self-service — letters and
	 * underscore only). Returns the assigned slug. */
	registerDeveloper?: (developerId: string) => Promise<string>;

	// ── Dashboard ────────────────────────────────────────────────────────
	/** Load the app's full deployment history, oldest first — the ONE fetch
	 * feeding the Dashboard's thread + activity feed AND the Store review
	 * timeline (hosts project the same rows both ways). */
	loadHistory?: () => Promise<AppHistoryEntry[]>;
	/** Append a developer message to the review thread. Server-gated to the
	 * developer org + namespace; the reply lands in the same history stream
	 * the reviewer's App Admin surface reads. */
	sendReply?: (message: string, version?: number) => Promise<void>;

	// ── Store ────────────────────────────────────────────────────────────
	/** Load the current listing draft (null = no server record yet). */
	loadListing?: () => Promise<ListingDraft | null>;
	/** Persist the listing draft. */
	saveListing?: (draft: ListingDraft) => Promise<void>;
	/** Run the pre-flight checks for the current build. */
	runPreflight?: () => Promise<PreflightCheck[]>;
	/** Native file picker for a manifest asset. Returns the picked file's
	 * APP-FOLDER-relative './'-prefixed POSIX path, or null on cancel. The
	 * host enforces containment: assets must live inside the app folder
	 * (the server's harvest only copies app-root-relative paths). */
	pickAppFile?: (kind: 'icon' | 'readme') => Promise<string | null>;
	/** Native picker for an include path — a workspace FOLDER or FILE.
	 * Returns the picked entry's WORKSPACE-relative POSIX path (no './'
	 * prefix — include entries are workspace-relative, unlike app assets),
	 * or null on cancel. The host enforces containment: the pick must live
	 * inside the workspace. */
	pickIncludePath?: () => Promise<string | null>;
	/** Read one app-folder-relative text file (icon SVG, README markdown)
	 * for preview. The host guards traversal and caps the size. */
	readAppTextFile?: (relPath: string) => Promise<string>;
	/** Read one app-folder-relative IMAGE as a data: URI (README images are
	 * often binary — png/jpg — so text reads would corrupt them). null =
	 * unreadable, unsupported type, or over the host's size cap. */
	readAppImageDataUri?: (relPath: string) => Promise<string | null>;
	/** Submit the given version for public review (addressed by the registry
	 * version int, like publish). */
	submitForReview?: (version: number) => Promise<void>;
	/** Withdraw a pending review (submit -> private) — the developer's own
	 * cancel; the version returns to draft. */
	withdrawReview?: (version: number) => Promise<void>;
}

// =============================================================================
// VIEW VOCABULARY
// =============================================================================

/** The five activity views. */
export type AppBuilderStage = 'dashboard' | 'design' | 'package' | 'store' | 'deploy';

/** The DESIGN pill panes (Code is web-only). */
export type DesignPane = 'preview' | 'code' | 'components' | 'events' | 'console' | 'errors';
