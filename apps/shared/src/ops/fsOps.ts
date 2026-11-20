// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE-FS OPS — the virtualized workspace filesystem over the bus
// =============================================================================
//
// The `WorkspaceFs` capability (shell contract) served as named ops: code in
// ANY realm finds, reads, writes, and watches workspace files — and drives
// the change-management surface — through these. The host executes against
// what "the workspace" means to it (vscode: real files + containment guard;
// rocket-ui: the staged store view) and knows NOTHING about what the caller
// wants the files for.
//
// Staging verbs are served TRIVIALLY by auto-commit hosts (vscode): nothing
// pending, commits succeed empty — a pending-changes UI simply shows nothing
// pending, truthfully.
//
// WATCHES: `sub` is a realm-generated ROUTING KEY, not a correlation id (the
// bus owns request correlation). Events ride the realm-registered
// `host.fs.event` op — registration-is-routing: the host broadcasts, only
// realms that registered the handler hear it, and they filter by their own
// `sub` keys. `path: ''` is the synthetic "re-evaluate everything" tick.
// Staged-change transitions (commit / rollback / discard) tick the same op.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';
import type { ChangeKind, CommitResult, LayerMeta, PendingState } from 'shell/src/workspace/workspaceFs';

/** The workspace-FS op map (strictly typed against the shell contract). */
export interface HostFsOpMap extends ShellOpMap {
	// ── Discovery / read ─────────────────────────────────────────────────────
	/** Glob search over the workspace → paths in the host's spelling. */
	'host.fs.findFiles': ShellOpSpec<{ include: string; exclude?: string }, string[]>;
	/** The workspace root paths (possibly empty on single-rooted hosts). */
	'host.fs.workspaceRoots': ShellOpSpec<Record<string, never>, string[]>;
	/** One directory's immediate entries ('' = the root). */
	'host.fs.list': ShellOpSpec<{ dir: string }, { name: string; type: 'file' | 'dir' }[]>;
	/** A path's kind, ruled definitively by the authority. */
	'host.fs.stat': ShellOpSpec<{ path: string }, 'file' | 'dir' | null>;
	/** One file's content (JSON-serializable; text reads as a string). */
	'host.fs.read': ShellOpSpec<{ path: string }, unknown>;
	/** Many files in ONE round-trip; unreadable paths are omitted. */
	'host.fs.readMany': ShellOpSpec<{ paths: string[] }, Record<string, unknown>>;
	/** One workspace file as UTF-8 (containment-guarded). */
	'host.fs.readText': ShellOpSpec<{ path: string }, string>;
	/** One workspace file as base64, null when over `maxBytes` (stat-first —
	 *  the size gate bounds the response, not the read). */
	'host.fs.readBase64': ShellOpSpec<{ path: string; maxBytes: number }, string | null>;

	// ── Write ────────────────────────────────────────────────────────────────
	/** Writes one file (JSON-serializable content). */
	'host.fs.write': ShellOpSpec<{ path: string; content: unknown }, void>;
	/** Writes UTF-8 text. */
	'host.fs.writeText': ShellOpSpec<{ path: string; text: string }, void>;
	/** Writes binary carried as base64 (the bus's binary rule). */
	'host.fs.writeBase64': ShellOpSpec<{ path: string; dataB64: string }, void>;
	/** Renames a file or directory. */
	'host.fs.rename': ShellOpSpec<{ from: string; to: string }, void>;
	/** Deletes a file or directory (`recursive` required truthy for
	 *  non-empty directories on hosts that distinguish). */
	'host.fs.delete': ShellOpSpec<{ path: string; recursive?: boolean }, void>;
	/** Creates a directory. */
	'host.fs.mkdir': ShellOpSpec<{ path: string }, void>;
	/** Re-walks the authority's inventory (no-op on direct-disk hosts). */
	'host.fs.refresh': ShellOpSpec<Record<string, never>, void>;

	// ── Watch ────────────────────────────────────────────────────────────────
	/** Starts (or replaces) one watch subscription (emitOp). */
	'host.fs.watch': ShellOpSpec<{ sub: string; globs: string[] }, void>;
	/** Stops one watch subscription (emitOp). */
	'host.fs.unwatch': ShellOpSpec<{ sub: string }, void>;
	/** PUSH — one watch event into the subscribing realm (realm-registered;
	 *  renamed from the legacy `sidebar.fs.event`). */
	'host.fs.event': ShellOpSpec<{ sub: string; path: string }, void>;

	// ── Change management (trivial on auto-commit hosts) ────────────────────
	/** The pending snapshot — ONE round-trip for badges and gates. */
	'host.fs.pending': ShellOpSpec<Record<string, never>, PendingState>;
	/** One path's base-vs-staged text pair (null side = absent there). */
	'host.fs.diff': ShellOpSpec<{ path: string }, { before: string | null; after: string | null }>;
	/** Commits everything pending — all-or-nothing. */
	'host.fs.commit': ShellOpSpec<{ retain?: boolean }, CommitResult>;
	/** Freezes the working layer as a named checkpoint (null = none pending). */
	'host.fs.checkpoint': ShellOpSpec<{ label: string; sessionId?: string }, string | null>;
	/** Rolls staged state back to (and including) one layer. */
	'host.fs.rollback': ShellOpSpec<{ layerId: string }, void>;
	/** Un-commits one retained layer from the base. */
	'host.fs.undoTurn': ShellOpSpec<{ layerId: string }, CommitResult>;
	/** Discards pending changes: one path, or everything when omitted. */
	'host.fs.discard': ShellOpSpec<{ path?: string }, void>;
	/** The staged layers' metadata, oldest first (contents never cross). */
	'host.fs.layers': ShellOpSpec<Record<string, never>, LayerMeta[]>;
	/** Switches write-through (auto-commit) mode; rejects with pending
	 *  changes. Always-on hosts no-op. */
	'host.fs.writeThrough': ShellOpSpec<{ on: boolean }, void>;
}

// Re-export the wire types beside the map for op implementors' convenience.
export type { ChangeKind, CommitResult, LayerMeta, PendingState };
