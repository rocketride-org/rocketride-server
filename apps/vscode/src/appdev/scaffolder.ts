// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffolder — the `rocketride.app.create` flow.
 *
 * QuickPick a template, collect the app id (`<org>.<name>`) and display
 * name, choose the target folder, write the template tree (every file with
 * the MIT header), then open the App Builder screen. The scaffold always
 * ends BOUND: the appManifest.id in the generated package.json is what MY
 * APPS discovers (bind, don't sync).
 *
 * Dependency install is left to the developer (`pnpm install` in the app
 * folder) — surfaced as the completion toast's action so the first watch
 * run has its toolchain.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { renderTemplate, TEMPLATE_NAMES } from 'shared/modules/appdev/templates';
import type { TemplateName } from 'shared/modules/appdev/templates';

// =============================================================================
// VALIDATION
// =============================================================================

/** App id shape: `<org>.<name>` — lowercase, digits, hyphens per segment. */
const APP_ID_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

// =============================================================================
// SCAFFOLD FLOW
// =============================================================================

/**
 * Runs the interactive New App flow.
 *
 * @returns The created app id, or undefined when the user cancelled.
 */
export async function createApp(): Promise<string | undefined> {
	// ── 1. Template ──────────────────────────────────────────────────────
	const template = (await vscode.window.showQuickPick([...TEMPLATE_NAMES], {
		title: 'New RocketRide App',
		placeHolder: 'Choose a template',
	})) as TemplateName | undefined;
	if (!template) return undefined;

	// ── 2. App id ────────────────────────────────────────────────────────
	const appId = await vscode.window.showInputBox({
		title: 'App ID',
		prompt: 'Unique app id in the form <org>.<name> (e.g. acme.brandy)',
		validateInput: (value) => (APP_ID_RE.test(value) ? undefined : 'Use <org>.<name> — lowercase letters, digits, hyphens'),
	});
	if (!appId) return undefined;

	// ── 3. Display name ──────────────────────────────────────────────────
	const defaultName = appId.split('.')[1].replace(/(^|-)(\w)/g, (_, __, c: string) => ` ${c.toUpperCase()}`).trim();
	const appName = await vscode.window.showInputBox({
		title: 'Display name',
		value: defaultName,
		prompt: 'Human-readable app name',
		validateInput: (value) => (value.trim() ? undefined : 'Name is required'),
	});
	if (!appName) return undefined;

	// ── 4. Target folder ─────────────────────────────────────────────────
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		vscode.window.showErrorMessage('Open a workspace folder first — the app is scaffolded into it.');
		return undefined;
	}
	// Apps live under ./apps by convention — symmetric with ./pipelines
	// (pipeline files) and the node designer's coming ./nodes, and it makes
	// an existing RocketRide repo's apps editable in place.
	const folderName = `${appId.split('.')[1]}-ui`;
	const target = vscode.Uri.joinPath(root.uri, 'apps', folderName);

	// Refuse to scaffold over an existing folder — never overwrite work
	try {
		await vscode.workspace.fs.stat(target);
		vscode.window.showErrorMessage(`Folder "apps/${folderName}" already exists in the workspace.`);
		return undefined;
	} catch { /* good — folder is free */ }

	// ── 5. Render + write the tree ───────────────────────────────────────
	// Preview URL baked into launch.json: the current engine's shell with
	// the app locked + dev hooks on (same derivation as the App Screen).
	const base = (ConnectionManager.getInstance().getHttpUrl?.() || 'http://localhost:5565').replace(/\/$/, '');
	const files = renderTemplate(template, {
		appId,
		appName,
		moduleId: appId.replace(/[.-]/g, '_'),
		// Deterministic-ish dev port from the app id, clear of common ranges
		port: 3100 + (Math.abs([...appId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 800),
		previewUrl: `${base}/?appid=${encodeURIComponent(appId)}&rrdev=1`,
	});
	for (const file of files) {
		const uri = vscode.Uri.joinPath(target, ...file.path.split('/'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
	}

	// ── 6. Open the App Builder + surface the install step ───────────────
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
