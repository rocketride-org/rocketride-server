// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffolder — the non-interactive engine behind `rocketride.app.create`.
 *
 * The New App wizard (NewAppProvider webview) collects the app-name slug,
 * display name, and frame options, assembles the app id from the resolved
 * developer id, and calls scaffoldApp(). Scaffolding validates at submit
 * time (the wizard panel is modeless — its form state may be stale), writes
 * the template tree (every file with the MIT header), then opens the App
 * Builder screen. The scaffold always ends BOUND: the appManifest.id in the
 * generated package.json is what MY APPS discovers (bind, don't sync).
 *
 * Dependency install is left to the developer (`pnpm install` in the app
 * folder) — surfaced as the completion toast's action so the first watch
 * run has its toolchain.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { renderTemplate } from 'shared/modules/appdev/templates';
import type { FrameOptions, TemplateName } from 'shared/modules/appdev/templates';
import { getExtensionContext } from '../extension';
import { vendorAppTypes } from './appTypes';

// =============================================================================
// VALIDATION
// =============================================================================

/** App id shape: `<publisher>.<name>` — lowercase, digits, hyphens per segment. */
export const APP_ID_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

// =============================================================================
// TYPES
// =============================================================================

/** Everything the wizard collects for one scaffold run. */
export interface ScaffoldParams {
	/** Full app id `<publisher>.<name>` — the linkage name. */
	appId: string;
	/** Human-readable display name. */
	appName: string;
	/** Frame options composing the generated App.tsx. */
	frame: FrameOptions;
	/** Template body; defaults to 'Blank' (the wizard's scaffold). */
	template?: TemplateName;
}

// =============================================================================
// WORKSPACE INSPECTION
// =============================================================================

/**
 * Lists the folder names already present under the workspace `apps/`
 * directory so the wizard can pre-validate name collisions live.
 *
 * @returns Folder names under apps/, or [] when none exist or no workspace is open.
 */
export async function listAppFolders(): Promise<string[]> {
	// step: no workspace = no apps directory to collide with
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) return [];

	// step: read apps/ and keep only directory entries
	try {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root.uri, 'apps'));
		return entries.filter(([, kind]) => kind === vscode.FileType.Directory).map(([name]) => name);
	} catch {
		// apps/ does not exist yet — nothing to collide with
		return [];
	}
}

// =============================================================================
// SCAFFOLD
// =============================================================================

/**
 * Scaffolds a new app into the workspace `apps/` directory.
 *
 * Re-validates the identity and target folder at submit time, writes the
 * rendered template tree, vendors the platform types, and opens the App
 * Builder with the install-step toast.
 *
 * @param params - The wizard-collected scaffold parameters.
 * @returns The created app id.
 * @throws Error when the id is malformed, the display name is empty, no
 *         workspace is open, or the target folder already exists.
 */
export async function scaffoldApp(params: ScaffoldParams): Promise<string> {
	const { appId, appName, frame } = params;

	// ── 1. Validate identity (submit-time — the form state may be stale) ─
	if (!APP_ID_RE.test(appId)) {
		throw new Error(`Invalid app id "${appId}" — use <publisher>.<name>, lowercase letters, digits, hyphens.`);
	}
	if (!appName.trim()) {
		throw new Error('Display name is required.');
	}

	// ── 2. Target folder ─────────────────────────────────────────────────
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Open a workspace folder first — the app is scaffolded into it.');
	}
	// Apps live under ./apps by convention — symmetric with ./pipelines
	// (pipeline files) and the node designer's ./nodes, and it makes an
	// existing RocketRide repo's apps editable in place.
	const folderName = `${appId.split('.')[1]}-ui`;
	const target = vscode.Uri.joinPath(root.uri, 'apps', folderName);

	// Refuse to scaffold over an existing folder — never overwrite work
	let folderTaken = false;
	try {
		await vscode.workspace.fs.stat(target);
		folderTaken = true;
	} catch {
		/* good — folder is free */
	}
	if (folderTaken) {
		throw new Error(`Folder "apps/${folderName}" already exists in the workspace.`);
	}

	// ── 3. Render + write the tree ───────────────────────────────────────
	// Preview URL baked into launch.json: the current engine's shell with
	// the app locked + dev hooks on (same derivation as the App Screen).
	const base = (ConnectionManager.getInstance().getHttpUrl?.() || 'http://localhost:5565').replace(/\/$/, '');
	const files = renderTemplate(
		params.template ?? 'Blank',
		{
			appId,
			appName,
			// The publisher half of the id — the resolved developer id
			publisher: appId.split('.')[0],
			moduleId: appId.replace(/[.-]/g, '_'),
			// Deterministic-ish dev port from the app id, clear of common ranges
			port: 3100 + (Math.abs([...appId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 800),
			previewUrl: `${base}/?appid=${encodeURIComponent(appId)}&rrdev=1`,
		},
		frame,
	);
	for (const file of files) {
		const uri = vscode.Uri.joinPath(target, ...file.path.split('/'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
	}

	// Install the platform package — wires "shell": "file:<workspace>/
	// .rocketride/shell" into the app's package.json (always, even offline)
	// and vendors the connected server's shell.tgz into that directory.
	// Nothing is written inside the app folder itself. Fire-and-forget and
	// non-fatal by design, so scaffolding never waits on it.
	void vendorAppTypes(getExtensionContext(), target.fsPath);

	// ── 4. Open the App Builder + surface the install step ───────────────
	await vscode.commands.executeCommand('revealInExplorer', target);
	await vscode.commands.executeCommand('rocketride.app.open', appId);
	const action = await vscode.window.showInformationMessage(`Created ${appName} (${appId}). Run "pnpm install" in ${folderName} to enable the watch loop.`, 'Open Terminal');
	if (action === 'Open Terminal') {
		const term = vscode.window.createTerminal({ name: appName, cwd: target.fsPath });
		term.show();
		term.sendText('pnpm install');
	}
	return appId;
}
