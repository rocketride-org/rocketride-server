// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App-types vendoring — puts the SHIPPED platform type surface into an app
 * folder.
 *
 * Standalone app repos have no rocketride-server checkout: platform modules
 * (the 'shell' surface) arrive from the shell's MF share scope at runtime
 * and are consume-only at build time, so TYPES are the only artifact such a
 * repo needs from the platform. The extension carries the generated bundle
 * (the frozen shell contract, built by shell:build)
 * and this module copies it into `<app>/types/rocketride-shell/`, where the
 * scaffolded tsconfig's `paths` point.
 *
 * Called at scaffold (new apps) and on every App Builder open (refresh —
 * existing apps track the platform the extension ships). The directory is
 * OWNED by the tooling: it is overwritten wholesale, never merged.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';

// The vendored directory name inside an app (documented in templates).
const VENDOR_DIR = path.join('types', 'rocketride-shell');

// The bundle's fixed file set. Three owners share this layout: the generator
// (generate-app-types), the server publisher (/dev/types/ under the shell's
// static root), and the vendored copy in app folders. tokens.css is the
// design-token vocabulary riding beside the types (see generate-app-types).
const BUNDLE_FILES = ['shell.d.ts', 'tokens.css', 'app-types.json'];

/**
 * Recursively copies a directory, replacing the destination.
 *
 * @param from - Source directory.
 * @param to - Destination directory (removed first).
 */
function replaceDir(from: string, to: string): void {
	fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) replaceDir(src, dst);
		else fs.copyFileSync(src, dst);
	}
}

/**
 * Downloads the connected server's type bundle. All files must arrive and
 * the manifest must parse before anything is written — a partial vendor is
 * worse than a stale one.
 *
 * @param baseUrl - The server's HTTP origin (from ConnectionManager).
 * @returns The bundle files, or null when unreachable/invalid.
 */
async function fetchServerBundle(baseUrl: string): Promise<Array<{ rel: string; text: string }> | null> {
	const logger = getLogger();
	try {
		// Trailing slash so URL resolution appends instead of replacing.
		const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
		const files = await Promise.all(BUNDLE_FILES.map(async (rel) => {
			const res = await fetch(new URL(`dev/types/${rel}`, base));
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
			return { rel, text: await res.text() };
		}));
		// Sanity: the provenance manifest must be valid JSON.
		JSON.parse(files.find((f) => f.rel === 'app-types.json')?.text ?? '');
		return files;
	} catch (err) {
		logger.output(`[appdev] server app-types fetch failed (${err instanceof Error ? err.message : String(err)}) — falling back to the extension's packaged copy`);
		return null;
	}
}

/**
 * Vendors (or refreshes) the app-types bundle into an app folder.
 *
 * Server first: the vendored types must describe the PLATFORM the app talks
 * to, and every server publishes its own bundle at /dev/types/ under the
 * shell's static root. The extension-packaged copy is the offline fallback
 * (and matches only the extension's own build vintage).
 *
 * Non-fatal by design: an unreachable server, a missing bundle (dev build
 * without shell:build), or an unwritable folder logs and returns — types
 * are an editor concern, never a reason to block the dev loop.
 *
 * @param context - Extension context (locates the packaged fallback bundle).
 * @param appFolder - The app's root folder.
 */
export async function vendorAppTypes(context: vscode.ExtensionContext, appFolder: string): Promise<void> {
	const logger = getLogger();
	const dest = path.join(appFolder, VENDOR_DIR);

	// ── Server bundle (preferred) ────────────────────────────────────────
	const baseUrl = ConnectionManager.getInstance().getHttpUrl?.() || '';
	if (baseUrl) {
		const files = await fetchServerBundle(baseUrl);
		if (files) {
			try {
				fs.rmSync(dest, { recursive: true, force: true });
				for (const f of files) {
					const target = path.join(dest, f.rel);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, f.text);
				}
				logger.output(`[appdev] vendored app types from ${baseUrl}/dev/types/ into ${dest}`);
				return;
			} catch (err) {
				logger.output(`[appdev] writing server app types failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	// ── Extension-packaged fallback ──────────────────────────────────────
	try {
		const source = path.join(context.extensionPath, 'app-types');
		if (!fs.existsSync(path.join(source, 'app-types.json'))) {
			logger.output('[appdev] app-types bundle not present in this extension build — skipping type vendoring');
			return;
		}
		replaceDir(source, dest);
		logger.output(`[appdev] vendored app types into ${dest}`);
	} catch (err) {
		logger.output(`[appdev] app-types vendoring failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
}
