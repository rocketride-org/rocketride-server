// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppScreenProvider — one App Builder panel per app (page-app webview).
 *
 * Modeled on StatusProvider: WebviewPanels keyed in a Map (by appId),
 * reveal-or-create, retainContextWhenHidden, the shared nonce+CSP HTML
 * pipeline. The webview is THIN (decision D7) — it mounts the shared
 * AppBuilderScreen and bridges every action over postMessage; this provider
 * answers the bridge: init payload (app facts + preview URL + capability
 * flags), F5 debug, reveal-in-explorer, and forwards shell events + watch
 * status into the webview's feed panes.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';
import { appIconDataUri, MAX_README_IMAGE_BYTES, scanWorkspaceApps } from 'shared/tools/appdev';
import type { IScannedWorkspaceApp as ScannedApp } from 'shared/tools/appdev';
import { hostWorkspaceFs } from './toolhost/hostWorkspaceFs';
import { ensureAppTrigger, ensureProjectId, readAppListing, saveAppListing } from '../appdev/appMarker';
import type { AppListing } from '../appdev/appMarker';
// Deep file imports (never the barrel — it drags the React view layer
// into the extension-host bundle): the SHARED preflight bar, dependency
// probe, and history walk, so this host can never drift from the web one.
import { runListingPreflight } from 'shared/modules/appdev/preflight';
import { probePackage } from 'shared/modules/appdev/compatProbe';
import { walkDeploymentHistory } from 'shared/modules/appdev/wire';
import type { WireHistoryRow } from 'shared/modules/appdev/wire';
import { ensureDevSession, getDevSessionManager } from '../appdev/devSessionManager';
import { deployApp } from '../appdev/publish';
import { vendorAppTypes } from '../appdev/appTypes';
import { getLogger } from '../shared/util/output';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { ConfigManager } from '../config';

// =============================================================================
// TYPES
// =============================================================================

/** Watch status shape forwarded to the webview DEV badge. */
export interface AppWatchStatus {
	state: 'idle' | 'installing' | 'building' | 'ok' | 'error';
	durationMs?: number;
	target?: string;
	/** WHY the state is 'error' — every error producer supplies one. */
	reason?: string;
}

// =============================================================================
// PROVIDER
// =============================================================================

export class AppScreenProvider implements vscode.CustomReadonlyEditorProvider {
	private panels = new Map<string, vscode.WebviewPanel>();
	private disposables: vscode.Disposable[] = [];
	private connectionManager = ConnectionManager.getInstance();
	// The webview subscribes at view:ready — replay the latest STATE there
	// (watch status, dev entry). Console rows are NOT replayed: VSCode queues
	// messages posted before view:ready, so rows arrive anyway and a replay
	// double-prints them.
	private lastWatch = new Map<string, AppWatchStatus>();
	// The running dev server's remoteEntry.js URL per app — the webview
	// injects it into the preview shell (replayed at view:ready like status).
	private devEntries = new Map<string, string>();
	/** Workspace manifests riding each dev registration (dev = local truth). */
	private devManifests = new Map<string, Record<string, unknown> | undefined>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.setupEventListeners();
	}

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/**
	 * Open (or reveal) the App Builder DOCUMENT for an app.
	 *
	 * Apps are documents the way pipelines are: a REAL `<name>.rrapp` file
	 * in the app folder is the document (double-clicking it in the Explorer
	 * opens the App Builder), and this custom editor is its surface. VSCode
	 * owns tab identity, one-editor-per-file dedupe, Open Editors
	 * membership, and restore-on-reload. The trigger file is contentless —
	 * every app fact (id, projectId) lives in the folder's appManifest —
	 * and is created on first open for apps that predate it.
	 *
	 * @param appId - The app id (appManifest.id).
	 */
	public async show(appId: string): Promise<void> {
		// Resolve the app's bound folder
		const apps = await scanWorkspaceApps(hostWorkspaceFs);
		const app = apps.find((a) => a.id === appId);
		if (!app) {
			vscode.window.showErrorMessage(`App "${appId}" has no bound folder in this workspace.`);
			return;
		}

		// The document: <folder>/<name>.rrapp — a contentless trigger created
		// on demand. The working-copy projectId is ensured in the appManifest
		// (package.json is the single home of app facts).
		await ensureProjectId(app.folder);
		const trigger = await ensureAppTrigger(app.folder, appId);
		await vscode.commands.executeCommand('vscode.openWith', trigger, 'rocketride.appBuilder');
	}

	// =========================================================================
	// CUSTOM EDITOR — document lifecycle
	// =========================================================================

	/** Opens the (stateless) custom document for an .rrapp file. */
	public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	/** Resolves an .rrapp document's app id from its folder's appManifest. */
	private async appIdOf(uri: vscode.Uri): Promise<string> {
		// The trigger file carries nothing — identity lives ONLY in the
		// containing folder's package.json appManifest.
		const folder = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) }).fsPath;
		const apps = await scanWorkspaceApps(hostWorkspaceFs);
		return apps.find((a) => a.folder === folder)?.id ?? '';
	}

	/**
	 * Starts watches for App Builder tabs that were already open when THIS
	 * extension host came up. "Developer: Restart Extension Host" kills the
	 * dev servers via deactivation but keeps the tabs and their persisted
	 * webview contexts — VSCode never re-resolves the custom editor, so
	 * view:ready never re-fires and the open-path ensureDevSession belongs to a
	 * resolve that never ran. The tab list is the one surface that survives
	 * every restart mode; activation reconciles against it directly.
	 *
	 * Safe against a concurrent re-resolve: ensureDevSession rides the per-app
	 * serialized chain and doStart's existing-session guard no-ops the loser.
	 */
	public async reconcileOpenTabs(): Promise<void> {
		// Collect the open App Builder tabs (synchronous, cheap).
		const uris: vscode.Uri[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'rocketride.appBuilder') {
					uris.push(tab.input.uri);
				}
			}
		}
		if (uris.length === 0) return;
		for (const uri of uris) {
			try {
				const appId = await this.appIdOf(uri);
				const apps = await scanWorkspaceApps(hostWorkspaceFs);
				const app = apps.find((a) => a.id === appId);
				if (app && !getDevSessionManager()?.isRunning(app.id)) void ensureDevSession(app);
			} catch {
				// Unresolvable tab (marker unreadable / app unbound) — VSCode's
				// eventual re-resolve reports that failure in a visible panel.
			}
		}
	}

	/**
	 * Resolves the App Builder editor for an .rrapp document — called by
	 * VSCode on open AND on window-reload restore.
	 */
	public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const appId = await this.appIdOf(document.uri);

		// Resolve the app's facts from the workspace binding
		const apps = await scanWorkspaceApps(hostWorkspaceFs);
		const app = apps.find((a) => a.id === appId);

		panel.title = app?.name ?? appId;
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		this.panels.set(appId, panel);
		// The build ticker + compile feed are org-scoped DEPLOY-type pushes:
		// without this monitor the server filters every apaevt_build* event
		// out for this connection (only the pipeline editor armed 'deploy'
		// before, so App Builder sessions heard nothing).
		this.armDeployMonitor();
		panel.webview.html = this.getHtmlForWebview(panel.webview);

		// Bridge: answer the webview's messages
		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				switch (message.type) {
					case 'view:ready': {
						await panel.webview.postMessage({
							type: 'appdev:init',
							app: this.buildAppSummary(appId, app),
							previewUrl: this.buildPreviewUrl(appId),
							// VSCode variant: files are native, F5 debugs.
							// hasReviewLadder mirrors the server's account backend
							// (base.py review_ladder): only a server declaring 'oss'
							// publishes @public directly; unknown/disconnected keeps
							// the gated default.
							capabilities: {
								hasNativeFiles: true,
								// External-browser debug was removed (2026-10-16).
								canDebug: false,
								hasReviewLadder: !(this.connectionManager.getClient()?.getAccountInfo()?.capabilities ?? []).includes('oss'),
							},
							stage: AppScreenProvider.normalizeStage(this.context.workspaceState.get(`appdev.stage.${appId}`)),
							// App Builder UI preferences (preview layout, zoom, …)
							// — per-workspace, per-app; written back via appdev:pref
							prefs: this.context.workspaceState.get(`appdev.prefs.${appId}`) ?? {},
						});
						// Replay STATE the webview may have missed (idempotent —
						// VSCode queues messages sent before view:ready, so
						// replaying console ROWS here double-printed them; only
						// latest-state messages are safe to resend).
						const last = this.lastWatch.get(appId);
						if (last) await panel.webview.postMessage({ type: 'appdev:watch', status: last });
						const devEntry = this.devEntries.get(appId);
						if (devEntry) await panel.webview.postMessage({ type: 'appdev:devServer', entry: devEntry, manifest: this.devManifests.get(appId) });
						// Session handoff: this window is already authenticated —
						// give the preview shell the same credential so apps
						// requiring auth render with a real signed-in session.
						try {
							const token = await this.connectionManager.resolveAuthCredential();
							if (token) await panel.webview.postMessage({ type: 'appdev:auth', token });
						} catch {
							/* signed out — the preview shows its sign-in prompt */
						}
						// The resolve-time watch start can lose a race with the
						// workspace scan — retry here (idempotent when running)
						if (app && !getDevSessionManager()?.isRunning(appId)) void ensureDevSession(app);
						// (No origin sanity warning anymore: LOCAL-FIRST previews
						// deliberately live on the dev server's proxy origin,
						// which differs from the engine origin by design.)
						break;
					}

					case 'appdev:stage':
						// Persist the active view per app (survives panel close)
						await this.context.workspaceState.update(`appdev.stage.${appId}`, message.stage);
						break;

					case 'appdev:pref': {
						// Persist one App Builder UI preference into the per-app
						// bag (merge — concurrent keys must not clobber each other)
						const bag = { ...(this.context.workspaceState.get<Record<string, unknown>>(`appdev.prefs.${appId}`) ?? {}) };
						bag[message.key] = message.value;
						await this.context.workspaceState.update(`appdev.prefs.${appId}`, bag);
						break;
					}

					case 'appdev:login': {
						// The preview shell needs a session and this window is
						// signed out — run the EXTENSION's own sign-in flow
						// (browser-based, works everywhere), then hand the fresh
						// credential down the normal rrdev:auth path.
						const auth = CloudAuthProvider.getInstance();
						// signIn() only OPENS the browser: the token lands later,
						// when the deep-link callback stores it and fires the
						// provider's change event. Arm a bounded wait for that
						// event BEFORE launching, then forward the credential —
						// resolving immediately would read the old signed-out
						// state and leave the preview stuck at its prompt.
						// Tears the wait down early; assigned inside the executor
						// where the listener and timer handles exist.
						let abandonWait = (): void => {};
						const completed = new Promise<boolean>((resolve) => {
							const onChanged = () => {
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
							// The browser never opened, so no change event is
							// coming: drop the listener and the five-minute
							// timer instead of leaving them armed for a token
							// that cannot arrive.
							abandonWait();
							getLogger().output(`[appdev] cloud sign-in could not start: ${err}`);
						}
						if (await completed) {
							try {
								const token = await this.connectionManager.resolveAuthCredential();
								if (token) await panel.webview.postMessage({ type: 'appdev:auth', token });
							} catch {
								/* sign-in abandoned — preview keeps its prompt */
							}
						}
						break;
					}

					case 'appdev:restart':
						// Preview Reload = full inner-loop reset: kill the dev
						// server, pnpm install (package.json may have changed),
						// fresh rsbuild dev. The new server's first successful
						// build triggers the normal preview reload.
						if (app) await getDevSessionManager()?.restart(app);
						break;

					case 'appdev:reveal': {
						// Reveal the bound folder in the OS file explorer; inside
						// the workspace the VSCode explorer is a better target.
						if (app?.folder) {
							await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(app.folder));
						}
						break;
					}

					case 'appdev:call': {
						// The BRIDGE's request/response lane: the shared views'
						// data accessors ride here (decision D7 — the webview
						// holds no client; this host answers).
						const { id, method, args: callArgs } = message as { id: number; method: string; args?: unknown[] };
						try {
							const client = this.connectionManager.getClient();
							let value: unknown;
							switch (method) {
								case 'listVersions':
									value = client ? await client.listDeployments(appId) : [];
									break;
								case 'where':
									value = client ? await client.whereApp(appId) : [];
									break;
								case 'deploy':
									// DEPLOY = copy the built bundle to the server as the next
									// immutable registry version.
									value = await deployApp(appId, String(callArgs?.[0] ?? ''));
									break;
								case 'submit': {
									// Submit a deployed version for store review — flips the
									// DEPLOYMENT private -> submit (review state lives on the
									// deployment; admin approval to 'ready' gates @public).
									if (!client) throw new Error('Not connected');
									value = await client.submitApp(appId, this.requireRegistryVersion(callArgs?.[0]));
									break;
								}
								case 'publish': {
									// PUBLISH = bind a version to an audience (@me/@team/@public).
									if (!client) throw new Error('Not connected');
									value = await client.publishApp(appId, this.requireRegistryVersion(callArgs?.[0]), String(callArgs?.[1] ?? ''));
									break;
								}
								case 'withdraw': {
									// Cancel a pending review (submit -> private).
									if (!client) throw new Error('Not connected');
									value = await client.withdrawApp(appId, this.requireRegistryVersion(callArgs?.[0]));
									break;
								}
								case 'unpublish': {
									// Remove an audience binding (soft — republishing revives).
									if (!client) throw new Error('Not connected');
									value = await client.removeAppPublish(appId, String(callArgs?.[0] ?? ''));
									break;
								}
								case 'teams':
									// The caller's team roster (the publish picker's team rows).
									value = (client?.getAccountInfo()?.organization?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
									break;
								case 'developerStatus':
									// The org's developer registration + Stripe status.
									if (!client) throw new Error('Not connected');
									value = await client.call('rrext_deploy_app', { subcommand: 'developer_status' });
									break;
								case 'loadListing': {
									// The listing IS the appManifest — read it from disk.
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									value = scanned ? await readAppListing(scanned.folder) : null;
									break;
								}
								case 'saveListing': {
									// Persist the listing back into package.json (files are
									// truth; the next deploy packs it as metadata.manifest).
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
									await saveAppListing(scanned.folder, callArgs?.[0] as AppListing);
									value = null;
									break;
								}
								case 'registerDeveloper':
									// Claim the org's developerId slug (org.admin, self-service).
									if (!client) throw new Error('Not connected');
									value = await client.call('rrext_deploy_app', { subcommand: 'developer_register', developerId: String(callArgs?.[0] ?? '') });
									break;
								case 'preflight': {
									// The SHARED tiered readiness bar (one implementation for
									// every host — apps/shared appdev/preflight), fed with this
									// host's IO: native-fs existence + the dependency compat
									// probe (Node fetch), which closes the gap where a Node-only
									// dep would survive to deploy from VSCode.
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) {
										value = await runListingPreflight(null, { fileExists: async () => false });
										break;
									}
									const listing = await readAppListing(scanned.folder);
									const wsRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scanned.folder))?.uri;
									// step: declared runtime deps for the compat rows
									let dependencies: Record<string, string> = {};
									try {
										const pkgBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.Uri.file(scanned.folder), 'package.json'));
										dependencies = (JSON.parse(Buffer.from(pkgBytes).toString('utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
									} catch { /* unreadable package.json — the manifest row already failed */ }
									value = await runListingPreflight(listing, {
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
										// step: bounded fetches — without a timeout one hung
										// module-source request stalls the whole readiness bar
										probeDependency: (name, range) => probePackage({
											name,
											version: range,
											fetchText: async (url) => {
												const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
												return { ok: response.ok, status: response.status, text: response.ok ? await response.text() : '' };
											},
										}),
									});
									break;
								}
								case 'pickFile': {
									// Native picker for a manifest asset (icon/readme). The
									// result is APP-FOLDER-relative: the server's harvest only
									// copies app-root-relative paths, so a pick outside the app
									// folder is refused, not silently accepted.
									const kind = String(callArgs?.[0] ?? '') === 'icon' ? 'icon' : 'readme';
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
									const picked = await vscode.window.showOpenDialog({
										canSelectMany: false,
										defaultUri: vscode.Uri.file(scanned.folder),
										openLabel: 'Select',
										// Every format the icon reader inlines (ICON_MEDIA_TYPES),
										// not SVG alone — the manifest and the overlay
										// registration accept all of them, so a picker that
										// showed only .svg refused icons the platform serves.
										filters: kind === 'icon' ? { Icon: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] } : { Markdown: ['md'] },
									});
									if (!picked || picked.length === 0) {
										value = null;
										break;
									}
									const rel = path.relative(scanned.folder, picked[0].fsPath);
									if (rel.startsWith('..') || path.isAbsolute(rel)) {
										throw new Error('The file must live inside the app folder. The deploy only packs (and the server only serves) app-relative assets.');
									}
									value = `./${rel.split(path.sep).join('/')}`;
									break;
								}
								case 'pickIncludePath': {
									// Native picker for an include path — a workspace FOLDER or
									// FILE. The result is WORKSPACE-relative (include entries
									// pack from the workspace root, unlike app-relative assets),
									// so a pick outside the workspace is refused, not silently
									// accepted. The native dialog cannot offer files and folders
									// TOGETHER on Windows/Linux (macOS only), so a QuickPick
									// asks which kind first.
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
									const wsRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scanned.folder))?.uri;
									if (!wsRoot) throw new Error('The app folder is not inside an open workspace folder.');
									const choice = await vscode.window.showQuickPick(
										[
											{ label: 'Folder', description: 'include a whole directory' },
											{ label: 'File', description: 'include a single file' },
										],
										{ placeHolder: 'Include a folder or a single file?' }
									);
									if (!choice) {
										value = null;
										break;
									}
									const wantFolder = choice.label === 'Folder';
									const picked = await vscode.window.showOpenDialog({
										canSelectMany: false,
										canSelectFiles: !wantFolder,
										canSelectFolders: wantFolder,
										defaultUri: wsRoot,
										openLabel: 'Select',
									});
									if (!picked || picked.length === 0) {
										value = null;
										break;
									}
									const rel = path.relative(wsRoot.fsPath, picked[0].fsPath);
									if (rel.startsWith('..') || path.isAbsolute(rel)) {
										throw new Error('The path must live inside the workspace. Include paths are workspace-relative and packed from the workspace root.');
									}
									// The workspace root itself would pack the entire workspace
									// into every deploy — an include entry names something in it.
									if (!rel) throw new Error('Select a folder inside the workspace, not the workspace root itself.');
									value = rel.split(path.sep).join('/');
									break;
								}
								case 'readImage': {
									// One app-folder-relative image as a data: URI — README
									// images are binary, so the text-read path would corrupt
									// them. Reuses the icon inliner (mime by extension,
									// undefined on anything unservable) with the README size
									// budget — screenshots/GIFs dwarf icons.
									const rel = String(callArgs?.[0] ?? '').replace(/^\.\//, '');
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
									const abs = path.resolve(scanned.folder, ...rel.split('/'));
									if (!abs.startsWith(path.resolve(scanned.folder) + path.sep)) {
										throw new Error('Path escapes the app folder.');
									}
									value = (await appIconDataUri(hostWorkspaceFs, abs, MAX_README_IMAGE_BYTES)) ?? null;
									break;
								}
								case 'readFile': {
									// One app-folder-relative text file for preview (icon SVG,
									// README markdown). Traversal-guarded and size-capped.
									const rel = String(callArgs?.[0] ?? '').replace(/^\.\//, '');
									const apps = await scanWorkspaceApps(hostWorkspaceFs);
									const scanned = apps.find((a) => a.id === appId);
									if (!scanned) throw new Error(`App "${appId}" has no bound folder in this workspace.`);
									const abs = path.resolve(scanned.folder, ...rel.split('/'));
									if (!abs.startsWith(path.resolve(scanned.folder) + path.sep)) {
										throw new Error('Path escapes the app folder.');
									}
									// Stat BEFORE reading: the manifest can name an arbitrarily
									// large file, and checking byteLength after the read means
									// the whole thing is already in memory by then.
									const stat = await vscode.workspace.fs.stat(vscode.Uri.file(abs));
									if (stat.size > 512 * 1024) throw new Error('File is over the 512KB preview limit.');
									const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
									value = Buffer.from(bytes).toString('utf8');
									break;
								}
								case 'history': {
									// The app's full deployment_history stream — audit rows
									// plus the review thread, walked and projected by the
									// SHARED helper (oldest-first AppHistoryEntry rows; the
									// webview renders them without a second mapping).
									if (!client) throw new Error('Not connected');
									value = await walkDeploymentHistory(async (page, pageSize) => (await client.deploy.history(appId, { page, pageSize })) as { rows?: WireHistoryRow[]; total?: number } | undefined);
									break;
								}
								case 'reply':
									// Append a developer message to the review thread.
									if (!client) throw new Error('Not connected');
									value = await client.replyApp(appId, String(callArgs?.[0] ?? ''), typeof callArgs?.[1] === 'number' ? callArgs[1] : undefined);
									break;
								case 'buildLog': {
									// One version's durable server build log (the Deploy
									// card's "failed" badge opens it).
									if (!client) throw new Error('Not connected');
									const body = await client.buildLog(appId, this.requireRegistryVersion(callArgs?.[0]));
									value = body?.log ?? '';
									break;
								}
								default:
									throw new Error(`Unknown appdev method: ${method}`);
							}
							await panel.webview.postMessage({ type: 'appdev:result', id, ok: true, value });
						} catch (err) {
							await panel.webview.postMessage({ type: 'appdev:result', id, ok: false, error: err instanceof Error ? err.message : String(err) });
						}
						break;
					}
				}
			} catch (error) {
				console.error('[AppScreenProvider] Message handling error:', error);
			}
		});

		panel.onDidDispose(() => {
			// A newer panel may own this app id now — never clear its state.
			if (this.panels.get(appId) !== panel) return;
			this.panels.delete(appId);
			this.lastWatch.delete(appId);
			this.devEntries.delete(appId);
			// The App Screen owns the watch lifecycle: closing it ends the
			// session and drops the dev overlay (shell returns to published).
			void getDevSessionManager()?.stop(appId);
		});

		// Start the inner loop (setting-gated by rocketride.appdev.autoWatch)
		if (app) {
			// Vendor the platform package FIRST, then start the watch: the
			// watch's workspace install resolves .rocketride/shell/shell.tgz,
			// so the tarball must be on disk before pnpm reads it.
			// ensureShell inside vendorAppTypes is single-flight, so several
			// panels opening concurrently share ONE vendor pass. The chain
			// stays fire-and-forget: the App Builder must not wait on it.
			// A FAILED vendor pass never starts the watch — its install could
			// only fail on the missing tarball; the panel gets the REASON
			// (center-screen) instead of a downstream pnpm ENOENT.
			void vendorAppTypes(this.context, app.folder).then((result) => {
				if (result.ok) {
					// A rewired dependency spec invalidates any memoised
					// workspace install — the watch's pnpm install must run
					// again so the app actually links the new spec.
					if (result.rewired) getDevSessionManager()?.invalidateInstall();
					return ensureDevSession(app);
				}
				this.notifyWatch(appId, { state: 'error', target: 'platform package', reason: result.reason });
			});
		} else {
			// No workspace binding = no dev server, ever — say so loudly
			// instead of a silent dead preview.
			this.notifyWatch(appId, { state: 'error', target: 'no workspace binding' });
			this.notifyConsole(appId, 'error', `No workspace folder is bound to "${appId}" — the .rrapp marker's folder has no package.json with appManifest.id "${appId}", so the dev server cannot start.`);
		}
	}

	/**
	 * Whether an App Builder panel is currently open for this app — the
	 * dev-session manager's crash-recovery gate (respawn only while someone is
	 * looking at the preview).
	 *
	 * @param appId - The app to check.
	 */
	public hasPanel(appId: string): boolean {
		return this.panels.has(appId);
	}

	/**
	 * Push a watch/build status update into an app's panel (DEV badge).
	 *
	 * @param appId - The app whose watch state changed.
	 * @param status - The new watch status.
	 */
	public notifyWatch(appId: string, status: AppWatchStatus): void {
		this.lastWatch.set(appId, status);
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:watch', status });
	}

	/**
	 * Trigger a preview reload in an app's panel (successful rebuild).
	 *
	 * @param appId - The app whose bundle was rebuilt.
	 */
	public notifyReload(appId: string): void {
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:reload' });
	}

	/**
	 * Announce the running dev server's remoteEntry.js URL to an app's panel.
	 * The webview injects it into the preview shell over postMessage — the
	 * preview needs NO server-side overlay, so it works against any shell.
	 *
	 * @param appId - The app whose dev server came up (or repointed).
	 * @param entry - The dev server's remoteEntry.js URL.
	 * @param manifest - The WORKSPACE manifest payload (appManifest +
	 *   top-level version) — in dev the workspace is the truth for the
	 *   preview shell's app metadata, not the server registry.
	 */
	public notifyDevServer(appId: string, entry: string, manifest?: Record<string, unknown>): void {
		this.devEntries.set(appId, entry);
		this.devManifests.set(appId, manifest);
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:devServer', entry, manifest });
	}

	/**
	 * Push one console row into an app's panel (Console pane) — the feed for
	 * pnpm install and rsbuild output. VSCode queues webview messages posted
	 * before view:ready, so no buffering is needed.
	 *
	 * @param appId - The app whose console the row belongs to.
	 * @param level - Row severity.
	 * @param text - Row text (one line).
	 */
	public notifyConsole(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:console', row: { time: AppScreenProvider.feedTime(), level, text } });
	}

	/**
	 * Push one error row into an app's panel (Errors pane).
	 *
	 * @param appId - The app the error belongs to.
	 * @param message - The error text.
	 * @param source - Optional origin tag ("rsbuild", "pnpm install").
	 */
	public notifyError(appId: string, message: string, source?: string): void {
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:error', row: { time: AppScreenProvider.feedTime(), message, source } });
	}

	/**
	 * Push a watch status to EVERY open panel — the workspace-global install
	 * belongs to all of them, not just the app that happened to trigger it.
	 *
	 * @param status - The watch status to broadcast.
	 */
	public notifyWatchAll(status: AppWatchStatus): void {
		for (const appId of this.panels.keys()) this.notifyWatch(appId, status);
	}

	/**
	 * Push one console row to EVERY open panel (workspace-global install
	 * output).
	 *
	 * @param level - Row severity.
	 * @param text - Row text (one line).
	 */
	public notifyConsoleAll(level: 'log' | 'warn' | 'error', text: string): void {
		for (const appId of this.panels.keys()) this.notifyConsole(appId, level, text);
	}

	// =========================================================================
	// BRIDGE HELPERS
	// =========================================================================

	/**
	 * Parses a registry version argument from a bridge call, rejecting anything
	 * that is not a finite integer. A missing / non-numeric arg would otherwise
	 * become NaN and serialize to null over JSON — silently changing deployment
	 * state against an unspecified version.
	 *
	 * @param arg - The raw bridge argument (callArgs[0]).
	 * @returns The validated integer registry version.
	 */
	private requireRegistryVersion(arg: unknown): number {
		// Number(null) and Number('') both coerce to 0, which would pass a
		// bare isInteger check and reach submit/publish/withdraw as version
		// 0 — the "unspecified version" this guard exists to reject.
		// Registry versions are positive integers (v1 is the first).
		if (typeof arg !== 'number' && typeof arg !== 'string') {
			throw new Error(`Invalid registry version: ${JSON.stringify(arg)}`);
		}
		const version = Number(arg);
		if (!Number.isSafeInteger(version) || version <= 0) {
			throw new Error(`Invalid registry version: ${JSON.stringify(arg)}`);
		}
		return version;
	}

	/**
	 * Maps a persisted stage value to the current vocabulary. workspaceState
	 * stores the active tab raw, so windows that persisted before the
	 * DEVELOP -> DESIGN rename hold the legacy id; anything unknown (or
	 * never persisted) lands on 'dashboard', the default view.
	 *
	 * @param raw - The raw workspaceState value.
	 * @returns A valid stage id for the current tab set.
	 */
	private static normalizeStage(raw: unknown): 'dashboard' | 'design' | 'package' | 'store' | 'deploy' {
		if (raw === 'develop') return 'design';
		if (raw === 'design' || raw === 'package' || raw === 'store' || raw === 'deploy' || raw === 'dashboard') return raw;
		return 'dashboard';
	}

	// =========================================================================
	// INIT PAYLOAD HELPERS
	// =========================================================================

	/** Builds the AppSummary the shared screen renders (header + trailing note). */
	private buildAppSummary(appId: string, app: ScannedApp | undefined): Record<string, unknown> {
		return {
			id: appId,
			moduleId: app?.moduleId ?? appId.replace(/[.-]/g, '_'),
			name: app?.name ?? appId,
			version: app?.version,
			description: app?.description,
			// Workspace-bound with no server record = 'local'; server statuses
			// (draft/pending/...) arrive with the marketplace wiring (M5).
			status: 'local',
		};
	}

	/**
	 * Builds the preview URL: the Development Mode engine's shell with the
	 * app locked + dev hooks on. `rocketride.appdev.shellUrl` overrides the
	 * base for monorepo devs running the shell dev server.
	 */
	private buildPreviewUrl(appId: string): string {
		const override = vscode.workspace.getConfiguration('rocketride.appdev').get<string>('shellUrl', '');
		const base = override || this.connectionManager.getHttpUrl?.() || 'http://localhost:5565';
		// _ts busts the browser's cached index.html — the flavor picker lives
		// in the html, and a stale copy silently serves the wrong shell flavor.
		return `${base.replace(/\/$/, '')}/?appid=${encodeURIComponent(appId)}&rrdev=1&_ts=${Date.now()}`;
	}

	// =========================================================================
	// EVENT FORWARDING — shell events into the Events pane
	// =========================================================================

	/** Renders a wall-clock time as the feed rows' HH:MM:SS stamp. */
	private static feedTime(): string {
		return new Date().toLocaleTimeString(undefined, { hour12: false });
	}

	/** Whether the org-wide DEPLOY monitor has been armed this session. */
	private deployMonitorArmed = false;

	/**
	 * Subscribes this connection to org-scoped DEPLOY-type server events.
	 *
	 * The build ticker (apaevt_build_status) and compile feed (apaevt_build)
	 * ride EVENT_TYPE.DEPLOY, and the server delivers a type only to
	 * connections that monitored it — the pipeline editor arms 'deploy' for
	 * its own views, but an App Builder session without an open pipeline
	 * heard NOTHING. Idempotent; a failed arm re-tries on the next
	 * connected status change, and the SDK replays a successful monitor
	 * across reconnects on its own.
	 */
	private armDeployMonitor(): void {
		if (this.deployMonitorArmed) return;
		const client = this.connectionManager.getClient();
		if (!client || !this.connectionManager.isConnected()) return;
		this.deployMonitorArmed = true;
		client.addMonitor({ token: '*' }, ['deploy']).catch((err: unknown) => {
			// Arm again on the next reconnect — the feed is telemetry, never
			// worth failing a panel over.
			this.deployMonitorArmed = false;
			getLogger().output(`[appdev] deploy monitor subscribe failed: ${err}`);
		});
	}

	/** Forward connection + server events to every open App Builder panel. */
	private setupEventListeners(): void {
		// connectionManager.on() returns the SHARED manager (a Node
		// EventEmitter), and ITS dispose() tears down the whole extension's
		// connection — disposal must wrap off() with the named handler instead.
		// Server push events → Events pane rows
		const onEvent = (event: GenericEvent): void => {
			if (!event?.event) return;
			// Server BUILD feed (apaevt_build): the build worker's live
			// pnpm/tsc/rsbuild output for this org's apps — routed into the
			// app's Console pane so a deploy shows its compile as it runs
			// (between the coarse status-ticker transitions).
			if (event.event === 'apaevt_build' && event.body) {
				const b = event.body as { appId?: string; phase?: string; lines?: string[] };
				if (b.appId && Array.isArray(b.lines) && b.lines.length > 0) {
					// One row PER LINE: notifyConsole's contract is a single
					// line and each call makes one row, so a joined string
					// would land in the Console pane as one row carrying
					// embedded newlines. watchManager feeds the same pane
					// line by line.
					const prefix = `[build:${b.phase || '?'}]`;
					for (const line of b.lines) this.notifyConsole(b.appId, 'log', `${prefix} ${line}`);
				}
			}
			// Server BUILD status ticker (apaevt_build_status): one short
			// display word per lifecycle transition ('' clears) — forwarded
			// to the app's panel for the DEPLOY-view version card.
			if (event.event === 'apaevt_build_status' && event.body) {
				const b = event.body as { appId?: string; version?: number; status?: string };
				if (b.appId && typeof b.status === 'string') {
					this.panels.get(b.appId)?.webview.postMessage({
						type: 'appdev:buildStatus',
						appId: b.appId,
						version: b.version,
						status: b.status,
					});
				}
			}
			// Review-state push (app:statusChanged): a review transition for
			// one of this org's apps. The open panel re-fetches its org-scoped
			// data (version rail + Store review state) through the existing
			// account-changed re-mint. No toasts: the dashboard's narrated
			// status, conversation stream, and Store review history are the
			// verdict surfaces (a verdict arriving with no panel open shows
			// the next time the app opens).
			if (event.event === 'app:statusChanged' && event.body) {
				const b = event.body as { appId?: string };
				if (b.appId && this.panels.has(b.appId)) {
					this.panels.get(b.appId)?.webview.postMessage({ type: 'appdev:accountChanged' });
				}
			}
			// Deployment change (apaevt_deploy, org-scoped invalidation): a
			// build landed or anyone in the org published/disabled/removed a
			// binding of an app with an open panel. The panel re-fetches its
			// rail and where-live serving states (#2461). An app's deploy
			// events carry the app id as projectId.
			if (event.event === 'apaevt_deploy' && event.body) {
				const b = event.body as { projectId?: string };
				if (b.projectId && this.panels.has(b.projectId)) {
					this.panels.get(b.projectId)?.webview.postMessage({ type: 'appdev:deployChanged', appId: b.projectId });
				}
			}
			const row = {
				time: AppScreenProvider.feedTime(),
				name: String(event.event),
				payload: event.body ? JSON.stringify(event.body).slice(0, 200) : undefined,
			};
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'appdev:event', row });
			}
		};
		this.connectionManager.on('shell:event', onEvent);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:event', onEvent) });

		// Connection status changes are feed-worthy context too
		const onStatus = (): void => {
			const row = {
				time: AppScreenProvider.feedTime(),
				name: 'shell:statusChange',
				payload: this.connectionManager.isConnected() ? 'connected' : 'disconnected',
			};
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'appdev:event', row });
			}
			// Reconnect recovery: panels parked on the platform-package error
			// (server was down / not connected at open) retry the vendor pass
			// now that a server is reachable — center-screen error to running
			// preview without closing and reopening the app.
			if (this.connectionManager.isConnected()) {
				// A panel opened while disconnected could not arm the DEPLOY
				// monitor — arm it now (the SDK replays a successful monitor
				// across later reconnects on its own).
				if (this.panels.size > 0) this.armDeployMonitor();
				// A reconnect may carry a NEW identity (an org switch re-logs-in
				// under the new default org): tell every open panel to re-fetch
				// its org-scoped data (developer namespace, publish rail, teams).
				for (const panel of this.panels.values()) {
					panel.webview.postMessage({ type: 'appdev:accountChanged' });
				}
				for (const [appId, status] of this.lastWatch) {
					if (status.state !== 'error' || status.target !== 'platform package') continue;
					void (async () => {
						const apps = await scanWorkspaceApps(hostWorkspaceFs);
						const app = apps.find((a) => a.id === appId);
						if (!app) return;
						const result = await vendorAppTypes(this.context, app.folder);
						if (result.ok) {
							// Same rewired-spec invalidation as the open path.
							if (result.rewired) getDevSessionManager()?.invalidateInstall();
							return ensureDevSession(app);
						}
						this.notifyWatch(appId, { state: 'error', target: 'platform package', reason: result.reason });
					})();
				}
			}
		};
		this.connectionManager.on('shell:statusChange', onStatus);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:statusChange', onStatus) });

		// The server pushed a refreshed account (developer registration, org
		// property change, subscription move) WITHOUT a reconnect — the same
		// org-scoped data in open panels is stale; have them re-fetch.
		const onAccountUpdate = (): void => {
			for (const panel of this.panels.values()) {
				panel.webview.postMessage({ type: 'appdev:accountChanged' });
			}
		};
		this.connectionManager.on('shell:accountUpdate', onAccountUpdate);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:accountUpdate', onAccountUpdate) });

		// Tab-based close detection. A tab can close WITHOUT ever having been
		// resolved by THIS host — reconcileOpenTabs starts watches for tabs
		// restored from a previous host, and until VSCode re-resolves one it
		// has no panel handle, so panel.onDidDispose cannot fire and closing
		// the tab would leave its dev server running forever. The tab list is
		// the universal close signal; for resolved panels this double-fires
		// alongside onDidDispose, which stop()'s linger path absorbs.
		const tabListener = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
			for (const tab of e.closed) {
				const input = tab.input;
				if (!(input instanceof vscode.TabInputCustom) || input.viewType !== 'rocketride.appBuilder') continue;
				try {
					// A tab MOVE between groups reports close+open — only stop
					// when no tab still shows this document.
					const uriKey = input.uri.toString();
					const stillOpen = vscode.window.tabGroups.all.some((g) =>
						g.tabs.some((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'rocketride.appBuilder' && t.input.uri.toString() === uriKey),
					);
					if (stillOpen) continue;
					const appId = await this.appIdOf(input.uri);
					void getDevSessionManager()?.stop(appId);
				} catch { /* unresolvable marker — nothing to stop */ }
			}
		});
		this.disposables.push(tabListener);
	}

	// =========================================================================
	// HTML
	// =========================================================================

	/** Load page-app.html via the shared nonce+CSP+static-rewrite pipeline. */
	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = this.generateNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'page-app.html');

		try {
			let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');
			htmlContent = htmlContent.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);
			return htmlContent.replace(/(?:src|href)="(\/static\/[^"]+)"/g, (match: string, relativePath: string): string => {
				const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
				const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', cleanPath));
				return match.replace(relativePath, resourceUri.toString());
			});
		} catch (error) {
			return `<html><body><p>Error loading App Builder: ${error}</p></body></html>`;
		}
	}

	private generateNonce(): string {
		// Cryptographic source — a CSP nonce must be unpredictable.
		return randomBytes(24).toString('base64url');
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	public dispose(): void {
		for (const panel of this.panels.values()) {
			panel.dispose();
		}
		this.panels.clear();
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}
