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
 * mcp-provider.ts - Auto-configures the rocketride-mcp server for any IDE
 *
 * Detects which IDE is running (VS Code, Cursor, Windsurf, etc.) and
 * configures the MCP server using the appropriate mechanism:
 *   - VS Code: programmatic registerMcpServerDefinitionProvider API
 *   - Cursor:  writes .cursor/mcp.json to workspace root
 *   - Claude Code: writes .mcp.json to workspace root
 *   - Windsurf: writes .windsurf/mcp.json to workspace root
 *   - Unknown: writes .mcp.json as a safe default
 *
 * The MCP server uses the engine binary (which embeds Python) to run the
 * rocketride_mcp module, giving AI assistants live access to the node
 * service catalog from the running engine.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

const MCP_SERVER_ID = 'rocketride-pipeline-builder';

// ---------------------------------------------------------------------------
// Engine discovery helpers
// ---------------------------------------------------------------------------

function findMcpPackagePath(engineDir: string): string | undefined {
	// 1. Already installed in site-packages (production)
	//    Glob for any python3.* version to avoid hardcoding the Python version.
	const libDir = path.join(engineDir, 'lib');
	if (fs.existsSync(libDir)) {
		const pythonDirs = fs.readdirSync(libDir).filter(d => d.startsWith('python3.'));
		for (const pyDir of pythonDirs) {
			const sitePackages = path.join(libDir, pyDir, 'site-packages', 'rocketride_mcp');
			if (fs.existsSync(sitePackages)) {
				return path.join(libDir, pyDir, 'site-packages');
			}
		}
	}

	// 2. Source directory in the repo (development)
	const repoRoot = path.resolve(engineDir, '..', '..');
	const srcDir = path.join(repoRoot, 'packages', 'client-mcp', 'src');
	if (fs.existsSync(path.join(srcDir, 'rocketride_mcp'))) {
		return srcDir;
	}

	// 3. Wheel file in static/clients/mcp/ (bundled but not installed)
	const mcpClientDir = path.join(engineDir, 'static', 'clients', 'mcp');
	if (fs.existsSync(mcpClientDir)) {
		const files = fs.readdirSync(mcpClientDir).filter(f => f.endsWith('.whl')).sort().reverse();
		if (files.length > 0) {
			return path.join(mcpClientDir, files[0]);
		}
	}

	return undefined;
}

function findEngineDir(extensionPath: string): string | undefined {
	const candidates = [
		path.join(extensionPath, 'engine'),
	];

	const workspaceRoot = path.resolve(extensionPath, '..', '..');
	candidates.push(path.join(workspaceRoot, 'dist', 'server'));

	const exeName = process.platform === 'win32' ? 'engine.exe' : 'engine';
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, exeName))) {
			return dir;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// MCP config file writers (Cursor, Claude Code, Windsurf, etc.)
// ---------------------------------------------------------------------------

interface McpServerConfig {
	command: string;
	args: string[];
	env: Record<string, string>;
}

function buildMcpServerConfig(engineDir: string, config: ReturnType<ConfigManager['getConfig']>): McpServerConfig | undefined {
	const engineExe = process.platform === 'win32'
		? path.join(engineDir, 'engine.exe')
		: path.join(engineDir, 'engine');

	const mcpPath = findMcpPackagePath(engineDir);
	if (!mcpPath) {
		return undefined;
	}

	const env: Record<string, string> = {
		ROCKETRIDE_URI: config.hostUrl,
	};
	if (config.apiKey) {
		env['ROCKETRIDE_APIKEY'] = config.apiKey;
	}

	// The engine binary embeds Python but ignores PYTHONPATH.
	// Use -c with a sys.path insert to bootstrap the MCP module.
	const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(mcpPath)}); from rocketride_mcp.server import main; main()`;

	return {
		command: engineExe,
		args: ['-c', bootstrap],
		env,
	};
}

/**
 * Writes or updates an MCP config JSON file for tools that use file-based
 * MCP server discovery (Cursor, Claude Code, Windsurf).
 *
 * Only touches the "rocketride" key — leaves all other servers intact.
 */
function writeMcpConfigFile(filePath: string, serverConfig: McpServerConfig): void {
	const logger = getLogger();

	let existing: Record<string, unknown> = {};
	if (fs.existsSync(filePath)) {
		try {
			existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		} catch {
			// Malformed JSON — overwrite with fresh config
			existing = {};
		}
	}

	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const mcpServers = (typeof existing.mcpServers === 'object' && existing.mcpServers !== null)
		? existing.mcpServers as Record<string, unknown>
		: {};

	mcpServers['rocketride'] = {
		command: serverConfig.command,
		args: serverConfig.args,
		env: serverConfig.env,
	};

	existing.mcpServers = mcpServers;

	fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
	logger.output(`${icons.success} Wrote MCP config to ${filePath}`);
}

/**
 * Returns the workspace root folder path, or undefined if no workspace is open.
 */
function getWorkspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}
	return folders[0].uri.fsPath;
}

// ---------------------------------------------------------------------------
// IDE detection and dispatch
// ---------------------------------------------------------------------------

type IdeType = 'vscode' | 'cursor' | 'windsurf' | 'unknown';

function detectIde(): IdeType {
	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes('cursor')) {
		return 'cursor';
	}
	if (appName.includes('windsurf')) {
		return 'windsurf';
	}
	if (appName.includes('visual studio code') || appName.includes('vs code') || appName.includes('vscode')) {
		return 'vscode';
	}
	return 'unknown';
}

/**
 * Writes the MCP config file for file-based IDE tools.
 * Called on activation and whenever connection config changes.
 */
function writeMcpConfigForIde(
	ide: IdeType,
	serverConfig: McpServerConfig,
): void {
	const logger = getLogger();
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		logger.output(`${icons.info} No workspace open — skipping MCP config file`);
		return;
	}

	const targets: string[] = [];

	switch (ide) {
		case 'cursor':
			targets.push(path.join(workspaceRoot, '.cursor', 'mcp.json'));
			break;
		case 'windsurf':
			targets.push(path.join(workspaceRoot, '.windsurf', 'mcp.json'));
			break;
		case 'unknown':
			// Write both common formats as a safe default
			targets.push(path.join(workspaceRoot, '.mcp.json'));
			break;
		// 'vscode' uses the programmatic API, no file needed
	}

	for (const target of targets) {
		try {
			writeMcpConfigFile(target, serverConfig);
		} catch (err) {
			logger.output(`${icons.warning} Failed to write MCP config to ${target}: ${err}`);
		}
	}
}

// ---------------------------------------------------------------------------
// VS Code programmatic registration
// ---------------------------------------------------------------------------

function registerVsCodeMcpProvider(
	context: vscode.ExtensionContext,
	engineDir: string,
): void {
	const logger = getLogger();

	if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
		logger.output(`${icons.info} MCP server provider API not available — skipping programmatic registration`);
		return;
	}

	const configManager = ConfigManager.getInstance();

	const disposable = vscode.lm.registerMcpServerDefinitionProvider(
		MCP_SERVER_ID,
		{
			provideMcpServerDefinitions(_token: vscode.CancellationToken): vscode.McpStdioServerDefinition[] {
				const config = configManager.getConfig();
				const serverConfig = buildMcpServerConfig(engineDir, config);
				if (!serverConfig) {
					return [];
				}

				return [
					new vscode.McpStdioServerDefinition(
						'RocketRide Pipeline Builder',
						serverConfig.command,
						serverConfig.args,
						serverConfig.env,
					),
				];
			},
		}
	);

	context.subscriptions.push(disposable);
	logger.output(`${icons.success} Registered MCP server provider: ${MCP_SERVER_ID}`);
}

// ---------------------------------------------------------------------------
// .rocketride/ workspace directory — IDE-agnostic agent context
// ---------------------------------------------------------------------------

const ROCKETRIDE_DIR = '.rocketride';

/**
 * Writes the bundled AGENTS.md to .rocketride/AGENTS.md in the workspace.
 * This is a static file that ships with the MCP package — no engine needed.
 */
function writeAgentsFile(mcpPackagePath: string): void {
	const logger = getLogger();
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	// Find AGENTS.md in the rocketride_mcp package directory
	const candidates = [
		path.join(mcpPackagePath, 'rocketride_mcp', 'AGENTS.md'),
		path.join(mcpPackagePath, 'AGENTS.md'),
	];

	let agentsSrc: string | undefined;
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			agentsSrc = candidate;
			break;
		}
	}

	if (!agentsSrc) {
		logger.output(`${icons.info} AGENTS.md not found in MCP package — skipping`);
		return;
	}

	const destDir = path.join(workspaceRoot, ROCKETRIDE_DIR);
	const destFile = path.join(destDir, 'AGENTS.md');
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}
	fs.copyFileSync(agentsSrc, destFile);
	logger.output(`${icons.success} Wrote ${destFile}`);
}

/**
 * Writes the live service catalog to .rocketride/services.md in the workspace.
 * Called whenever the engine's service definitions are updated.
 */
export function writeServicesFile(services: Record<string, unknown>): void {
	const logger = getLogger();
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return;
	}

	if (!services || Object.keys(services).length === 0) {
		return;
	}

	const content = formatServicesMarkdown(services);
	const destDir = path.join(workspaceRoot, ROCKETRIDE_DIR);
	const destFile = path.join(destDir, 'services.md');
	if (!fs.existsSync(destDir)) {
		fs.mkdirSync(destDir, { recursive: true });
	}
	fs.writeFileSync(destFile, content, 'utf-8');
	logger.output(`${icons.success} Wrote ${destFile}`);
}

/**
 * Formats raw engine service definitions into readable markdown for AI agents.
 */
function formatServicesMarkdown(services: Record<string, unknown>): string {
	const lines: string[] = [
		'# RocketRide Node Service Catalog (Live from Engine)',
		'',
		'This is the live service catalog from the running RocketRide engine.',
		'It reflects the exact nodes, profiles, and config fields available.',
		'',
	];

	const sorted = Object.entries(services).sort(([a], [b]) => a.localeCompare(b));
	for (const [name, rawDef] of sorted) {
		if (typeof rawDef !== 'object' || rawDef === null) {
			continue;
		}
		const def = rawDef as Record<string, unknown>;
		const title = (def.title as string) || name;
		lines.push(`## ${name} — ${title}`);

		// Description
		let desc = def.description;
		if (Array.isArray(desc)) {
			desc = desc.join('');
		}
		if (typeof desc === 'string' && desc.trim()) {
			lines.push(`  ${desc.trim()}`);
		}

		// Class type & capabilities
		const classType = def.classType as string[] | undefined;
		if (Array.isArray(classType) && classType.length) {
			lines.push(`  Type: ${classType.join(', ')}`);
		}
		const capabilities = def.capabilities as string[] | undefined;
		if (Array.isArray(capabilities) && capabilities.length) {
			lines.push(`  Capabilities: ${capabilities.join(', ')}`);
		}

		// Lanes
		const lanes = def.lanes;
		if (typeof lanes === 'object' && lanes !== null) {
			for (const [laneIn, lanesOut] of Object.entries(lanes as Record<string, unknown>)) {
				const out = Array.isArray(lanesOut) ? lanesOut.join(', ') : String(lanesOut);
				lines.push(`  Lanes: ${laneIn} → ${out}`);
			}
		}

		// Input definitions (fallback if no lanes)
		if (!lanes) {
			const inputDefs = def.input;
			if (Array.isArray(inputDefs)) {
				for (const inp of inputDefs) {
					if (typeof inp !== 'object' || inp === null) { continue; }
					const inpObj = inp as Record<string, unknown>;
					const laneIn = (inpObj.lane as string) || '?';
					const outputs = inpObj.output;
					if (Array.isArray(outputs)) {
						const outNames = outputs
							.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
							.map(o => (o.lane as string) || '?');
						if (outNames.length) {
							lines.push(`  Lanes: ${laneIn} → ${outNames.join(', ')}`);
						}
					}
				}
			}
		}

		// Profiles
		const preconfig = def.preconfig;
		if (typeof preconfig === 'object' && preconfig !== null) {
			const pc = preconfig as Record<string, unknown>;
			const defaultProfile = pc.default as string || '';
			const profiles = pc.profiles;
			if (typeof profiles === 'object' && profiles !== null) {
				const entries: string[] = [];
				for (const [pname, pdef] of Object.entries(profiles as Record<string, unknown>)) {
					let label = pname;
					if (typeof pdef === 'object' && pdef !== null) {
						const p = pdef as Record<string, unknown>;
						const parts: string[] = [];
						if (p.model) { parts.push(`model=${p.model}`); }
						if (p.modelTotalTokens) { parts.push(`tokens=${p.modelTotalTokens}`); }
						const ptitle = p.title as string | undefined;
						if (ptitle && ptitle !== pname) { parts.unshift(ptitle); }
						if (pname === defaultProfile) { label = `${pname} (default)`; }
						if (parts.length) { label = `${label} [${parts.join(', ')}]`; }
					} else if (pname === defaultProfile) {
						label = `${pname} (default)`;
					}
					entries.push(label);
				}
				if (entries.length) {
					lines.push(`  Profiles: ${entries.join('; ')}`);
				}
			}
		}

		// Config fields
		const fields = def.fields;
		if (typeof fields === 'object' && fields !== null) {
			const configFields: string[] = [];
			for (const [fieldName, fieldDef] of Object.entries(fields as Record<string, unknown>)) {
				if (typeof fieldDef !== 'object' || fieldDef === null) { continue; }
				const fd = fieldDef as Record<string, unknown>;
				if ('object' in fd || fieldName.split('.').length > 2) { continue; }
				const parts = [fieldName];
				if (fd.type) { parts.push(`(${fd.type})`); }
				const fdesc = (fd.description || fd.title) as string | undefined;
				if (fdesc) { parts.push(`: ${fdesc}`); }
				if (fd.default !== undefined) { parts.push(` [default: ${fd.default}]`); }
				configFields.push(parts.join(' '));
			}
			if (configFields.length) {
				lines.push('  Config fields:');
				for (const cf of configFields) {
					lines.push(`    - ${cf}`);
				}
			}
		}

		lines.push('');
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects the current IDE and configures the rocketride-mcp server
 * using the appropriate mechanism. Call once during extension activation.
 *
 * Also writes .rocketride/AGENTS.md immediately (static, no engine needed).
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
	const logger = getLogger();
	const ide = detectIde();
	logger.output(`${icons.info} Detected IDE: ${ide} (${vscode.env.appName})`);

	const engineDir = findEngineDir(context.extensionPath);
	if (!engineDir) {
		logger.output(`${icons.warning} Engine not found — MCP server unavailable`);
		return;
	}

	const mcpPath = findMcpPackagePath(engineDir);
	if (!mcpPath) {
		logger.output(`${icons.warning} rocketride_mcp package not found in engine — MCP server unavailable`);
		return;
	}

	// Write .rocketride/AGENTS.md immediately (static file, no engine connection needed)
	try {
		writeAgentsFile(mcpPath);
	} catch (err) {
		logger.output(`${icons.warning} Failed to write AGENTS.md: ${err}`);
	}

	// VS Code: use the programmatic API (always, even if also writing a file)
	registerVsCodeMcpProvider(context, engineDir);

	// File-based IDEs: write the MCP config file
	if (ide !== 'vscode') {
		const configManager = ConfigManager.getInstance();
		const config = configManager.getConfig();
		const serverConfig = buildMcpServerConfig(engineDir, config);
		if (serverConfig) {
			writeMcpConfigForIde(ide, serverConfig);
		}
	}
}
