// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * HtmlPageProvider — the framework's generic "open an HTML page" surface.
 *
 * ONE provider for every static content page: given a key, a title, and a
 * complete standalone HTML document, it opens (or reveals) a scriptless
 * webview panel showing it. The framework never knows what a page is about;
 * content ships with whoever asks (a builtin tool's intro.ts, a store
 * tool's docs, …).
 *
 * Commands:
 *   rocketride.page.intro.open (mode) — resolves the builtin tools' intro
 *     catalog and opens the page generically.
 *
 * Interactive pages (account, settings, tool readmes) are NOT this —
 * scripts stay disabled here by design.
 */

import * as vscode from 'vscode';
import { INTRO_PAGES } from 'shared/tools/introCatalog';
import type { IntroMode } from 'shared/tools/introCatalog';

export class HtmlPageProvider {
	/** Open panels by page key — reopening reveals instead of duplicating. */
	private panels = new Map<string, vscode.WebviewPanel>();

	private disposables: vscode.Disposable[] = [];

	constructor(private context: vscode.ExtensionContext) {
		const intro = vscode.commands.registerCommand('rocketride.page.intro.open', (mode?: IntroMode) => {
			const page = mode ? INTRO_PAGES[mode] : undefined;
			if (mode && page) this.show(`intro:${mode}`, page.title, page.html);
		});
		this.disposables.push(intro);
		this.context.subscriptions.push(intro);
	}

	/**
	 * Opens (or reveals) one content page.
	 *
	 * @param key - Stable page identity (panel dedupe key).
	 * @param title - Tab title.
	 * @param html - The complete standalone HTML document.
	 */
	private show(key: string, title: string, html: string): void {
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}
		// Static content — scripts stay disabled, no local resources needed.
		const panel = vscode.window.createWebviewPanel(`rocketride.page.html.${key}`, title, vscode.ViewColumn.One, {
			enableScripts: false,
		});
		panel.webview.html = html;
		this.panels.set(key, panel);
		panel.onDidDispose(() => {
			this.panels.delete(key);
		});
	}

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const panel of this.panels.values()) panel.dispose();
		this.panels.clear();
	}
}
