// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App-types vendoring — puts the SHIPPED platform type surface into an app
 * folder.
 *
 * Standalone app repos have no rocketride-server checkout: platform modules
 * (`shell-ui`, `shared`) arrive from the shell's MF share scope at runtime
 * and are consume-only at build time, so TYPES are the only artifact such a
 * repo needs from the platform. The extension carries the generated bundle
 * (frozen shell-api contract + shared-ui rollup, built by shell-ui:build)
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

// The vendored directory name inside an app (documented in templates).
const VENDOR_DIR = path.join('types', 'rocketride-shell');

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
 * Vendors (or refreshes) the app-types bundle into an app folder.
 *
 * Non-fatal by design: a missing bundle (dev build without shell-ui:build)
 * or an unwritable folder logs and returns — types are an editor concern,
 * never a reason to block the dev loop.
 *
 * @param context - Extension context (locates the shipped bundle).
 * @param appFolder - The app's root folder.
 */
export function vendorAppTypes(context: vscode.ExtensionContext, appFolder: string): void {
	const logger = getLogger();
	try {
		const source = path.join(context.extensionPath, 'app-types');
		if (!fs.existsSync(path.join(source, 'app-types.json'))) {
			logger.output('[appdev] app-types bundle not present in this extension build — skipping type vendoring');
			return;
		}
		replaceDir(source, path.join(appFolder, VENDOR_DIR));
		logger.output(`[appdev] vendored app types into ${path.join(appFolder, VENDOR_DIR)}`);
	} catch (err) {
		logger.output(`[appdev] app-types vendoring failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
}
