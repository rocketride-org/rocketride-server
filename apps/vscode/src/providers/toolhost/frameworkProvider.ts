// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FRAMEWORK PROVIDER — a generic webview-panel host for bus-realm framework pages
// =============================================================================
//
// A framework page (Account, Environment, ...) renders SHELL components in a
// webview and reaches the engine ONLY over the shell bus (request('client.*')
// against the BusHost broker). The extension host's entire job for such a
// page is: register the open command, own the singleton panel, serve the
// built HTML, and attach the webview as a bus realm. No page-specific
// message protocol exists — one FrameworkProvider instance replaces what used to be
// a 400–1300 line relay provider per page.
// =============================================================================

import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import * as crypto from 'crypto';
import type { BusHost } from './busHost';

/** The one HTML bundle every framework page shares (see views/page-frame). */
const FRAME_HTML = 'page-frame.html';

/**
 * Reads the shared page-frame HTML and injects nonce + webview URIs + THE
 * PAGE NAME (a body data attribute — present before any script runs, so the
 * bundle mounts the right component with no handshake). Optional `args` are
 * stamped the same way (`data-rr-args`, JSON) for pages that open with an
 * identity (e.g. a dev tool's app id) — per-instance state, not a protocol.
 *
 * Exported for host surfaces that own MULTIPLE panels of one page (the
 * dev-tool details pages); FrameworkProvider's singleton panel uses it too.
 */
/** One webview page's HTML: which file, what identity to stamp, and any
 *  CSP/markup transform that page needs. */
export interface IRenderWebviewHtmlOptions {
	/** Path under `webview/` — e.g. 'page-frame.html', 'devtool/page-devtool.html'. */
	htmlFile: string;
	/** `data-rr-*` identity stamped on `<body>`, present before any script
	 *  runs. Keys are the suffix: `{ page: 'account' }` -> `data-rr-page`. */
	stamps?: Record<string, string | undefined>;
	/** Stamped as `data-rr-args` (JSON) for pages that open with an identity. */
	args?: unknown;
	/** Applied AFTER placeholder substitution, BEFORE asset rewriting — the
	 *  seam for per-page CSP (Stripe's meta, the dev-tool engine origin). */
	transform?: (html: string) => string;
}

/** HTML-escapes a value destined for an attribute. */
function escAttr(v: string): string {
	return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * THE webview HTML pipeline — one implementation for every page.
 *
 * Reads the built HTML, substitutes `{{nonce}}`/`{{cspSource}}`, stamps the
 * page's identity onto `<body>` (present before any script runs — no
 * handshake), applies the page's optional transform, and rewrites emitted
 * `/static/...` asset URLs to webview URIs resolved against the HTML file's
 * own directory.
 *
 * Every host surface uses this: PipelineProvider, AppScreenProvider,
 * DevToolPanelProvider and FrameworkProvider. Hand-rolling a fifth copy is
 * how the nonce, the CSP and the asset rewriting drift apart.
 */
export function renderWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview, opts: IRenderWebviewHtmlOptions): string {
	const nonce = crypto.randomBytes(32).toString('base64url');
	const parts = opts.htmlFile.split('/');
	const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'webview', ...parts);
	// Assets resolve against the HTML's OWN directory: the dev-tool build
	// emits into webview/devtool/, the rest into webview/.
	const assetDir = parts.slice(0, -1);

	let html: string;
	try {
		html = readFileSync(htmlPath.fsPath, 'utf8');
	} catch (error) {
		return `<!DOCTYPE html><html><body style="padding:20px;color:var(--vscode-errorForeground)">
			<h3>Could not load ${escAttr(opts.htmlFile)}</h3>
			<p>Reload the window; if it persists the extension build is incomplete.</p>
			<pre>${escAttr(String(error))}</pre></body></html>`;
	}

	html = html.replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, webview.cspSource);

	const stamps = Object.entries(opts.stamps ?? {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` data-rr-${k}="${escAttr(String(v))}"`)
		.join('');
	const argsAttr = opts.args === undefined ? '' : ` data-rr-args="${escAttr(JSON.stringify(opts.args))}"`;
	if (stamps || argsAttr) html = html.replace('<body', `<body${stamps}${argsAttr}`);

	if (opts.transform) html = opts.transform(html);

	return html.replace(/(?:src|href)="(\.?\/?static\/[^"]+)"/g, (match: string, rel: string): string => {
		const clean = rel.replace(/^\.?\//, '');
		const uri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', ...assetDir, clean));
		return match.replace(rel, uri.toString());
	});
}

/**
 * A framework page's HTML — the ONE page-frame bundle, stamped with which
 * page to mount. Thin wrapper over {@link renderWebviewHtml}.
 */
export function renderPageFrameHtml(context: vscode.ExtensionContext, webview: vscode.Webview, page: string, args?: unknown): string {
	return renderWebviewHtml(context, webview, { htmlFile: FRAME_HTML, stamps: { page }, ...(args !== undefined ? { args } : {}) });
}

/** One framework page's wiring. */
export interface IFrameworkProviderOptions {
	/** The page's registry name — stamped into the served HTML and resolved
	 *  by the page-frame bundle's compiled-in component registry. Also the
	 *  name `host.openPage` routes by. */
	page: string;
	/** The open command id (e.g. 'rocketride.page.account.open'). */
	command: string;
	/** The panel viewType (e.g. 'rocketride.page.account'). */
	viewType: string;
	/** The panel tab title. */
	title: string;
	/** Optional hook fired on every command invocation (open AND reveal)
	 *  with the command's arguments — e.g. the Environment page's
	 *  missing-keys prefill. */
	onOpen?: (args: unknown[]) => void;
	/** Optional hook fired when the panel goes away. `userClosed` is true
	 *  for a user exit (tab X, host.closePage) and false when the host is
	 *  shutting down — pages that treat closing as a decision (Welcome's
	 *  dismissal, Settings' staged-credential discard) need the difference. */
	onClose?: (userClosed: boolean) => void;
	/** MULTI-INSTANCE pages (one panel per identity — e.g. the dev-tool
	 *  details pages, one per app id): derives the panel key from the open
	 *  command's arguments. '' IGNORES the open (invalid identity). Absent =
	 *  the page is a singleton. */
	instanceKey?: (args: unknown[]) => string;
	/** Per-instance tab title (multi-instance pages); falls back to `title`. */
	instanceTitle?: (args: unknown[]) => string | undefined;
	/** Per-instance stamped args (`data-rr-args`) — the page's identity,
	 *  readable before any script runs. */
	instanceArgs?: (args: unknown[]) => unknown;
}

/**
 * Hosts one framework page: command → panel(s) → bus realm. All pages serve
 * the SAME page-frame bundle; only the stamped name (and, for multi-instance
 * pages, the stamped args) differ. A page is a SINGLETON unless its options
 * derive an `instanceKey` from the open arguments — then one panel exists
 * per key (e.g. the dev-tool details pages, one per app id).
 */
export class FrameworkProvider {
	/** page name → surface — the `host.openPage`/`host.closePage` directory
	 *  (self-registered). */
	private static readonly directory = new Map<string, { open: (args: unknown[]) => void; close: () => void }>();

	/** Opens a page by registry name. @returns False for an unknown page. */
	public static openPage(page: string, args: unknown[] = []): boolean {
		const entry = FrameworkProvider.directory.get(page);
		if (!entry) return false;
		entry.open(args);
		return true;
	}

	/** Closes a page's panel(s) if open. @returns False for an unknown page. */
	public static closePage(page: string): boolean {
		const entry = FrameworkProvider.directory.get(page);
		if (!entry) return false;
		entry.close();
		return true;
	}

	/** Open panels by instance key ('' = the singleton). */
	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private disposables: vscode.Disposable[] = [];
	/** True while THIS provider is being disposed (host shutdown) — the
	 *  panels' dispose then is not a user exit. */
	private shuttingDown = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly busHost: BusHost,
		private readonly options: IFrameworkProviderOptions
	) {
		const open = (args: unknown[]): void => {
			options.onOpen?.(args);
			this.show(args);
		};
		const cmd = vscode.commands.registerCommand(options.command, (...args: unknown[]) => open(args));
		FrameworkProvider.directory.set(options.page, {
			open,
			close: () => {
				for (const panel of [...this.panels.values()]) panel.dispose();
			},
		});
		this.disposables.push(cmd, { dispose: () => FrameworkProvider.directory.delete(options.page) });
		context.subscriptions.push(cmd);
	}

	/** Opens (or reveals) the page's webview panel for the given open args. */
	public show(args: unknown[] = []): void {
		// '' is the singleton key; for multi-instance pages an empty derived
		// key means the open carried no identity — ignore it.
		const key = this.options.instanceKey ? this.options.instanceKey(args) : '';
		if (this.options.instanceKey && !key) return;

		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		const title = (key ? this.options.instanceTitle?.(args) : undefined) ?? this.options.title;
		const panel = vscode.window.createWebviewPanel(this.options.viewType, title, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [this.context.extensionUri],
		});
		this.panels.set(key, panel);
		panel.webview.html = this.getHtmlForWebview(panel.webview, this.options.instanceArgs?.(args));

		// The page is a bus realm — ALL its traffic rides the `__rrbus`
		// envelope; there is no page-specific postMessage protocol.
		const detachRealm = this.busHost.attachWebview(panel.webview, key ? `page:${this.options.page}/${key}` : `page:${this.options.page}`);

		panel.onDidDispose(() => {
			detachRealm();
			if (this.panels.get(key) === panel) this.panels.delete(key);
			this.options.onClose?.(!this.shuttingDown);
		});
	}

	/** Serves the shared frame, falling back to a readable error page. */
	private getHtmlForWebview(webview: vscode.Webview, args?: unknown): string {
		try {
			return renderPageFrameHtml(this.context, webview, this.options.page, args);
		} catch (error) {
			return `<!DOCTYPE html>
            <html><body style="padding:20px;color:#f44336;">
                <h3>Error Loading ${this.options.title} Page</h3>
                <p>${error}</p>
                <p>Run <code>pnpm run build:webview</code> to build the webview.</p>
            </body></html>`;
		}
	}

	/** Disposes the command registration and closes every open panel. */
	public dispose(): void {
		this.shuttingDown = true;
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const panel of [...this.panels.values()]) panel.dispose();
		this.panels.clear();
	}
}
