// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Dev Tool Panel Provider
 *
 * Hosts pinned dev tools as editor-area webview panels — one panel per tool,
 * titled by the tool's name. Each panel is a Module Federation HOST (built by
 * rsbuild.devtool.config.mjs): it loads the tool's remote straight from the
 * connected engine and mounts the descriptor's `devToolFrame` natively — no
 * iframe, no shell boot. The panel's CSP is computed per creation so the
 * engine origin is allowed for scripts (remote chunks) and connections (the
 * webview's own SDK websocket).
 *
 * A loaded MF container cannot be repointed, so a registry-version change
 * recreates the panel instead of updating it in place.
 *
 * Architecture:
 *   DevToolPanelProvider (Node.js) ↔ postMessage ↔ DevToolWebview (browser, MF host)
 */

import * as vscode from 'vscode';
import { getLogger } from '../shared/util/output';
import { ConnectionManager } from '../connection/connection';
import type { BusHost } from './toolhost/busHost';
import { renderWebviewHtml } from './toolhost/frameworkProvider';
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { OpImplTable } from 'shell/src/ops/busOps';
import type { HostOpMap, DevToolViewPayload } from 'shared/ops/hostOps';
import type { DevToolWebviewToHost } from './types/devToolTypes';

// =============================================================================
// PROVIDER
// =============================================================================

/** viewType prefix — the tab's identity is `<prefix><appId>`, so a restored
    tab identifies its tool by itself (no webview state involved). */
const VIEWTYPE_PREFIX = 'rocketride.page.devTool.';

/** One open panel: the webview plus its identity. */
interface PanelEntry {
	panel: vscode.WebviewPanel;
	appId: string;
	/** The host-document key ('' = the tool's single/default frame). */
	docKey: string;
}

export class DevToolPanelProvider {
	/** Open panels, keyed `${appId}\u0000${docKey}` — a tool may hold one
	    panel per document key (e.g. one per database connection). */
	private panels = new Map<string, PanelEntry>();

	/** The registry version each open panel mounted (recreate on change). */
	private panelVersions = new Map<string, number>();

	/** The composite map key for one tool document. */
	private static panelKey(appId: string, docKey: string): string {
		return `${appId}\u0000${docKey}`;
	}

	/** Subscriptions and listeners to clean up on dispose. */
	private disposables: vscode.Disposable[] = [];

	/** Dev connection singleton — the engine URL, credential, and app list. */
	private connectionManager = ConnectionManager.getInstance();

	/**
	 * Called when a tool panel becomes the ACTIVE editor — the host syncs the
	 * sidebar's strip highlight to it.
	 */
	public onPanelFocused?: (appId: string) => void;

	/**
	 * Called whenever the ACTIVE editor tab changes: the fronted tool
	 * document (appId + docKey), or (null, null) when the active tab is not
	 * a dev-tool panel at all. Duplicates are filtered; feeds the sidebar
	 * mounts' `activeDocKey` so they follow the editor selection.
	 */
	public onActiveDocChange?: (appId: string | null, docKey: string | null) => void;

	/** Last emitted active-doc signature (duplicate filter). */
	private lastActiveDocSig = '';

	/** Emits onActiveDocChange once per distinct active document. */
	private emitActiveDoc(appId: string | null, docKey: string | null): void {
		const sig = appId === null ? '-' : `${appId}\u0000${docKey ?? ''}`;
		if (sig === this.lastActiveDocSig) return;
		this.lastActiveDocSig = sig;
		this.onActiveDocChange?.(appId, docKey);
	}

	/**
	 * Reads the active tab of the active group and emits what it fronts —
	 * a dev-tool document (parsed back out of the panel viewType) or not
	 * ours at all.
	 */
	private syncActiveDoc(): void {
		const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
		// TabInputWebview.viewType is host-mangled ("mainThreadWebview-<viewType>").
		if (input instanceof vscode.TabInputWebview && input.viewType.includes(VIEWTYPE_PREFIX)) {
			const raw = input.viewType.slice(input.viewType.indexOf(VIEWTYPE_PREFIX) + VIEWTYPE_PREFIX.length);
			// docKey is encodeURIComponent'd at panel creation, so the first
			// '/' is always the appId/docKey separator.
			const slash = raw.indexOf('/');
			const appId = slash < 0 ? raw : raw.slice(0, slash);
			const docKey = slash < 0 ? '' : decodeURIComponent(raw.slice(slash + 1));
			this.emitActiveDoc(appId, docKey);
			return;
		}
		this.emitActiveDoc(null, null);
	}

	/**
	 * Creates the provider and registers the open command.
	 *
	 * @param context - The VS Code extension context for subscriptions and URIs.
	 * @param busHost - The shell bus root — each panel attaches as a realm
	 *   (tool peer traffic rides the bus) and the host publishes each tool's
	 *   authoritative open-panel count on its presence topic.
	 */
	constructor(private context: vscode.ExtensionContext, private busHost?: BusHost) {
		const cmd = vscode.commands.registerCommand('rocketride.devtool.open', (appId?: string, docKey?: string, title?: string) => {
			if (typeof appId === 'string' && appId) this.show(appId, typeof docKey === 'string' ? docKey : '', typeof title === 'string' ? title : undefined);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
		const closeCmd = vscode.commands.registerCommand('rocketride.devtool.close', (appId?: string, docKey?: string) => {
			if (typeof appId === 'string' && appId) this.closeDocument(appId, typeof docKey === 'string' ? docKey : '');
		});
		this.disposables.push(closeCmd);
		this.context.subscriptions.push(closeCmd);
		// Reveal-only (the sidebar strip's tab selection): bring an open
		// window of the tool forward, create nothing.
		const revealCmd = vscode.commands.registerCommand('rocketride.devtool.reveal', (appId?: string) => {
			if (typeof appId === 'string' && appId) this.revealApp(appId);
		});
		this.disposables.push(revealCmd);
		this.context.subscriptions.push(revealCmd);

		// A frame realm PULLS its boot state (the panel's appId is stamped
		// into the served HTML). The host owns the catalog and the engine
		// connection, so it answers authoritatively — a tool panel opens
		// long after activation, and a late realm must not have to
		// re-derive this from mirror replay.
		if (this.busHost) {
			const impls: OpImplTable<HostOpMap> = {
				'host.devtools.load': (p) => this.toolView(p.appId),
			};
			registerOpHandlers<HostOpMap>(this.busHost.rootBus, impls);
		}
		// The Dev Tools reset flow: recreate panels whose mounted registry
		// version went stale (a publish bumped it under a live panel).
		const refreshCmd = vscode.commands.registerCommand('rocketride.devtool.refreshStale', () => {
			this.refreshStale();
		});
		this.disposables.push(refreshCmd);
		this.context.subscriptions.push(refreshCmd);

		// Connection changes reach each panel realm directly (the shell:status
		// mirror re-emits shell:statusChange inside the webview, and the
		// account mirror carries the catalog) — the webview re-runs its
		// connect + mount pipeline itself. The host's only remaining job here
		// is cosmetic: name panels that were created while disconnected once
		// the catalog knows the tool.
		const statusListener = this.connectionManager.on('shell:statusChange', () => {
			for (const entry of this.panels.values()) {
				const row = this.findApp(entry.appId);
				if (row?.name && !entry.docKey) entry.panel.title = row.name;
			}
		});
		this.disposables.push(statusListener as any);

		// Follow the editor's ACTIVE tab globally — switching to a text file
		// or another tool must clear the tool sidebars' selection, and no
		// panel event fires for tabs that are not ours.
		this.disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(() => this.syncActiveDoc()),
			vscode.window.tabGroups.onDidChangeTabGroups(() => this.syncActiveDoc()),
		);

		// Tool tabs do NOT persist across a window reload / extension-host
		// restart: their panels lived in the previous host, so any surviving
		// tab is a dead husk this provider cannot talk to — and the next
		// sidebar click would sit a DUPLICATE next to it. The viewType names
		// the tab as ours; close the leftovers. Clicking the tool reopens it
		// in its initial state.
		void this.closeOrphanTabs();
	}

	/** Closes dev-tool tabs left over from a previous extension host. */
	private async closeOrphanTabs(): Promise<void> {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				// TabInputWebview.viewType is host-mangled ("mainThreadWebview-<viewType>").
				if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(VIEWTYPE_PREFIX)) {
					try {
						await vscode.window.tabGroups.close(tab);
					} catch {
						/* tab already gone — nothing to close */
					}
				}
			}
		}
	}

	// =========================================================================
	// SHOW / REVEAL
	// =========================================================================

	/**
	 * Opens (or reveals) the panel for one tool document.
	 *
	 * @param appId - The tool's app id.
	 * @param docKey - The host-document key ('' = the tool's single frame).
	 * @param title - Tab title for a per-document panel (the tool names its
	 *                documents); defaults to the tool's name.
	 */
	public show(appId: string, docKey = '', title?: string): void {
		const row = this.findApp(appId);
		const key = DevToolPanelProvider.panelKey(appId, docKey);

		// A version change means the mounted MF container is stale — a loaded
		// remote cannot be repointed, so dispose and recreate.
		const existing = this.panels.get(key);
		if (existing) {
			const mounted = this.panelVersions.get(key);
			if (row && mounted !== undefined && row.registryVersion !== undefined && mounted !== row.registryVersion) {
				existing.panel.dispose(); // onDidDispose clears the maps
			} else {
				existing.panel.reveal(vscode.ViewColumn.One);
				return;
			}
		}

		const panelTitle = title ?? row?.name ?? appId;
		const viewType = `${VIEWTYPE_PREFIX}${appId}${docKey ? `/${encodeURIComponent(docKey)}` : ''}`;
		const panel = vscode.window.createWebviewPanel(viewType, panelTitle, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});

		const entry: PanelEntry = {
			panel,
			appId,
			docKey,
		};
		this.panels.set(key, entry);
		if (row?.registryVersion !== undefined) this.panelVersions.set(key, row.registryVersion);

		panel.webview.html = this.getHtmlForWebview(panel.webview, appId, docKey);

		// The panel is a bus realm: the tool's peer traffic (and any engine
		// access) rides the `__rrbus` envelope beside the typed devtool:*
		// document messages. Presence feeds the sidebar peer's summon decisions —
		// a webview can die without running unmount cleanup, so the HOST's
		// panel count is the authority.
		const detachRealm = this.busHost?.attachWebview(panel.webview, `tool:${appId}/${docKey || 'main'}`);
		this.publishPresence(appId);

		panel.webview.onDidReceiveMessage(async (message: DevToolWebviewToHost) => {
			try {
				switch (message.type) {
					case 'devtool:openDocument':
						// The tool asks for one of ITS documents (DevToolProps
						// .documents.open) — e.g. a database connection's tab.
						this.show(appId, message.docKey, message.title);
						break;
					case 'devtool:closeDocument':
						this.closeDocument(appId, message.docKey);
						break;
				}
			} catch (error) {
				getLogger().error(`[DevToolPanelProvider] Message handling error: ${error}`);
			}
		});

		// Focusing the tool's editor tab highlights its strip tab in the
		// RocketRide sidebar (and shows its sidebar body); the focused panel
		// also becomes the app's reveal target for strip-tab clicks.
		panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) {
				this.lastFocused.set(appId, key);
				this.onPanelFocused?.(appId);
				this.emitActiveDoc(appId, docKey);
			}
		});

		panel.onDidDispose(() => {
			detachRealm?.();
			this.panels.delete(key);
			this.panelVersions.delete(key);
			if (this.lastFocused.get(appId) === key) this.lastFocused.delete(appId);
			this.publishPresence(appId);
		});
	}

	/** The panel key each app's user focused last (reveal target). */
	private lastFocused = new Map<string, string>();

	/** Publishes one tool's open-panel count on its presence topic. */
	private publishPresence(appId: string): void {
		let count = 0;
		for (const entry of this.panels.values()) if (entry.appId === appId) count += 1;
		this.busHost?.retained.publish(`tool:${appId}:panels`, count);
	}

	/**
	 * Brings an already-open window of the tool forward — the last-focused
	 * one, falling back to any open panel of the app. Opens NOTHING when the
	 * tool has no window; a sidebar tab switch is not a request for one.
	 *
	 * @param appId - The tool's app id.
	 */
	public revealApp(appId: string): void {
		const lastKey = this.lastFocused.get(appId);
		const entry = (lastKey ? this.panels.get(lastKey) : undefined)
			?? [...this.panels.values()].find((e) => e.appId === appId);
		entry?.panel.reveal(vscode.ViewColumn.One, true);
	}

	/**
	 * Recreates every open panel whose mounted registry version no longer
	 * matches the catalog — the Dev Tools RESET flow after a publish. A
	 * loaded MF container cannot be repointed, so each stale panel's webview
	 * is disposed and reopened at the same document (same docKey, same tab
	 * title); panels already on the current version are left untouched.
	 * Call AFTER the catalog itself was refreshed (findApp reads it).
	 */
	public refreshStale(): void {
		for (const [key, entry] of [...this.panels]) {
			const row = this.findApp(entry.appId);
			if (!row || row.registryVersion === undefined) continue;
			if (this.panelVersions.get(key) === row.registryVersion) continue;
			const title = entry.panel.title;
			entry.panel.dispose(); // onDidDispose clears the maps
			this.show(entry.appId, entry.docKey, title);
		}
	}

	/**
	 * Closes ALL of a tool's open panels (the Remove flow — a removed tool
	 * must not keep a live frame, per-document tabs included).
	 *
	 * @param appId - The tool's app id.
	 */
	public close(appId: string): void {
		for (const entry of [...this.panels.values()]) {
			if (entry.appId === appId) entry.panel.dispose(); // onDidDispose clears the maps
		}
	}

	/**
	 * Closes one tool document's panel, if open.
	 *
	 * @param appId - The tool's app id.
	 * @param docKey - The host-document key.
	 */
	public closeDocument(appId: string, docKey: string): void {
		this.panels.get(DevToolPanelProvider.panelKey(appId, docKey))?.panel.dispose();
	}

	// =========================================================================
	// INIT PAYLOAD
	// =========================================================================

	/**
	 * A frame's boot state — the authoritative answer to
	 * `host.devtools.load` (and what the retired `devtool:init` push carried).
	 *
	 * @param appId - The tool whose frame is asking.
	 */
	private toolView(appId: string): DevToolViewPayload {
		const connected = this.connectionManager.isConnected();
		const row = connected ? this.findApp(appId) : undefined;
		return {
			connected,
			engineHttpUrl: connected ? (this.connectionManager.getHttpUrl() || 'http://localhost:5565').replace(/\/$/, '') : '',
			app: row && row.registryVersion !== undefined
				? { id: row.id, moduleId: row.moduleId, name: row.name, registryVersion: row.registryVersion }
				: null,
		};
	}

	/** One account-payload app row, as this provider reads it. */
	private findApp(appId: string): { id: string; moduleId: string; name: string; registryVersion?: number } | undefined {
		const client = this.connectionManager.getClient();
		const apps = (client?.getAccountInfo()?.apps ?? []) as Array<{ id: string; moduleId: string; name: string; registryVersion?: number }>;
		return apps.find((a) => a?.id === appId);
	}

	// =========================================================================
	// WEBVIEW HTML + RUNTIME CSP
	// =========================================================================

	/**
	 * Reads the MF-host build's HTML (webview/devtool/page-devtool.html),
	 * injects the nonce/CSP source, widens the CSP with the ENGINE origin
	 * (remote chunks ride `script-src`; the webview's SDK websocket and MF
	 * chunk fetches ride `connect-src`), and rewrites static asset URLs to
	 * webview-safe URIs.
	 *
	 * The panel's identity (tool id + document key) is STAMPED into the body
	 * (`data-rr-tool` / `data-rr-doc`), present before any script runs — the
	 * realm derives everything else (connection, engine URL, catalog row)
	 * from its mirrored ConnectionManager. There is no init message.
	 *
	 * @param webview - The webview to generate HTML for.
	 * @param appId - The tool's app id (stamped).
	 * @param docKey - The host-document key, '' for the tool's single frame (stamped).
	 * @returns The HTML string to set as `webview.html`.
	 */
	private getHtmlForWebview(webview: vscode.Webview, appId: string, docKey: string): string {
		// The engine origin this panel may load SCRIPTS from — computed per
		// creation (the engine URL is a user setting).
		let engineOrigin = '';
		try {
			engineOrigin = new URL(this.connectionManager.getHttpUrl() || 'http://localhost:5565').origin;
		} catch {
			/* no engine origin — the CSP stays as the template wrote it */
		}
		return renderWebviewHtml(this.context, webview, {
			htmlFile: 'devtool/page-devtool.html',
			stamps: { tool: appId, doc: docKey },
			// Per-panel runtime CSP: SCRIPTS stay engine-only (code loading is
			// the sensitive direction); DATA fetches open to any http(s) origin
			// because file content rides presigned storage URLs on cloud
			// connections (fsGetUrl -> S3/Azure blob origins).
			transform: (html) =>
				engineOrigin
					? html
							.replace(/script-src /, `script-src ${engineOrigin} `)
							.replace(/style-src /, `style-src ${engineOrigin} `)
							.replace(/connect-src /, 'connect-src http: https: ws: wss: blob: ')
							.replace(/img-src /, 'img-src http: https: blob: ')
							.replace(/font-src /, 'font-src http: https: ')
							.replace(/default-src 'none';/, "default-src 'none'; media-src http: https: data: blob:;")
					: html,
		});
	}

	// =========================================================================
	// DISPOSAL
	// =========================================================================

	/** Disposes all subscriptions and closes every open panel. */
	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const entry of this.panels.values()) entry.panel.dispose();
		this.panels.clear();
		this.panelVersions.clear();
	}
}
