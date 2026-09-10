// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The `.rrapp` trigger — the file that opens the App Builder.
 *
 * `<folder>/<name>.rrapp` is a CONTENTLESS trigger: double-clicking it in
 * the Explorer opens the App Builder, and VSCode uses it for tab identity.
 * Everything ABOUT the app — id, name, and the working-copy `projectId` —
 * lives in ONE place: the folder's package.json `appManifest` block.
 *
 * `projectId` is a client-side guid that tells one working copy (checkout,
 * duplicate) of the same app apart from another. It never becomes a server
 * key — deploys record it only as `metadata.projectId` provenance. Legacy
 * markers that still carry `{ id, projectId }` are migrated: their
 * projectId is adopted into the appManifest on first ensure.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// =============================================================================
// TRIGGER FILE
// =============================================================================

/**
 * The trigger URI for an app folder: `<folder>/<lastSegment(appId)>.rrapp`.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id.
 */
export function markerUriOf(folder: string, appId: string): vscode.Uri {
	return vscode.Uri.joinPath(vscode.Uri.file(folder), `${appId.split('.').pop()}.rrapp`);
}

/**
 * Ensures the folder's `.rrapp` trigger file exists (created empty when
 * missing). Existing files are left untouched — their content is ignored.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id (names the trigger file).
 * @returns The trigger file URI.
 */
export async function ensureAppTrigger(folder: string, appId: string): Promise<vscode.Uri> {
	const uri = markerUriOf(folder, appId);
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		// Valid-but-empty JSON so generic tooling opening it never chokes
		await vscode.workspace.fs.writeFile(uri, Buffer.from('{}\n', 'utf8'));
	}
	return uri;
}

// =============================================================================
// PACKAGE.JSON ACCESS — one owner of every manifest read/write
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
	uri: vscode.Uri;
	raw: string;
	pkg: { name?: string; appManifest?: AppManifestJson; [key: string]: unknown };
}

/**
 * Reads + parses the folder's package.json, requiring an appManifest.id.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The parsed file with its raw text.
 */
async function readPkg(folder: string): Promise<PkgFile> {
	const uri = vscode.Uri.joinPath(vscode.Uri.file(folder), 'package.json');
	const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	const pkg = JSON.parse(raw) as PkgFile['pkg'];
	if (!pkg.appManifest?.id) {
		throw new Error(`No appManifest.id in ${uri.fsPath} — not an app project.`);
	}
	return { uri, raw, pkg };
}

/**
 * Writes the parsed package.json back, preserving the original file's
 * indentation style and trailing newline.
 *
 * @param file - The parsed file (pkg mutated in place by the caller).
 */
async function writePkg(file: PkgFile): Promise<void> {
	const indent = file.raw.match(/\n([ \t]+)"/)?.[1] ?? '\t';
	const eol = file.raw.endsWith('\n') ? '\n' : '';
	await vscode.workspace.fs.writeFile(file.uri, Buffer.from(JSON.stringify(file.pkg, null, indent) + eol, 'utf8'));
}

// =============================================================================
// PROJECT ID — lives in package.json appManifest
// =============================================================================

/**
 * Reads a legacy marker's projectId, if the file predates the move of
 * projectId into the appManifest.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id (names the trigger file).
 * @returns The legacy guid, or null when absent/contentless.
 */
async function legacyMarkerProjectId(folder: string, appId: string): Promise<string | null> {
	try {
		const raw = await vscode.workspace.fs.readFile(markerUriOf(folder, appId));
		const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as { projectId?: string };
		return typeof parsed?.projectId === 'string' && parsed.projectId ? parsed.projectId : null;
	} catch {
		return null;
	}
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
export async function ensureProjectId(folder: string): Promise<string> {
	const file = await readPkg(folder);
	const manifest = file.pkg.appManifest as AppManifestJson;
	if (manifest.projectId) return manifest.projectId;

	// Backfill: legacy marker guid wins over a fresh one
	manifest.projectId = (await legacyMarkerProjectId(folder, manifest.id as string)) ?? randomUUID();
	await writePkg(file);
	return manifest.projectId;
}

// =============================================================================
// STORE LISTING — projection of the appManifest (package.json is the storage)
// =============================================================================

/** Structural mirror of the shared ListingDraft (the webview contract). */
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
export async function readAppListing(folder: string): Promise<AppListing> {
	const { pkg } = await readPkg(folder);
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
export async function saveAppListing(folder: string, listing: AppListing): Promise<void> {
	const file = await readPkg(folder);
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
	await writePkg(file);
}
