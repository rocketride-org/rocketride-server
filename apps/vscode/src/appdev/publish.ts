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
 * .gitignore plus a hardcoded baseline (see packFilter). The zip rides
 * the generic `rrext_deploy add` rail door; the server retains it and
 * unpacks at receipt; deploying never activates anything — the Deploy
 * view publishes rungs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import AdmZip from 'adm-zip';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { ensureProjectId } from './appMarker';
import { collectPackedFiles } from './packFilter';
import { getLogger } from '../shared/util/output';

// =============================================================================
// LIMITS
// =============================================================================

/**
 * Ceiling on the UNCOMPRESSED source the deploy zip may carry. The archive is
 * built entirely in the extension host's memory (AdmZip buffers + toBuffer +
 * a Uint8Array copy), so an unbounded tree OOMs the host and kills every
 * RocketRide surface. A deploy packs source only — a few hundred MB is far
 * beyond any legitimate app plus its declared includes. This is the memory
 * bound; the upload contract is MAX_ZIP_BYTES on the zipped result.
 */
const MAX_PACK_BYTES = 512 * 1024 * 1024;

/**
 * The upload cap on the ZIPPED package. The server refuses anything larger
 * at receipt before parsing a byte, so the pack fails fast client-side with
 * the same bound and a pointer at the usual cause (an over-broad include).
 */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

// =============================================================================
// INCLUDE VALIDATION
// =============================================================================

/**
 * Reads and validates the app's `appManifest.include` list.
 *
 * Entries are WORKSPACE-RELATIVE POSIX paths (files or directories),
 * packed verbatim at those paths — no resolution against the app folder,
 * no `..` walking: the zip packs exactly what the user wrote. Every
 * entry must exist; a typo fails the deploy loudly rather than shipping
 * a zip the server build cannot compile.
 *
 * @param appFolder - The app's bound folder (absolute path).
 * @param workspaceRoot - The workspace folder the zip is rooted at.
 * @returns Normalized include entries ([] when none are declared).
 * @throws Error on a malformed or missing entry.
 */
function readIncludeEntries(appFolder: string, workspaceRoot: string): string[] {
	const logger = getLogger();
	// step: read the CURRENT package.json — the include list must reflect
	// what is on disk at deploy time, not a cached scan
	let pkg: { appManifest?: { include?: unknown } };
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(appFolder, 'package.json'), 'utf8'));
	} catch (err) {
		throw new Error(`Could not read the app's package.json: ${err instanceof Error ? err.message : String(err)}`);
	}
	const raw = pkg.appManifest?.include;
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
		throw new Error('appManifest.include must be an array of workspace-relative path strings.');
	}

	const entries: string[] = [];
	for (const item of raw as string[]) {
		// step: normalize separators, strip a trailing slash
		const entry = item.replace(/\\/g, '/').replace(/\/+$/, '');
		if (!entry) {
			logger.output('[appdev:pack]   check include "" — FAILED: empty entry');
			throw new Error('appManifest.include contains an empty entry.');
		}
		// step: workspace-relative means RELATIVE — no absolute paths, no
		// drive letters, and no `..` escapes
		if (entry.startsWith('/') || entry.includes(':') || entry.split('/').includes('..') || entry.split('/').includes('.')) {
			logger.output(`[appdev:pack]   check include "${item}" — FAILED: not a plain workspace-relative path`);
			throw new Error(`appManifest.include entry "${item}" must be a plain workspace-relative path (no absolute paths, drive letters, "." or "..").`);
		}
		const abs = path.join(workspaceRoot, entry);
		if (!fs.existsSync(abs)) {
			logger.output(`[appdev:pack]   check include "${entry}" — FAILED: does not exist in the workspace`);
			throw new Error(`appManifest.include entry "${entry}" does not exist in the workspace.`);
		}
		logger.output(`[appdev:pack]   check include "${entry}" — OK (${fs.statSync(abs).isDirectory() ? 'directory' : 'file'})`);
		entries.push(entry);
	}
	return entries;
}

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

	// ── Include entries: extra workspace paths the server build needs ────
	// appRoot === '' is the app-folder-as-workspace case: there is no
	// surrounding workspace to include from, and the zip keeps the legacy
	// app-at-root layout (no appRoot metadata).
	const include = readIncludeEntries(app.folder, workspaceRoot);
	if (appRoot === '' && include.length > 0) {
		logger.output('[appdev:pack]   check include layout — FAILED: include declared but the workspace folder IS the app folder');
		throw new Error('appManifest.include needs the app inside a larger workspace — the workspace folder IS the app folder here.');
	}

	// ── Working-copy provenance: the appManifest projectId ───────────────
	// Ensured BEFORE packing so a first-time deploy's freshly stamped
	// package.json is inside the zip, not just on disk.
	const projectId = await ensureProjectId(app.folder);
	logger.output(`[appdev:pack]   check projectId — OK (${projectId})`);

	// ── Pack the workspace-relative tree ─────────────────────────────────
	// The app folder (package.json carrying the FULL appManifest — the
	// server reads it as metadata.manifest, the listing truth — src/,
	// rsbuild config, icon, README, assets, the .rrapp trigger) plus every
	// include entry, filtered by .gitignore + the baseline excludes
	// (node_modules, dist, .git — the server injects the platform deps
	// for its own build; client output is never uploaded).
	logger.output(`[appdev] packing source: ${appId} (appRoot=${appRoot || '.'}${include.length ? `, include=${include.join(',')}` : ''})`);
	const files = collectPackedFiles(workspaceRoot, [appRoot, ...include]);
	logger.output(`[appdev:pack] files to pack (${files.length}):`);
	const zip = new AdmZip();
	let totalBytes = 0;
	for (const file of files) {
		const bytes = fs.readFileSync(file.absPath);
		totalBytes += bytes.length;
		// Bound the pack BEFORE building the archive: AdmZip retains every
		// buffer, zip.toBuffer() materializes the archive, and Uint8Array
		// copies it again (~2-3x peak RSS). An over-broad appManifest.include
		// (a shared source root, a stray build tree) would OOM the extension
		// host and take down every RocketRide surface with no actionable
		// error, so fail loudly on the source total instead.
		if (totalBytes > MAX_PACK_BYTES) {
			logger.output(`[appdev:pack] pack ABORTED — source exceeds ${Math.round(MAX_PACK_BYTES / (1024 * 1024))} MB`);
			throw new Error(`Deploy package source exceeds ${Math.round(MAX_PACK_BYTES / (1024 * 1024))} MB — check appManifest.include for an over-broad entry (a shared source root, a build output, or a dependency tree) and narrow it.`);
		}
		zip.addFile(file.zipPath, bytes);
		logger.output(`[appdev:pack]   + ${file.zipPath} (${bytes.length} bytes)`);
	}
	const data = new Uint8Array(zip.toBuffer());
	// The upload contract: the server refuses over-cap zips at receipt, so
	// an oversized pack fails HERE with the actionable spelling instead of
	// after the upload round-trip.
	if (data.byteLength > MAX_ZIP_BYTES) {
		logger.output(`[appdev:pack] pack ABORTED — ${Math.round(data.byteLength / (1024 * 1024))} MB zipped exceeds the ${Math.round(MAX_ZIP_BYTES / (1024 * 1024))} MB upload cap`);
		throw new Error(`Deploy package is ${Math.round(data.byteLength / (1024 * 1024))} MB zipped — the upload cap is ${Math.round(MAX_ZIP_BYTES / (1024 * 1024))} MB. Narrow appManifest.include (a shared source root, a build output, or large assets) and redeploy.`);
	}
	logger.output(`[appdev:pack] pack complete — all checks passed; ${files.length} files, ${totalBytes} bytes source, ${data.byteLength} bytes zipped`);
	logger.output(`[appdev] packed ${files.length} files (${data.byteLength} bytes)`);

	// ── The ONE rail door (deploy = copy code to the server) ─────────────
	const body = await client.deploy.add({
		kind: 'app',
		data,
		metadata: { projectId, ...(appRoot ? { appRoot } : {}) },
		comment: message,
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
