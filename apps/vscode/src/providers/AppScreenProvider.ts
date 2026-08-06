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
import { randomBytes } from 'crypto';
import { ConnectionManager } from '../connection/connection';
import { GenericEvent } from '../shared/types';
import { scanWorkspaceApps } from '../appdev/appScan';
import type { ScannedApp } from '../appdev/appScan';
import { ensureWatch, getWatchManager } from '../appdev/watchManager';
import { publishApp } from '../appdev/publish';
import { vendorAppTypes } from '../appdev/appTypes';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';

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
	 * membership, and restore-on-reload. The marker is created on first
	 * open for apps that predate it (a one-line JSON carrying the app id).
	 *
	 * @param appId - The app id (appManifest.id).
	 */
	public async show(appId: string): Promise<void> {
		// Resolve the app's bound folder
		const apps = await scanWorkspaceApps();
		const app = apps.find((a) => a.id === appId);
		if (!app) {
			vscode.window.showErrorMessage(`App "${appId}" has no bound folder in this workspace.`);
			return;
		}

		// The document: <folder>/<name>.rrapp — created on demand
		const marker = vscode.Uri.joinPath(vscode.Uri.file(app.folder), `${appId.split('.').pop()}.rrapp`);
		try {
			await vscode.workspace.fs.stat(marker);
		} catch {
			await vscode.workspace.fs.writeFile(marker, Buffer.from(`${JSON.stringify({ id: appId }, null, 2)}\n`, 'utf8'));
		}
		await vscode.commands.executeCommand('vscode.openWith', marker, 'rocketride.appBuilder');
	}

	// =========================================================================
	// CUSTOM EDITOR — document lifecycle
	// =========================================================================

	/** Opens the (stateless) custom document for an .rrapp file. */
	public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		return { uri, dispose: () => undefined };
	}

	/** Reads the app id from an .rrapp document (falls back to the folder binding). */
	private async appIdOf(uri: vscode.Uri): Promise<string> {
		// The marker carries {"id": "<appId>"}
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as { id?: string };
			if (parsed?.id) return parsed.id;
		} catch { /* malformed/empty marker — fall through to the binding */ }
		// Fallback: the appManifest binding of the containing folder
		const folder = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) }).fsPath;
		const apps = await scanWorkspaceApps();
		return apps.find((a) => a.folder === folder)?.id ?? '';
	}

	/**
	 * Resolves the App Builder editor for an .rrapp document — called by
	 * VSCode on open AND on window-reload restore.
	 */
	public async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const appId = await this.appIdOf(document.uri);

		// Resolve the app's facts from the workspace binding
		const apps = await scanWorkspaceApps();
		const app = apps.find((a) => a.id === appId);

		panel.title = app?.name ?? appId;
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};
		this.panels.set(appId, panel);
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
							// VSCode variant: files are native, F5 debugs, no Code pane
							capabilities: { hasCodePane: false, hasNativeFiles: true, canDebug: true },
							stage: this.context.workspaceState.get(`appdev.stage.${appId}`) ?? 'develop',
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
						if (devEntry) await panel.webview.postMessage({ type: 'appdev:devServer', entry: devEntry });
						// Session handoff: this window is already authenticated —
						// give the preview shell the same credential so apps
						// requiring auth render with a real signed-in session.
						try {
							const token = await this.connectionManager.resolveAuthCredential();
							if (token) await panel.webview.postMessage({ type: 'appdev:auth', token });
						} catch { /* signed out — the preview shows its sign-in prompt */ }
						// The resolve-time watch start can lose a race with the
						// workspace scan — retry here (idempotent when running)
						if (app && !getWatchManager()?.isRunning(appId)) void ensureWatch(app);
						// Config sanity: the dev overlay registers on the
						// CONNECTED server — a preview shell pointing anywhere
						// else can never see the dev bundle. Warn loudly.
						const override = vscode.workspace.getConfiguration('rocketride.appdev').get<string>('shellUrl', '');
						const connected = this.connectionManager.getHttpUrl?.() ?? '';
						if (override && connected && new URL(override).origin !== new URL(connected).origin) {
							this.notifyConsole(appId, 'warn', `Preview shell is ${override} but this window is connected to ${connected}. The dev overlay registers on the connected server, so the preview will show "App not found" — clear or fix rocketride.appdev.shellUrl, or switch Development Mode to the matching server.`);
						}
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

					case 'appdev:debug':
						await vscode.commands.executeCommand('rocketride.app.debug', appId);
						break;

					case 'appdev:login': {
						// The preview shell needs a session and this window is
						// signed out — run the EXTENSION's own sign-in flow
						// (browser-based, works everywhere), then hand the fresh
						// credential down the normal rrdev:auth path.
						const auth = CloudAuthProvider.getInstance();
						await auth.signIn(process.env.RR_ZITADEL_URL || '', process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '');
						try {
							const token = await this.connectionManager.resolveAuthCredential();
							if (token) await panel.webview.postMessage({ type: 'appdev:auth', token });
						} catch { /* sign-in abandoned — preview keeps its prompt */ }
						break;
					}

					case 'appdev:restart':
						// Preview Reload = full inner-loop reset: kill the dev
						// server, pnpm install (package.json may have changed),
						// fresh rsbuild dev. The new server's first successful
						// build triggers the normal preview reload.
						if (app) await getWatchManager()?.restart(app);
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
									value = client ? await client.appVersions(appId) : [];
									break;
								case 'where':
									value = client ? await client.appWhere(appId) : [];
									break;
								case 'deploy': {
									if (!client) throw new Error('Not connected');
									value = await client.appDeploy(appId, Number(callArgs?.[0]), String(callArgs?.[1] ?? ''));
									break;
								}
								case 'publish':
									value = await publishApp(appId, String(callArgs?.[0] ?? ''));
									break;
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
			void getWatchManager()?.stop(appId);
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
				if (result.ok) return ensureWatch(app);
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
	 */
	public notifyDevServer(appId: string, entry: string): void {
		this.devEntries.set(appId, entry);
		this.panels.get(appId)?.webview.postMessage({ type: 'appdev:devServer', entry });
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

	/** Forward connection + server events to every open App Builder panel. */
	private setupEventListeners(): void {
		// connectionManager.on() returns the SHARED manager (a Node
		// EventEmitter), and ITS dispose() tears down the whole extension's
		// connection — disposal must wrap off() with the named handler instead.
		// Server push events → Events pane rows
		const onEvent = (event: GenericEvent): void => {
			if (!event?.event) return;
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
				for (const [appId, status] of this.lastWatch) {
					if (status.state !== 'error' || status.target !== 'platform package') continue;
					void (async () => {
						const apps = await scanWorkspaceApps();
						const app = apps.find((a) => a.id === appId);
						if (!app) return;
						const result = await vendorAppTypes(this.context, app.folder);
						if (result.ok) return ensureWatch(app);
						this.notifyWatch(appId, { state: 'error', target: 'platform package', reason: result.reason });
					})();
				}
			}
		};
		this.connectionManager.on('shell:statusChange', onStatus);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:statusChange', onStatus) });
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
