// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE-FS OPS — the generic tool-host file capability over the bus
// =============================================================================
//
// The `ToolWorkspaceFs` capability (frozen shell contract) served as named
// ops: tool controllers running in a webview realm find, read, and watch
// workspace files through these — the host executes globs and reads and
// knows NOTHING about what the controller is looking for. Reads are confined
// to the open workspace folders (host-enforced containment).
//
// WATCHES: `sub` is a realm-generated ROUTING KEY, not a correlation id (the
// bus owns request correlation). Events ride the realm-registered
// `sidebar.fs.event` op — registration-is-routing: the host broadcasts, only
// realms that registered the handler hear it, and they filter by their own
// `sub` keys. `path: ''` is the synthetic workspace-folders tick ("re-
// evaluate everything").
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';

/** The workspace-FS op map. */
export interface HostFsOpMap extends ShellOpMap {
	/** Glob search over the open workspace folders → absolute fsPaths. */
	'host.fs.findFiles': ShellOpSpec<{ include: string; exclude?: string }, string[]>;
	/** The open workspace folders' absolute fsPaths. */
	'host.fs.workspaceRoots': ShellOpSpec<Record<string, never>, string[]>;
	/** One workspace file as UTF-8 (containment-guarded). */
	'host.fs.readText': ShellOpSpec<{ path: string }, string>;
	/** One workspace file as base64, null when over `maxBytes` (stat-first —
	 *  the size gate bounds the response, not the read). */
	'host.fs.readBase64': ShellOpSpec<{ path: string; maxBytes: number }, string | null>;
	/** Starts (or replaces) one watch subscription (emitOp). */
	'host.fs.watch': ShellOpSpec<{ sub: string; globs: string[] }, void>;
	/** Stops one watch subscription (emitOp). */
	'host.fs.unwatch': ShellOpSpec<{ sub: string }, void>;
	/** PUSH — one watch event into the subscribing realm (realm-registered). */
	'sidebar.fs.event': ShellOpSpec<{ sub: string; path: string }, void>;
}
