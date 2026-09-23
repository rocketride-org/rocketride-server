// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * F5 debug — `rocketride.app.debug` (decision D2).
 *
 * Ensures the app's watch session is running (one built bundle + live dev
 * overlay), then launches a REAL external browser via a standard js-debug
 * config pointed at the preview URL — the developer's default browser when
 * it is Chromium-based (see browser.ts), Edge otherwise. Everything else is
 * stock VSCode: Run & Debug sidebar, breakpoints, Debug Console. The config
 * is built in-memory — this command is the single debug entry point; no
 * launch.json entry is scaffolded (a static entry could not ensure the
 * watch session and would open a preview with no dev bundle served).
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { resolveBrowserDebugTarget } from './browser';
import { DEV_SESSION_NONCE } from './devSession';
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
	const base = (ConnectionManager.getInstance().getHttpUrl?.() || 'http://localhost:5565').replace(/\/$/, '');
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(app.folder));
	// The developer's default browser when Chromium-based; Edge otherwise
	const browser = await resolveBrowserDebugTarget();
	const config: vscode.DebugConfiguration = {
		name: `Debug ${app.name}`,
		type: browser.type,
		...(browser.runtimeExecutable ? { runtimeExecutable: browser.runtimeExecutable } : {}),
		request: 'launch',
		// rrsession routes the browser preview to THIS editor's dev-overlay
		// entry when several editors dev-serve the same app.
		url: `${base}/?appid=${encodeURIComponent(appId)}&rrdev=1&rrsession=${DEV_SESSION_NONCE}`,
		// The app bundles' sourcemaps carry sources RELATIVE to the build
		// root's parent (the workspace root), e.g.
		// "../../../../../../apps/home-ui/src/HomeApp.tsx" — the browser
		// clamps the leading "../"s at the origin, so js-debug sees
		// "<origin>/apps/<name>/src/*.tsx" and maps that URL path onto
		// webRoot. webRoot must therefore be the WORKSPACE root, not the app
		// folder — the app folder doubles the path
		// (".../apps/home-ui/apps/home-ui/...") and no breakpoint ever binds.
		webRoot: folder?.uri.fsPath ?? app.folder,
	};
	// startDebugging resolves false (no throw) when the session never starts
	// — a silent F5 no-op unless it is reported here.
	const started = await vscode.debug.startDebugging(folder, config);
	if (!started) {
		vscode.window.showErrorMessage(`Debug session for ${app.name} did not start — the ${browser.type} (js-debug) launch was rejected; check that the browser is installed and the js-debug extension is enabled.`);
	}
}
