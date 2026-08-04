// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Publish flow — snapshot an immutable app version from VSCode.
 *
 * Publish ALWAYS uses the real rsbuild build (decision D5 — browser-linked
 * dev output is never uploaded): a one-shot `rsbuild build` in the app
 * folder, then the built remoteEntry.js is pushed to the org registry via
 * the SDK's appPublish. Publishing never activates anything — the Deploy
 * view pins rungs.
 *
 * v1 transport bound: one binary frame = the remoteEntry.js (template-scale
 * apps). Multi-file bundles ride the zip upload when it lands (M5).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { resolveRsbuildInvocation } from './watchManager';
import { getLogger } from '../shared/util/output';

// =============================================================================
// PUBLISH
// =============================================================================

/**
 * Builds the app and publishes the bundle as an immutable version.
 *
 * @param appId - The app to publish (appManifest.id).
 * @param message - Commit-style "what changed" note for the version card.
 * @returns The new version-rail entry.
 */
export async function publishApp(appId: string, message: string): Promise<Record<string, unknown>> {
	const logger = getLogger();
	const apps = await scanWorkspaceApps();
	const app = apps.find((a) => a.id === appId);
	if (!app) throw new Error(`App "${appId}" has no bound folder in this workspace.`);

	const client = ConnectionManager.getInstance().getClient();
	if (!client || !ConnectionManager.getInstance().isConnected()) {
		throw new Error('Not connected — publishing needs a live server connection.');
	}

	// ── The canonical build (decision D5) ────────────────────────────────
	logger.output(`[appdev] publish build: ${appId}`);
	const invocation = resolveRsbuildInvocation(app.folder);
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(invocation.cmd, [...invocation.args, 'build'], {
			cwd: app.folder,
			shell: invocation.shell,
			env: { ...process.env, NO_COLOR: '1' },
		});
		let tail = '';
		proc.stdout?.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
		proc.stderr?.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
		proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`rsbuild build failed (${code}): ${tail.slice(-400)}`))));
		proc.on('error', reject);
	});

	// ── Read the built entry ─────────────────────────────────────────────
	const bundlePath = path.join(app.folder, 'dist', 'remoteEntry.js');
	const bundle = new Uint8Array(await fs.readFile(bundlePath));

	// ── Registry publish (never activates) ───────────────────────────────
	const entry = await client.appPublish({
		appId,
		version: app.version || '0.0.0',
		bundle,
		message,
		moduleId: app.moduleId,
		name: app.name,
	});
	logger.output(`[appdev] published ${appId} v${entry?.appVersion ?? app.version} (registry v${entry?.registryVersion})`);
	vscode.window.showInformationMessage(`Published ${app.name} v${app.version} — pin a rung from the Deploy view to make it live.`);
	return entry as Record<string, unknown>;
}
