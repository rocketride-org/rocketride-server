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
// WORKSPACE FILE OPENING — the ONE route table from a path to an editor
// =============================================================================
//
// Every surface that opens a workspace file by path (the workspace Explorer,
// the SCM changes list) routes through here, so "what opens what" is decided
// exactly once:
//
//   pipelines/**.pipe   → the pipeline canvas (Documents adapter — editable,
//                         saves through the view)
//   apps/<folder>/*.rrapp → the App Builder panel for that app (the .rrapp
//                         is a contentless trigger marker, same as VS Code)
//   **.rrnode           → the Node Designer — SEAM ONLY today: the designer
//                         does not exist yet; when it lands, its static-doc
//                         uri (`node:<id>`) is wired HERE and nowhere else
//   text-shaped files   → the read-only file viewer tab (`file:<path>`)
//   binary/media        → not openable in this surface (explorer-ui is the
//                         store browser with real viewers)
// =============================================================================

import type { Documents } from 'shell';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';
import { getDocs } from '../../../docs';
import { isPipelineFile } from '../projectStore';
import { readAppPackage } from '../../preview/session/appStore';
import { getMediaInfo } from 'shared/utils/mediaTypes';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Media categories the read-only `file:` viewer can present as text. */
const TEXT_CATEGORIES = new Set(['text', 'code', 'json', 'markdown']);

// =============================================================================
// OPEN ROUTING
// =============================================================================

/**
 * Opens a workspace path in its editor. See the file header for the table.
 *
 * @param path - View-relative path (e.g. 'pipelines/a.pipe', 'apps/x/y.ts').
 * @returns True when a tab was opened; false when the type has no editor.
 */
export async function openWorkspaceFile(path: string): Promise<boolean> {
	const docs = getDocs();
	if (!docs) return false;
	const leaf = path.split('/').pop() ?? path;

	// ── Pipeline canvas ──────────────────────────────────────────────────
	// The Documents adapter speaks pipelines-mount-relative paths.
	if (path.startsWith('pipelines/') && isPipelineFile(leaf)) {
		await docs.openDocument(path.slice('pipelines/'.length));
		return true;
	}

	// ── App Builder (the .rrapp trigger marker) ──────────────────────────
	// Resolved from the folder's OWN package.json through the view — one
	// read, no dependence on a full store scan succeeding.
	if (leaf.endsWith('.rrapp')) {
		const folder = path.startsWith('apps/') ? path.split('/')[1] : null;
		if (!folder) {
			console.log('[openWorkspaceFile] .rrapp outside apps/<folder>/ — nothing to open:', path);
			return false;
		}
		try {
			const pkg = await readAppPackage(folder);
			const m = (pkg.appManifest ?? {}) as Record<string, unknown>;
			if (typeof m.id !== 'string' || !m.id) {
				console.log('[openWorkspaceFile] package.json has no appManifest.id:', `apps/${folder}/package.json`);
				return false;
			}
			const name = typeof m.name === 'string' && m.name ? m.name : (pkg.name ?? m.id);
			docs.openStaticDocument(`tool:apps/${m.id}`, name);
			return true;
		} catch (err) {
			console.log('[openWorkspaceFile] could not read the app package for', path, err);
			return false;
		}
	}

	// ── Node Designer seam (.rrnode) ─────────────────────────────────────
	// The designer does not exist yet. When it lands, open its static doc
	// here (`node:<id>`), exactly like the .rrapp branch above.
	if (leaf.endsWith('.rrnode')) {
		console.log('[openWorkspaceFile] node designer not built yet — .rrnode routing is reserved:', path);
		return false;
	}

	// ── Read-only text viewer ────────────────────────────────────────────
	// .svg classifies as 'image' (explorer-ui renders it as one), but it IS
	// XML text — in a dev workspace the source view is the useful one.
	if (TEXT_CATEGORIES.has(getMediaInfo(path).category) || leaf.toLowerCase().endsWith('.svg')) {
		docs.openStaticDocument(`file:${path}`, leaf);
		return true;
	}

	// Binary/media: no in-workspace editor; explorer-ui owns rich viewers.
	return false;
}

// =============================================================================
// RENAME
// =============================================================================

/** The workspace path a tab shows: a text tab's file, or a canvas's pipeline. Null for any other tab, since a page's key can read like a pipeline folder. */
function tabPath(uri: string, isStatic: boolean | undefined): string | null {
	if (uri.startsWith('file:')) return uri.slice('file:'.length);
	return isStatic ? null : `pipelines/${uri}`;
}

/**
 * Renames a workspace file or folder and moves the open tabs at or under it. Unless the view refuses
 * (unsaved changes), the tabs close before the rename awaits anything, so no typing lands on an old
 * path, and reopen afterward on the new paths, or the old ones if the rename failed.
 */
export async function renameWithTabs(view: IWorkspaceFileSystem, docs: Documents | null, from: string, to: string): Promise<void> {
	const under = (path: string) => path === from || path.startsWith(`${from}/`);
	if (!docs || [...view.dirtyPaths()].some(under)) return view.rename(from, to);
	const { editors, documents } = docs.getState();
	const open = new Map<string, string>();
	for (const { documentUri: uri } of Object.values(editors)) {
		const path = tabPath(uri, documents[uri]?.static);
		if (path !== null && under(path)) open.set(uri, path);
	}
	for (const [id, ed] of Object.entries(editors)) if (open.has(ed.documentUri)) docs.closeEditor(id);
	let moved = false;
	try {
		await view.rename(from, to);
		moved = true;
	} finally {
		for (const [uri, path] of open) {
			const at = moved ? to + path.slice(from.length) : path;
			if (uri.startsWith('file:')) docs.openStaticDocument(`file:${at}`, at.split('/').pop() ?? at);
			else await docs.openDocument(at.slice('pipelines/'.length));
		}
	}
}
