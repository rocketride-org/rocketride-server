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
// SCOPED FILESYSTEM — a prefix lens over a workspace view (view -> view)
// =============================================================================

/**
 * `scopedFileSystem(root, prefix)` presents a subtree of a workspace view
 * as a view of its own: callers use subtree-relative paths; the lens maps
 * them onto the root. Stateless — no cache, no layers, no listeners of its
 * own; everything (overlays, dirty state, staging, subscription) lives in
 * the root view and is shared by every lens over it.
 *
 * Used by per-app surfaces (the App Builder dev session) so they keep
 * thinking in app-relative paths while all state converges in the one
 * shared workspace view.
 */

import type { IWorkspaceFileSystem, VfsEntry, VfsOverlay } from './vfsTypes';

/**
 * A subtree view over a root view.
 *
 * @param root - The backing workspace view.
 * @param prefix - The subtree root (root-relative, no trailing slash).
 * @returns A view whose paths are relative to the prefix.
 */
export function scopedFileSystem(root: IWorkspaceFileSystem, prefix: string): IWorkspaceFileSystem {
	// step: canonicalize the prefix once
	const scope = String(prefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	if (!scope) return root;

	/** Subtree-relative -> root path. */
	const toRoot = (path: string): string => {
		const p = String(path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		return p ? `${scope}/${p}` : scope;
	};

	/** Root path -> subtree-relative (null when outside the scope). */
	const toLocal = (path: string): string | null => {
		if (path === scope) return '';
		return path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : null;
	};

	return {
		// ── IVirtualFileSystem ──────────────────────────────────────────
		list: (dir) => root.list(toRoot(dir)),
		read: (path) => root.read(toRoot(path)),
		write: (path, content, origin) => root.write(toRoot(path), content, origin),
		rename: (oldPath, newPath, origin) => root.rename(toRoot(oldPath), toRoot(newPath), origin),
		delete: (path, origin) => root.delete(toRoot(path), origin),
		mkdir: (path, origin) => root.mkdir(toRoot(path), origin),

		// ── View surface ────────────────────────────────────────────────
		refresh: () => root.refresh(),
		readMany: async (paths: string[]): Promise<Record<string, unknown>> => {
			// step: batch at the root, translate both directions
			const rooted = await root.readMany(paths.map(toRoot));
			const out: Record<string, unknown> = {};
			for (const [p, content] of Object.entries(rooted)) {
				const local = toLocal(p);
				if (local !== null) out[local] = content;
			}
			return out;
		},
		stat: (path) => root.stat(toRoot(path)),
		listEntries: (): VfsEntry[] => {
			// step: subtree filter + strip, root entry itself excluded
			const out: VfsEntry[] = [];
			for (const e of root.listEntries()) {
				const local = toLocal(e.path);
				if (local) out.push({ path: local, type: e.type });
			}
			return out;
		},
		entryType: (path) => root.entryType(toRoot(path)),
		upsert: (path, type) => root.upsert(toRoot(path), type),
		prime: (path, content) => root.prime(toRoot(path), content),
		invalidate: (path?: string) => root.invalidate(path === undefined ? undefined : toRoot(path)),
		cachedContent: (path) => root.cachedContent(toRoot(path)),
		peekBase: (path) => root.peekBase(toRoot(path)),
		registerOverlay: (path: string, overlay: VfsOverlay) => root.registerOverlay(toRoot(path), overlay),
		isDirty: (path) => root.isDirty(toRoot(path)),
		dirtyPaths: (): Set<string> => {
			const out = new Set<string>();
			for (const p of root.dirtyPaths()) {
				const local = toLocal(p);
				if (local) out.add(local);
			}
			return out;
		},
		subscribe: (listener) => root.subscribe(listener),
		notify: () => root.notify(),
	};
}
