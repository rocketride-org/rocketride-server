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
// STAGED FILESYSTEM — the git-like workspace view: layers, commit, rollback
// =============================================================================

/**
 * `StagedFileSystem` is a workspace view (IWorkspaceFileSystem) that stages
 * every mutation in local layers instead of writing to the server. It
 * decorates a base view (the host's CachedVfs — typed to the interface,
 * never the class):
 *
 *   - Reads are a top-down union: dirty editor overlay (via the base) wins,
 *     then staged layers newest-first, then the base itself.
 *   - Mutations land in the topmost (working) layer as writes, tombstones,
 *     or mkdirs. The content that was effective BEFORE the first touch is
 *     captured per path (`before` + its hash) — the conflict anchor and the
 *     undo source. Staged mutations never reach the backend; only commit()
 *     holds that path.
 *   - checkpoint() freezes the working layer; rollback() truncates back to
 *     a checkpoint; commit() verifies the captured base hashes against the
 *     live base (conflicts reported, never clobbered) and replays the net
 *     operations onto the base — the single moment the server changes.
 *   - Committed layers can be RETAINED as inert history (auto-commit mode):
 *     they stop contributing to reads and pending state but keep their
 *     before-content so undoTurn() can inverse-replay them.
 *   - An optional staging store persists layers (content-addressed blobs +
 *     manifest); persistence completes before the change tick fires —
 *     persistence IS the save.
 *
 * Staged content is text-only (the cloud workspace tools are text-only);
 * binary paths flow through untouched in write-through mode only.
 */

import type { IWorkspaceFileSystem, VfsEntry, VfsOverlay } from './vfsTypes';
import { sha256Hex } from './hash';
// The wire-shaped change-management types are OWNED by the shell's
// WorkspaceFs leaf (both hosts and the op layer type against them);
// re-exported here so existing importers keep their path.
import { StaleWriteError, globToRegExp } from 'shell/src/workspace/workspaceFs';
import type { WorkspaceFs, ChangeKind, CommitResult, StagedConflict, LayerMeta, PendingState } from 'shell/src/workspace/workspaceFs';

export { StaleWriteError };
export type { ChangeKind, CommitResult, StagedConflict };

// =============================================================================
// TYPES — layers, entries, results
// =============================================================================

/** One staged operation on one path. */
export type LayerEntry =
	| {
		kind: 'write';
		/** The staged content. */
		content: string;
		/** Effective content below at first touch (null = did not exist). */
		before: string | null;
		/** Hash of `before` (null = did not exist) — the conflict anchor. */
		baseHash: string | null;
		stamp: number;
	}
	| {
		kind: 'tombstone';
		/** The deleted file's content at first touch (null for dirs/unknown). */
		before: string | null;
		baseHash: string | null;
		/**
		 * True when the deleted path was a DIRECTORY — dirs have no content
		 * capture, so existence (not a content hash) is their commit anchor.
		 */
		dir?: boolean;
		stamp: number;
	}
	| {
		kind: 'mkdir';
		stamp: number;
	};

/** One checkpoint: a frozen (or working) set of staged operations. */
export interface Layer {
	/** Stable id (uuid). */
	id: string;
	/** Display label (e.g. a turn title). */
	label: string;
	/** The agent session that produced it, when any. */
	sessionId?: string;
	/** True once commit() retained this layer as inert undo history. */
	committed?: boolean;
	/** Staged operations, keyed by canonical path. */
	entries: Map<string, LayerEntry>;
}

/** Persistence seam — implemented by the workspace StagingStore. */
export interface IStagingStore {
	/** Restores persisted layers (null = nothing staged). */
	load(): Promise<Layer[] | null>;
	/** Persists the full layer set (blobs first, manifest last). */
	persist(layers: readonly Layer[]): Promise<void>;
	/** Deletes the entire staging tree (nothing left to persist). */
	sweep(): Promise<void>;
	/**
	 * Best-effort removal of unreferenced blobs. The store derives the
	 * referenced set by scanning its own manifest (content hashes are
	 * computed at persist time and live there, never in the layers).
	 */
	gc(): Promise<void>;
}

/** Construction options. */
export interface StagedFileSystemOptions {
	/**
	 * When true, mutations pass straight through to the base (today's
	 * behavior). Used until every consumer reads through the view, and by
	 * auto-commit mode between checkpoints.
	 */
	writeThrough?: boolean;
	/**
	 * Fired after a STAGED mutation persists (write/rename/delete/mkdir on
	 * the staged branch only — write-through delegates to the base, whose
	 * backend already announces). The composition root uses this to announce
	 * view changes on the host's notification bus, so manual mode's edits
	 * reach the same consumers (dev preview, rescans) as physical writes.
	 */
	onMutate?: (path: string, origin?: string) => void;
}

// =============================================================================
// STAGED FILESYSTEM
// =============================================================================

export class StagedFileSystem implements IWorkspaceFileSystem, WorkspaceFs {
	/** The base view — server truth (plus editor overlays). */
	private readonly base: IWorkspaceFileSystem;
	/** Optional persistence; when present, mutations await it before notify. */
	private readonly staging: IStagingStore | null;
	/** Ordered layers, oldest first; last = the mutable working layer. */
	private layerStack: Layer[] = [];
	/** Change-tick listeners (base ticks are re-emitted through this set). */
	private readonly listeners = new Set<() => void>();
	/** Resolves once persisted layers are rehydrated; mutations await it. */
	private readonly ready: Promise<void>;
	/** Pass-through mode flag (see StagedFileSystemOptions). */
	private writeThrough: boolean;
	/** Staged-mutation announcement hook (see StagedFileSystemOptions). */
	private readonly onMutate: ((path: string, origin?: string) => void) | null;

	/**
	 * Builds the staged view over a base view.
	 *
	 * @param base - The host's workspace view (CachedVfs or another view).
	 * @param staging - Optional persistence store for the layers.
	 * @param options - Behavior flags.
	 */
	constructor(base: IWorkspaceFileSystem, staging: IStagingStore | null = null, options: StagedFileSystemOptions = {}) {
		this.base = base;
		this.staging = staging;
		this.writeThrough = options.writeThrough === true;
		this.onMutate = options.onMutate ?? null;
		// step: base ticks flow through our single subscription stream
		this.base.subscribe(() => this.notify());
		// step: rehydrate persisted layers; reads before this resolves see the
		// base. Closes over the PARAMETER: the async IIFE runs inside the
		// constructor, where the property's definite assignment is still open.
		this.ready = (async () => {
			if (!staging) return;
			try {
				const restored = await staging.load();
				if (restored && restored.length > 0) {
					this.layerStack = restored;
					this.notify();
				}
			} catch (err) {
				console.log('[workspace] staging rehydrate failed:', err);
			}
		})();
	}

	/**
	 * Resolves once persisted staged layers are rehydrated. The composition
	 * root awaits this before the first consumer read, so a reloaded page
	 * never briefly shows un-staged base state.
	 *
	 * @returns The rehydration promise (already-resolved when no store).
	 */
	whenReady(): Promise<void> {
		return this.ready;
	}

	// ── Mode control ─────────────────────────────────────────────────────

	/**
	 * Switches pass-through mode. Turning write-through ON with pending
	 * (uncommitted, non-retained) changes is refused — the caller must
	 * commit or discard first (the P3 prompt consumes this error).
	 *
	 * @param on - The new mode.
	 */
	async setWriteThrough(on: boolean): Promise<void> {
		if (on && this.hasPendingChanges()) {
			throw new Error('Cannot enable write-through with uncommitted changes — commit or discard them first.');
		}
		this.writeThrough = on;
	}

	/** Whether any non-retained staged operation exists. */
	hasPendingChanges(): boolean {
		return this.pendingLayers().some((l) => l.entries.size > 0);
	}

	// ── Internals ────────────────────────────────────────────────────────

	/** Canonicalizes a caller path (separators, edge slashes). */
	private norm(path: string): string {
		return String(path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	}

	/** The layers that still contribute to reads/pending state. */
	private pendingLayers(): Layer[] {
		return this.layerStack.filter((l) => !l.committed);
	}

	/**
	 * Memo for effective() rulings, valid for one change tick: listing and
	 * inventory walks call effective() per candidate path (quadratic over
	 * the staged set without this). Cleared by notify() — every layer or
	 * base change flows through that single point.
	 */
	private effectiveCache = new Map<string, LayerEntry | 'gone' | null>();

	/** The mutable working layer, created on first staged mutation. */
	private workingLayer(): Layer {
		const last = this.layerStack[this.layerStack.length - 1];
		if (last && !last.committed) return last;
		const layer: Layer = { id: crypto.randomUUID(), label: 'Working', entries: new Map() };
		this.layerStack.push(layer);
		return layer;
	}

	/**
	 * The decisive staged answer for a path, newest pending layer first.
	 * Checks the exact path, then ancestors in the same layer (a tombstoned
	 * or file-overwritten ancestor hides everything beneath it).
	 *
	 * @param path - Canonical path.
	 * @returns The entry, 'gone' when shadowed/deleted, or null (ask base).
	 */
	private effective(path: string): LayerEntry | 'gone' | null {
		const memo = this.effectiveCache.get(path);
		if (memo !== undefined) return memo;
		const ruling = this.effectiveUncached(path);
		this.effectiveCache.set(path, ruling);
		return ruling;
	}

	/** effective()'s actual walk — only the memo above calls this. */
	private effectiveUncached(path: string): LayerEntry | 'gone' | null {
		const pending = this.pendingLayers();
		for (let i = pending.length - 1; i >= 0; i--) {
			const layer = pending[i];
			const exact = layer.entries.get(path);
			if (exact) return exact.kind === 'tombstone' ? 'gone' : exact;
			// step: ancestor rulings in this layer shadow deeper paths
			for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
				const ancestor = layer.entries.get(path.slice(0, cut));
				if (ancestor && (ancestor.kind === 'tombstone' || ancestor.kind === 'write')) return 'gone';
			}
		}
		return null;
	}

	/** Whether any pending staged entry exists strictly below a path. */
	private hasStagedDescendant(path: string): boolean {
		const prefix = `${path}/`;
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				if (p.startsWith(prefix) && this.effective(p) !== 'gone' && this.effective(p) !== null) return true;
			}
		}
		return false;
	}

	/**
	 * The content effective BELOW the working layer for a path — what a new
	 * working-layer entry must capture as its `before`.
	 *
	 * @param path - Canonical path.
	 * @returns Content string, or null when the path has no file below.
	 */
	private async effectiveBefore(path: string): Promise<string | null> {
		// step: an existing working-layer entry already carries the capture
		const working = this.layerStack[this.layerStack.length - 1];
		const own = working && !working.committed ? working.entries.get(path) : undefined;
		if (own && own.kind !== 'mkdir') return own.before;
		if (own && own.kind === 'mkdir') return null;
		// step: otherwise the current effective view IS the below-state
		const eff = this.effective(path);
		if (eff === 'gone') return null;
		if (eff && eff.kind === 'write') return eff.content;
		if (eff && eff.kind === 'mkdir') return null;
		try {
			// step: base TRUTH, never a dirty overlay — the base view serves
			// an open editor's buffer from read(), and capturing that as
			// "before" would make staging the same buffer a silent no-op
			const content = await this.base.peekBase(path);
			return typeof content === 'string' ? content : null;
		} catch {
			return null;
		}
	}

	/** Persists layers (when a store exists), then fires the change tick. */
	private async persistAndNotify(): Promise<void> {
		// step: the layers already changed — reads during the persist await
		// must not be served from the pre-change memo
		this.effectiveCache.clear();
		if (this.staging) {
			// step: persistence IS the save — the tick waits for it
			await this.staging.persist(this.layerStack);
		}
		this.notify();
	}

	/** Best-effort GC — failures only leave orphans for the next load(). */
	private async gcBestEffort(): Promise<void> {
		if (!this.staging) return;
		try {
			await this.staging.gc();
		} catch {
			/* orphans are harmless; load() sweeps authoritatively */
		}
	}

	// ── IVirtualFileSystem — reads ───────────────────────────────────────

	/** Lists one directory as the staged union over the base. */
	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		await this.ready;
		const d = this.norm(dir);

		// step: base contribution (a dir may exist only in layers)
		let baseEntries: { name: string; type: 'file' | 'dir' }[] = [];
		try {
			baseEntries = await this.base.list(d);
		} catch {
			baseEntries = [];
		}

		// step: candidate child names = base names + staged direct children
		const candidates = new Map<string, 'file' | 'dir'>();
		for (const e of baseEntries) candidates.set(e.name, e.type);
		const prefix = d ? `${d}/` : '';
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				if (!p.startsWith(prefix) || p === d) continue;
				const rest = p.slice(prefix.length);
				const name = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
				if (!candidates.has(name)) candidates.set(name, 'dir');
			}
		}

		// step: rule each candidate through the effective view
		const out: { name: string; type: 'file' | 'dir' }[] = [];
		for (const [name, baseType] of candidates) {
			const full = prefix + name;
			const eff = this.effective(full);
			if (eff === 'gone') continue;
			if (eff && eff.kind === 'write') { out.push({ name, type: 'file' }); continue; }
			if (eff && eff.kind === 'mkdir') { out.push({ name, type: 'dir' }); continue; }
			if (baseEntries.some((e) => e.name === name)) { out.push({ name, type: baseType }); continue; }
			// step: implied directory — staged entries exist deeper down
			if (this.hasStagedDescendant(full)) out.push({ name, type: 'dir' });
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Reads one file: dirty overlay, then staged layers, then base. */
	async read(path: string): Promise<unknown> {
		await this.ready;
		const p = this.norm(path);
		// step: a dirty editor buffer is the user's live truth — it wins
		if (this.base.isDirty(p)) return this.base.read(p);
		const eff = this.effective(p);
		if (eff === 'gone') throw new Error(`No such file: ${p}`);
		if (eff && eff.kind === 'write') return eff.content;
		if (eff && eff.kind === 'mkdir') throw new Error(`Not a file: ${p}`);
		return this.base.read(p);
	}

	/**
	 * Reads many files in one call, each resolved through the staged view
	 * exactly like read(); unreadable paths (staged-deleted, missing) are
	 * OMITTED rather than failing the batch.
	 *
	 * @param paths - Paths to read.
	 * @returns Map of path to content for every readable path.
	 */
	async readMany(paths: string[]): Promise<Record<string, unknown>> {
		await this.ready;
		const out: Record<string, unknown> = {};
		const passthrough: string[] = [];
		for (const path of paths) {
			const p = this.norm(path);
			// step: dirty overlays and staged rulings answer locally; only
			// the remainder rides the base's batch (one round trip there)
			if (this.base.isDirty(p)) { out[path] = await this.base.read(p); continue; }
			const eff = this.effective(p);
			if (eff === 'gone') continue;
			if (eff && eff.kind === 'write') { out[path] = eff.content; continue; }
			if (eff && eff.kind === 'mkdir') continue;
			passthrough.push(path);
		}
		if (passthrough.length > 0) {
			for (const [path, content] of Object.entries(await this.base.readMany(passthrough))) out[path] = content;
		}
		return out;
	}

	/**
	 * The type of a path, consulting the base backend when neither the
	 * staged layers nor the cached inventory can answer.
	 *
	 * @param path - Path to classify.
	 * @returns 'file' | 'dir', or null when the path does not exist.
	 */
	async stat(path: string): Promise<'file' | 'dir' | null> {
		await this.ready;
		const p = this.norm(path);
		const known = this.entryType(p);
		if (known) return known;
		// step: a staged ruling of 'gone' is final — never ask the base
		if (this.effective(p) === 'gone') return null;
		return this.base.stat(p);
	}

	// ── IVirtualFileSystem — mutations (staged) ──────────────────────────

	/**
	 * Verifies the base has not moved under a path since it was read — the
	 * freshness gate every write-through save passes. Baseline = the base
	 * view's cached content (what the buffer was opened from); current =
	 * a cache-preserving backend peek. Equal hashes (or both absent — a new
	 * file) pass; anything else refuses with StaleWriteError and leaves the
	 * baseline UNTOUCHED, so a blind retry refuses again — exactly VS Code's
	 * behavior. Resolution is the caller's: re-read (adopts the new base as
	 * baseline) then re-save to overwrite deliberately, or revert.
	 *
	 * @param p - The normalized path about to be written.
	 */
	private async guardFreshBase(p: string): Promise<void> {
		const baseline = this.base.cachedContent(p);
		let current: unknown;
		try {
			current = await this.base.peekBase(p);
		} catch {
			current = undefined; // does not exist on the base
		}
		if (baseline === undefined && current === undefined) return; // new file
		if (baseline !== undefined && current !== undefined) {
			const [a, b] = await Promise.all([sha256Hex(String(baseline)), sha256Hex(String(current))]);
			if (a === b) return;
		}
		throw new StaleWriteError(p);
	}

	/** Stages a whole-file write (or passes through in write-through mode). */
	async write(path: string, content: unknown, origin?: string): Promise<void> {
		await this.ready;
		const p = this.norm(path);
		if (this.writeThrough) {
			// step: write-through IS the commit for this path — same freshness
			// discipline commit() applies to staged layers, at save time.
			await this.guardFreshBase(p);
			return this.base.write(p, content, origin);
		}
		if (typeof content !== 'string') {
			throw new Error(`Staged writes are text-only: ${p}`);
		}
		const before = await this.effectiveBefore(p);
		const layer = this.workingLayer();
		const prior = layer.entries.get(p);
		// step: first touch captures the conflict anchor; later touches keep it
		const keepBefore = prior && prior.kind !== 'mkdir' ? prior.before : before;
		// step: a write landing EXACTLY on the below-state is not a change —
		// drop the round-trip entry (save, undo, save-again leaves no residue,
		// exactly git's clean status after a revert). keepBefore IS what reads
		// resolve to once the entry is gone, so deletion is content-neutral.
		if (typeof keepBefore === 'string' && content === keepBefore) {
			if (!prior) return; // no-op save of unchanged content — nothing to stage
			layer.entries.delete(p);
			await this.persistAndNotify();
			// step: the view's content changed (back to the below-state)
			this.onMutate?.(p, origin);
			return;
		}
		const baseHash = keepBefore === null ? null : await sha256Hex(keepBefore);
		layer.entries.set(p, { kind: 'write', content, before: keepBefore, baseHash, stamp: Date.now() });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	/**
	 * Stages a delete (tombstone); directories drop their staged subtree.
	 *
	 * @param path - The target.
	 * @param originOrRecursive - A string = the vfs-layer write ORIGIN (echo
	 *   suppression); a boolean = the WorkspaceFs contract recursive flag,
	 *   which a staged delete does not need (subtrees are shadowed anyway).
	 */
	async delete(path: string, originOrRecursive?: string | boolean): Promise<void> {
		const origin = typeof originOrRecursive === 'string' ? originOrRecursive : undefined;
		await this.ready;
		const p = this.norm(path);
		if (this.writeThrough) return this.base.delete(p, origin);
		if (!p) throw new Error('Refusing to delete the workspace root.');
		// step: rule on the path's KIND first — a missing path is an error,
		// not an invisible forever-pending entry. The dir flag records that
		// the BASE has the directory (a staged-only dir nets to nothing);
		// dirs have no content capture, so existence is their commit anchor
		const kind = await this.stat(p);
		if (kind === null) throw new Error(`No such path: ${p}`);
		const baseKind = kind === 'dir' ? await this.base.stat(p) : null;
		const before = await this.effectiveBefore(p);
		const layer = this.workingLayer();
		// step: staged entries under a deleted directory are swallowed by it
		const prefix = `${p}/`;
		for (const key of [...layer.entries.keys()]) {
			if (key.startsWith(prefix)) layer.entries.delete(key);
		}
		const prior = layer.entries.get(p);
		const keepBefore = prior && prior.kind !== 'mkdir' ? prior.before : before;
		const baseHash = keepBefore === null ? null : await sha256Hex(keepBefore);
		layer.entries.set(p, { kind: 'tombstone', before: keepBefore, baseHash, dir: baseKind === 'dir', stamp: Date.now() });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	/** Stages a file rename as tombstone + write (dirs: commit first). */
	async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
		await this.ready;
		const from = this.norm(oldPath);
		const to = this.norm(newPath);
		if (this.writeThrough) return this.base.rename(from, to, origin);
		// step: a definitive ruling — stat consults the base backend when
		// the inventory has not been walked, so the guard actually holds
		const type = await this.stat(from);
		if (type === 'dir') {
			throw new Error(`Staged directory renames are not supported yet — commit first, then rename ${from}.`);
		}
		const content = await this.read(from);
		if (typeof content !== 'string') throw new Error(`Staged renames are text-only: ${from}`);
		// step: origin rides both halves — each announces through onMutate,
		// matching the backend's both-ends announcement for physical renames
		await this.delete(from, origin);
		await this.write(to, content, origin);
	}

	/**
	 * Stages a directory creation. Creating a directory that already exists
	 * (in the base or staged) is a NO-OP rather than a staged entry, so
	 * changedPaths()/undo never report an "added" directory that was
	 * actually there all along.
	 */
	async mkdir(path: string, origin?: string): Promise<void> {
		await this.ready;
		const p = this.norm(path);
		if (this.writeThrough) return this.base.mkdir(p, origin);
		if (!p) return;
		const existing = await this.stat(p);
		if (existing === 'dir') return;
		if (existing === 'file') throw new Error(`Not a directory: ${p}`);
		this.workingLayer().entries.set(p, { kind: 'mkdir', stamp: Date.now() });
		await this.persistAndNotify();
		this.onMutate?.(p, origin);
	}

	// ── IWorkspaceFileSystem — view surface ──────────────────────────────

	/** Re-walks the base inventory. */
	refresh(): Promise<void> {
		return this.base.refresh();
	}

	/** The staged union of the base inventory and layer-created paths. */
	listEntries(): VfsEntry[] {
		const out = new Map<string, 'file' | 'dir'>();
		// step: base inventory, minus staged-gone paths
		for (const e of this.base.listEntries()) {
			if (this.effective(e.path) !== 'gone') out.set(e.path, e.type);
		}
		// step: staged creations (and their implicit parent dirs)
		for (const layer of this.pendingLayers()) {
			for (const [p, entry] of layer.entries) {
				const eff = this.effective(p);
				if (eff === 'gone' || eff === null) continue;
				if (entry.kind === 'write') out.set(p, 'file');
				if (entry.kind === 'mkdir') out.set(p, 'dir');
				for (let cut = p.lastIndexOf('/'); cut > 0; cut = p.lastIndexOf('/', cut - 1)) {
					const parent = p.slice(0, cut);
					if (!out.has(parent)) out.set(parent, 'dir');
				}
			}
		}
		return [...out.entries()].map(([path, type]) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path));
	}

	/** The staged kind of a path. */
	entryType(path: string): 'file' | 'dir' | null {
		const p = this.norm(path);
		const eff = this.effective(p);
		if (eff === 'gone') return null;
		if (eff && eff.kind === 'write') return 'file';
		if (eff && eff.kind === 'mkdir') return 'dir';
		const baseType = this.base.entryType(p);
		if (baseType) return baseType;
		return this.hasStagedDescendant(p) ? 'dir' : null;
	}

	/** Inventory seed — delegates to the base. */
	upsert(path: string, type: 'file' | 'dir'): void {
		this.base.upsert(path, type);
	}

	/** Content-cache seed — delegates to the base. */
	prime(path: string, content: unknown): void {
		this.base.prime(path, content);
	}

	/** Content-cache eviction — delegates to the base. */
	invalidate(path?: string): void {
		this.base.invalidate(path);
	}

	/** Editor overlays live on the base (one registry for all views). */
	registerOverlay(path: string, overlay: VfsOverlay): () => void {
		return this.base.registerOverlay(this.norm(path), overlay);
	}

	/** The base view's cached baseline content (freshness-gate anchor). */
	cachedContent(path: string): unknown {
		return this.base.cachedContent(this.norm(path));
	}

	/** Current base truth — bypasses staged layers, overlays, and caches. */
	peekBase(path: string): Promise<unknown> {
		return this.base.peekBase(this.norm(path));
	}

	/** Dirty state is the base's (editor buffers). */
	isDirty(path: string): boolean {
		return this.base.isDirty(this.norm(path));
	}

	/** Dirty paths are the base's (editor buffers). */
	dirtyPaths(): Set<string> {
		return this.base.dirtyPaths();
	}

	/** Subscribes to the single change stream (layers + base). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Fires the change tick (and drops the per-tick effective() memo). */
	notify(): void {
		this.effectiveCache.clear();
		for (const listener of [...this.listeners]) listener();
	}

	// ── Staging surface — checkpoints, commit, rollback, undo ───────────

	/** The current layers, oldest first (read-only view for UI). */
	getLayers(): readonly Layer[] {
		return this.layerStack;
	}

	// ── WorkspaceFs surface (the shell contract; wire shapes) ────────────

	/** The pending snapshot — one call for badges and gates. */
	async pending(): Promise<PendingState> {
		return {
			hasPending: this.hasPendingChanges(),
			changedPaths: Object.fromEntries(this.changedPaths()),
			dirtyPaths: [...this.dirtyPaths()],
		};
	}

	/** Layer METADATA (contents never cross a realm). */
	async layers(): Promise<LayerMeta[]> {
		return this.layerStack.map((l) => ({
			id: l.id,
			label: l.label,
			...(l.sessionId !== undefined ? { sessionId: l.sessionId } : {}),
			...(l.committed !== undefined ? { committed: l.committed } : {}),
			entryCount: l.entries.size,
		}));
	}

	/** Reads a file as UTF-8 text (JSON content is stringified). */
	async readTextFile(path: string): Promise<string> {
		const v = await this.read(path);
		return typeof v === 'string' ? v : JSON.stringify(v);
	}

	/** Writes UTF-8 text. */
	async writeTextFile(path: string, text: string): Promise<void> {
		await this.write(path, text);
	}

	/** Reads a file as base64, size-gated (null = missing / too large). */
	async readFileBase64(path: string, maxBytes: number): Promise<string | null> {
		const v = await this.read(path).catch(() => null);
		if (v === null || v === undefined) return null;
		const bytes = new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
		if (bytes.length > maxBytes) return null;
		let bin = '';
		for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	/** Writes binary carried as base64 (decoded as UTF-8 text — the store
	 *  is text-shaped; true binary rides the store's handle API). */
	async writeFileBase64(path: string, dataB64: string): Promise<void> {
		const bin = atob(dataB64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		await this.write(path, new TextDecoder().decode(bytes));
	}

	/** Glob search over the staged inventory. */
	async findFiles(include: string, exclude?: string): Promise<string[]> {
		await this.ready;
		const inc = globToRegExp(include);
		const exc = exclude ? globToRegExp(exclude) : null;
		return this.listEntries()
			.filter((e) => e.type === 'file' && inc.test(e.path) && !(exc && exc.test(e.path)))
			.map((e) => e.path);
	}

	/** Single virtual root — paths are already workspace-relative. */
	async workspaceRoots(): Promise<string[]> {
		return [];
	}

	/** Change watch. The staged view's change stream is tick-only, so
	 *  every event is the synthetic '' ("re-evaluate everything"). */
	watch(_globs: string[], onEvent: (path: string) => void): () => void {
		return this.subscribe(() => onEvent(''));
	}

	/**
	 * Freezes the working layer as a checkpoint; subsequent mutations open
	 * a fresh working layer.
	 *
	 * @param label - Display label (e.g. the turn title).
	 * @param sessionId - The agent session that produced it, when any.
	 * @returns The frozen layer's id, or null when nothing was staged.
	 */
	async checkpoint(label: string, sessionId?: string): Promise<string | null> {
		const last = this.layerStack[this.layerStack.length - 1];
		if (!last || last.committed || last.entries.size === 0) return null;
		last.label = label;
		if (sessionId) last.sessionId = sessionId;
		// step: the next mutation creates a fresh working layer above this one
		this.layerStack.push({ id: crypto.randomUUID(), label: 'Working', entries: new Map() });
		await this.persistAndNotify();
		return last.id;
	}

	/**
	 * Truncates the stack back to a checkpoint ("roll back to here"):
	 * every layer above it is dropped. Server untouched.
	 *
	 * @param layerId - The checkpoint to become the top of the stack.
	 */
	async rollback(layerId: string): Promise<void> {
		const idx = this.layerStack.findIndex((l) => l.id === layerId);
		if (idx < 0) throw new Error(`No such checkpoint: ${layerId}`);
		const dropped = this.layerStack.slice(idx + 1);
		this.layerStack = this.layerStack.slice(0, idx + 1);
		this.evictDroppedFromBaseCache(dropped);
		await this.persistAndNotify();
		this.announceDropped(dropped);
		await this.gcBestEffort();
	}

	/**
	 * Drops ONE path's pending changes from every pending layer — the
	 * per-file "git checkout -- <path>": the next read sees the base again.
	 * A rename's two paths are independent entries (write + tombstone), so
	 * discarding one side leaves the other staged — per-path semantics,
	 * exactly like git's. Server untouched.
	 *
	 * @param path - The path to revert.
	 */
	async discardPath(path: string): Promise<void> {
		const p = this.norm(path);
		let touched = false;
		for (const layer of this.pendingLayers()) {
			if (layer.entries.delete(p)) touched = true;
		}
		if (!touched) return;
		// A consumer may have primed the base with content reflecting the
		// staged state — same eviction rule as rollback/discard.
		this.base.invalidate(p);
		await this.persistAndNotify();
		// step: the path's effective content reverted to the base — announce,
		// so per-path consumers (editor models) re-read instead of going stale
		this.onMutate?.(p);
		await this.gcBestEffort();
	}

	/**
	 * Drops pending changes. Server untouched.
	 *
	 * @param path - One path only; omitted = everything pending.
	 */
	async discard(path?: string): Promise<void> {
		if (path !== undefined) return this.discardPath(path);
		const dropped = this.pendingLayers();
		this.layerStack = this.layerStack.filter((l) => l.committed);
		this.evictDroppedFromBaseCache(dropped);
		if (this.layerStack.length === 0 && this.staging) {
			await this.staging.sweep();
			this.notify();
			this.announceDropped(dropped);
			return;
		}
		await this.persistAndNotify();
		this.announceDropped(dropped);
		await this.gcBestEffort();
	}

	/**
	 * Announces every path a dropped layer set touched — discard/rollback
	 * change effective content WITHOUT a base write, so no backend
	 * announcement exists; without this, per-path consumers (dev-session
	 * Monaco models) keep the rolled-back content forever.
	 *
	 * @param dropped - The layers removed from the stack.
	 */
	private announceDropped(dropped: readonly Layer[]): void {
		if (!this.onMutate) return;
		const paths = new Set<string>();
		for (const layer of dropped) for (const p of layer.entries.keys()) paths.add(p);
		for (const p of paths) this.onMutate(p);
	}

	/**
	 * Evicts dropped layers' paths from the base content cache: a consumer
	 * (bulk loader, dev session) may have primed the base with content that
	 * REFLECTED the staged state — after a rollback/discard those entries
	 * would keep serving rolled-back content forever.
	 *
	 * @param dropped - The layers removed from the stack.
	 */
	private evictDroppedFromBaseCache(dropped: readonly Layer[]): void {
		for (const layer of dropped) {
			for (const p of layer.entries.keys()) this.base.invalidate(p);
		}
	}

	/**
	 * How each staged path differs from the base — badges and review rows.
	 *
	 * @returns Map of canonical path to change kind.
	 */
	changedPaths(): Map<string, ChangeKind> {
		const out = new Map<string, ChangeKind>();
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				const eff = this.effective(p);
				if (eff === null) continue;
				if (eff === 'gone') {
					// visible only when the base actually had the path (content
					// capture for files, the dir flag for directories)
					const first = this.firstEntry(p);
					if (first && first.kind !== 'mkdir' && (first.before !== null || (first.kind === 'tombstone' && first.dir))) out.set(p, 'deleted');
					continue;
				}
				if (eff.kind === 'mkdir') { out.set(p, 'added'); continue; }
				if (eff.kind === 'write') {
					const first = this.firstEntry(p);
					const hadBefore = first && first.kind !== 'mkdir' ? first.before !== null : false;
					// step: net identity across layers (changed in a frozen
					// checkpoint, reverted in the working layer) is git-clean —
					// the effective content IS the original capture
					if (hadBefore && first && first.kind !== 'mkdir' && eff.content === first.before) continue;
					out.set(p, hadBefore ? 'modified' : 'added');
				}
			}
		}
		return out;
	}

	/**
	 * Before/after content for review diffs.
	 *
	 * @param path - Canonical path.
	 * @returns Captured before-content and current effective content.
	 */
	async diff(path: string): Promise<{ before: string | null; after: string | null }> {
		const p = this.norm(path);
		const first = this.firstEntry(p);
		const before = first && first.kind !== 'mkdir'
			? first.before
			: await this.effectiveBefore(p);
		let after: string | null = null;
		try {
			const content = await this.read(p);
			after = typeof content === 'string' ? content : null;
		} catch {
			after = null;
		}
		return { before, after };
	}

	/** The OLDEST pending entry for a path (the original capture). */
	private firstEntry(path: string): LayerEntry | null {
		for (const layer of this.pendingLayers()) {
			const entry = layer.entries.get(path);
			if (entry) return entry;
		}
		return null;
	}

	/** The net effect per path across all pending layers (top-wins). */
	private netOps(): Map<string, LayerEntry> {
		const net = new Map<string, LayerEntry>();
		for (const layer of this.pendingLayers()) {
			for (const p of layer.entries.keys()) {
				if (net.has(p)) continue;
				const eff = this.effective(p);
				if (eff === 'gone') {
					const first = this.firstEntry(p);
					// deletes only matter when the base actually has the path —
					// content capture for files, the dir flag for directories
					if (first && first.kind === 'tombstone' && (first.before !== null || first.dir)) {
						net.set(p, { kind: 'tombstone', before: first.before, baseHash: first.baseHash, dir: first.dir, stamp: Date.now() });
					} else if (first && first.kind === 'write' && first.before !== null) {
						net.set(p, { kind: 'tombstone', before: first.before, baseHash: first.baseHash, stamp: Date.now() });
					}
				} else if (eff) {
					// carry the ORIGINAL capture so conflicts anchor to first touch
					const first = this.firstEntry(p);
					if (eff.kind === 'write' && first && first.kind !== 'mkdir') {
						// step: net-identity writes replay NOTHING — the content
						// already equals the original capture (mirrors the
						// changedPaths() ruling, so commit matches the badge list)
						if (first.before !== null && eff.content === first.before) continue;
						net.set(p, { ...eff, before: first.before, baseHash: first.baseHash });
					} else {
						net.set(p, eff);
					}
				}
			}
		}
		return net;
	}

	/**
	 * Verifies every staged path against the live base, then replays the
	 * net operations onto it — the only server write.
	 *
	 * ATOMIC-VERIFY / BEST-EFFORT-REPLAY: the verify phase is all-or-nothing
	 * (any conflict aborts with NOTHING written), but the replay phase is a
	 * sequence of independent backend writes — a mid-replay transport
	 * failure leaves the base partially written while the layers (still
	 * intact; they are only swept after a full replay) hold the complete
	 * intent, so re-running commit() finishes the job. There is no server
	 * transaction to lean on; this is the honest contract.
	 *
	 * @param options.retain - Keep the layers as inert history (auto mode
	 *   undo); otherwise layers and staging are swept.
	 * @returns Committed count, or the conflicts that blocked it.
	 */
	async commit(options: { retain?: boolean } = {}): Promise<CommitResult> {
		await this.ready;
		const net = this.netOps();
		if (net.size === 0) return { committed: 0, conflicts: [] };

		// step: verify — the base must still match every first-touch capture.
		// Tombstones whose outcome the base ALREADY holds are marked converged
		// and excluded from the replay (deleting a gone path would throw).
		const conflicts: StagedConflict[] = [];
		const converged = new Set<string>();
		for (const [p, entry] of net) {
			if (entry.kind === 'mkdir') continue;
			// step: a DIRECTORY tombstone anchors on existence, not content —
			// gone already = converged; still a dir = passes and replays
			if (entry.kind === 'tombstone' && entry.dir) {
				if ((await this.base.stat(p)) === null) converged.add(p);
				continue;
			}
			let current: string | null = null;
			try {
				// step: base truth, never a dirty overlay (see effectiveBefore)
				const content = await this.base.peekBase(p);
				current = typeof content === 'string' ? content : null;
			} catch {
				current = null;
			}
			// step: convergence — a base that already holds this entry's net
			// OUTCOME (same content, or already deleted) is never a conflict;
			// this is what lets a re-run finish a partially replayed commit
			if (entry.kind === 'write' && current === entry.content) continue;
			if (entry.kind === 'tombstone' && current === null) {
				converged.add(p);
				continue;
			}
			if (entry.baseHash === null) {
				if (current !== null) conflicts.push({ path: p, reason: 'resurrected' });
			} else if (current === null) {
				conflicts.push({ path: p, reason: 'missing' });
			} else if ((await sha256Hex(current)) !== entry.baseHash) {
				conflicts.push({ path: p, reason: 'changed' });
			}
		}
		if (conflicts.length > 0) return { committed: 0, conflicts };

		// step: replay — mkdirs shallow-first, writes, deletes deep-first
		const paths = [...net.keys()];
		const depth = (p: string) => p.split('/').length;
		for (const p of paths.filter((x) => net.get(x)!.kind === 'mkdir').sort((a, b) => depth(a) - depth(b))) {
			await this.base.mkdir(p);
		}
		for (const p of paths.filter((x) => net.get(x)!.kind === 'write')) {
			const entry = net.get(p)! as Extract<LayerEntry, { kind: 'write' }>;
			await this.base.write(p, entry.content);
		}
		for (const p of paths.filter((x) => net.get(x)!.kind === 'tombstone' && !converged.has(x)).sort((a, b) => depth(b) - depth(a))) {
			await this.base.delete(p);
		}

		// step: sweep or retain
		if (options.retain) {
			for (const layer of this.layerStack) {
				if (layer.entries.size > 0) layer.committed = true;
			}
			this.layerStack = this.layerStack.filter((l) => l.entries.size > 0);
			await this.persistAndNotify();
			await this.gcBestEffort();
		} else {
			this.layerStack = [];
			if (this.staging) await this.staging.sweep();
			this.notify();
		}
		return { committed: net.size, conflicts: [] };
	}

	/**
	 * Inverse-replays a retained (committed) checkpoint AND everything
	 * committed after it — auto mode's "Undo this turn". Hash-guarded: if
	 * any affected file changed on the base since its commit, nothing is
	 * undone and the conflicts are returned.
	 *
	 * @param layerId - The oldest checkpoint to undo.
	 * @returns Undone path count, or blocking conflicts.
	 */
	async undoTurn(layerId: string): Promise<CommitResult> {
		await this.ready;
		const idx = this.layerStack.findIndex((l) => l.id === layerId);
		if (idx < 0 || !this.layerStack[idx].committed) throw new Error(`No such committed checkpoint: ${layerId}`);
		const undoing = this.layerStack.slice(idx).filter((l) => l.committed);

		// step: inverse per path = the OLDEST capture among undone layers;
		// expected current = the NEWEST write among them
		const inverse = new Map<string, { before: string | null; expected: string | null }>();
		for (const layer of undoing) {
			for (const [p, entry] of layer.entries) {
				if (entry.kind === 'mkdir') continue;
				const prior = inverse.get(p);
				const expected = entry.kind === 'write' ? entry.content : null;
				// step: oldest capture is the restore target; newest op is the guard
				if (!prior) inverse.set(p, { before: entry.before, expected });
				else prior.expected = expected;
			}
		}

		// step: guard — the base must still hold what these turns wrote
		const conflicts: StagedConflict[] = [];
		for (const [p, { expected }] of inverse) {
			let current: string | null = null;
			try {
				// step: base truth, never a dirty overlay (see effectiveBefore)
				const content = await this.base.peekBase(p);
				current = typeof content === 'string' ? content : null;
			} catch {
				current = null;
			}
			if (current !== expected) conflicts.push({ path: p, reason: 'changed' });
		}
		if (conflicts.length > 0) return { committed: 0, conflicts };

		// step: inverse replay — restore before-content, delete creations
		for (const [p, { before }] of inverse) {
			if (before === null) await this.base.delete(p);
			else await this.base.write(p, before);
		}

		// step: the undone history is spent
		this.layerStack = this.layerStack.filter((l) => !undoing.includes(l));
		if (this.layerStack.length === 0 && this.staging) {
			await this.staging.sweep();
			this.notify();
		} else {
			await this.persistAndNotify();
			await this.gcBestEffort();
		}
		return { committed: inverse.size, conflicts: [] };
	}
}
