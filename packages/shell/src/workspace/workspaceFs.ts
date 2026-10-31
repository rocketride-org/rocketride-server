// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// WORKSPACE FS — the virtualized workspace filesystem (dependency-free leaf)
// =============================================================================
//
// THE one seam through which apps access the user's workspace. Hosts
// implement it against what "the workspace" means to them:
//
//   vscode     real files — vscode.workspace.fs over the open folders.
//              Staging verbs answer trivially (an AUTO-COMMIT workspace:
//              nothing is ever pending).
//   rocket-ui  the STAGED file system over the server store — uncommitted
//              files, dirty state, diffs, commit/rollback/checkpoint all
//              live.
//
// An app consumes it identically everywhere: `createWorkspaceFs(cm)` in any
// realm (the ops resolve locally in a framework root, over the bridge in a
// webview realm), or `services.workspaceFs` when mounted as a tool. Which
// filesystem "the workspace" is — and whether anything can be staged — is
// answered entirely by the host that registered the `host.fs.*`
// implementations.
//
// EVERYTHING IS ASYNC (Rod's ruling): there is no privileged sync surface
// and nothing is mirrored between realms — reads go through the authority on
// demand; `watch` events notify. Caching, where it exists, lives at the
// authority (rocket-ui's staged inventory) and is therefore shared by every
// realm automatically.
//
// Paths are HOST-OPAQUE TOKENS (OS paths on vscode, store-virtual paths on
// rocket-ui). `workspaceRoots()` is the only structure a consumer may assume.
// Binary crosses the bus as base64 (house rule).
//
// Kept import-free so NON-BROWSER host processes (the VS Code extension
// host) can type against it without pulling the shell's React barrel.
// =============================================================================

// =============================================================================
// WIRE TYPES — the change-management shapes (owned here; the vfs module and
// both hosts import them from this leaf)
// =============================================================================

/** How a path differs from the base, for badges and review. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

/** One commit/undo blocker: the base moved underneath a staged change. */
export interface StagedConflict {
	path: string;
	reason: 'changed' | 'missing' | 'resurrected';
}

/** The outcome of commit(): all-or-nothing. */
export interface CommitResult {
	/** Paths written/deleted on the base (0 when conflicts exist). */
	committed: number;
	/** Non-empty means NOTHING was written. */
	conflicts: StagedConflict[];
}

/** One staged layer's METADATA — entry contents never cross a realm. */
export interface LayerMeta {
	/** Stable id (uuid). */
	id: string;
	/** Display label (e.g. a turn title). */
	label: string;
	/** The agent session that produced it, when any. */
	sessionId?: string;
	/** True once commit() retained this layer as inert undo history. */
	committed?: boolean;
	/** Number of staged operations in the layer. */
	entryCount: number;
}

/** The one-round-trip pending snapshot (`host.fs.pending`). */
export interface PendingState {
	/** Whether any non-retained staged operation exists. */
	hasPending: boolean;
	/** Staged path → how it differs from the base. */
	changedPaths: Record<string, ChangeKind>;
	/** Paths with unsaved editor overlays (dirty markers). */
	dirtyPaths: string[];
}

/**
 * A write-through save was REFUSED because the base moved underneath the
 * buffer (someone else committed this path since it was opened) — the
 * VS Code "content of the file is newer" condition. The buffer is intact;
 * the caller resolves by comparing, overwriting deliberately (re-read then
 * re-save), or reverting.
 */
export class StaleWriteError extends Error {
	/** The refused path. */
	readonly path: string;

	constructor(path: string) {
		super(`Refusing to save '${path}' — the file changed on the server after it was opened. Compare and retry, or revert to the server version.`);
		this.name = 'StaleWriteError';
		this.path = path;
	}
}

// =============================================================================
// THE CONTRACT
// =============================================================================

/**
 * The workspace-FS capability a host provides: files, globs, watches, AND
 * the full change-management surface. Hosts without staging (vscode)
 * answer the staging verbs trivially — a pending-changes UI simply shows
 * nothing pending, truthfully.
 */
export interface WorkspaceFs {
	// ── Files ────────────────────────────────────────────────────────────────
	/**
	 * Lists one directory's immediate entries.
	 *
	 * @param dir - Directory path ('' = the root).
	 * @returns Name + kind per entry.
	 */
	list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]>;
	/**
	 * The type of a path, consulting the authority definitively.
	 *
	 * @param path - Path to classify.
	 * @returns 'file' | 'dir', or null when the path does not exist.
	 */
	stat(path: string): Promise<'file' | 'dir' | null>;
	/**
	 * Reads one file's content (JSON-serializable; text files read as
	 * strings).
	 *
	 * @param path - The file.
	 * @returns The content.
	 */
	read(path: string): Promise<unknown>;
	/**
	 * Reads many files in one round-trip — the batch seam for bulk
	 * consumers (pack, export).
	 *
	 * @param paths - Paths to read.
	 * @returns Path → content; unreadable paths are omitted.
	 */
	readMany(paths: string[]): Promise<Record<string, unknown>>;
	/**
	 * Reads a file as UTF-8 text.
	 *
	 * @param path - The file.
	 * @returns The text.
	 */
	readTextFile(path: string): Promise<string>;
	/**
	 * Reads a file as base64, size-gated.
	 *
	 * @param path - The file.
	 * @param maxBytes - Files larger than this return null.
	 * @returns The base64 payload, or null (missing / too large).
	 */
	readFileBase64(path: string, maxBytes: number): Promise<string | null>;
	/**
	 * Writes one file (JSON-serializable content; strings for text).
	 *
	 * @param path - The file.
	 * @param content - The content, stored per the host's workspace.
	 */
	write(path: string, content: unknown): Promise<void>;
	/** Writes UTF-8 text. */
	writeTextFile(path: string, text: string): Promise<void>;
	/** Writes binary content carried as base64 (the bus's binary rule). */
	writeFileBase64(path: string, dataB64: string): Promise<void>;
	/** Renames a file or directory. */
	rename(from: string, to: string): Promise<void>;
	/**
	 * Deletes a file or directory.
	 *
	 * @param path - The target.
	 * @param recursive - Required truthy to delete a non-empty directory on
	 *                    hosts that distinguish (vscode); staged hosts
	 *                    shadow subtrees either way.
	 */
	delete(path: string, recursive?: boolean): Promise<void>;
	/** Creates a directory. */
	mkdir(path: string): Promise<void>;
	/** Re-walks the authority's inventory (no-op on direct-disk hosts). */
	refresh(): Promise<void>;

	// ── Discovery / watch ────────────────────────────────────────────────────
	/**
	 * Finds files by glob across the workspace.
	 *
	 * @param include - Include glob (e.g. '**​/*.rrapp').
	 * @param exclude - Optional exclude glob.
	 * @returns Paths in the host's spelling.
	 */
	findFiles(include: string, exclude?: string): Promise<string[]>;
	/**
	 * The workspace root paths — what result paths are made
	 * display-relative against (possibly empty on single-rooted virtual
	 * hosts).
	 */
	workspaceRoots(): Promise<string[]>;
	/**
	 * Watches globs for create/change/delete.
	 *
	 * @param globs - Include globs.
	 * @param onEvent - Receives each changed path; '' is the synthetic
	 *                  "re-evaluate everything" tick.
	 * @returns Unsubscribe.
	 */
	watch(globs: string[], onEvent: (path: string) => void): () => void;

	// ── Change management (trivial on auto-commit hosts) ────────────────────
	/** The pending snapshot — one round-trip for badges and gates. */
	pending(): Promise<PendingState>;
	/**
	 * One path's base-vs-staged comparison.
	 *
	 * @param path - The file.
	 * @returns Text pair; null side = does not exist there.
	 */
	diff(path: string): Promise<{ before: string | null; after: string | null }>;
	/**
	 * Commits every pending staged operation to the base — all-or-nothing.
	 *
	 * @param options - retain: keep committed layers as inert undo history.
	 * @returns The outcome (conflicts mean nothing was written).
	 */
	commit(options?: { retain?: boolean }): Promise<CommitResult>;
	/**
	 * Freezes the working layer as a named checkpoint.
	 *
	 * @param label - Display label.
	 * @param sessionId - Producing agent session, when any.
	 * @returns The new layer id, or null when nothing was pending.
	 */
	checkpoint(label: string, sessionId?: string): Promise<string | null>;
	/** Rolls staged state back to (and including) one layer. */
	rollback(layerId: string): Promise<void>;
	/** Un-commits one retained layer from the base (the undo of a commit). */
	undoTurn(layerId: string): Promise<CommitResult>;
	/**
	 * Discards pending staged changes.
	 *
	 * @param path - One path; omitted = everything pending.
	 */
	discard(path?: string): Promise<void>;
	/** The staged layers' metadata, oldest first (contents never cross). */
	layers(): Promise<LayerMeta[]>;
	/**
	 * Switches write-through (auto-commit) mode. Rejects when pending
	 * changes exist — commit or discard first. Always-on hosts no-op.
	 */
	setWriteThrough(on: boolean): Promise<void>;
	/** Resolves once persisted staged layers are rehydrated (trivial where
	 *  there is no staging). */
	whenReady(): Promise<void>;
}

// =============================================================================
// GLOB — the one matcher both host implementations use (dependency-free)
// =============================================================================

/**
 * Compiles one include glob to a RegExp over '/'-separated paths.
 * Supports `**` (any depth), `*` (within a segment), `?` (one char).
 *
 * @param glob - The glob.
 * @returns The matcher.
 */
export function globToRegExp(glob: string): RegExp {
	const g = String(glob ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				// '**/' or trailing '**' — any depth (including none).
				re += '(?:.*)';
				i += g[i + 2] === '/' ? 2 : 1;
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]'.includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}
