// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App scaffolder — the VS Code host of `rocketride.app.create`.
 *
 * The New App wizard (NewAppProvider webview) collects the app-name slug,
 * display name, and frame options, assembles the app id from the resolved
 * developer id, and calls scaffoldApp(). Scaffolding validates at submit
 * time (the wizard panel is modeless — its form state may be stale), then
 * runs the SDK's one scaffold (`createAppWorkspace` — the same code behind
 * `rocketride app create`), and opens the App Builder screen. The scaffold
 * always ends BOUND: the appManifest.id in the generated package.json is
 * what MY APPS discovers (bind, don't sync).
 *
 * Dependencies install through the workspace-global model: the root
 * workspace file claims apps/*, so scaffolding triggers the shared
 * single-flight `pnpm install` at the workspace root and the new member
 * links without any manual step.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createAppWorkspace } from 'rocketride/app-pack';
import { ConnectionManager } from '../connection/connection';
import { getLogger } from '../shared/util/output';
import type { FrameOptions, TemplateName } from 'shared/modules/appdev/templates';
import { getExtensionContext } from '../extension';
import { vendorAppTypes } from './appTypes';
import { getWatchManager } from './watchManager';

// =============================================================================
// VALIDATION
// =============================================================================

/** App id shape: `<publisher>.<name>` — publisher is letters+underscore
 * (matches the server developerId rule); name starts with a lowercase
 * letter, then any mix of letters, digits, underscores, and hyphens (the
 * server accepts digits in the name — e.g. `acme.s3-explorer`, `acme.app2`). */
export const APP_ID_RE = /^[a-z][a-z_]*\.[a-z][a-zA-Z0-9_-]*$/;

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
// SCAFFOLD
// =============================================================================

/**
 * Scaffolds a new app into the workspace `apps/` directory.
 *
 * Re-validates the identity at submit time, runs the SDK scaffold (folder,
 * template tree, .rrapp trigger, projectId, workspace file, dependency
 * wiring, .gitignore), vendors the platform types through the session
 * memo, and opens the App Builder.
 *
 * @param params - The wizard-collected scaffold parameters.
 * @returns The created app id.
 * @throws Error when the id is malformed, the display name is empty, no
 *         workspace is open, or the target folder already exists.
 */
export async function scaffoldApp(params: ScaffoldParams): Promise<string> {
	const { appId, appName, frame } = params;
	const logger = getLogger();

	// ── 1. Validate identity (submit-time — the form state may be stale) ─
	if (!APP_ID_RE.test(appId)) {
		throw new Error(`Invalid app id "${appId}". Use <publisher>.<name>; the name starts with a lowercase letter, then letters, digits, underscores, and hyphens.`);
	}
	if (!appName.trim()) {
		throw new Error('Display name is required.');
	}
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Open a workspace folder first. The app is scaffolded into it.');
	}

	// ── 2. The one scaffold (shared with `rocketride app create`) ────────
	// Apps live under ./apps/<slug>-ui — symmetric with ./pipelines and the
	// node designer's ./nodes. The SDK refuses an existing folder. Its
	// install and vendoring are left to this host: the WatchManager owns
	// the single-flight install and ensureShell the session vendor memo.
	const [developerId, slug] = appId.split('.');
	const created = await createAppWorkspace(root.uri.fsPath, slug, {
		template: params.template ?? 'Blank',
		displayName: appName,
		developerId,
		sidebar: frame.sidebar,
		statusFooter: frame.statusFooter,
		docTabs: frame.docTabs,
		// The connected engine's shell — the preview URL's origin
		serverBaseUrl: ConnectionManager.getInstance().getHttpUrl?.() || undefined,
		vendor: false,
		install: false,
		onProgress: (line) => logger.output(`[appdev] ${line}`),
	});
	const target = vscode.Uri.joinPath(root.uri, ...created.folder.split('/'));

	// No launch.json entry is scaffolded: F5 debugging goes through the
	// rocketride.app.debug command, which builds its config in-memory and
	// ensures the watch session first — a static launch entry would open
	// the preview with no dev bundle being served.

	// First scaffold in a fresh workspace also seeds settings.json so the
	// Explorer hides the gitignored machine-generated trees.
	ensureWorkspaceSettings(root.uri.fsPath);

	// Install the platform package — ensures the root workspace file,
	// verifies the template's portable file: specs resolve (adding a
	// workspace-yaml override when the layout needs one; the manifest is
	// never rewritten), and downloads the canonical tarball. Fire-and-forget
	// and non-fatal by design, so scaffolding never waits on it.
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
	// No toast: the App Builder opens on the new app — that IS the feedback.
	return appId;
}
