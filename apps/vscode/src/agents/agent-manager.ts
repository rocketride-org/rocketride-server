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
 * agent-manager.ts - VS Code adapter over @rocketride/agents-core
 *
 * Holds only vscode-specific concerns:
 *   - IDE detection (vscode.env.appName / vscode.extensions / ~/.claude probe)
 *   - reading rocketride.integrations.* settings
 *   - an output-channel Logger
 *   - Uri -> string path conversion and the bundled-docs path
 *
 * All file operations are delegated to @rocketride/agents-core, the single
 * source of truth shared with the CLI (`rocketride init`).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager as CoreAgentManager, type Logger, type ResourceBundle } from '@rocketride/agents-core';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { detectAgentNames, mergeSelectedAgents } from './detection';

/** Map from agent display name to its VS Code config key under rocketride.integrations.* */
const INTEGRATION_CONFIG_KEYS: Record<string, string> = {
	Cursor: 'integrations.cursor',
	'Claude Code': 'integrations.claudeCode',
	Windsurf: 'integrations.windsurf',
	Copilot: 'integrations.copilot',
	'CLAUDE.md': 'integrations.claudeMd',
	'AGENTS.md': 'integrations.agentsMd',
};

export class AgentManager {
	private readonly core = new CoreAgentManager();

	/** Output-channel-backed logger passed into core. */
	private logger(): Logger {
		const out = getLogger();
		return (message: string) => out.output(`${icons.info} ${message}`);
	}

	/** Resolve the docs/stubs bundle shipped inside the vsix (built into <extensionPath>/docs). */
	private bundle(extensionPath: string): ResourceBundle {
		const docsDir = path.join(extensionPath, 'docs');
		return { docsDir, stubsDir: path.join(docsDir, 'stubs') };
	}

	/** All supported agent names (proxied from core). */
	get supportedAgents(): string[] {
		return this.core.supportedAgents;
	}

	/**
	 * Detect which coding agents are present based on the IDE environment.
	 * Returns agent name strings (the installers themselves live in core).
	 */
	async detectEnvironment(): Promise<string[]> {
		const hasClaudeExtension = !!vscode.extensions.getExtension('anthropic.claude-code');
		const hasClaudeCli = hasClaudeExtension ? false : await this.isClaudeCliInstalled();
		return detectAgentNames({
			appName: vscode.env.appName,
			hasClaudeExtension,
			hasClaudeCli,
		});
	}

	private async isClaudeCliInstalled(): Promise<boolean> {
		try {
			const homeDir = process.env.HOME || process.env.USERPROFILE || '';
			await fs.promises.access(path.join(homeDir, '.claude'));
			return true;
		} catch {
			return false;
		}
	}

	/** Names currently checked in rocketride.integrations.* settings. */
	private settingsCheckedAgents(): string[] {
		const config = vscode.workspace.getConfiguration('rocketride');
		return Object.entries(INTEGRATION_CONFIG_KEYS)
			.filter(([, configKey]) => config.get<boolean>(configKey, false))
			.map(([name]) => name);
	}

	/**
	 * Startup install: auto-detected agents (when autoAgentIntegration is on)
	 * unioned with individually-checked integration settings.
	 */
	async autoInstall(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const config = vscode.workspace.getConfiguration('rocketride');
		const autoDetect = config.get<boolean>('integrations.autoAgentIntegration', true);

		const detected = autoDetect ? await this.detectEnvironment() : [];
		const names = mergeSelectedAgents(detected, this.settingsCheckedAgents());
		if (names.length === 0) {
			return;
		}

		await this.core.installFromList(names, this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
		getLogger().output(`${icons.info} Agent stubs installed: ${names.join(', ')}`);
	}

	/** Install docs + every supported agent stub. */
	async installAll(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		await this.core.installAll(this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
	}

	/** Install stubs for integrations currently checked in settings. */
	async installFromSettings(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const names = this.settingsCheckedAgents();
		if (names.length === 0) {
			return;
		}
		await this.core.installFromList(names, this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
	}

	/** Remove all agent stubs and the .rocketride docs/schema/catalog. */
	async uninstallAll(workspaceRoot: vscode.Uri): Promise<void> {
		await this.core.uninstallAll(workspaceRoot.fsPath, this.logger());
	}
}
