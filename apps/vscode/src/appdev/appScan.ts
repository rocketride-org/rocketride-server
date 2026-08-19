// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Workspace app scanner — finds app working copies by their `.rrapp` marker.
 *
 * Discovery is `.rrapp`-driven: every `<folder>/<name>.rrapp` marker names a
 * candidate folder, and the package.json NEXT TO the marker must verify the
 * folder as one of our apps via its `appManifest` block (binding key:
 * appManifest.id — "bind, don't sync": the file system is the single source
 * of truth; this scanner only READS). Folders without a marker are never
 * listed, no matter what their package.json declares.
 *
 * Results are cached by the caller (SidebarProvider re-scans on `.rrapp`
 * and package.json file events).
 */

import * as vscode from 'vscode';

// =============================================================================
// TYPES
// =============================================================================

/** One app project found in the workspace. */
export interface ScannedApp {
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
	/** Absolute path of the app's icon file (appManifest.icon), when declared and readable. */
	icon?: string;
}

// =============================================================================
// SCAN
// =============================================================================

/**
 * Reads one candidate folder's package.json and returns its ScannedApp when
 * it carries an appManifest block with an id — the check that verifies a
 * marker's folder really is one of our apps.
 *
 * @param folder - Absolute folder URI to probe.
 * @returns The scanned app, or null when this folder is not an app project.
 */
async function probeFolder(folder: vscode.Uri): Promise<ScannedApp | null> {
	try {
		// Read + parse the candidate package.json
		const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'package.json'));
		const pkg = JSON.parse(Buffer.from(raw).toString('utf8')) as {
			name?: string;
			version?: string;
			appManifest?: { id?: string; name?: string; description?: string; icon?: string };
		};
		const manifest = pkg.appManifest;
		if (!manifest?.id) return null;

		// Resolve the declared icon against the app folder; drop it when the
		// file does not actually exist so consumers can trust the path.
		let icon: string | undefined;
		if (manifest.icon) {
			try {
				const iconUri = vscode.Uri.joinPath(folder, manifest.icon);
				await vscode.workspace.fs.stat(iconUri);
				icon = iconUri.fsPath;
			} catch {
				/* icon declared but missing — fall back to the generic glyph */
			}
		}

		return {
			id: manifest.id,
			name: manifest.name || pkg.name || manifest.id,
			moduleId: manifest.id.replace(/[.-]/g, '_'),
			folder: folder.fsPath,
			version: pkg.version,
			description: manifest.description,
			icon,
		};
	} catch {
		// Missing/unreadable/invalid package.json — not an app project
		return null;
	}
}

/**
 * Path depth of a URI (segment count) — orders markers shallowest-first.
 *
 * @param uri - The URI to measure.
 * @returns Number of path segments.
 */
function segmentCount(uri: vscode.Uri): number {
	return uri.path.split('/').length;
}

/**
 * Scans every workspace folder for app working copies.
 *
 * Discovery key is the `.rrapp` marker file: each marker's folder is a
 * candidate, and its adjacent package.json must verify the folder as one of
 * our apps (an appManifest block with an id). Deduplicated by app id, with
 * the shallowest marker winning (the least nested working copy is the
 * canonical binding). The server catalog is never consulted.
 *
 * @returns All bound app projects in the workspace.
 */
export async function scanWorkspaceApps(): Promise<ScannedApp[]> {
	// Every `.rrapp` marker is a candidate; node_modules never holds a binding
	const markers = await vscode.workspace.findFiles('**/*.rrapp', '**/node_modules/**');

	// Shallowest first: findFiles order is not guaranteed, and the dedup
	// below keeps the FIRST hit per app id
	markers.sort((a, b) => segmentCount(a) - segmentCount(b) || a.fsPath.localeCompare(b.fsPath));

	// One probe per marker folder (a folder holding several markers probes once)
	const folders: vscode.Uri[] = [];
	const seenFolders = new Set<string>();
	for (const marker of markers) {
		const folder = vscode.Uri.joinPath(marker, '..');
		if (!seenFolders.has(folder.fsPath)) {
			seenFolders.add(folder.fsPath);
			folders.push(folder);
		}
	}

	// Probed concurrently; Promise.all preserves candidate order, so
	// first-binding-per-app-id-wins is deterministic
	const probed = await Promise.all(folders.map((folder) => probeFolder(folder)));
	const found = new Map<string, ScannedApp>();
	for (const app of probed) {
		if (app && !found.has(app.id)) found.set(app.id, app);
	}
	return [...found.values()];
}

// =============================================================================
// ICON
// =============================================================================

/**
 * Icon size ceiling for the data: URI conversion. The manifest can point at
 * an arbitrarily large file; base64-inlining it would balloon the webview
 * message, so anything above this falls back to the generic glyph.
 */
const MAX_ICON_BYTES = 256 * 1024;

/**
 * Size ceiling for README-inlined images. Screenshots and GIFs are
 * legitimately far larger than icons, so the README preview gets its own
 * budget; anything above it keeps its original (broken) reference.
 */
export const MAX_README_IMAGE_BYTES = 10 * 1024 * 1024;

/** Media type per icon file extension the app store accepts. */
const ICON_MEDIA_TYPES: Record<string, string> = {
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

/**
 * Converts a scanned app's icon file to a data: URI the sidebar webview can
 * render directly. A data: URI (allowed by the webview CSP's img-src) avoids
 * widening localResourceRoots to workspace folders just to serve one image.
 *
 * @param iconPath - Absolute icon file path from {@link ScannedApp.icon}.
 * @param maxBytes - Size ceiling for the conversion; larger files return
 *                   undefined. Defaults to the icon budget.
 * @returns The data: URI, or undefined when absent/unreadable/unknown type.
 */
export async function appIconDataUri(iconPath: string | undefined, maxBytes: number = MAX_ICON_BYTES): Promise<string | undefined> {
	if (!iconPath) return undefined;
	try {
		// Media type from the extension; unknown types get the generic glyph.
		const ext = iconPath.slice(iconPath.lastIndexOf('.')).toLowerCase();
		const mediaType = ICON_MEDIA_TYPES[ext];
		if (!mediaType) return undefined;

		// Stat before reading: the manifest can point at an arbitrarily large
		// file, and only this size gate keeps the data: URI bounded.
		const uri = vscode.Uri.file(iconPath);
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size > maxBytes) return undefined;

		// Read + base64-encode the file (bounded by the gate above).
		const bytes = await vscode.workspace.fs.readFile(uri);
		return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
	} catch {
		// Unreadable icon — the row falls back to the generic glyph
		return undefined;
	}
}
