// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AppScreenProvider — one App Builder panel per app (page-app webview).
 *
 * The panel is a BUS REALM: its identity is STAMPED into the served HTML
 * (`data-rr-app`), boot state rides `host.appbuilder.load`, host verbs ride
 * the `host.appbuilder.*` ops (ops/appBuilderOps.ts), the SDK half rides the
 * brokered `client.app.*` ops, and the dev-session feeds ride the app's
 * topics:
 *
 *   appbuilder:app:<appId>:watch    RETAINED WatchStatus — retracted on close
 *   appbuilder:app:<appId>:dev      RETAINED {entry,manifest} — retracted
 *   appbuilder:app:<appId>:console  SIGNAL   row (realm keeps its backlog)
 *   appbuilder:app:<appId>:errors   SIGNAL   row
 *   appbuilder:app:<appId>:session  RETAINED {token} — one-shot credential,
 *                                   the consuming page retracts after apply
 *
 * This provider keeps only what is genuinely PANEL work: the .rrapp custom
 * editor lifecycle (tabs, HTML, dispose), the dev-session inner loop
 * (vendor + watch kickoff, reconnect retry, close detection), and the feed
 * publishing above. There is no postMessage protocol.
 */

import * as vscode from 'vscode';
import { renderWebviewHtml } from './toolhost/frameworkProvider';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from 'shared/tools/appdev';
import { hostWorkspaceFs } from './toolhost/hostWorkspaceFs';
import { ensureAppTrigger, ensureProjectId } from '../appdev/appMarker';
import { ensureDevSession, getDevSessionManager } from '../appdev/devSessionManager';
import { vendorAppTypes } from '../appdev/appTypes';
import type { BusHost } from './toolhost/busHost';

// =============================================================================
// TYPES
// =============================================================================

/** Watch status shape published to the app's retained :watch topic. */
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
	/** Latest watch status per app — the reconnect vendor-retry scan reads it
	 *  (the webview's replay rides the retained topic, not this map). */
	private lastWatch = new Map<string, AppWatchStatus>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly busHost: BusHost
	) {
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
	 * webview contexts — VSCode never re-resolves the custom editor, so the
	 * open-path ensureDevSession belongs to a resolve that never ran. The
	 * tab list is the one surface that survives every restart mode;
	 * activation reconciles against it directly.
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
		panel.webview.html = this.getHtmlForWebview(panel.webview, appId);

		// The panel is a bus realm: boot state rides host.appbuilder.load,
		// the SDK half rides client.app.*, the feeds ride the app's topics.
		const detachRealm = this.busHost.attachWebview(panel.webview, `page:appbuilder/${appId}`);

		// Session handoff: this window is already authenticated — give the
		// preview shell the same credential so apps requiring auth render
		// with a real signed-in session. A one-shot credential on the
		// retained :session lane; the consuming page retracts after applying.
		void this.connectionManager
			.resolveAuthCredential()
			.then((token) => {
				if (token) this.busHost.retained.publish(`appbuilder:app:${appId}:session`, { token });
			})
			.catch(() => {
				/* signed out — the preview shows its sign-in prompt */
			});

		panel.onDidDispose(() => {
			// A newer panel may own this app id now — never clear its state.
			if (this.panels.get(appId) !== panel) return;
			detachRealm();
			this.panels.delete(appId);
			this.lastWatch.delete(appId);
			// Retract the app's retained topics — retention outlives the
			// publisher by design, and a reopened panel must not replay a
			// closed session's state (or a stale credential).
			this.busHost.retained.publish(`appbuilder:app:${appId}:watch`, undefined);
			this.busHost.retained.publish(`appbuilder:app:${appId}:dev`, undefined);
			this.busHost.retained.publish(`appbuilder:app:${appId}:session`, undefined);
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

	// =========================================================================
	// FEEDS — dev-session state and rows onto the app's topics
	// =========================================================================

	/**
	 * Publish a watch/build status update (the DEV badge). RETAINED — a late
	 * or reloaded webview replays the latest state on subscribe.
	 *
	 * @param appId - The app whose watch state changed.
	 * @param status - The new watch status.
	 */
	public notifyWatch(appId: string, status: AppWatchStatus): void {
		this.lastWatch.set(appId, status);
		this.busHost.retained.publish(`appbuilder:app:${appId}:watch`, status);
	}

	/**
	 * Announce the running dev server's remoteEntry.js URL. RETAINED — the
	 * realm injects it into the preview shell; replay on subscribe covers a
	 * reloaded webview.
	 *
	 * @param appId - The app whose dev server came up (or repointed).
	 * @param entry - The dev server's remoteEntry.js URL.
	 * @param manifest - The WORKSPACE manifest payload (appManifest +
	 *   top-level version) — in dev the workspace is the truth for the
	 *   preview shell's app metadata, not the server registry.
	 */
	public notifyDevServer(appId: string, entry: string, manifest?: Record<string, unknown>): void {
		this.busHost.retained.publish(`appbuilder:app:${appId}:dev`, { entry, manifest });
	}

	/**
	 * Push one console row (Console pane) — pnpm install and rsbuild output.
	 * A SIGNAL, deliberately not retained: the realm keeps its own bounded
	 * backlog, and a retained replay would double-print startup lines.
	 *
	 * @param appId - The app whose console the row belongs to.
	 * @param level - Row severity.
	 * @param text - Row text (one line).
	 */
	public notifyConsole(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		this.busHost.retained.signal(`appbuilder:app:${appId}:console`, { time: AppScreenProvider.feedTime(), level, text });
	}

	/**
	 * Push one error row (Errors pane). A SIGNAL, like console rows.
	 *
	 * @param appId - The app the error belongs to.
	 * @param message - The error text.
	 * @param source - Optional origin tag ("rsbuild", "pnpm install").
	 */
	public notifyError(appId: string, message: string, source?: string): void {
		this.busHost.retained.signal(`appbuilder:app:${appId}:errors`, { time: AppScreenProvider.feedTime(), message, source });
	}

	/**
	 * Push a watch status to EVERY app with an open panel — the
	 * workspace-global install belongs to all of them, not just the app that
	 * happened to trigger it. Scoped to LIVE panels on purpose: retained
	 * topics outlive their publisher, and a global install must not write
	 * into a closed app's replayable state.
	 *
	 * @param status - The watch status to broadcast.
	 */
	public notifyWatchAll(status: AppWatchStatus): void {
		for (const appId of this.panels.keys()) this.notifyWatch(appId, status);
	}

	/**
	 * Push one console row to EVERY app with an open panel (workspace-global
	 * install output).
	 *
	 * @param level - Row severity.
	 * @param text - Row text (one line).
	 */
	public notifyConsoleAll(level: 'log' | 'warn' | 'error', text: string): void {
		for (const appId of this.panels.keys()) this.notifyConsole(appId, level, text);
	}

	/** Renders a wall-clock time as the feed rows' HH:MM:SS stamp. */
	private static feedTime(): string {
		return new Date().toLocaleTimeString(undefined, { hour12: false });
	}

	// =========================================================================
	// HOST-SIDE RECOVERY — the pieces the realm cannot do itself
	// =========================================================================

	/**
	 * Reconnect recovery. Everything the panels DISPLAY on a status change
	 * rides the mirrors into each realm directly — the host's only remaining
	 * job is the dev-session side: panels parked on the platform-package
	 * error (server was down / not connected at open) retry the vendor pass
	 * now that a server is reachable.
	 */
	private setupEventListeners(): void {
		// connectionManager.on() returns the SHARED manager (a Node
		// EventEmitter), and ITS dispose() tears down the whole extension's
		// connection — disposal must wrap off() with the named handler instead.
		const onStatus = (): void => {
			if (!this.connectionManager.isConnected()) return;
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
		};
		this.connectionManager.on('shell:statusChange', onStatus);
		this.disposables.push({ dispose: () => this.connectionManager.off('shell:statusChange', onStatus) });

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

	/**
	 * Load page-app.html via the shared nonce+CSP+static-rewrite pipeline.
	 * The panel's identity is STAMPED into the body (`data-rr-app`), present
	 * before any script runs — there is no init message.
	 */
	private getHtmlForWebview(webview: vscode.Webview, appId: string): string {
		return renderWebviewHtml(this.context, webview, { htmlFile: 'page-app.html', stamps: { app: appId } });
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
