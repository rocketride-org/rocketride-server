// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Workspace app scanner — VS Code adapter.
 *
 * Marker DISCOVERY uses the editor's workspace index (every open folder,
 * honoring files.exclude); resolving markers to apps — probing, ordering,
 * first-binding-wins dedup — is the SDK's (`rocketride/app-pack`), shared
 * with the CLI.
 *
 * Results are cached by the caller (SidebarProvider re-scans on `.rrapp`
 * and package.json file events).
 */

import * as vscode from 'vscode';
import { scanAppMarkers } from 'rocketride/app-pack';
import type { ScannedApp } from 'rocketride/app-pack';

export { appIconDataUri, MAX_README_IMAGE_BYTES } from 'rocketride/app-pack';
export type { ScannedApp } from 'rocketride/app-pack';

/**
 * Scans every workspace folder for app working copies.
 *
 * @returns All bound app projects in the workspace (shallowest marker per
 *          app id wins).
 */
export async function scanWorkspaceApps(): Promise<ScannedApp[]> {
	// Every `.rrapp` marker is a candidate; node_modules never holds a binding
	const markers = await vscode.workspace.findFiles('**/*.rrapp', '**/node_modules/**');
	return scanAppMarkers(markers.map((marker) => marker.fsPath));
}
