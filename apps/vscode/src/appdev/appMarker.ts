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
// Deep file import (like the templates shim) — the barrel would drag the
// React view layer into the extension-host bundle.
import { applyListing, projectListing } from 'shared/modules/appdev/listing';
import type { PackageJsonLike } from 'shared/modules/appdev/listing';
import type { ListingDraft } from 'shared/modules/appdev/types';

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
		throw new Error(`No appManifest.id in ${uri.fsPath}. Not an app project.`);
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

// The listing IS the shared ListingDraft — the projection logic lives in
// shared appdev/listing (one implementation for every host); this module
// contributes only the native-fs read/write plumbing.
export type AppListing = ListingDraft;

/**
 * Reads the STORE listing from the folder's appManifest.
 *
 * @param folder - The app's bound folder (absolute path).
 * @returns The listing projection (mode defaults to 'free').
 */
export async function readAppListing(folder: string): Promise<AppListing> {
	const { pkg } = await readPkg(folder);
	return projectListing(pkg as PackageJsonLike);
}

/**
 * Writes the app-manifest draft back into the folder's appManifest (the
 * shared applyListing owns the field semantics — empty values delete their
 * keys, plan metadata rides verbatim, packaging fields only when carried).
 *
 * @param folder - The app's bound folder (absolute path).
 * @param listing - The draft to persist.
 */
export async function saveAppListing(folder: string, listing: AppListing): Promise<void> {
	const file = await readPkg(folder);
	applyListing(file.pkg as PackageJsonLike, listing);
	await writePkg(file);
}
