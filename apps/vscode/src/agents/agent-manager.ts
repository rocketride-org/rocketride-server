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
 *   1. Copying docs from extension bundle → .rocketride/docs/
 *   2. Ensuring .rocketride/ is in .gitignore
 *   3. Detecting which coding agents are present
 *   4. Delegating to per-agent installers
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { BaseAgentInstaller } from './base-installer';
import { CursorInstaller } from './cursor-installer';
import { ClaudeCodeInstaller } from './claude-code-installer';
import { WindsurfInstaller } from './windsurf-installer';
import { CopilotInstaller } from './copilot-installer';
import { ClaudeMdInstaller } from './claude-md-installer';
import { AgentsMdInstaller } from './agents-md-installer';

const DOCS_DIR = '.rocketride/docs';
const GITIGNORE_ENTRY = '.rocketride/';

/** Doc files shipped in the extension's docs/ directory. */
const DOC_FILES = ['ROCKETRIDE_README.md', 'ROCKETRIDE_QUICKSTART.md', 'ROCKETRIDE_PIPELINE_RULES.md', 'ROCKETRIDE_COMPONENT_REFERENCE.md', 'ROCKETRIDE_COMMON_MISTAKES.md', 'ROCKETRIDE_python_API.md', 'ROCKETRIDE_typescript_API.md'];

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
	async autoInstall(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const logger = getLogger();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
		const autoDetect = workspaceConfig.get<boolean>('integrations.autoAgentIntegration', true);

		// Track which installers have already been run so we don't double-install
		const installed = new Set<string>();
		let workspacePrepared = false;

		// Helper: ensure docs + gitignore are set up before first install
		const prepareWorkspace = async () => {
			if (workspacePrepared) return;
			await this.installDocs(extensionPath, workspaceRoot);
			await this.ensureGitignore(workspaceRoot);
			workspacePrepared = true;
		};

		// Pass 1: auto-detect
		if (autoDetect) {
			const detected = await this.detectEnvironment();
			if (detected.length > 0) {
				await prepareWorkspace();
				for (const installer of detected) {
					const ok = await this.runInstaller(installer, extensionPath, workspaceRoot);
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
				const ok = await this.runInstaller(installer, extensionPath, workspaceRoot);
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
	async installAll(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		await this.installDocs(extensionPath, workspaceRoot);
		await this.ensureGitignore(workspaceRoot);

		for (const installer of this.installers) {
			await this.runInstaller(installer, extensionPath, workspaceRoot);
		}
	}

	/**
	 * Called when integration settings are saved. Installs stubs for any
	 * integration that is currently checked in settings.
	 */
	async installFromSettings(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
		let anyInstalled = false;

		for (const installer of this.installers) {
			const configKey = INTEGRATION_CONFIG_KEYS[installer.name];
			if (configKey && workspaceConfig.get<boolean>(configKey, false)) {
				if (!anyInstalled) {
					// Only sync docs + gitignore if we actually have something to install
					await this.installDocs(extensionPath, workspaceRoot);
					await this.ensureGitignore(workspaceRoot);
					anyInstalled = true;
				}
				await this.runInstaller(installer, extensionPath, workspaceRoot);
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
	 * Sync documentation files from the extension bundle into .rocketride/docs/.
	 * - Adds missing files
	 * - Updates files whose content has changed
	 * - Removes files in the target that are not in the source (obsolete)
	 */
	async installDocs(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const logger = getLogger();
		const targetDir = vscode.Uri.joinPath(workspaceRoot, DOCS_DIR);
		await vscode.workspace.fs.createDirectory(targetDir);

		const sourceDir = `${extensionPath}/docs`;
		const expectedFiles = new Set(DOC_FILES);

		// Add or update files from the source
		for (const file of DOC_FILES) {
			const sourceUri = vscode.Uri.file(`${sourceDir}/${file}`);
			const targetUri = vscode.Uri.joinPath(targetDir, file);

			try {
				const sourceContent = await vscode.workspace.fs.readFile(sourceUri);

				// Only write if content differs or file is missing
				let needsWrite = true;
				try {
					const targetContent = await vscode.workspace.fs.readFile(targetUri);
					// Normalize line endings so \r\n vs \n doesn't trigger a false write
					const sourceStr = Buffer.from(sourceContent).toString('utf8').replace(/\r\n/g, '\n');
					const targetStr = Buffer.from(targetContent).toString('utf8').replace(/\r\n/g, '\n');
					needsWrite = sourceStr !== targetStr;
				} catch {
					// Target doesn't exist — needs write
				}

				if (needsWrite) {
					await vscode.workspace.fs.writeFile(targetUri, sourceContent);
					logger.output(`${icons.info} Synced ${file}`);
				}
			} catch (err) {
				logger.output(`${icons.warning} Could not sync ${file}: ${err}`);
			}
		}

		// Remove obsolete files in the target that are not in the source
		try {
			const entries = await vscode.workspace.fs.readDirectory(targetDir);
			for (const [name, type] of entries) {
				if (type === vscode.FileType.File && !expectedFiles.has(name)) {
					const obsoleteUri = vscode.Uri.joinPath(targetDir, name);
					await vscode.workspace.fs.delete(obsoleteUri);
					logger.output(`${icons.info} Removed obsolete doc: ${name}`);
				}
			}
		} catch {
			// Directory listing failed — likely first install, nothing to clean
		}

		logger.output(`${icons.info} Documentation synced to ${DOCS_DIR}`);
	}

	/**
	 * Ensure .rocketride/ is listed in .gitignore.
	 * Creates .gitignore if it doesn't exist. Appends if entry is missing.
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

		// Check if already present (exact line match)
		const lines = content.split('\n');
		if (lines.some((line) => line.trim() === GITIGNORE_ENTRY)) {
			return;
		}

		const newContent = content.trimEnd() + (content ? '\n' : '') + GITIGNORE_ENTRY + '\n';
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

	private async runInstaller(installer: BaseAgentInstaller, extensionPath: string, workspaceRoot: vscode.Uri): Promise<boolean> {
		const logger = getLogger();
		try {
			await installer.install(extensionPath, workspaceRoot);
			logger.output(`${icons.info} Installed ${installer.name} agent stub → ${installer.stubTarget}`);
			return true;
		} catch (err) {
			logger.output(`${icons.warning} Failed to install ${installer.name} agent stub: ${err}`);
			return false;
		}
	}
}
