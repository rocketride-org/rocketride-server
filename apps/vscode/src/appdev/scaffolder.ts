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
 * Dependencies install through the workspace-global model: the root
 * workspace file claims apps/*, so scaffolding triggers the shared
 * single-flight `pnpm install` at the workspace root and the new member
 * links without any manual step.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection';
import { getLogger } from '../shared/util/output';
import { renderTemplate } from 'shared/modules/appdev/templates';
import type { FrameOptions, TemplateName } from 'shared/modules/appdev/templates';
import { getExtensionContext } from '../extension';
import { vendorAppTypes } from './appTypes';
import { getWatchManager } from './watchManager';

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
// GITIGNORE
// =============================================================================

/**
 * Ensures the WORKSPACE root's .gitignore covers dependency trees and build
 * output — the root install materializes node_modules at the root and in
 * every app, and app builds emit dist/, none of which belong in the user's
 * repository.
 *
 * Conservative with the user-owned file: a missing file is created; an
 * existing file only gains the patterns it does not already carry (checked
 * against the common spellings), appended at the end with a comment.
 *
 * @param workspaceRoot - The workspace folder owning .gitignore.
 */
function ensureGitignore(workspaceRoot: string): void {
	const logger = getLogger();
	const ignorePath = path.join(workspaceRoot, '.gitignore');
	// step: pattern → accepted existing spellings (any of these means covered)
	const wanted: Array<{ line: string; spellings: string[] }> = [
		{ line: '**/node_modules/', spellings: ['node_modules', 'node_modules/', '**/node_modules', '**/node_modules/'] },
		{ line: '**/dist/', spellings: ['dist', 'dist/', '**/dist', '**/dist/'] },
	];
	try {
		const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
		const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
		const missing = wanted.filter((w) => !w.spellings.some((s) => lines.has(s)));
		if (missing.length === 0) return;
		// step: append only what is missing, under one explanatory comment
		const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}# Dependencies and build output (machine-generated)\n${missing.map((w) => w.line).join('\n')}\n`;
		fs.writeFileSync(ignorePath, existing + block);
		logger.output(`[appdev] ${existing ? 'amended' : 'wrote'} ${ignorePath} — added ${missing.map((w) => w.line).join(', ')}`);
	} catch (err) {
		logger.output(`[appdev] could not update ${ignorePath} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
}

// =============================================================================
// WORKSPACE SETTINGS
// =============================================================================

/**
 * Creates the WORKSPACE root's .vscode/settings.json when none exists,
 * enabling explorer.excludeGitIgnore so the Explorer hides everything the
 * .gitignore covers (node_modules/, dist/ — the machine-generated noise
 * the root install and app builds produce).
 *
 * Create-only by design: an existing settings.json is the user's and is
 * never touched. Non-fatal.
 *
 * @param workspaceRoot - The workspace folder owning .vscode/.
 */
function ensureWorkspaceSettings(workspaceRoot: string): void {
	const logger = getLogger();
	const settingsDir = path.join(workspaceRoot, '.vscode');
	const settingsPath = path.join(settingsDir, 'settings.json');
	try {
		// step: existing settings are user-owned — leave them alone entirely
		if (fs.existsSync(settingsPath)) return;
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(settingsPath, `${JSON.stringify({ 'explorer.excludeGitIgnore': true }, null, 2)}\n`);
		logger.output(`[appdev] wrote ${settingsPath} (Explorer hides gitignored files)`);
	} catch (err) {
		logger.output(`[appdev] could not write ${settingsPath} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	}
}

// =============================================================================
// LAUNCH CONFIG
// =============================================================================

/**
 * Merges the app's F5 debug configuration into the WORKSPACE root's
 * .vscode/launch.json — one entry per app, keyed by name ("Debug <app>").
 *
 * Conservative with the user-owned file: a missing file is created whole; a
 * parseable file gains (or updates) only this app's entry; an unparseable
 * file (launch.json allows comments, which JSON.parse rejects) is left
 * untouched with a log naming the config to add by hand. Non-fatal — a
 * debug config is never a reason to fail a scaffold.
 *
 * @param workspaceRoot - The workspace folder owning .vscode/.
 * @param appName - Display name (the config is "Debug <appName>").
 * @param appRelFolder - App folder relative to the root (webRoot target).
 * @param previewUrl - The preview shell URL the debugger opens.
 */
function ensureLaunchConfig(workspaceRoot: string, appName: string, appRelFolder: string, previewUrl: string): void {
	const logger = getLogger();
	const launchDir = path.join(workspaceRoot, '.vscode');
	const launchPath = path.join(launchDir, 'launch.json');
	// step: the entry — msedge against the preview shell, sources mapped
	// into the app's folder
	const config = {
		name: `Debug ${appName}`,
		type: 'msedge',
		request: 'launch',
		url: previewUrl,
		webRoot: `\${workspaceFolder}/${appRelFolder}`,
		sourceMapPathOverrides: {
			'webpack:///./*': `\${workspaceFolder}/${appRelFolder}/*`,
			'webpack:///*': '*',
		},
	};
	try {
		if (!fs.existsSync(launchPath)) {
			// step: no file — create the standard skeleton with this entry
			fs.mkdirSync(launchDir, { recursive: true });
			fs.writeFileSync(launchPath, `${JSON.stringify({ version: '0.2.0', configurations: [config] }, null, 2)}\n`);
			logger.output(`[appdev] wrote ${launchPath} with "${config.name}"`);
			return;
		}
		// step: merge into the existing file — replace this app's entry by
		// name, keep everything else byte-for-byte semantically intact
		const parsed = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
		const configurations: Record<string, unknown>[] = Array.isArray(parsed.configurations) ? parsed.configurations : [];
		const idx = configurations.findIndex((c) => c && c.name === config.name);
		if (idx >= 0) configurations[idx] = config;
		else configurations.push(config);
		parsed.configurations = configurations;
		fs.writeFileSync(launchPath, `${JSON.stringify(parsed, null, 2)}\n`);
		logger.output(`[appdev] ${idx >= 0 ? 'updated' : 'added'} "${config.name}" in ${launchPath}`);
	} catch (err) {
		// launch.json permits comments/trailing commas; never mangle a file
		// this code cannot faithfully rewrite.
		logger.output(`[appdev] could not merge the debug config into ${launchPath} (${err instanceof Error ? err.message : String(err)}) — add a "${config.name}" msedge configuration for ${previewUrl} manually`);
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
	// Preview URL for the F5 debug config: the current engine's shell with
	// the app locked + dev hooks on (same derivation as the App Screen).
	const base = (ConnectionManager.getInstance().getHttpUrl?.() || 'http://localhost:5565').replace(/\/$/, '');
	const previewUrl = `${base}/?appid=${encodeURIComponent(appId)}&rrdev=1`;
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
			previewUrl,
		},
		frame
	);
	for (const file of files) {
		const uri = vscode.Uri.joinPath(target, ...file.path.split('/'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
	}

	// F5 debug config lives in the WORKSPACE root's .vscode/launch.json —
	// VSCode only surfaces launch configs from workspace-folder roots, so an
	// app-local .vscode would never appear in the debug dropdown. One entry
	// per app, merged beside whatever the user already has.
	ensureLaunchConfig(root.uri.fsPath, appName, `apps/${folderName}`, previewUrl);

	// Dependency trees and build output stay out of the user's repository —
	// the root install and app builds generate both at multiple depths.
	ensureGitignore(root.uri.fsPath);

	// First scaffold in a fresh workspace also seeds settings.json so the
	// Explorer hides the gitignored machine-generated trees.
	ensureWorkspaceSettings(root.uri.fsPath);

	// Install the platform package — ensures the root workspace file, wires
	// "shell": "file:../../.rocketride/shell/shell.tgz" into the app's
	// package.json (always, even offline), and downloads the canonical
	// tarball. Fire-and-forget and non-fatal by design, so scaffolding
	// never waits on it.
	void vendorAppTypes(getExtensionContext(), target.fsPath);

	// ── 4. Open the App Builder + link the new member ────────────────────
	await vscode.commands.executeCommand('revealInExplorer', target);
	await vscode.commands.executeCommand('rocketride.app.open', appId);
	// The root workspace claims apps/* — invalidate the shared install so
	// the brand-new member links even when no watch session starts (the
	// single-flight memo dedupes against the watch's own install).
	const watchManager = getWatchManager();
	watchManager?.invalidateInstall();
	void watchManager?.ensureInstalled(appId);
	vscode.window.showInformationMessage(`Created ${appName} (${appId}).`);
	return appId;
}
