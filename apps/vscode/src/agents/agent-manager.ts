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
 * agent-manager.ts - Agent Documentation Installer Orchestrator
 *
 * Coordinates installing RocketRide documentation and agent stubs into
 * user workspaces. Handles:
 *   1. Downloading the agent docs bundle from the connected server
 *      (GET /client/docs) → .rocketride/docs/ (docs at the root, stubs
 *      under stubs/), hash-stamped so unchanged bundles are a no-op
 *   2. Ensuring .rocketride/ and .env are in .gitignore
 *   3. Detecting which coding agents are present
 *   4. Delegating to per-agent installers (stubs come from the
 *      downloaded bundle, so they always match the connected server)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConnectionManager } from '../connection/connection';
import { installDocsBundle, toHttpBase } from '../../../../packages/client-common/typescript/src/provision';
import { BaseAgentInstaller } from './base-installer';
import { CursorInstaller } from './cursor-installer';
import { ClaudeCodeInstaller } from './claude-code-installer';
import { WindsurfInstaller } from './windsurf-installer';
import { CopilotInstaller } from './copilot-installer';
import { ClaudeMdInstaller } from './claude-md-installer';
import { AgentsMdInstaller } from './agents-md-installer';
import { appendGitignoreEntries } from '../shared/util/gitignoreEntries';

const DOCS_DIR = '.rocketride/docs';
/**
 * Entries the extension keeps in the workspace `.gitignore`.
 *
 * `.env` is here because connecting to a self-hosted engine writes a real
 * `ROCKETRIDE_APIKEY` into it (see `Connection.syncEnvFile`), so a fresh
 * project would otherwise be one `git add .` away from committing a live key.
 * The pattern is the exact name, so a committed `.env.example` is unaffected.
 */
const GITIGNORE_ENTRIES = ['.rocketride/', '.env'] as const;

/** Map from installer name to the VS Code config key under rocketride.integrations.* */
const INTEGRATION_CONFIG_KEYS: Record<string, string> = {
	Cursor: 'integrations.cursor',
	'Claude Code': 'integrations.claudeCode',
	Windsurf: 'integrations.windsurf',
	Copilot: 'integrations.copilot',
	'CLAUDE.md': 'integrations.claudeMd',
	'AGENTS.md': 'integrations.agentsMd',
};

export class AgentManager {
	private readonly installers: BaseAgentInstaller[] = [new CursorInstaller(), new ClaudeCodeInstaller(), new WindsurfInstaller(), new CopilotInstaller(), new ClaudeMdInstaller(), new AgentsMdInstaller()];

	/**
	 * Run on startup. Two passes:
	 *
	 * Pass 1 (auto-detect): If autoAgentIntegration is enabled, detect the
	 *   environment and install stubs for everything that is detected.
	 *
	 * Pass 2 (manual settings): For each individual integration checkbox that
	 *   is checked, install that stub if it wasn't already covered by Pass 1.
	 */
	async autoInstall(workspaceRoot: vscode.Uri): Promise<void> {
		const logger = getLogger();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
		const autoDetect = workspaceConfig.get<boolean>('integrations.autoAgentIntegration', true);

		// Track which installers have already been run so we don't double-install
		const installed = new Set<string>();
		let workspacePrepared = false;

		// Helper: ensure docs + gitignore are set up before first install
		const prepareWorkspace = async () => {
			if (workspacePrepared) return;
			await this.installDocs(workspaceRoot);
			await this.ensureGitignore(workspaceRoot);
			workspacePrepared = true;
		};

		// Pass 1: auto-detect
		if (autoDetect) {
			const detected = await this.detectEnvironment();
			if (detected.length > 0) {
				await prepareWorkspace();
				for (const installer of detected) {
					const ok = await this.runInstaller(installer, workspaceRoot);
					if (ok) installed.add(installer.name);
				}
			}
		}

		// Pass 2: individual settings — install any that are checked but not yet installed
		for (const installer of this.installers) {
			if (installed.has(installer.name)) continue;

			const configKey = INTEGRATION_CONFIG_KEYS[installer.name];
			if (configKey && workspaceConfig.get<boolean>(configKey, false)) {
				await prepareWorkspace();
				const ok = await this.runInstaller(installer, workspaceRoot);
				if (ok) installed.add(installer.name);
			}
		}

		if (installed.size > 0) {
			logger.output(`${icons.info} Agent stubs installed: ${[...installed].join(', ')}`);
		}
	}

	/**
	 * Detect which coding agents are running based on the IDE environment.
	 */
	async detectEnvironment(): Promise<BaseAgentInstaller[]> {
		const detected: BaseAgentInstaller[] = [];
		const appName = vscode.env.appName.toLowerCase();
		const byName = (name: string) => this.installers.find((i) => i.name === name)!;

		// Cursor IDE
		if (appName.includes('cursor')) {
			detected.push(byName('Cursor'));
		}

		// Windsurf IDE
		if (appName.includes('windsurf')) {
			detected.push(byName('Windsurf'));
		}

		// Standard VS Code → install Copilot (the built-in agent)
		if (appName.includes('visual studio code') || appName === 'code') {
			detected.push(byName('Copilot'));
		}

		// Claude Code: check VS Code extension first, then CLI config dir
		const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
		if (claudeExtension) {
			detected.push(byName('Claude Code'));
		} else {
			const hasCli = await this.isClaudeCliInstalled();
			if (hasCli) {
				detected.push(byName('Claude Code'));
			}
		}

		return detected;
	}

	/**
	 * Check if Claude Code CLI has been used by looking for its config directory (~/.claude).
	 */
	private async isClaudeCliInstalled(): Promise<boolean> {
		try {
			const homeDir = process.env.HOME || process.env.USERPROFILE || '';
			const claudeDir = path.join(homeDir, '.claude');
			await fs.promises.access(claudeDir);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Install docs + stubs for all detected agents in the workspace.
	 */
	async installAll(workspaceRoot: vscode.Uri): Promise<void> {
		await this.installDocs(workspaceRoot);
		await this.ensureGitignore(workspaceRoot);

		for (const installer of this.installers) {
			await this.runInstaller(installer, workspaceRoot);
		}
	}

	/**
	 * Called when integration settings are saved. Installs stubs for any
	 * integration that is currently checked in settings.
	 */
	async installFromSettings(workspaceRoot: vscode.Uri): Promise<void> {
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
		let anyInstalled = false;

		for (const installer of this.installers) {
			const configKey = INTEGRATION_CONFIG_KEYS[installer.name];
			if (configKey && workspaceConfig.get<boolean>(configKey, false)) {
				if (!anyInstalled) {
					// Only sync docs + gitignore if we actually have something to install
					await this.installDocs(workspaceRoot);
					await this.ensureGitignore(workspaceRoot);
					anyInstalled = true;
				}
				await this.runInstaller(installer, workspaceRoot);
			}
		}
	}

	/**
	 * Uninstall stubs for all agents in the workspace.
	 */
	async uninstallAll(workspaceRoot: vscode.Uri): Promise<void> {
		const logger = getLogger();

		for (const installer of this.installers) {
			const removed = await installer.uninstall(workspaceRoot);
			if (removed) {
				logger.output(`${icons.info} Removed ${installer.name} agent stub`);
			}
		}

		// Remove .rocketride/docs/ directory
		const docsUri = vscode.Uri.joinPath(workspaceRoot, DOCS_DIR);
		try {
			await vscode.workspace.fs.delete(docsUri, { recursive: true });
			logger.output(`${icons.info} Removed ${DOCS_DIR}`);
		} catch {
			// Directory doesn't exist — nothing to do
		}

		// Remove .rocketride/schema/ directory
		const schemaUri = vscode.Uri.joinPath(workspaceRoot, '.rocketride', 'schema');
		try {
			await vscode.workspace.fs.delete(schemaUri, { recursive: true });
			logger.output(`${icons.info} Removed .rocketride/schema`);
		} catch {
			// Directory doesn't exist — nothing to do
		}

		// Remove .rocketride/services-catalog.json
		const catalogUri = vscode.Uri.joinPath(workspaceRoot, '.rocketride', 'services-catalog.json');
		try {
			await vscode.workspace.fs.delete(catalogUri);
			logger.output(`${icons.info} Removed .rocketride/services-catalog.json`);
		} catch {
			// File doesn't exist — nothing to do
		}
	}

	/**
	 * Sync the agent docs bundle from the connected server into
	 * .rocketride/docs/.
	 *
	 * Downloads GET /client/docs (docs.zip), compares its manifest hash
	 * to the workspace stamp, and on change deletes every ROCKETRIDE_*
	 * doc before unpacking the new set — renamed/retired docs cannot
	 * linger, while non-matching files a user added survive. Stubs land
	 * under .rocketride/docs/stubs/, where the per-agent installers read
	 * them.
	 *
	 * Non-fatal by design: with no reachable server the existing
	 * workspace docs are kept untouched and the sync re-runs on the next
	 * connect.
	 */
	async installDocs(workspaceRoot: vscode.Uri): Promise<void> {
		const logger = getLogger();

		// step: the connected server is the only docs source — no bundle copy
		const baseUrl = ConnectionManager.getInstance().getHttpUrl?.() || '';
		if (!baseUrl) {
			logger.output(`${icons.info} Not connected — agent docs sync deferred to the next connect`);
			return;
		}

		// step: shared install (sweep + stamp + unpack) from client-common —
		// the exact code the CLI's `rocketride init` runs. Non-fatal: with
		// an unreachable bundle the existing workspace docs are kept.
		try {
			await installDocsBundle(workspaceRoot.fsPath, toHttpBase(baseUrl), (line) => logger.output(`${icons.info} ${line}`));
		} catch (err) {
			logger.output(`${icons.warning} Agent docs sync failed: ${err} — keeping existing docs`);
		}
	}

	/**
	 * Ensure every entry in GITIGNORE_ENTRIES is listed in .gitignore.
	 * Creates .gitignore if it doesn't exist. Appends only the missing entries,
	 * so an entry the user already covers is never duplicated.
	 */
	async ensureGitignore(workspaceRoot: vscode.Uri): Promise<void> {
		const gitignoreUri = vscode.Uri.joinPath(workspaceRoot, '.gitignore');
		let content = '';

		try {
			const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
			content = Buffer.from(bytes).toString('utf8');
		} catch {
			// .gitignore doesn't exist — will create
		}

		const newContent = appendGitignoreEntries(content, GITIGNORE_ENTRIES);
		if (newContent === null) {
			return;
		}

		await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent, 'utf8'));
	}

	/**
	 * Detect which coding agents have configuration directories in the workspace.
	 * Returns the matching installers.
	 */
	/**
	 * Get the list of all supported agent names.
	 */
	get supportedAgents(): string[] {
		return this.installers.map((i) => i.name);
	}

	private async runInstaller(installer: BaseAgentInstaller, workspaceRoot: vscode.Uri): Promise<boolean> {
		const logger = getLogger();
		try {
			await installer.install(workspaceRoot);
			logger.output(`${icons.info} Installed ${installer.name} agent stub → ${installer.stubTarget}`);
			return true;
		} catch (err) {
			logger.output(`${icons.warning} Failed to install ${installer.name} agent stub: ${err}`);
			return false;
		}
	}
}
