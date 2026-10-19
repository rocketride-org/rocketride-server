// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP BUILDER OPS — the VS Code implementations of host.appbuilder.*
// =============================================================================
//
// The host half of the App Builder page (declared in
// shared/ops/appBuilderOps.ts): workspace file IO against the app's native
// folder, the OS pickers, the dev-session inner loop, and the staged
// sign-in. The page's SDK half rides the brokered `client.app.*` ops through
// the shared adapter — never through here. AppScreenProvider keeps only the
// panel lifecycle (tabs, HTML, feeds onto topics); every request/response
// verb lives in this table.
// =============================================================================

import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../connection/connection';
import { appIconDataUri, MAX_README_IMAGE_BYTES, scanWorkspaceApps } from 'shared/tools/appdev';
import type { IScannedWorkspaceApp as ScannedApp } from 'shared/tools/appdev';
import { hostWorkspaceFs } from '../providers/toolhost/hostWorkspaceFs';
import { readAppListing, saveAppListing } from '../appdev/appMarker';
// Deep file imports (never the barrel — it drags the React view layer into
// the extension-host bundle).
import { runListingPreflight } from 'shared/tools/appdev/preflight';
import { probePackage } from 'shared/tools/appdev/compatProbe';
import { getDevSessionManager } from '../appdev/devSessionManager';
import { deployApp } from '../appdev/publish';
import { getLogger } from '../shared/util/output';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConfigManager } from '../config';
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { IRetainedRegistry } from 'shell/src/ops/retained';
import type { AppBuilderHostOpMap, AppBuilderLoadPayload } from 'shared/ops/appBuilderOps';
import type { AppBuilderStage } from 'shared/tools/appdev/types';

/** What the registration needs from the extension. */
interface IAppBuilderOpsDeps {
	context: vscode.ExtensionContext;
	connectionManager: ConnectionManager;
	/** The root's retained registry — the login op republishes the app's
	 *  one-shot :session credential there. */
	retained: IRetainedRegistry;
}

/**
 * Maps a persisted stage value to the current vocabulary. workspaceState
 * stores the active tab raw, so windows that persisted before the
 * DEVELOP -> DESIGN rename hold the legacy id; anything unknown (or never
 * persisted) lands on 'dashboard', the default view.
 */
function normalizeStage(raw: unknown): AppBuilderStage {
	if (raw === 'develop') return 'design';
	if (raw === 'design' || raw === 'package' || raw === 'store' || raw === 'deploy' || raw === 'dashboard') return raw;
	return 'dashboard';
}

/**
 * Registers the App Builder's host verbs.
 *
 * @param bus - The root's op bus.
 * @param deps - See {@link IAppBuilderOpsDeps}.
 * @returns Unregister-all function.
 */
export function registerVscodeAppBuilderOps(bus: IOpBus, deps: IAppBuilderOpsDeps): () => void {
	const { context, connectionManager, retained } = deps;

	/** The app's workspace binding, or throws the standard unbound error. */
	const resolveApp = async (appId: string): Promise<ScannedApp> => {
		const apps = await scanWorkspaceApps(hostWorkspaceFs);
		const app = apps.find((a) => a.id === appId);
		if (!app) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
		return app;
	};

	/** Traversal-guarded absolute path for an app-folder-relative file. */
	const resolveAppFile = (folder: string, relPath: string): string => {
		const rel = String(relPath ?? '').replace(/^\.\//, '');
		const abs = path.resolve(folder, ...rel.split('/'));
		if (!abs.startsWith(path.resolve(folder) + path.sep)) {
			throw new Error('Path escapes the app folder.');
		}
		return abs;
	};

	/**
	 * Builds the preview URL: the Development Mode engine's shell with the
	 * app locked + dev hooks on. `rocketride.appdev.shellUrl` overrides the
	 * base for monorepo devs running the shell dev server.
	 */
	const buildPreviewUrl = (appId: string): string => {
		const override = vscode.workspace.getConfiguration('rocketride.appdev').get<string>('shellUrl', '');
		const base = override || connectionManager.getHttpUrl?.() || 'http://localhost:5565';
		// _ts busts the browser's cached index.html — the flavor picker lives
		// in the html, and a stale copy silently serves the wrong shell flavor.
		return `${base.replace(/\/$/, '')}/?appid=${encodeURIComponent(appId)}&rrdev=1&_ts=${Date.now()}`;
	};

	const impls: OpImplTable<AppBuilderHostOpMap> = {
		'host.appbuilder.load': async (p): Promise<AppBuilderLoadPayload> => {
			const apps = await scanWorkspaceApps(hostWorkspaceFs);
			const app = apps.find((a) => a.id === p.app);
			return {
				app: {
					id: p.app,
					moduleId: app?.moduleId ?? p.app.replace(/[.-]/g, '_'),
					name: app?.name ?? p.app,
					version: app?.version,
					description: app?.description,
					// Workspace-bound with no server record = 'local'; server
					// statuses (draft/pending/...) arrive with the marketplace
					// wiring (M5).
					status: 'local',
				},
				previewUrl: buildPreviewUrl(p.app),
				// VSCode variant: files are native, F5 debug removed 2026-10-16.
				// hasReviewLadder mirrors the server's account backend: only a
				// server declaring 'oss' publishes @public directly;
				// unknown/disconnected keeps the gated default.
				capabilities: {
					hasNativeFiles: true,
					canDebug: false,
					hasReviewLadder: !(connectionManager.getClient()?.getAccountInfo()?.capabilities ?? []).includes('oss'),
				},
				stage: normalizeStage(context.workspaceState.get(`appdev.stage.${p.app}`)),
				prefs: context.workspaceState.get(`appdev.prefs.${p.app}`) ?? {},
			};
		},

		'host.appbuilder.stage': async (p) => {
			await context.workspaceState.update(`appdev.stage.${p.app}`, p.stage);
		},

		'host.appbuilder.pref': async (p) => {
			// Merge-write the per-app bag — concurrent keys must not clobber
			// each other.
			const bag = { ...(context.workspaceState.get<Record<string, unknown>>(`appdev.prefs.${p.app}`) ?? {}) };
			bag[p.key] = p.value;
			await context.workspaceState.update(`appdev.prefs.${p.app}`, bag);
		},

		'host.appbuilder.restart': async (p) => {
			// Preview Reload = full inner-loop reset: kill the dev server, pnpm
			// install (package.json may have changed), fresh rsbuild dev. The
			// new server's first successful build triggers the preview reload.
			const app = await resolveApp(p.app);
			await getDevSessionManager()?.restart(app);
		},

		'host.appbuilder.reveal': async (p) => {
			const app = await resolveApp(p.app);
			await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(app.folder));
		},

		'host.appbuilder.login': async (p) => {
			// The preview shell needs a session and this window is signed out —
			// run the EXTENSION's own sign-in flow (browser-based), then hand
			// the fresh credential down the app's retained :session lane.
			// signIn() only OPENS the browser: the token lands later, when the
			// deep-link callback stores it and fires the provider's change
			// event — arm a bounded wait for that event BEFORE launching.
			const auth = CloudAuthProvider.getInstance();
			let abandonWait = (): void => {};
			const completed = new Promise<boolean>((resolve) => {
				const onChanged = (): void => {
					clearTimeout(timer);
					resolve(true);
				};
				const timer = setTimeout(() => {
					auth.onDidChange.removeListener('changed', onChanged);
					resolve(false);
				}, 300000);
				auth.onDidChange.once('changed', onChanged);
				abandonWait = () => {
					clearTimeout(timer);
					auth.onDidChange.removeListener('changed', onChanged);
					resolve(false);
				};
			});
			try {
				await auth.signIn(
					process.env.RR_ZITADEL_URL || '',
					process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '',
					ConfigManager.getInstance().getEffectiveCloudUrl()
				);
			} catch (err) {
				// The browser never opened, so no change event is coming: drop
				// the listener and the five-minute timer instead of leaving
				// them armed for a token that cannot arrive.
				abandonWait();
				getLogger().output(`[appdev] cloud sign-in could not start: ${err}`);
			}
			if (await completed) {
				try {
					const token = await connectionManager.resolveAuthCredential();
					// One-shot credential on the retained lane — the consuming
					// page retracts after applying (the pipeline oauth pattern).
					if (token) retained.publish(`appbuilder:app:${p.app}:session`, { token });
				} catch {
					/* sign-in abandoned — the preview keeps its prompt */
				}
			}
		},

		'host.appbuilder.deploy': async (p) => {
			// DEPLOY = zip the app folder from disk and upload it as the next
			// immutable registry version (the server builds the one true bundle).
			await deployApp(p.app, String(p.message ?? ''));
		},

		'host.appbuilder.loadListing': async (p) => {
			// The listing IS the appManifest — read it from disk.
			const apps = await scanWorkspaceApps(hostWorkspaceFs);
			const scanned = apps.find((a) => a.id === p.app);
			return scanned ? await readAppListing(scanned.folder) : null;
		},

		'host.appbuilder.saveListing': async (p) => {
			// Persist the listing back into package.json (files are truth; the
			// next deploy packs it as metadata.manifest).
			const app = await resolveApp(p.app);
			await saveAppListing(app.folder, p.draft);
		},

		'host.appbuilder.preflight': async (p) => {
			// The SHARED tiered readiness bar (one implementation for every
			// host), fed with this host's IO: native-fs existence + the
			// dependency compat probe (Node fetch) — closes the gap where a
			// Node-only dep would survive to deploy from VSCode.
			const apps = await scanWorkspaceApps(hostWorkspaceFs);
			const scanned = apps.find((a) => a.id === p.app);
			if (!scanned) {
				return runListingPreflight(null, { fileExists: async () => false });
			}
			const listing = await readAppListing(scanned.folder);
			const wsRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scanned.folder))?.uri;
			// Declared runtime deps for the compat rows.
			let dependencies: Record<string, string> = {};
			try {
				const pkgBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(scanned.folder), 'package.json'));
				dependencies = (JSON.parse(Buffer.from(pkgBytes).toString('utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
			} catch { /* unreadable package.json — the manifest row already failed */ }
			return runListingPreflight(listing, {
				fileExists: async (rel) => {
					try {
						await vscode.workspace.fs.stat(vscode.Uri.joinPath(vscode.Uri.file(scanned.folder), ...rel.replace(/^\.\//, '').split('/')));
						return true;
					} catch {
						return false;
					}
				},
				includeExists: async (entry) => {
					try {
						if (!wsRoot) return false;
						await vscode.workspace.fs.stat(vscode.Uri.joinPath(wsRoot, ...entry.split('/')));
						return true;
					} catch {
						return false;
					}
				},
				dependencies,
				// Bounded fetches — without a timeout one hung module-source
				// request stalls the whole readiness bar.
				probeDependency: (name, range) => probePackage({
					name,
					version: range,
					fetchText: async (url) => {
						const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
						return { ok: response.ok, status: response.status, text: response.ok ? await response.text() : '' };
					},
				}),
			});
		},

		'host.appbuilder.pickAppFile': async (p) => {
			// Native picker for a manifest asset (icon/readme). The result is
			// APP-FOLDER-relative: the server's harvest only copies
			// app-root-relative paths, so a pick outside the app folder is
			// refused, not silently accepted.
			const app = await resolveApp(p.app);
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				defaultUri: vscode.Uri.file(app.folder),
				openLabel: 'Select',
				// Every format the icon reader inlines (ICON_MEDIA_TYPES), not
				// SVG alone — the manifest and the overlay registration accept
				// all of them.
				filters: p.kind === 'icon' ? { Icon: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] } : { Markdown: ['md'] },
			});
			if (!picked || picked.length === 0) return null;
			const rel = path.relative(app.folder, picked[0].fsPath);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				throw new Error('The file must live inside the app folder. The deploy only packs (and the server only serves) app-relative assets.');
			}
			return `./${rel.split(path.sep).join('/')}`;
		},

		'host.appbuilder.pickIncludePath': async (p) => {
			// Native picker for an include path — a workspace FOLDER or FILE.
			// The result is WORKSPACE-relative (include entries pack from the
			// workspace root, unlike app-relative assets). The native dialog
			// cannot offer files and folders TOGETHER on Windows/Linux (macOS
			// only), so a QuickPick asks which kind first.
			const app = await resolveApp(p.app);
			const wsRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(app.folder))?.uri;
			if (!wsRoot) throw new Error('The app folder is not inside an open workspace folder.');
			const choice = await vscode.window.showQuickPick(
				[
					{ label: 'Folder', description: 'include a whole directory' },
					{ label: 'File', description: 'include a single file' },
				],
				{ placeHolder: 'Include a folder or a single file?' }
			);
			if (!choice) return null;
			const wantFolder = choice.label === 'Folder';
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				canSelectFiles: !wantFolder,
				canSelectFolders: wantFolder,
				defaultUri: wsRoot,
				openLabel: 'Select',
			});
			if (!picked || picked.length === 0) return null;
			const rel = path.relative(wsRoot.fsPath, picked[0].fsPath);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				throw new Error('The path must live inside the workspace. Include paths are workspace-relative and packed from the workspace root.');
			}
			// The workspace root itself would pack the entire workspace into
			// every deploy — an include entry names something in it.
			if (!rel) throw new Error('Select a folder inside the workspace, not the workspace root itself.');
			return rel.split(path.sep).join('/');
		},

		'host.appbuilder.readTextFile': async (p) => {
			// One app-folder-relative text file for preview (icon SVG, README
			// markdown). Traversal-guarded and size-capped.
			const app = await resolveApp(p.app);
			const abs = resolveAppFile(app.folder, p.relPath);
			// Stat BEFORE reading: the manifest can name an arbitrarily large
			// file, and checking byteLength after the read means the whole
			// thing is already in memory by then.
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
			if (stat.size > 512 * 1024) throw new Error('File is over the 512KB preview limit.');
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
			return Buffer.from(bytes).toString('utf8');
		},

		'host.appbuilder.readImage': async (p) => {
			// One app-folder-relative image as a data: URI — README images are
			// binary, so the text-read path would corrupt them. Reuses the icon
			// inliner with the README size budget.
			const app = await resolveApp(p.app);
			const abs = resolveAppFile(app.folder, p.relPath);
			return (await appIconDataUri(hostWorkspaceFs, abs, MAX_README_IMAGE_BYTES)) ?? null;
		},
	};

	return registerOpHandlers<AppBuilderHostOpMap>(bus, impls);
}
