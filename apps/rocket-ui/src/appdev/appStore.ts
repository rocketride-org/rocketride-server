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
// APP STORE — the .appdev VFS: the web App Builder's working copies
// =============================================================================

/**
 * Store-VFS helpers for the web App Builder. Each app is a folder under
 * `.appdev/<name>-ui/` in the user's server-side file store (beside the
 * `.projects`-prefixed pipeline files) holding the app's SOURCE truth:
 * package.json (with the appManifest binding block), tsconfig.json, src/**.
 *
 * This is the web twin of the workspace scan (shared tools/appdev): the
 * sidebar lists what you can open and edit here — server registry state
 * deliberately not merged in.
 */

import { PROJECT_DIR } from 'rocketride';
import type { RocketRideClient } from 'shell';
import { emitFsChange } from 'shared/utils/fsNotify';
import { getStagedWorkspace, getWorkspaceVfs, toScopedStorePath } from '../workspace/workspace';
import { renderTemplate } from 'shared/modules/appdev';
import type { FrameOptions, PackageJsonLike, TemplateName } from 'shared/modules/appdev';

// =============================================================================
// PATHS
// =============================================================================

/** The App Builder's working-copy directory inside the project store. */
export const APPDEV_DIR = '.appdev';

/** Preview-size cap for app text/image reads (matches the VSCode host). */
const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * The store path of a file inside an app folder.
 *
 * ESCAPE-HATCH ONLY: consumers speak VIRTUAL paths ('apps/<folder>/...')
 * through the workspace view; this physical mapping exists solely for the
 * raw binary reads the text-only view contract cannot serve yet
 * (readAppImageDataUri, pack's fsReadMany batch).
 *
 * @param folder - The app's folder name under .appdev (e.g. 'brandy-ui').
 * @param rel - App-folder-relative POSIX path ('' = the folder itself).
 * @returns The full store path.
 */
export function appPath(folder: string, rel = ''): string {
	// step: through the workspace scope — the raw reads must hit the SAME
	// tree (user or team) the view translates into.
	return toScopedStorePath(rel ? `${PROJECT_DIR}/${APPDEV_DIR}/${folder}/${rel}` : `${PROJECT_DIR}/${APPDEV_DIR}/${folder}`);
}

// =============================================================================
// CHANGE NOTIFICATION
// =============================================================================

// The emitter lives in shared (ONE page-monotonic rev counter for every
// store writer); re-exported here so existing importers keep working.
export { emitFsChange };

/**
 * Guards an app-folder-relative path against traversal — the store client
 * validates path shapes too, but the manifest can name anything and the
 * refusal should be local and explicit.
 *
 * @param rel - The './'-prefixed or bare relative path from the manifest.
 * @returns The normalized relative path.
 */
function safeRel(rel: string): string {
	const normalized = rel.replace(/^\.\//, '');
	if (normalized.startsWith('/') || normalized.split('/').some((seg) => seg === '..' || seg === '')) {
		throw new Error('Path escapes the app folder.');
	}
	return normalized;
}

// =============================================================================
// SCAN
// =============================================================================

/** One scanned working copy under .appdev. */
export interface StoredApp {
	/** App id (appManifest.id). */
	id: string;
	/** Display name (appManifest.name, falling back to the pkg name). */
	name: string;
	/** MF container name (appManifest.moduleId, or derived from the id). */
	moduleId: string;
	/** The folder name under .appdev. */
	folder: string;
	/** Top-level package.json semver. */
	version: string;
	/** Listing description (appManifest.description). */
	description: string;
}

/**
 * Lists the folder names under .appdev ([] when the directory does not
 * exist yet — nothing has been scaffolded).
 *
 * @returns Folder names, unsorted.
 */
export async function listAppFolders(): Promise<string[]> {
	try {
		// step: through the workspace VIEW so staged (uncommitted) apps list too
		const entries = await getWorkspaceVfs().list('apps');
		return entries.filter((e) => e.type === 'dir').map((e) => e.name);
	} catch (err) {
		// Named, not swallowed: an empty MY APPS with a healthy workspace is
		// this failing — the console must say why.
		console.log('[appStore] listing apps/ failed:', err);
		return [];
	}
}

/**
 * Scans every .appdev working copy: one row per folder whose package.json
 * carries an appManifest with an id. Unreadable folders are skipped, not
 * fatal — a half-written scaffold must not hide the rest of the list.
 *
 * @returns The scanned apps, sorted by display name.
 */
export async function scanApps(): Promise<StoredApp[]> {
	const folders = await listAppFolders();
	const apps: StoredApp[] = [];
	for (const folder of folders) {
		try {
			const pkg = await readAppPackage(folder);
			const m = (pkg.appManifest ?? {}) as Record<string, unknown>;
			if (typeof m.id !== 'string' || !m.id) {
				console.log('[appStore] skipping apps/' + folder + ' — package.json has no appManifest.id');
				continue;
			}
			apps.push({
				id: m.id,
				name: typeof m.name === 'string' && m.name ? m.name : (pkg.name ?? m.id),
				moduleId: typeof m.moduleId === 'string' && m.moduleId ? m.moduleId : m.id.replace(/[^a-zA-Z0-9_$]/g, '_'),
				folder,
				version: typeof pkg.version === 'string' ? pkg.version : '',
				description: typeof m.description === 'string' ? m.description : '',
			});
		} catch (err) {
			// A half-written scaffold must not hide the rest of the list —
			// but the skip has to be VISIBLE, or "no apps" is undebuggable.
			console.log('[appStore] skipping apps/' + folder + ' — package.json unreadable:', err);
			continue;
		}
	}
	return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// =============================================================================
// PACKAGE.JSON ROUND-TRIP
// =============================================================================

/**
 * Reads and parses an app folder's package.json.
 *
 * @param folder - The app's folder name under .appdev.
 * @returns The parsed package.json object.
 */
export async function readAppPackage(folder: string): Promise<PackageJsonLike> {
	// step: through the workspace VIEW — staged manifest edits are visible
	return JSON.parse(String(await getWorkspaceVfs().read(`apps/${folder}/package.json`))) as PackageJsonLike;
}

/**
 * Serializes and writes an app folder's package.json (tab-indented, like
 * the scaffold emits it) through the workspace view — the write stages or
 * passes through per the commit mode, and the view's backend announces it.
 *
 * @param folder - The app's folder name under .appdev.
 * @param pkg - The parsed package.json object to persist.
 * @param origin - The writer's identity for the onFsChange notification
 *                 (a dev-session id; omitted = the backend default).
 */
export async function writeAppPackage(folder: string, pkg: PackageJsonLike, origin?: string): Promise<void> {
	await getWorkspaceVfs().write(`apps/${folder}/package.json`, `${JSON.stringify(pkg, null, '\t')}\n`, origin);
}

// =============================================================================
// FILE READS (preview surfaces)
// =============================================================================

/**
 * Reads one app-folder-relative TEXT file for preview (icon SVG, README
 * markdown) through the workspace view, so staged edits preview live.
 * Traversal-guarded; size-capped after the read (the store has no cheap
 * stat, and preview files are small by convention).
 *
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns The file text.
 */
export async function readAppText(folder: string, relPath: string): Promise<string> {
	const text = String(await getWorkspaceVfs().read(`apps/${folder}/${safeRel(relPath)}`));
	if (text.length > MAX_PREVIEW_BYTES) throw new Error('File is over the 512KB preview limit.');
	return text;
}

/** Media types the image reader inlines, by extension. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

/**
 * Reads one app-folder-relative IMAGE as a data: URI (README images are
 * binary — a text read would corrupt them). Uses the batch read op for the
 * one-shot binary fetch.
 *
 * RAW BY DESIGN: this is the documented binary escape hatch — the view
 * contract is text-only (see vfsTypes), so binary assets read the store
 * directly until view binary reads land.
 *
 * @param client - The connected RocketRide client.
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns The data: URI, or null for unreadable/unsupported/oversized files.
 */
export async function readAppImageDataUri(client: RocketRideClient, folder: string, relPath: string): Promise<string | null> {
	const rel = safeRel(relPath);
	const ext = rel.split('.').pop()?.toLowerCase() ?? '';
	const mime = IMAGE_MEDIA_TYPES[ext];
	if (!mime) return null;
	const [entry] = await client.fsReadMany([appPath(folder, rel)]);
	if (!entry?.ok || !entry.data || entry.data.byteLength > MAX_PREVIEW_BYTES) return null;
	// step: base64-encode in chunks — String.fromCharCode(...whole) overflows
	// the argument limit on large files.
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < entry.data.byteLength; i += CHUNK) {
		binary += String.fromCharCode(...entry.data.subarray(i, i + CHUNK));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Whether an app-folder-relative file exists in the workspace (staged
 * creations count; staged deletions do not).
 *
 * @param folder - The app's folder name under .appdev.
 * @param relPath - App-folder-relative path from the manifest.
 * @returns True when present.
 */
export async function appFileExists(folder: string, relPath: string): Promise<boolean> {
	try {
		return (await getWorkspaceVfs().stat(`apps/${folder}/${safeRel(relPath)}`)) !== null;
	} catch {
		return false;
	}
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/** Inputs for a new-app scaffold into the store VFS. */
export interface ScaffoldRequest {
	/** The app-name slug (the half after the dot in the app id). */
	appName: string;
	/** Human-readable display name. */
	displayName: string;
	/** Publisher slug (the org developer id, or 'local'). */
	publisher: string;
	/** Frame options composing the generated App.tsx. */
	frame: FrameOptions;
	/** Template to render (defaults to 'Blank'). */
	template?: TemplateName;
}

/**
 * Scaffolds a new app into `.appdev/<appName>-ui/`: renders the shared
 * template set and writes every file through the workspace view — in
 * manual mode the whole scaffold stages (and rolls back) as one
 * checkpoint. Nothing else — no install, no tgz vendoring (the design
 * loop compiles in the browser and the server build materializes its own
 * toolchain).
 *
 * @param req - The scaffold inputs.
 * @returns The created app's id and folder name.
 */
export async function scaffoldApp(req: ScaffoldRequest): Promise<{ appId: string; folder: string }> {
	const appId = `${req.publisher}.${req.appName}`;
	const folder = `${req.appName}-ui`;

	// step: refuse a live collision (the form checks too, but the scan can
	// be stale by the time Create lands)
	const existing = await listAppFolders();
	if (existing.includes(folder)) throw new Error(`Folder "${APPDEV_DIR}/${folder}" already exists.`);

	// step: render the shared template set — identical files to the VSCode
	// scaffold, so the packed source is host-independent
	const files = renderTemplate(req.template ?? 'Blank', {
		appId,
		appName: req.displayName,
		publisher: req.publisher,
		moduleId: appId.replace(/[^a-zA-Z0-9_$]/g, '_'),
		port: 3011,
		previewUrl: `${window.location.origin}/?appid=${encodeURIComponent(appId)}&rrdev=1`,
	}, req.frame);

	// step: write every file through the view (nested store paths create
	// parents implicitly; the backend announces each write)
	const view = getWorkspaceVfs();
	for (const file of files) {
		await view.write(`apps/${folder}/${file.path}`, file.content, 'scaffold');
	}
	// step: one checkpoint per scaffold — in manual mode the whole scaffold
	// becomes a single reviewable/rollbackable unit (no-op in auto mode)
	await getStagedWorkspace().checkpoint(`Scaffold ${appId}`);

	return { appId, folder };
}
