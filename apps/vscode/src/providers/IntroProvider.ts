// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Intro Page Provider — the embedded "Introduction to ..." documents.
 *
 * Opens one editor-area WebviewPanel per sidebar mode (apps / nodes /
 * pipelines) showing the mode's introduction page. The page ships INSIDE the
 * extension bundle (shared/modules/intro) as a complete standalone HTML
 * document — no webview build, no local resources, no scripts — so the
 * panel's html is assigned directly from the embedded string.
 */

import * as vscode from 'vscode';
import { INTRO_PAGES } from 'shared/modules/intro/introPages';
import type { IntroMode } from 'shared/modules/intro/introPages';

export class IntroProvider {
	/** Open panels keyed by mode — reopening a mode reveals its panel. */
	private panels = new Map<IntroMode, vscode.WebviewPanel>();
	private disposables: vscode.Disposable[] = [];

	constructor(private context: vscode.ExtensionContext) {
		this.registerCommands();
	}

	// =========================================================================
	// Commands
	// =========================================================================

	private registerCommands(): void {
		const cmd = vscode.commands.registerCommand('rocketride.page.intro.open', (mode: IntroMode) => {
			this.show(mode);
		});
		this.disposables.push(cmd);
		this.context.subscriptions.push(cmd);
	}

	// =========================================================================
	// Show / Reveal
	// =========================================================================

	/**
	 * Opens (or reveals) the introduction panel for one sidebar mode.
	 *
	 * @param mode - The sidebar mode whose introduction to show.
	 */
	public show(mode: IntroMode): void {
		const page = INTRO_PAGES[mode];
		if (!page) return;

		// step: one panel per mode — reopening reveals instead of duplicating
		const existing = this.panels.get(mode);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		// step: static page — scripts stay disabled, no local resources needed
		const panel = vscode.window.createWebviewPanel(`rocketride.pageIntro.${mode}`, page.title, vscode.ViewColumn.One, {
			enableScripts: false,
		});
		panel.webview.html = page.html;
		this.panels.set(mode, panel);

		panel.onDidDispose(() => {
			this.panels.delete(mode);
		});
	}

	// =========================================================================
	// Disposal
	// =========================================================================

	public dispose(): void {
		this.disposables.forEach((d) => d.dispose());
		this.disposables = [];
		for (const panel of this.panels.values()) panel.dispose();
		this.panels.clear();
	}
}
