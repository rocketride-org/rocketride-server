// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The `.rrapp` trigger and the appManifest — VS Code adapter.
 *
 * The trigger/manifest logic (projectId provenance, listing projection) is
 * the SDK's (`rocketride/app-pack`), shared with the CLI. This module only
 * hands the trigger back as a `vscode.Uri` for the custom-editor open.
 */

import * as vscode from 'vscode';
import { ensureAppTrigger as ensureTriggerFile } from 'rocketride/app-pack';

export { ensureProjectId, readAppListing, saveAppListing } from 'rocketride/app-pack';
export type { AppListing } from 'rocketride/app-pack';

/**
 * Ensures the folder's `.rrapp` trigger file exists (created empty when
 * missing). Existing files are left untouched — their content is ignored.
 *
 * @param folder - The app's bound folder (absolute path).
 * @param appId - The appManifest id (names the trigger file).
 * @returns The trigger file URI.
 */
export function ensureAppTrigger(folder: string, appId: string): vscode.Uri {
	return vscode.Uri.file(ensureTriggerFile(folder, appId));
}
