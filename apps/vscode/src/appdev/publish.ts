// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy flow — copy an immutable app version to the server from VSCode.
 *
 * The zip carries the app's SOURCE (the SERVER owns the build, so the
 * store never has to trust client-produced binaries, and deploy runs NO
 * local build of any kind), laid out WORKSPACE-RELATIVE: the app folder
 * packs at its real position (deploy metadata names it as `appRoot`),
 * and `appManifest.include` entries — workspace-relative files or dirs
 * the build needs beyond the app folder (a shared source dir, a local
 * lib) — pack at theirs. Because the zip mirrors the workspace tree,
 * relative references between the packed roots resolve after the server
 * unpacks, with nothing rewritten. Filtering follows the workspace's
 * .gitignore plus a hardcoded baseline (see rocketride/app-pack — the
 * canonical pack rules, shared with deploy.addApp). The zip rides
 * the generic `rrext_deploy add` rail door; the server retains it and
 * unpacks at receipt; deploying never activates anything — the Deploy
 * view publishes rungs.
 */

import * as path from 'path';
import * as vscode from 'vscode';
// Side-effect import: arms the SDK's app-pack registry so deploy.addApp()
// finds the Node-only packer inside the bundled extension (a runtime
// package-specifier import cannot resolve from a bundle).
import 'rocketride/app-pack';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { ensureProjectId, readAppListing } from './appMarker';
import type { AppListing } from './appMarker';
import { getLogger } from '../shared/util/output';

// =============================================================================
// PUBLISH
// =============================================================================

/**
 * Packs the app's source (workspace-rooted, includes honored) and deploys
 * it as an immutable version.
 *
 * @param appId - The app to publish (appManifest.id).
 * @param message - Commit-style "what changed" note for the version card.
 * @returns The new version-rail entry.
 */
export async function deployApp(appId: string, message: string): Promise<Record<string, unknown>> {
	const logger = getLogger();
	logger.output(`[appdev:pack] deploy ${appId} — pre-pack checks:`);
	const apps = await scanWorkspaceApps();
	const app = apps.find((a) => a.id === appId);
	if (!app) {
		logger.output(`[appdev:pack]   check bound folder — FAILED: no bound folder for ${appId}`);
		throw new Error(`App "${appId}" has no bound folder in this workspace.`);
	}
	logger.output(`[appdev:pack]   check bound folder — OK (${app.folder})`);

	const client = ConnectionManager.getInstance().getClient();
	if (!client || !ConnectionManager.getInstance().isConnected()) {
		logger.output('[appdev:pack]   check server connection — FAILED: not connected');
		throw new Error('Not connected — publishing needs a live server connection.');
	}
	logger.output('[appdev:pack]   check server connection — OK');

	// ── Workspace anchoring: the zip is rooted at the app's workspace ────
	// folder, so include entries and the app pack at their real positions.
	const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(app.folder));
	if (!wsFolder) {
		logger.output('[appdev:pack]   check workspace anchoring — FAILED: app folder outside every workspace folder');
		throw new Error(`App folder "${app.folder}" is not inside an open workspace folder.`);
	}
	const workspaceRoot = wsFolder.uri.fsPath;
	const appRoot = path.relative(workspaceRoot, app.folder).replace(/\\/g, '/');
	if (appRoot.startsWith('..')) {
		logger.output(`[appdev:pack]   check appRoot — FAILED: "${appRoot}" escapes the workspace`);
		throw new Error(`App folder "${app.folder}" escapes its workspace folder.`);
	}
	logger.output(`[appdev:pack]   check workspace anchoring — OK (root ${workspaceRoot})`);
	logger.output(`[appdev:pack]   check appRoot — OK (${appRoot || '(workspace root — legacy layout)'})`);

	// ── Include layout rule: appRoot === '' is the app-folder-as-workspace
	// case — there is no surrounding workspace to include from. Checked
	// here (not left to the packer) so the failure names the VS Code
	// workspace situation precisely.
	if (appRoot === '') {
		// readAppListing owns the read, the parse, and the include
		// normalization — re-implementing them here would be a second copy
		// to keep in step with the manifest shape.
		let listing: AppListing;
		try {
			listing = await readAppListing(app.folder);
		} catch (err) {
			throw new Error(`Could not read the app's package.json: ${err instanceof Error ? err.message : String(err)}`);
		}
		if ((listing.include?.length ?? 0) > 0) {
			logger.output('[appdev:pack]   check include layout — FAILED: include declared but the workspace folder IS the app folder');
			throw new Error('appManifest.include needs the app inside a larger workspace — the workspace folder IS the app folder here.');
		}
	}

	// ── Working-copy provenance: the appManifest projectId ───────────────
	// Ensured BEFORE packing so a first-time deploy's freshly stamped
	// package.json is inside the zip, not just on disk.
	const projectId = await ensureProjectId(app.folder);
	logger.output(`[appdev:pack]   check projectId — OK (${projectId})`);

	// ── Verify + pack + send: the ONE SDK call (deploy = copy code to the
	// server). Packing rules — workspace-rooted layout, include entries,
	// gitignore + baseline filtering, both size caps — are the SDK's
	// canonical implementation; every step narrates into the output
	// channel through onProgress.
	const body = await client.deploy.addApp(appRoot || '.', {
		workspaceRoot,
		comment: message,
		metadata: { projectId },
		onProgress: (line) => logger.output(`[appdev:pack] ${line}`),
	});
	const entry = (body as Record<string, unknown>)?.artifact as Record<string, unknown> | undefined;
	if (!entry) throw new Error(`Deploy returned no artifact entry for ${appId}.`);
	// The registry's answer is the truth about what was deployed — report
	// the SAME version in the log (the manifest's app.version is only the
	// fallback). No toast: the deploy runs FROM the App Builder, whose
	// Deploy rail and dashboard already show the new version live.
	const deployedVersion = (entry.appVersion as string) ?? app.version;
	logger.output(`[appdev] deployed ${appId} v${deployedVersion} (registry v${entry.registryVersion})`);
	return entry;
}
