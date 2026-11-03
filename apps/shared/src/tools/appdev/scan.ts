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
// TOOLS/APPDEV — workspace app scanning (the controller's own logic)
// =============================================================================
//
// The `.rrapp` discovery that used to live in the VS Code extension host
// (apps/vscode/src/appdev/appScan.ts — still present there for the host's
// OWN flows: publish, debug, the App Builder editor), moved to the sidebar
// controller per the sidebar-as-controller architecture. It runs wherever
// the controller runs, against the host's GENERIC workspace-FS capability —
// the host knows how to find and read files; only this module knows what an
// `.rrapp` binding is.
// =============================================================================

// Leaf import: these modules also compile in the VS Code EXTENSION HOST
// program, which must not resolve the shell's React barrel.
import type { WorkspaceFs } from 'shell/src/workspace/workspaceFs';

/** One app project found in the workspace. */
export interface IScannedWorkspaceApp {
	/** appManifest.id (e.g. 'acme.brandy'). */
	id: string;
	/** Display name (appManifest.name, falling back to the package name). */
	name: string;
	/** MF container name (dots/hyphens → underscores, as registerApp derives). */
	moduleId: string;
	/** Absolute folder path of the app project. */
	folder: string;
	/** package.json version, if present. */
	version?: string;
	/** appManifest.description, if present. */
	description?: string;
	/** Absolute path of the declared icon file, when present. */
	iconPath?: string;
}

/** A My Apps row ready for the sidebar list (AppListItem-compatible). */
export interface IWorkspaceAppRow {
	id: string;
	name: string;
	folder: string;
	iconUrl?: string;
}

/** The marker glob that makes a folder an app-binding candidate. */
export const APP_MARKER_GLOB = '**/*.rrapp';
/** node_modules never holds a binding (and its churn is enormous). */
export const APP_SCAN_EXCLUDE = '**/node_modules/**';
/** The globs whose events can add/remove/rename an app binding. */
export const APP_BINDING_WATCH_GLOBS = ['**/*.rrapp', '**/package.json'];
/** Debounce for binding-event rescans (installs touch many files at once). */
export const APP_RESCAN_DEBOUNCE_MS = 500;

/** Icon size ceiling for data: URI conversion (see appIconDataUri). */
const MAX_ICON_BYTES = 256 * 1024;

/**
 * Size ceiling for README-inlined images. Screenshots and GIFs are
 * legitimately far larger than icons, so README previews get their own
 * budget; anything above it keeps its original (broken) reference.
 */
export const MAX_README_IMAGE_BYTES = 10 * 1024 * 1024;

/** Media types the icon conversion understands, by extension. */
const ICON_MEDIA_TYPES: Record<string, string> = {
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

/** The path separator a host-native absolute path uses. */
function separatorOf(path: string): string {
	return path.includes('\\') ? '\\' : '/';
}

/** The containing folder of a host-native absolute path. */
function dirnameOf(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut > 0 ? path.slice(0, cut) : path;
}

/** Joins a host-native folder path and a (possibly '/'-relative) segment. */
function joinPath(folder: string, segment: string): string {
	const sep = separatorOf(folder);
	const normalized = sep === '\\' ? segment.replace(/\//g, '\\') : segment;
	return `${folder}${sep}${normalized}`;
}

/** Path depth (segment count) — orders markers shallowest-first. */
function segmentCount(path: string): number {
	return path.split(/[\\/]/).length;
}

/**
 * Reads one candidate folder's package.json and returns its app when it
 * carries an appManifest block with an id — the check that verifies a
 * marker's folder really is one of our apps.
 *
 * @param fs - The workspace-FS capability.
 * @param folder - Absolute folder path to probe.
 * @returns The scanned app, or null when this folder is not an app project.
 */
async function probeFolder(fs: WorkspaceFs, folder: string): Promise<IScannedWorkspaceApp | null> {
	try {
		const raw = await fs.readTextFile(joinPath(folder, 'package.json'));
		const pkg = JSON.parse(raw) as {
			name?: string;
			version?: string;
			appManifest?: { id?: string; name?: string; description?: string; icon?: string };
		};
		const manifest = pkg.appManifest;
		if (!manifest?.id) return null;
		return {
			id: manifest.id,
			name: manifest.name || pkg.name || manifest.id,
			moduleId: manifest.id.replace(/[.-]/g, '_'),
			folder,
			...(pkg.version !== undefined ? { version: pkg.version } : {}),
			...(manifest.description !== undefined ? { description: manifest.description } : {}),
			...(manifest.icon !== undefined ? { iconPath: joinPath(folder, manifest.icon) } : {}),
		};
	} catch {
		// Missing/unreadable/invalid package.json — not an app project.
		return null;
	}
}

/**
 * Scans the workspace for app working copies. Discovery key is the `.rrapp`
 * marker: each marker's folder is a candidate, its adjacent package.json
 * must verify the binding. Deduplicated by app id, shallowest marker wins.
 * The server catalog is never consulted.
 *
 * @param fs - The workspace-FS capability.
 * @returns All bound app projects in the workspace.
 */
export async function scanWorkspaceApps(fs: WorkspaceFs): Promise<IScannedWorkspaceApp[]> {
	const markers = await fs.findFiles(APP_MARKER_GLOB, APP_SCAN_EXCLUDE);
	// Shallowest first: find order is not guaranteed, and the dedup below
	// keeps the FIRST hit per app id.
	markers.sort((a, b) => segmentCount(a) - segmentCount(b) || a.localeCompare(b));

	// One probe per marker folder (a folder holding several markers probes once).
	const folders: string[] = [];
	const seen = new Set<string>();
	for (const marker of markers) {
		const folder = dirnameOf(marker);
		if (!seen.has(folder)) {
			seen.add(folder);
			folders.push(folder);
		}
	}

	// Probed concurrently; Promise.all preserves candidate order, so
	// first-binding-per-app-id-wins stays deterministic.
	const probed = await Promise.all(folders.map((folder) => probeFolder(fs, folder)));
	const found = new Map<string, IScannedWorkspaceApp>();
	for (const app of probed) {
		if (app && !found.has(app.id)) found.set(app.id, app);
	}
	return [...found.values()];
}

/**
 * Converts an app's image file to a data: URI the sidebar can render
 * directly (bounded; unknown types and oversized files fall back to the
 * generic glyph).
 *
 * @param fs - The workspace-FS capability.
 * @param iconPath - Absolute image path from {@link IScannedWorkspaceApp.iconPath}.
 * @param maxBytes - Size ceiling; larger files return undefined. Defaults
 *                   to the icon budget (README previews pass their own).
 * @returns The data: URI, or undefined.
 */
export async function appIconDataUri(fs: WorkspaceFs, iconPath: string | undefined, maxBytes: number = MAX_ICON_BYTES): Promise<string | undefined> {
	if (!iconPath) return undefined;
	const ext = iconPath.slice(iconPath.lastIndexOf('.')).toLowerCase();
	const mediaType = ICON_MEDIA_TYPES[ext];
	if (!mediaType) return undefined;
	try {
		const base64 = await fs.readFileBase64(iconPath, maxBytes);
		return base64 ? `data:${mediaType};base64,${base64}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Builds the My Apps rows: scan, inline icons, sort by display name.
 *
 * @param fs - The workspace-FS capability.
 * @returns The rows for the sidebar list.
 */
export async function buildWorkspaceAppRows(fs: WorkspaceFs): Promise<IWorkspaceAppRow[]> {
	const scanned = await scanWorkspaceApps(fs);
	const rows = await Promise.all(scanned.map(async (app): Promise<IWorkspaceAppRow> => {
		const iconUrl = await appIconDataUri(fs, app.iconPath);
		return { id: app.id, name: app.name, folder: app.folder, ...(iconUrl !== undefined ? { iconUrl } : {}) };
	}));
	rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
	return rows;
}
