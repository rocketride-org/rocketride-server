// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPELINE EDITOR OPS — declarations for the pipeline page's host verbs
// =============================================================================
//
// The pipeline editor (the .pipe custom editor) is a bus realm; these are
// the verbs only its HOST can serve: document I/O (save), run/stop with the
// host's policy injection (trace level, ttl, the save-for-run suppression,
// the subscription gate), and the bridged link panel. DECLARATIONS ONLY —
// the VS Code implementation lives with the editor provider.
//
// IDENTITY: `doc` is the DOCUMENT URI STRING — the panel's stable identity.
// The pipeline's projectId is content-derived and mutable (edited project_id
// fields reassign it mid-session), so it is never a wire key.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';

/**
 * What `host.pipeline.load` answers: the document's full boot state. The
 * framework-global facts (connection, services, env keys, cloud setup) ride
 * their own topics — this is only what is PER-DOCUMENT.
 *
 * `doc` kinds: a document URI for the editor, or `task:<projectId>.<sourceId>`
 * for the readonly live-task viewer (the StatusProvider replacement) — the
 * host fetches that pipeline off the running task.
 */
export interface PipelineLoadPayload {
	project?: unknown;
	viewState: Record<string, unknown>;
	statuses: Record<string, unknown>;
	isSubscribed: boolean;
	isDirty: boolean;
	isNew: boolean;
	isReadonly?: boolean;
	oauthReturnUrl?: string;
	envKeys?: string[];
}

// RETAINED TOPICS / SIGNALS the pipeline page rides (host = the writer,
// except where noted):
//   pipeline:doc:<doc>          RETAINED {isDirty,isNew} — RETRACTED on close
//   pipeline:doc:<doc>:canvas   SIGNAL   {project} (undo/redo echo)
//   pipeline:doc:<doc>:oauth    RETAINED {tokens,state} — retention IS the
//                               redelivery stash; the CONSUMING page retracts
//                               after applying (the one sanctioned
//                               consumer-retract: the value is a one-shot
//                               credential, not state)
//   pipeline:env / pipeline:cloudSetup — see steps above (global retained)

/** The pipeline editor's host-verb op map. */
export interface PipelineHostOpMap extends ShellOpMap {
	/** The document's full boot state (see {@link PipelineLoadPayload}). */
	'host.pipeline.load': ShellOpSpec<{ doc: string }, PipelineLoadPayload>;
	/** Applies the canvas's edited content to the document (emitOp).
	 *  `saveAfter` is the one-shot OAuth coupling: the change that applies
	 *  freshly delivered tokens must reach disk without a manual save. */
	'host.pipeline.contentSet': ShellOpSpec<{ doc: string; project: unknown; saveAfter?: boolean }, void>;
	/** Persists the document's layout defaults (emitOp). */
	'host.pipeline.viewState': ShellOpSpec<{ doc: string; viewState: Record<string, unknown> }, void>;
	/** Starts the browser OAuth flow (https-only guard host-side); tokens
	 *  come back on the doc's retained oauth topic. */
	'host.pipeline.oauthStart': ShellOpSpec<{ doc: string; url: string }, void>;
	/** Runs (or restarts) the document's pipeline: the host saves first
	 *  (untitled documents drive the OS Save dialog; a cancelled dialog
	 *  cancels the run), injects run policy, and gates on the subscription
	 *  (the gate pushes checkout:required back to the panel). */
	'host.pipeline.run': ShellOpSpec<{ doc: string; source?: string; action: 'run' | 'restart' }, void>;
	/** Stops the document's running source. */
	'host.pipeline.stop': ShellOpSpec<{ doc: string; source: string }, void>;
	/** Saves the document — same flow as the Ctrl+S keybinding. */
	'host.pipeline.save': ShellOpSpec<{ doc: string }, void>;
	/** Publishes an immutable version of the document to the registry.
	 *  HOST-side because it snapshots the TextDocument, never webview state:
	 *  an untitled doc rejects outright and a dirty one is saved first, so
	 *  the registry holds exactly what is on disk. Rejects with the failure
	 *  message — the bus carries the error, so no result correlation. */
	'host.pipeline.publish': ShellOpSpec<{ doc: string; comment?: string; deployTo?: string }, void>;
	/** ROCKETRIDE_* refs the canvas found that are not in the env — the host
	 *  offers the add-variables flow. */
	'host.pipeline.missingEnv': ShellOpSpec<{ keys: string[] }, void>;
	/** Opens a URL: system browser (`browser`, scheme-allowlisted) or the
	 *  bridged iframe panel (clipboard/file-dialog/drag bridging). */
	'host.pipeline.openLink': ShellOpSpec<{ url: string; displayName?: string; browser?: boolean }, void>;

	// ── File-keyed verbs (the sidebar's pipeline rows — no document open) ────
	/** Opens a .pipe file in the pipeline editor (emitOp). */
	'host.pipeline.openFile': ShellOpSpec<{ fsPath: string }, void>;
	/** Runs a .pipe FILE (stamping invariant + restart-on-save policy applied
	 *  host-side), optionally one source (emitOp). */
	'host.pipeline.runFile': ShellOpSpec<{ fsPath: string; sourceId?: string }, void>;
	/** Stops a running source by project identity (emitOp). */
	'host.pipeline.stopSource': ShellOpSpec<{ projectId: string; sourceId: string }, void>;
	/** Opens the readonly live-task viewer for a running task this workspace
	 *  has no file for (emitOp). */
	'host.pipeline.openStatus': ShellOpSpec<{ projectId: string; sourceId: string; displayName?: string }, void>;
}
