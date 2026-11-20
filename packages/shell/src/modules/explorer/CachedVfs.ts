// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CachedVfs — a caching {@link IVirtualFileSystem} decorator with overlays.
 *
 * Wraps any backing VFS and adds the state a file UI needs but the plain
 * interface cannot answer synchronously:
 *
 *  - TREE CACHE: one `refresh()` walks the backend recursively and records
 *    EVERY entry (directories and files alike); `listEntries()` then serves
 *    the whole inventory synchronously. `list()` answers from the cache.
 *  - CONTENT CACHE: `read()` results are retained per path, so re-reads are
 *    free; `prime()` fills the cache from bulk loads that bypass `read()`.
 *  - OVERLAYS: a live producer (e.g. an open editor buffer) registers per
 *    path; while its `isDirty()` is true, `read()` serves the overlay's
 *    content — every consumer sees the CURRENT truth through one seam
 *    without knowing an editor exists.
 *  - DIRTY: `isDirty(path)` / `dirtyPaths()` aggregate the overlays, so a
 *    file tree can decorate unsaved files without touching the editor.
 *
 * Ownership model: the VFS owns WHAT EXISTS (the tree, the persisted or
 * cached content); overlays own WHAT IS BEING TYPED. Writes go through the
 * backend and update the cache; the overlay's registrar is responsible for
 * clearing its own dirty state after a save and calling `notify()`.
 */

import type { IVirtualFileSystem } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** One entry of the cached tree inventory. */
export interface VfsEntry {
	/** Full relative path (POSIX, '' never appears — the root is implicit). */
	path: string;
	/** Entry type. */
	type: 'file' | 'dir';
}

/**
 * A live content source layered over one file (typically an editor buffer).
 * While `isDirty()` is true, `read()` serves `getContent()` instead of the
 * cache/backend — the overlay is the current truth for that path.
 */
export interface VfsOverlay {
	/** The overlay's current content (same type the backend would return). */
	getContent(): unknown;
	/** Whether the overlay differs from the persisted content. */
	isDirty(): boolean;
}

/** Constructor options for {@link CachedVfs}. */
export interface CachedVfsOptions {
	/**
	 * Directory NAMES `refresh()` never descends into (derived outputs like
	 * `node_modules`, `dist` — machine truth, not user truth).
	 */
	skipDirs?: readonly string[];
}

// =============================================================================
// CACHED VFS
// =============================================================================

/**
 * A caching, overlay-aware decorator over a backing {@link IVirtualFileSystem}.
 */
export class CachedVfs implements IVirtualFileSystem {
	private readonly backend: IVirtualFileSystem;
	private readonly skipDirs: Set<string>;
	/** The tree inventory: path -> entry type. Filled by refresh()/upsert(). */
	private readonly entries = new Map<string, 'file' | 'dir'>();
	/** The content cache: path -> last read/written/primed content. */
	private readonly contents = new Map<string, unknown>();
	/** Live overlays: path -> content producer. */
	private readonly overlays = new Map<string, VfsOverlay>();
	/** Change listeners (tree, cache, or dirty-state changes). */
	private readonly listeners = new Set<() => void>();
	/** Whether refresh() has completed at least once. */
	private treeLoaded = false;

	/**
	 * @param backend - The backing VFS every miss and write goes through.
	 * @param options - See {@link CachedVfsOptions}.
	 */
	constructor(backend: IVirtualFileSystem, options?: CachedVfsOptions) {
		this.backend = backend;
		this.skipDirs = new Set(options?.skipDirs ?? []);
	}

	// =========================================================================
	// TREE INVENTORY
	// =========================================================================

	/**
	 * Rebuilds the tree inventory with one recursive backend walk. Cached
	 * content of paths that vanished from the tree is dropped.
	 */
	async refresh(): Promise<void> {
		const next = new Map<string, 'file' | 'dir'>();
		/** Walks one directory level into `next`. */
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await this.backend.list(dir)) {
				const path = dir ? `${dir}/${entry.name}` : entry.name;
				next.set(path, entry.type);
				if (entry.type === 'dir' && !this.skipDirs.has(entry.name)) await walk(path);
			}
		};
		await walk('');
		// step: adopt the fresh tree and evict cached content of vanished paths
		this.entries.clear();
		for (const [path, type] of next) this.entries.set(path, type);
		for (const path of [...this.contents.keys()]) {
			if (!this.entries.has(path)) this.contents.delete(path);
		}
		this.treeLoaded = true;
		this.notify();
	}

	/** The full cached inventory (files AND directories), sorted by path. */
	listEntries(): VfsEntry[] {
		return [...this.entries.entries()]
			.map(([path, type]) => ({ path, type }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** The cached type of a path (null = not in the tree). */
	entryType(path: string): 'file' | 'dir' | null {
		return this.entries.get(path) ?? null;
	}

	/**
	 * The type of a path, loading the tree inventory first when it has not
	 * been walked yet — the ASYNC counterpart of entryType() for callers
	 * that must have a real answer (e.g. a rename's directory guard).
	 *
	 * @param path - The relative path.
	 * @returns 'file' | 'dir', or null when the path does not exist.
	 */
	async stat(path: string): Promise<'file' | 'dir' | null> {
		if (!this.treeLoaded) await this.refresh();
		return this.entryType(path);
	}

	/**
	 * Records an entry (plus its ancestor directories) without a backend
	 * round trip — for adopting externally announced changes.
	 *
	 * @param path - The relative path.
	 * @param type - The entry type.
	 */
	upsert(path: string, type: 'file' | 'dir'): void {
		this.ensureEntry(path, type);
		this.notify();
	}

	/** Entry bookkeeping shared by upsert/write/prime (no notify). */
	private ensureEntry(path: string, type: 'file' | 'dir'): void {
		this.entries.set(path, type);
		// step: synthesize the ancestor directory chain
		let idx = path.lastIndexOf('/');
		while (idx > 0) {
			this.entries.set(path.substring(0, idx), 'dir');
			idx = path.lastIndexOf('/', idx - 1);
		}
	}

	/** Drops a path (and, for directories, its whole subtree) everywhere. */
	private evict(path: string): void {
		const prefix = `${path}/`;
		for (const map of [this.entries, this.contents] as Array<Map<string, unknown>>) {
			map.delete(path);
			for (const key of [...map.keys()]) {
				if (key.startsWith(prefix)) map.delete(key);
			}
		}
	}

	// =========================================================================
	// CONTENT CACHE + OVERLAYS
	// =========================================================================

	/**
	 * Fills the content cache (and the tree) for one file WITHOUT a backend
	 * read — the seam for bulk loaders that fetch many files in one batch.
	 * Does not notify: bulk callers announce once when the sweep completes.
	 *
	 * @param path - The relative file path.
	 * @param content - The file's content.
	 */
	prime(path: string, content: unknown): void {
		this.ensureEntry(path, 'file');
		this.contents.set(path, content);
	}

	/**
	 * Drops cached content — one path, or the whole cache when omitted. The
	 * next `read()` goes back to the overlay/backend.
	 *
	 * @param path - The relative file path (omit for all).
	 */
	invalidate(path?: string): void {
		if (path === undefined) this.contents.clear();
		else this.contents.delete(path);
	}

	/**
	 * The cached content of a path — the BASELINE an open editor buffer was
	 * read from (undefined = never read/primed). Synchronous and side-effect
	 * free: the freshness gate compares this against peekBase() before a
	 * write-through save.
	 *
	 * @param path - The relative file path.
	 * @returns The cached content, or undefined when not cached.
	 */
	cachedContent(path: string): unknown {
		return this.contents.get(path);
	}

	/**
	 * Reads CURRENT backend truth, bypassing overlays AND the content cache
	 * — and deliberately NOT updating the cache: the cache is the baseline
	 * an open buffer was read from, and a freshness probe that replaced it
	 * would make the very conflict it just detected invisible to the next
	 * probe (a blind retry-save would then pass the gate).
	 *
	 * @param path - The relative file path.
	 * @returns The backend's current content.
	 */
	peekBase(path: string): Promise<unknown> {
		return this.backend.read(path);
	}

	/**
	 * Registers a live content overlay for one file.
	 *
	 * @param path - The relative file path.
	 * @param overlay - The content producer.
	 * @returns Unregister function.
	 */
	registerOverlay(path: string, overlay: VfsOverlay): () => void {
		this.overlays.set(path, overlay);
		return () => {
			// step: unregister by IDENTITY, not by the registration path — a
			// rename() migrates overlays to the new prefix, and the disposer
			// must still find (and only find) its own entry afterwards
			for (const [p, o] of this.overlays) {
				if (o === overlay) {
					this.overlays.delete(p);
					break;
				}
			}
		};
	}

	/** Whether a path has unsaved overlay edits. */
	isDirty(path: string): boolean {
		return this.overlays.get(path)?.isDirty() ?? false;
	}

	/** Every path whose overlay is currently dirty. */
	dirtyPaths(): Set<string> {
		const dirty = new Set<string>();
		for (const [path, overlay] of this.overlays) {
			if (overlay.isDirty()) dirty.add(path);
		}
		return dirty;
	}

	// =========================================================================
	// CHANGE NOTIFICATION
	// =========================================================================

	/**
	 * Subscribes to change notifications (tree, cache, or dirty flips).
	 *
	 * @param listener - Invoked on every announced change.
	 * @returns Unsubscribe function.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Announces a change to every subscriber. Public by design: overlay
	 * registrars call it when their dirty state flips — the VFS cannot see
	 * those transitions itself.
	 */
	notify(): void {
		for (const listener of this.listeners) listener();
	}

	// =========================================================================
	// IVirtualFileSystem
	// =========================================================================

	/**
	 * Lists a directory from the tree cache (first call triggers the walk).
	 *
	 * @param dir - Relative directory path ('' for root).
	 */
	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		if (!this.treeLoaded) await this.refresh();
		const prefix = dir ? `${dir}/` : '';
		const out: { name: string; type: 'file' | 'dir' }[] = [];
		for (const [path, type] of this.entries) {
			if (!path.startsWith(prefix)) continue;
			const remainder = path.substring(prefix.length);
			if (remainder && remainder.indexOf('/') === -1) out.push({ name: remainder, type });
		}
		return out;
	}

	/**
	 * Reads one file: dirty overlay first, then the content cache, then the
	 * backend (whose result is cached).
	 *
	 * @param path - Relative file path.
	 */
	async read(path: string): Promise<unknown> {
		const overlay = this.overlays.get(path);
		if (overlay?.isDirty()) return overlay.getContent();
		if (this.contents.has(path)) return this.contents.get(path);
		const content = await this.backend.read(path);
		this.contents.set(path, content);
		return content;
	}

	/**
	 * Reads many files in one call: dirty overlays and cache hits answer
	 * locally; the misses go to the backend in ONE batch when it offers
	 * readMany (falling back to parallel single reads). Unreadable paths
	 * are OMITTED from the result rather than failing the batch.
	 *
	 * @param paths - Relative file paths.
	 * @returns Map of path to content for every readable path.
	 */
	async readMany(paths: string[]): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		const misses: string[] = [];
		for (const path of paths) {
			const overlay = this.overlays.get(path);
			if (overlay?.isDirty()) { out[path] = overlay.getContent(); continue; }
			if (this.contents.has(path)) { out[path] = this.contents.get(path); continue; }
			misses.push(path);
		}
		if (misses.length === 0) return out;
		if (this.backend.readMany) {
			for (const [path, content] of Object.entries(await this.backend.readMany(misses))) {
				this.contents.set(path, content);
				out[path] = content;
			}
			return out;
		}
		await Promise.all(misses.map(async (path) => {
			try {
				const content = await this.backend.read(path);
				this.contents.set(path, content);
				out[path] = content;
			} catch { /* unreadable — omitted by contract */ }
		}));
		return out;
	}

	/**
	 * Writes one file through the backend and updates the caches.
	 *
	 * @param path - Relative file path.
	 * @param content - The content to persist.
	 * @param origin - The writer's identity, forwarded to the backend.
	 */
	async write(path: string, content: unknown, origin?: string): Promise<void> {
		await this.backend.write(path, content, origin);
		this.ensureEntry(path, 'file');
		this.contents.set(path, content);
		this.notify();
	}

	/**
	 * Renames through the backend and migrates the cached state.
	 *
	 * @param oldPath - Current relative path.
	 * @param newPath - New relative path.
	 * @param origin - The writer's identity, forwarded to the backend.
	 */
	async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
		await this.backend.rename(oldPath, newPath, origin);
		const type = this.entries.get(oldPath) ?? 'file';
		// step: migrate the subtree's cached entries/content to the new prefix
		const prefix = `${oldPath}/`;
		const movedEntries = [...this.entries].filter(([p]) => p === oldPath || p.startsWith(prefix));
		const movedContents = [...this.contents].filter(([p]) => p === oldPath || p.startsWith(prefix));
		// step: overlays ride along — a dirty buffer must keep serving read()
		// at the NEW path, and dirtyPaths() must stop naming the old one
		const movedOverlays = [...this.overlays].filter(([p]) => p === oldPath || p.startsWith(prefix));
		this.evict(oldPath);
		this.ensureEntry(newPath, type);
		for (const [p, t] of movedEntries) this.entries.set(`${newPath}${p.substring(oldPath.length)}`, t);
		for (const [p, c] of movedContents) this.contents.set(`${newPath}${p.substring(oldPath.length)}`, c);
		for (const [p, o] of movedOverlays) {
			this.overlays.delete(p);
			this.overlays.set(`${newPath}${p.substring(oldPath.length)}`, o);
		}
		this.notify();
	}

	/**
	 * Deletes through the backend and evicts the cached subtree.
	 *
	 * @param path - Relative path to delete.
	 * @param origin - The writer's identity, forwarded to the backend.
	 */
	async delete(path: string, origin?: string): Promise<void> {
		await this.backend.delete(path, origin);
		this.evict(path);
		this.notify();
	}

	/**
	 * Creates a directory through the backend and records it.
	 *
	 * @param path - Relative directory path.
	 * @param origin - The writer's identity, forwarded to the backend.
	 */
	async mkdir(path: string, origin?: string): Promise<void> {
		await this.backend.mkdir(path, origin);
		this.ensureEntry(path, 'dir');
		this.notify();
	}
}
