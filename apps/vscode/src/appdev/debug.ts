// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * F5 debug — `rocketride.app.debug` (decision D2).
 *
 * Ensures the app's watch session is running (one built bundle + live dev
 * overlay), then launches a REAL external browser via a standard js-debug
 * msedge config pointed at the preview URL. Everything else is stock
 * VSCode: Run & Debug sidebar, breakpoints, Debug Console. The app's
 * .vscode/launch.json (scaffolded) is preferred when the app is the
 * workspace root; otherwise this in-memory config is used.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { ensureWatch } from './watchManager';

// =============================================================================
// DEBUG LAUNCH
// =============================================================================

/**
 * Launches an external-browser debug session for an app.
 *
 * @param appId - The app to debug (appManifest.id).
 */
export async function debugApp(appId: string): Promise<void> {
	// Resolve the workspace binding
	const apps = await scanWorkspaceApps();
	const app = apps.find((a) => a.id === appId);
	if (!app) {
		vscode.window.showErrorMessage(`App "${appId}" has no bound folder in this workspace.`);
		return;
	}

	// One watch session must be live so the preview serves a dev bundle
	await ensureWatch(app, true);

	// Standard js-debug external-browser launch (stock UI from here on).
	// sourceMapPathOverrides maps the MF remote's webpack:/// sources back
	// to the app folder so breakpoints bind in the developer's .tsx files.
	const base = (ConnectionManager.getInstance().getHttpUrl?.() || 'http://localhost:5565').replace(/\/$/, '');
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(app.folder));
	const config: vscode.DebugConfiguration = {
		name: `Debug ${app.name}`,
		type: 'msedge',
		request: 'launch',
		url: `${base}/?appid=${encodeURIComponent(appId)}&rrdev=1`,
		webRoot: app.folder,
		sourceMapPathOverrides: {
			'webpack:///./*': `${app.folder}/*`,
			'webpack:///*': '*',
		},
	};
	await vscode.debug.startDebugging(folder, config);
}
