// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Workspace app scanner — finds app projects bound by their appManifest.
 *
 * An app in MY APPS is bound to a workspace folder by the `appManifest` block
 * in its package.json (binding key: appManifest.id — "bind, don't sync": the
 * file system is the single source of truth; this scanner only READS).
 *
 * Scan surface: each workspace root itself, one level beneath it, and the
 * monorepo convention `apps/<name>/` two levels down. Results are cached by
 * the caller (SidebarProvider re-scans on package.json file events).
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
 * it carries an appManifest block with an id.
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
 * Lists the subdirectories of a folder, tolerating missing folders.
 *
 * @param folder - Absolute folder URI.
 * @returns Subdirectory URIs (empty on error).
 */
async function subdirs(folder: vscode.Uri): Promise<vscode.Uri[]> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(folder);
		return entries.filter(([, kind]) => kind === vscode.FileType.Directory).map(([name]) => vscode.Uri.joinPath(folder, name));
	} catch {
		return [];
	}
}

/**
 * Scans every workspace folder for app projects.
 *
 * Coverage per root: the root itself, its direct subdirectories, and the
 * `apps/<name>/` monorepo convention. Deduplicated by app id (first hit
 * wins — the shallower binding is the canonical one).
 *
 * @returns All bound app projects in the workspace.
 */
export async function scanWorkspaceApps(): Promise<ScannedApp[]> {
	const found = new Map<string, ScannedApp>();
	for (const root of vscode.workspace.workspaceFolders ?? []) {
		// Candidate set: root, root/*, root/apps/*
		const candidates: vscode.Uri[] = [root.uri];
		const level1 = await subdirs(root.uri);
		candidates.push(...level1);
		const appsDir = level1.find((u) => u.path.endsWith('/apps'));
		if (appsDir) candidates.push(...(await subdirs(appsDir)));

		// Probed concurrently; Promise.all preserves candidate order, so
		// first-binding-per-app-id-wins is unchanged.
		const probed = await Promise.all(candidates.map((candidate) => probeFolder(candidate)));
		for (const app of probed) {
			if (app && !found.has(app.id)) found.set(app.id, app);
		}
	}
	return [...found.values()];
}

// =============================================================================
// ICON
// =============================================================================

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
 * @returns The data: URI, or undefined when absent/unreadable/unknown type.
 */
export async function appIconDataUri(iconPath: string | undefined): Promise<string | undefined> {
	if (!iconPath) return undefined;
	try {
		// Media type from the extension; unknown types get the generic glyph.
		const ext = iconPath.slice(iconPath.lastIndexOf('.')).toLowerCase();
		const mediaType = ICON_MEDIA_TYPES[ext];
		if (!mediaType) return undefined;

		// Read + base64-encode the file (app icons are small by store policy).
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(iconPath));
		return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
	} catch {
		// Unreadable icon — the row falls back to the generic glyph
		return undefined;
	}
}
