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
// GUIDE FILE SYSTEM — the workspace view with the guides read-only at .rocketride
// =============================================================================

/**
 * Wraps the user's workspace view so the agent's normal file tools can open the
 * RocketRide guides. Paths under '.rocketride/' are answered from the
 * GuideSource and can never be changed; every other path goes straight to the
 * workspace. Nothing is written into the user's file store. The root listing
 * hides '.rocketride', so a search of the whole workspace does not wade through
 * the guides. The wrapper records the guides the agent has read in
 * `guidesRead`, which is how the loop knows a guide was opened.
 */

import type { IWorkspaceFileSystem, VfsEntry, VfsOverlay } from '../vfs/vfsTypes';
import type { GuideSource } from './host';

// =============================================================================
// GUIDE PATHS — where the guides appear in the workspace, and which bundle files are guides
// =============================================================================

/**
 * The guides are RocketRide's agent docs. The agent reads them under
 * '.rocketride/' with its normal read tool, so the skills and the docs index,
 * which already name '.rocketride/docs/ROCKETRIDE_*.md', work unedited. This
 * section holds the pure path rules; GuideFileSystem, below, serves the paths.
 */

// =============================================================================
// THE ROOT
// =============================================================================

/** The workspace folder the guides are served under. */
const GUIDE_ROOT = '.rocketride';

/**
 * Cleans a path to its canonical segments: backslashes become slashes, empty
 * and '.' segments drop out, and '..' steps back up. Used only to decide where
 * a path points; the original path is what reaches the workspace.
 *
 * @param path - The path as the caller wrote it.
 * @returns The canonical path ('' for the workspace root).
 */
function cleanPath(path: string): string {
	const kept: string[] = [];
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') kept.pop();
		else kept.push(segment);
	}
	return kept.join('/');
}

/**
 * Where a path sits relative to the guides root.
 *
 * @param path - A workspace path, in any spelling cleanPath() accepts.
 * @returns The path below '.rocketride/' ('' for the root itself), or null when the path is not under it.
 */
function guideRelative(path: string): string | null {
	const clean = cleanPath(path);
	if (clean === GUIDE_ROOT) return '';
	return clean.startsWith(`${GUIDE_ROOT}/`) ? clean.slice(GUIDE_ROOT.length + 1) : null;
}

// =============================================================================
// BUNDLE KEYS
// =============================================================================

/**
 * Maps a docs/agents bundle key to the guide path it is served at.
 * './context/X.md' becomes 'docs/X.md' (the installer stubs under
 * './context/stubs/' are not guides), and './skills/<path>.md' keeps its path.
 * Everything else, such as the folder README, the task battery and scripts,
 * is not a guide.
 *
 * @param contextKey - A key from the docs/agents bundle, e.g. './context/ROCKETRIDE_APPS.md'.
 * @returns The path relative to '.rocketride/' (e.g. 'docs/ROCKETRIDE_APPS.md'), or null when the file is not a guide.
 */
export function guidePathFor(contextKey: string): string | null {
	const key = contextKey.replace(/^\.\//, '');
	if (!key.endsWith('.md') || key.startsWith('context/stubs/')) return null;
	if (key.startsWith('context/')) return `docs/${key.slice('context/'.length)}`;
	if (key.startsWith('skills/')) return key;
	return null;
}

// =============================================================================
// THE VIEW
// =============================================================================

/** The workspace view with the guides served read-only under '.rocketride/'. */
export class GuideFileSystem implements IWorkspaceFileSystem {
	/** Workspace paths of the guides read so far (e.g. '.rocketride/docs/ROCKETRIDE_APPS.md'). */
	readonly guidesRead = new Set<string>();

	/** The workspace this view wraps; every non-guide path goes to it. */
	private readonly base: IWorkspaceFileSystem;
	/** Where the guides come from. */
	private readonly guides: GuideSource;
	/** Guide text already read, by workspace path, so cachedContent() can answer without a read. */
	private readonly texts = new Map<string, string>();

	/**
	 * @param base - The user's workspace view.
	 * @param guides - The guides to serve under '.rocketride/'.
	 */
	constructor(base: IWorkspaceFileSystem, guides: GuideSource) {
		this.base = base;
		this.guides = guides;
	}

	// ---- reads ----

	async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
		const rel = guideRelative(dir);
		if (rel === null) {
			const entries = await this.base.list(dir);
			return cleanPath(dir) === '' ? entries.filter((entry) => entry.name !== GUIDE_ROOT) : entries;
		}
		const kind = this.kind(rel);
		if (kind === 'file') throw new Error(`${this.workspacePath(rel)} is a guide, not a folder. Read it with read_file.`);
		if (kind === null) throw this.noGuide(rel);

		const prefix = rel ? `${rel}/` : '';
		const names = new Map<string, 'file' | 'dir'>();
		for (const path of this.guides.paths()) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf('/');
			names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'dir');
		}
		return [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, type]) => ({ name, type }));
	}

	async read(path: string): Promise<unknown> {
		const rel = guideRelative(path);
		if (rel === null) return this.base.read(path);
		const full = this.workspacePath(rel);
		const text = this.texts.get(full) ?? (await this.fetch(rel));
		this.texts.set(full, text);
		this.guidesRead.add(full);
		return text;
	}

	async readMany(paths: string[]): Promise<Map<string, unknown>> {
		const workspacePaths = paths.filter((path) => guideRelative(path) === null);
		const fromWorkspace = workspacePaths.length > 0 ? await this.base.readMany(workspacePaths) : new Map<string, unknown>();
		const out = new Map<string, unknown>();
		for (const path of paths) {
			if (guideRelative(path) === null) {
				if (fromWorkspace.has(path)) out.set(path, fromWorkspace.get(path));
				continue;
			}
			try {
				out.set(path, await this.read(path));
			} catch {
				// unreadable paths are omitted, as the view contract says
			}
		}
		return out;
	}

	async stat(path: string): Promise<'file' | 'dir' | null> {
		// the workspace's stat() is the definitive answer (it loads what the cached entryType() has not seen), so a workspace path must reach it
		const rel = guideRelative(path);
		return rel === null ? this.base.stat(path) : this.kind(rel);
	}

	listEntries(): VfsEntry[] {
		return this.base.listEntries();
	}

	entryType(path: string): 'file' | 'dir' | null {
		const rel = guideRelative(path);
		return rel === null ? this.base.entryType(path) : this.kind(rel);
	}

	cachedContent(path: string): unknown {
		const rel = guideRelative(path);
		return rel === null ? this.base.cachedContent(path) : this.texts.get(this.workspacePath(rel));
	}

	async peekBase(path: string): Promise<unknown> {
		const rel = guideRelative(path);
		return rel === null ? this.base.peekBase(path) : this.fetch(rel);
	}

	// ---- mutations: the workspace's, never the guides' ----

	async write(path: string, content: unknown, origin?: string): Promise<void> {
		this.refuseGuides(path);
		return this.base.write(path, content, origin);
	}

	async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
		this.refuseGuides(oldPath, newPath);
		return this.base.rename(oldPath, newPath, origin);
	}

	async delete(path: string, origin?: string): Promise<void> {
		this.refuseGuides(path);
		return this.base.delete(path, origin);
	}

	async mkdir(path: string, origin?: string): Promise<void> {
		this.refuseGuides(path);
		return this.base.mkdir(path, origin);
	}

	// ---- dirty state: guides are never dirty ----

	isDirty(path: string): boolean {
		return guideRelative(path) === null && this.base.isDirty(path);
	}

	dirtyPaths(): Set<string> {
		return new Set([...this.base.dirtyPaths()].filter((path) => guideRelative(path) === null));
	}

	// ---- cache and subscription: the workspace's ----

	refresh(): Promise<void> {
		return this.base.refresh();
	}

	upsert(path: string, type: 'file' | 'dir'): void {
		this.base.upsert(path, type);
	}

	prime(path: string, content: unknown): void {
		this.base.prime(path, content);
	}

	invalidate(path?: string): void {
		if (path === undefined) {
			this.texts.clear();
		} else {
			const rel = guideRelative(path);
			if (rel !== null) this.texts.delete(this.workspacePath(rel));
		}
		this.base.invalidate(path);
	}

	registerOverlay(path: string, overlay: VfsOverlay): () => void {
		return this.base.registerOverlay(path, overlay);
	}

	subscribe(listener: () => void): () => void {
		return this.base.subscribe(listener);
	}

	notify(): void {
		this.base.notify();
	}

	// ---- helpers ----

	/** The workspace path of a guide path relative to the root. */
	private workspacePath(rel: string): string {
		return rel ? `${GUIDE_ROOT}/${rel}` : GUIDE_ROOT;
	}

	/** Whether a path below the root is a guide, a guide folder, or neither. */
	private kind(rel: string): 'file' | 'dir' | null {
		if (rel === '') return 'dir';
		const paths = this.guides.paths();
		if (paths.includes(rel)) return 'file';
		return paths.some((path) => path.startsWith(`${rel}/`)) ? 'dir' : null;
	}

	/** Reads one guide from the source, refusing folders and misses with the real guide paths. */
	private async fetch(rel: string): Promise<string> {
		const kind = this.kind(rel);
		if (kind === 'dir') throw new Error(`${this.workspacePath(rel)} is a folder, not a guide. List it with list_directory to see its guides.`);
		if (kind === null) throw this.noGuide(rel);
		return this.guides.read(rel);
	}

	/** The error for a path that is not a guide, naming the guides that exist. */
	private noGuide(rel: string): Error {
		const guides = this.guides.paths().map((path) => this.workspacePath(path));
		return new Error(`No guide at ${this.workspacePath(rel)}.${guides.length > 0 ? ` Guides: ${guides.join(', ')}` : ''}`);
	}

	/** Refuses a mutation that touches the guides. */
	private refuseGuides(...paths: string[]): void {
		if (paths.some((path) => guideRelative(path) !== null)) {
			throw new Error(`Guides under ${GUIDE_ROOT}/ are read-only. Use a path outside ${GUIDE_ROOT}/.`);
		}
	}
}
