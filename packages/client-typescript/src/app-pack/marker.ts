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

/**
 * The `.rrapp` trigger and the package.json `appManifest` — the on-disk
 * identity of one app working copy (Node.js only).
 *
 * `<folder>/<name>.rrapp` is a CONTENTLESS trigger: editors open the App
 * Builder from it and use it for tab identity. Everything ABOUT the app —
 * id, name, listing, and the working-copy `projectId` — lives in ONE place:
 * the folder's package.json `appManifest` block. This module is the one
 * owner of every manifest read/write, shared by the VS Code extension and
 * the CLI.
 *
 * `projectId` is a client-side guid that tells one working copy (checkout,
 * duplicate) of the same app apart from another. It never becomes a server
 * key — deploys record it only as `metadata.projectId` provenance. Legacy
 * markers that still carry `{ id, projectId }` are migrated: their
 * projectId is adopted into the appManifest on first ensure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// =============================================================================
// TRIGGER FILE
// =============================================================================

/**
 * The trigger path for an app folder: `<folder>/<lastSegment(appId)>.rrapp`.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id.
 * @returns The absolute trigger file path.
 */
export function markerPathOf(folder: string, appId: string): string {
	return path.join(folder, `${appId.split('.').pop()}.rrapp`);
}

/**
 * Ensures the folder's `.rrapp` trigger file exists (created empty when
 * missing). Existing files are left untouched — their content is ignored.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id (names the trigger file).
 * @returns The absolute trigger file path.
 */
export function ensureAppTrigger(folder: string, appId: string): string {
	const markerPath = markerPathOf(folder, appId);
	if (!fs.existsSync(markerPath)) {
		// Valid-but-empty JSON so generic tooling opening it never chokes
		fs.writeFileSync(markerPath, '{}\n');
	}
	return markerPath;
}

// =============================================================================
// PACKAGE.JSON ACCESS
// =============================================================================

/** The appManifest block, loosely typed — unknown keys are preserved. */
interface AppManifestJson {
	id?: string;
	projectId?: string;
	name?: string;
	description?: string;
	mode?: string;
	icon?: string;
	readme?: string;
	include?: string[];
	typecheck?: boolean;
	billing?: { plans?: Array<Record<string, unknown>> } & Record<string, unknown>;
	[key: string]: unknown;
}

/** A parsed package.json with the raw text kept for format preservation. */
interface PkgFile {
	filePath: string;
	raw: string;
	pkg: { name?: string; appManifest?: AppManifestJson; [key: string]: unknown };
}

/**
 * Reads + parses the folder's package.json, requiring an appManifest.id.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The parsed file with its raw text.
 * @throws Error when the file is unreadable or carries no appManifest.id.
 */
function readPkg(folder: string): PkgFile {
	const filePath = path.join(folder, 'package.json');
	const raw = fs.readFileSync(filePath, 'utf8');
	const pkg = JSON.parse(raw) as PkgFile['pkg'];
	if (!pkg.appManifest?.id) {
		throw new Error(`No appManifest.id in ${filePath}. Not an app project.`);
	}
	return { filePath, raw, pkg };
}

/**
 * Writes the parsed package.json back, preserving the original file's
 * indentation style and trailing newline.
 *
 * @param file - The parsed file (pkg mutated in place by the caller).
 */
function writePkg(file: PkgFile): void {
	const indent = file.raw.match(/\n([ \t]+)"/)?.[1] ?? '\t';
	const eol = file.raw.endsWith('\n') ? '\n' : '';
	fs.writeFileSync(file.filePath, JSON.stringify(file.pkg, null, indent) + eol);
}

// =============================================================================
// PROJECT ID
// =============================================================================

/**
 * Reads a legacy marker's projectId, if the file predates the move of
 * projectId into the appManifest.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id (names the trigger file).
 * @returns The legacy guid, or null when absent/contentless.
 */
function legacyMarkerProjectId(folder: string, appId: string): string | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(markerPathOf(folder, appId), 'utf8')) as { projectId?: string };
		return typeof parsed?.projectId === 'string' && parsed.projectId ? parsed.projectId : null;
	} catch {
		return null;
	}
}

/**
 * Reads the app's working-copy projectId WITHOUT writing anything: the
 * appManifest's, else a legacy `{ id, projectId }` marker's.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The projectId, or null when the working copy has none yet.
 * @throws Error when package.json is unreadable or carries no appManifest.id.
 */
export function readProjectId(folder: string): string | null {
	const manifest = readPkg(folder).pkg.appManifest as AppManifestJson;
	return manifest.projectId || legacyMarkerProjectId(folder, manifest.id as string);
}

/**
 * Ensures the app's working-copy projectId in package.json appManifest.
 *
 * - Present: returned as-is (package.json untouched).
 * - Missing: adopted from a legacy `{ id, projectId }` marker when one
 *   exists (provenance continuity), otherwise freshly generated — then
 *   written into the appManifest, preserving the file's indentation.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The projectId now recorded in the appManifest.
 */
export function ensureProjectId(folder: string): string {
	const file = readPkg(folder);
	const manifest = file.pkg.appManifest as AppManifestJson;
	if (manifest.projectId) return manifest.projectId;

	// Backfill: legacy marker guid wins over a fresh one
	manifest.projectId = legacyMarkerProjectId(folder, manifest.id as string) ?? randomUUID();
	writePkg(file);
	return manifest.projectId;
}

// =============================================================================
// STORE LISTING — projection of the appManifest (package.json is the storage)
// =============================================================================

/** The listing projection of an appManifest (the App Builder webview contract). */
export interface AppListing {
	appId: string;
	mode: 'free' | 'subscription' | 'paywall';
	name: string;
	description: string;
	plans: Array<Record<string, unknown>>;
	/** App-folder-relative icon path ('' = undeclared). */
	icon?: string;
	/** App-folder-relative README path ('' = undeclared). */
	readme?: string;
	/** Workspace-relative extra pack roots (appManifest.include). */
	include?: string[];
	/** Server-build typecheck gate (appManifest.typecheck; absent = true). */
	typecheck?: boolean;
}

/**
 * Reads the STORE listing from the folder's appManifest.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The listing projection (mode defaults to 'free').
 */
export function readAppListing(folder: string): AppListing {
	const { pkg } = readPkg(folder);
	const m = pkg.appManifest as AppManifestJson;
	const mode = m.mode === 'subscription' || m.mode === 'paywall' ? m.mode : 'free';
	return {
		appId: m.id as string,
		mode,
		name: typeof m.name === 'string' ? m.name : (pkg.name ?? ''),
		description: typeof m.description === 'string' ? m.description : '',
		plans: Array.isArray(m.billing?.plans) ? m.billing.plans : [],
		icon: typeof m.icon === 'string' ? m.icon : '',
		readme: typeof m.readme === 'string' ? m.readme : '',
		include: Array.isArray(m.include) ? m.include.filter((p): p is string => typeof p === 'string' && p.length > 0) : [],
		// Normalized: only an explicit false disables the gate.
		typecheck: m.typecheck !== false,
	};
}

/**
 * Writes the app-manifest draft back into the folder's appManifest — name,
 * description, mode, billing.plans, and the packaging fields (icon, readme,
 * include). Plan metadata rides along verbatim; other billing keys are
 * preserved. Empty values DELETE their key (an empty plan list removes
 * billing.plans and an emptied billing block entirely; '' icon/readme and
 * an empty include list drop the manifest key) so the manifest never
 * accumulates dead fields.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param listing - The draft to persist.
 */
export function saveAppListing(folder: string, listing: AppListing): void {
	const file = readPkg(folder);
	const manifest = file.pkg.appManifest as AppManifestJson;
	manifest.name = listing.name;
	manifest.description = listing.description;
	manifest.mode = listing.mode;
	if (listing.plans.length > 0) {
		manifest.billing = { ...(manifest.billing ?? {}), plans: listing.plans };
	} else if (manifest.billing) {
		delete manifest.billing.plans;
		if (Object.keys(manifest.billing).length === 0) delete manifest.billing;
	}
	// Packaging fields — only touched when the draft carries them (the STORE
	// tab's save omits them; the PACKAGE tab's save owns them).
	if (listing.icon !== undefined) {
		if (listing.icon) manifest.icon = listing.icon;
		else delete manifest.icon;
	}
	if (listing.readme !== undefined) {
		if (listing.readme) manifest.readme = listing.readme;
		else delete manifest.readme;
	}
	if (listing.include !== undefined) {
		const entries = listing.include.map((p) => p.trim()).filter(Boolean);
		if (entries.length > 0) manifest.include = entries;
		else delete manifest.include;
	}
	if (listing.typecheck !== undefined) {
		// Only the non-default is stored: absent = strict (true).
		if (listing.typecheck) delete manifest.typecheck;
		else manifest.typecheck = false;
	}
	writePkg(file);
}
