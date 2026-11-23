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
import type { IMintedEndpointKey } from '../tools/pipelines/components/pipeline-actions/endpointKey';
import type { NewPipelineIdentity } from '../tools/pipelines/types';

/**
 * What `host.pipeline.load` answers: the document's full boot state. The
 * framework-global facts (connection, services, env keys, cloud setup) ride
 * their own topics — this is only what is PER-DOCUMENT.
 *
 * `doc` kinds: a document URI for the editor, or `task:<projectId>.<sourceId>`
 * (split on the LAST dot; the source is one dot-free component id)
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
	/** Puts the document back to its saved state and keeps it open (the
	 *  PACKAGE page's Cancel). An untitled document has no saved state. */
	'host.pipeline.revert': ShellOpSpec<{ doc: string }, void>;
	/** Publishes an immutable version of the document to the registry.
	 *  HOST-side because it snapshots the TextDocument, never webview state:
	 *  an untitled doc rejects outright and a dirty one is saved first, so
	 *  the registry holds exactly what is on disk. Rejects with the failure
	 *  message — the bus carries the error, so no result correlation. */
	'host.pipeline.publish': ShellOpSpec<{ doc: string; comment?: string; deployTo?: string }, void>;
	/** ROCKETRIDE_* refs the canvas found that are not in the env — the host
	 *  offers the add-variables flow. */
	'host.pipeline.missingEnv': ShellOpSpec<{ keys: string[] }, void>;
	/** Opens a docs URL in the system browser (scheme-allowlisted). A node's
	 *  front end is never a URL: that is `host.pipeline.openTool`. */
	'host.pipeline.openLink': ShellOpSpec<{ url: string }, void>;
	/** Opens a node's front end (plan §3.6): the dev-tool panel of `appId`
	 *  bound to the running control's `address` and the node `nodeId`
	 *  (document key `<address>/<nodeId>`). No URL, no credential. */
	'host.pipeline.openTool': ShellOpSpec<{ appId: string; address: string; nodeId: string }, void>;
	/** Mints the owner's scoped API key for one endpoint address (`task.data`,
	 *  that address, the home team; plan §2.4) — answered by the host that
	 *  holds the client. A host that cannot mint keys (OSS) rejects. */
	'host.pipeline.createEndpointKey': ShellOpSpec<{ address: string }, IMintedEndpointKey>;
	/** The org's developer id ('' when none is claimed yet) — the address
	 *  namespace every pipeline needs (plan §2.1). */
	'host.pipeline.developerId': ShellOpSpec<Record<string, never>, { developerId: string }>;
	/** Claims the org's developer id (org admins; the server refuses others);
	 *  answers the id as registered. */
	'host.pipeline.registerDeveloper': ShellOpSpec<{ developerId: string }, { developerId: string }>;
	/** The New Pipeline form's identity: developer id, create target, names in use (plan §2.1, §9). */
	'host.pipeline.newIdentity': ShellOpSpec<Record<string, never>, NewPipelineIdentity>;
	/** Creates the bundle `pipelines/<name>/<name>.pipe` with `project_id: <name>`,
	 *  retires the untitled document and opens the file. Rejection carries the
	 *  validation message. */
	'host.pipeline.create': ShellOpSpec<{ doc: string; name: string; displayName: string; project: unknown }, void>;
	/** Closes the untitled document without creating anything (the form's Cancel). */
	'host.pipeline.cancelNew': ShellOpSpec<{ doc: string }, void>;
	/** Reads a UTF-8 text file BESIDE the document's .pipe (`relPath`
	 *  '/'-separated, relative to the pipe's folder); `text` is null when the
	 *  file does not exist or the path leaves the folder (PACKAGE › Assets). */
	'host.pipeline.readFile': ShellOpSpec<{ doc: string; relPath: string }, { text: string | null }>;
	/** Reads an image BESIDE the document's .pipe as a `data:` URI; null when
	 *  missing, not an image, over the host's cap, or outside the folder. */
	'host.pipeline.readImageDataUri': ShellOpSpec<{ doc: string; relPath: string }, { dataUri: string | null }>;
	/** Writes a file BESIDE the document's .pipe, folders created as needed:
	 *  `text` for UTF-8 content, `dataB64` for bytes (the bridge carries
	 *  strings). Rejects for an untitled document or a path outside the folder. */
	'host.pipeline.writeFile': ShellOpSpec<{ doc: string; relPath: string; text?: string; dataB64?: string }, void>;
	/** The native file picker for PACKAGE › Assets: an image or a markdown
	 *  file; answers the file's name and bytes (base64), null on cancel. */
	'host.pipeline.pickFile': ShellOpSpec<{ doc: string; accept: 'image' | 'markdown' }, { name: string; dataB64: string } | null>;
	/** Opens a file BESIDE the document's .pipe in a text editor next to the
	 *  pipeline (PACKAGE › Assets "Open in editor"). */
	'host.pipeline.openAsset': ShellOpSpec<{ doc: string; relPath: string }, void>;

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
