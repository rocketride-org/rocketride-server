// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP BUILDER OPS — declarations for the App Builder page's host verbs
// =============================================================================
//
// The App Builder page is a bus realm; these are the verbs only its HOST can
// serve: workspace file IO (the app folder is native on disk), the OS
// pickers, the dev-session inner loop, and the staged sign-in. The page's
// SDK half rides the brokered `client.app.*` / `client.deploy.*` ops through
// the shared adapter (shared/tools/appdev/busHost.ts) — never through here.
// DECLARATIONS ONLY — the VS Code implementation lives in
// apps/vscode/src/ops/appBuilderOps.ts. The cloud host serves NONE of these
// (its file IO is the store VFS, declared with its own surface).
//
// IDENTITY: `app` is the APP ID — the panel's stable identity (panels,
// prefs, and dev sessions are all appId-keyed; the .rrapp trigger file is
// only VS Code's tab anchor and never crosses the bus).
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';
import type { AppSummary, AppBuilderStage, AppBuilderCapabilities, ListingDraft, PreflightCheck } from '../tools/appdev/types';

/**
 * What `host.appbuilder.load` answers: the page's full boot state. The
 * framework-global facts (connection, account/catalog, services) ride their
 * own mirror topics — this is only what is PER-APP and host-known.
 */
export interface AppBuilderLoadPayload {
	/** The app under construction (folder-scan truth, not the catalog row). */
	app: AppSummary;
	/** The preview shell URL (host setting ?? engine base, cache-busted). */
	previewUrl: string;
	/** Host affordances (fixed per host). */
	capabilities: AppBuilderCapabilities;
	/** The persisted stage, normalized ('dashboard' when never persisted). */
	stage: AppBuilderStage;
	/** The persisted per-app UI preference bag. MUST be applied before the
	 *  views mount — getPref is synchronous by contract. */
	prefs: Record<string, unknown>;
}

// RETAINED TOPICS / SIGNALS the App Builder page rides (host = the writer;
// all RETRACTED on panel close):
//   appbuilder:app:<appId>:watch    RETAINED WatchStatus (the DEV badge)
//   appbuilder:app:<appId>:dev      RETAINED {entry,manifest} (MF dev remote)
//   appbuilder:app:<appId>:console  SIGNAL   ConsoleRow — signals, NOT
//                                   retained: the realm keeps its own bounded
//                                   backlog; retained replay would double-
//                                   print every startup line
//   appbuilder:app:<appId>:errors   SIGNAL   AppErrorRow
//   appbuilder:app:<appId>:session  RETAINED {token} — one-shot credential;
//                                   the CONSUMING page retracts after
//                                   applying (the pipeline:doc:oauth pattern)

/** The App Builder page's host-verb op map. */
export interface AppBuilderHostOpMap extends ShellOpMap {
	/** The page's full boot state (see {@link AppBuilderLoadPayload}). */
	'host.appbuilder.load': ShellOpSpec<{ app: string }, AppBuilderLoadPayload>;
	/** Persists the active stage (emitOp). */
	'host.appbuilder.stage': ShellOpSpec<{ app: string; stage: AppBuilderStage }, void>;
	/** Persists one per-app UI preference (emitOp, merge-write). */
	'host.appbuilder.pref': ShellOpSpec<{ app: string; key: string; value: unknown }, void>;
	/** Full inner-loop reset: kill + reinstall + respawn the dev session
	 *  (emitOp). NOT the cloud's iframe remount — the semantics are host-
	 *  specific by design. */
	'host.appbuilder.restart': ShellOpSpec<{ app: string }, void>;
	/** Reveals the app folder in the OS explorer (emitOp, hasNativeFiles). */
	'host.appbuilder.reveal': ShellOpSpec<{ app: string }, void>;
	/** Runs the staged browser sign-in; resolves when the session lands (the
	 *  token then arrives on the app's retained :session topic). LONG-LIVED —
	 *  callers pass an explicit generous timeoutMs. */
	'host.appbuilder.login': ShellOpSpec<{ app: string }, void>;
	/** DEPLOY = zip the app folder from disk and upload it as the next
	 *  immutable registry version (the server builds the one true bundle). */
	'host.appbuilder.deploy': ShellOpSpec<{ app: string; message: string }, void>;
	/** The current listing draft from the app's package.json (null = none). */
	'host.appbuilder.loadListing': ShellOpSpec<{ app: string }, ListingDraft | null>;
	/** Persists the listing draft into the app's package.json. */
	'host.appbuilder.saveListing': ShellOpSpec<{ app: string; draft: ListingDraft }, void>;
	/** Runs the listing pre-flight checks against the on-disk build. */
	'host.appbuilder.preflight': ShellOpSpec<{ app: string }, PreflightCheck[]>;
	/** OS picker for a manifest asset; answers the app-folder-relative './'
	 *  POSIX path (containment enforced host-side), null on cancel. */
	'host.appbuilder.pickAppFile': ShellOpSpec<{ app: string; kind: 'icon' | 'readme' }, string | null>;
	/** OS picker for an include FOLDER or FILE; answers the workspace-relative
	 *  POSIX path (no './' — include entries are workspace-relative), null on
	 *  cancel. */
	'host.appbuilder.pickIncludePath': ShellOpSpec<{ app: string }, string | null>;
	/** One app-folder-relative text file (traversal-guarded, size-capped). */
	'host.appbuilder.readTextFile': ShellOpSpec<{ app: string; relPath: string }, string>;
	/** One app-folder-relative image as a data: URI (null = unreadable,
	 *  unsupported, or over the cap). */
	'host.appbuilder.readImage': ShellOpSpec<{ app: string; relPath: string }, string | null>;
}
