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
// WORKSPACE FILESYSTEM TYPES — the view contract every consumer is typed to
// =============================================================================

/**
 * Role doctrine for the workspace storage stack:
 *
 *   - `IVirtualFileSystem` (shell) — the stateless BACKEND contract: six
 *     async methods answering "where do bytes live". Implementations are
 *     dumb adapters (store wire, VS Code bridge, mocks); no cache, no
 *     inventory, no events.
 *   - `IWorkspaceFileSystem` (this file) — the consumer VIEW contract:
 *     everything UI and tooling need on top of a backend — the cached tree
 *     inventory, content cache, editor overlays, and change subscription.
 *   - Two view implementations exist: the shell's `CachedVfs` (satisfies
 *     this interface structurally; a plain cached mirror of its backend)
 *     and `StagedFileSystem` (staged layers with commit/rollback over
 *     another view).
 *   - `scopedFileSystem` is a prefix lens, view -> view.
 *
 * Consumers type against THIS interface, never the CachedVfs class — nominal
 * class typing would shut out the staged view, lenses, and test doubles.
 * Member signatures deliberately match CachedVfs's public surface verbatim.
 */

import type { IVirtualFileSystem, VfsEntry, VfsOverlay } from 'shell';

export type { IVirtualFileSystem, VfsEntry, VfsOverlay } from 'shell';

// =============================================================================
// THE VIEW CONTRACT
// =============================================================================

/**
 * The workspace view: a backend plus the consumer surface (inventory cache,
 * content cache, overlays, subscription). Signatures mirror the shell's
 * CachedVfs public API exactly so CachedVfs satisfies this structurally.
 */
/**
 * BINARY SEMANTICS (contract-wide): the view's content type is TEXT.
 * `read()` passes whatever the backend returns straight through, but the
 * STAGED layers hold strings only — a staged write of non-string content is
 * refused in BOTH modes (never mode-dependent behavior), and binary assets
 * (icons, images) are read through the documented raw escape hatch until
 * binary reads land on this contract.
 */
export interface IWorkspaceFileSystem extends IVirtualFileSystem {
	/** Re-walks the tree inventory from the backend and notifies. */
	refresh(): Promise<void>;

	/**
	 * Reads many files in one call — the batch seam, so bulk consumers
	 * (pack, export) issue ONE view call instead of merging per-path reads
	 * against staged membership themselves.
	 *
	 * @param paths - Paths to read.
	 * @returns Map of path to content; unreadable paths are omitted.
	 */
	readMany(paths: string[]): Promise<Record<string, unknown>>;

	/**
	 * The type of a path, consulting the backend when the cached inventory
	 * cannot answer — the async counterpart of entryType() for callers that
	 * need a definitive ruling (e.g. a rename's directory guard).
	 *
	 * @param path - Path to classify.
	 * @returns 'file' | 'dir', or null when the path does not exist.
	 */
	stat(path: string): Promise<'file' | 'dir' | null>;

	/** The full cached inventory (files AND dirs), sorted by path. */
	listEntries(): VfsEntry[];

	/**
	 * The cached kind of a path.
	 *
	 * @param path - Path to classify.
	 * @returns 'file' | 'dir' when known, null when absent/not loaded.
	 */
	entryType(path: string): 'file' | 'dir' | null;

	/**
	 * Records a path in the inventory without a backend walk.
	 *
	 * @param path - The path to record.
	 * @param type - Its kind.
	 */
	upsert(path: string, type: 'file' | 'dir'): void;

	/**
	 * Seeds the content cache without a backend read. Does not notify.
	 *
	 * @param path - The path to seed.
	 * @param content - The content to cache.
	 */
	prime(path: string, content: unknown): void;

	/**
	 * Evicts cached content (one path, or everything when omitted).
	 *
	 * @param path - The path to evict; omit to clear the whole cache.
	 */
	invalidate(path?: string): void;

	/**
	 * The cached BASELINE content of a path (what an open buffer was read
	 * from), or undefined when never read. Side-effect free.
	 *
	 * @param path - The path to look up.
	 */
	cachedContent(path: string): unknown;

	/**
	 * Current BASE truth for a path, bypassing overlays, caches, and staged
	 * layers — and never mutating the cache (the baseline must survive a
	 * freshness probe, or a detected conflict would vanish on retry).
	 *
	 * @param path - The path to probe.
	 * @returns The backend's current content; rejects when it doesn't exist.
	 */
	peekBase(path: string): Promise<unknown>;

	/**
	 * Registers a live editor buffer over a path. Reads prefer a DIRTY
	 * overlay's content; isDirty/dirtyPaths report it.
	 *
	 * @param path - The overlaid path.
	 * @param overlay - Live accessors into the editor buffer.
	 * @returns Dispose function that unregisters the overlay.
	 */
	registerOverlay(path: string, overlay: VfsOverlay): () => void;

	/**
	 * Whether a registered overlay reports unsaved changes at a path.
	 *
	 * @param path - The path to check.
	 * @returns True when an overlay exists and is dirty.
	 */
	isDirty(path: string): boolean;

	/** All currently dirty overlay paths. */
	dirtyPaths(): Set<string>;

	/**
	 * Subscribes to change ticks (inventory, content, or layer changes).
	 *
	 * @param listener - Invoked on every change tick.
	 * @returns Unsubscribe function.
	 */
	subscribe(listener: () => void): () => void;

	/** Fires the change tick manually (public by design, like CachedVfs). */
	notify(): void;
}
