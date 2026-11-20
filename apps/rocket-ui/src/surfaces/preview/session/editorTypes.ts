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
// EDITOR TYPES — the workspace file editor's TS language service (page-wide)
// =============================================================================

/**
 * Gives the standalone workspace editors (FileProvider tabs, diff panes)
 * the SAME TypeScript surface the App Builder's Code pane gets, without a
 * dev session: the scaffold-shaped compiler options + bundled React type
 * packages (setupAppTypescript), the server-versioned platform types
 * (shell.d.ts + vendored SDK via the types feed), and automatic type
 * acquisition for third-party imports.
 *
 * ONE page-lifetime singleton, deliberately never disposed: Monaco's
 * typescriptDefaults are global per page anyway, file tabs come and go,
 * and the registered libs are exactly what the Code pane would register —
 * a dev session opening later re-registers the same paths (extraLibs
 * replace by path), so the two surfaces never fight.
 *
 * Models and project-source libs live in the `file:///workspace/<path>`
 * namespace (workspace-relative paths), disjoint from the Code pane's
 * per-app `file:///<appId>/<rel>` models by construction.
 */

import { setupAppTypescript } from 'shared/components/monaco';
import type { Monaco, TypescriptSetupHandle } from 'shared/components/monaco';
import { createAtaEngine } from './ata';
import type { AtaEngine } from './ata';
import { fetchPlatformTypeLibs } from './typesFeed';
import { getWorkspaceVfs } from '../../workspace/vfs/workspace';

// =============================================================================
// SINGLETON
// =============================================================================

/** The page-wide editor TS service. */
export interface WorkspaceEditorTs {
	/** The TS setup handle (extraLib registration). */
	handle: TypescriptSetupHandle;
	/** The shared acquisition engine (debounced; keyed per file path). */
	ata: AtaEngine;
}

/** The URI namespace the workspace editors' models and libs live in. */
export const WORKSPACE_URI_PREFIX = 'file:///workspace/';

/** Matches paths the TS language service cares about. */
const SOURCE_RE = /\.(ts|tsx)$/;

/** Directory names the project-source walk never descends into. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

let singleton: WorkspaceEditorTs | null = null;
/** The Monaco namespace the singleton was built against (for getModel checks). */
let monacoNs: Monaco | null = null;

/**
 * Ensures the page-wide TS service exists (idempotent). Platform types load
 * in the background — the editor upgrades as they arrive, exactly like the
 * Code pane; a feed failure degrades to a console warning, never an error.
 *
 * @param monaco - The loaded Monaco namespace.
 * @returns The service.
 */
export function ensureWorkspaceEditorTs(monaco: Monaco): WorkspaceEditorTs {
	if (singleton) return singleton;
	monacoNs = monaco;
	const handle = setupAppTypescript(monaco);
	const ata = createAtaEngine(handle, (message) => console.warn('[editorTypes]', message));
	// step: platform types (server-versioned) — fetched, IndexedDB-cached;
	// registration is an upgrade, so the editor renders before it lands
	void fetchPlatformTypeLibs()
		.then((libs) => {
			for (const lib of libs) handle.addExtraLib(lib.content, lib.path);
			console.log(`[editorTypes] platform types registered (${libs.length} libs)`);
		})
		.catch((err) => {
			console.warn('[editorTypes] platform types unavailable:', err instanceof Error ? err.message : String(err));
		});
	singleton = { handle, ata };
	return singleton;
}

/**
 * The service when it exists — for callers that only ever run after an
 * editor mounted (ATA enqueue on keystrokes).
 *
 * @returns The service, or null before the first ensure.
 */
export function getWorkspaceEditorTs(): WorkspaceEditorTs | null {
	return singleton;
}

// =============================================================================
// PROJECT SOURCES — sibling files, so relative imports resolve
// =============================================================================

/** App folders whose sources are already registered (one walk per folder). */
const primedProjects = new Set<string>();

/** Registered project-source libs by workspace path (for release-on-open). */
const projectLibs = new Map<string, { dispose: () => void }>();

/**
 * Drops the project-source lib for one path, if registered — called right
 * before an editor creates a LIVE model at that path, so the model never
 * coexists with a shadow copy of itself in the lib set.
 *
 * @param filePath - The workspace path about to get a live model.
 */
export function releaseProjectSource(filePath: string): void {
	const lib = projectLibs.get(filePath);
	if (lib) {
		lib.dispose();
		projectLibs.delete(filePath);
	}
}

/**
 * Registers every .ts/.tsx source of the open file's app folder as an
 * extraLib at its workspace URI, so the file's RELATIVE imports ('./x')
 * resolve in the language service — the Code pane gets this for free by
 * loading the whole tree as models; a single file tab has to feed the
 * neighbors explicitly. One-shot per app folder (editor-only types: a
 * later neighbor edit may go stale until the next page load — same
 * trade-off ATA makes for package types).
 *
 * @param filePath - The workspace path of the file being opened.
 */
export async function primeProjectSources(filePath: string): Promise<void> {
	if (!singleton) return;
	// step: only app folders hold TS projects (nodes are Python, pipelines JSON)
	const match = /^apps\/([^/]+)\//.exec(filePath);
	if (!match) return;
	const root = `apps/${match[1]}`;
	if (primedProjects.has(root)) return;
	primedProjects.add(root);
	try {
		const view = getWorkspaceVfs();
		const sources: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await view.list(dir)) {
				const path = `${dir}/${entry.name}`;
				if (entry.type === 'dir') {
					if (!SKIP_DIRS.has(entry.name)) await walk(path);
				} else if (SOURCE_RE.test(entry.name)) {
					sources.push(path);
				}
			}
		};
		await walk(root);
		const contents = await view.readMany(sources);
		for (const [path, text] of Object.entries(contents)) {
			// step: a path with a LIVE model is already the truth — an extraLib
			// at the same URI would shadow-duplicate it
			const uri = `${WORKSPACE_URI_PREFIX}${path}`;
			if (monacoNs?.editor.getModel(monacoNs.Uri.parse(uri))) continue;
			projectLibs.set(path, singleton.handle.addExtraLib(String(text), uri));
		}
	} catch (err) {
		// step: un-prime so a transient failure retries on the next open
		primedProjects.delete(root);
		console.warn(`[editorTypes] priming ${root} sources failed:`, err instanceof Error ? err.message : String(err));
	}
}
