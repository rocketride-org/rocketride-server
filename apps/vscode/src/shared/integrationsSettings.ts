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

// =============================================================================
// INTEGRATIONS SETTINGS — the agent-integration schema (PURE LEAF)
// =============================================================================
//
// The agent-integration toggles are WORKSPACE settings (deltas in
// `vscode.integrations.workspace.json`, per-user by construction — the
// `.workspace/` tree lives in the user's server-side store): nothing about
// them is needed to REACH a server, and the docs they install come from the
// connected server's catalog, so pre-connect values couldn't act anyway.
// `shells: ['vscode']` — only the VS Code host has a local repo to write
// CLAUDE.md / Copilot instructions / … into.
//
// Consumed by the settings webview (registry contribution) AND the ext
// host's workspace-settings bridge (AgentManager's reads) — a pure data
// leaf, like shared/tools/toolSettings.ts.
// =============================================================================

import type { AppConfiguration } from 'shell/src/components/workspace/types';

/** The contribution's identity: the section id AND the owner whose partition
 *  file (`vscode.integrations.workspace.json`) holds the deltas. */
export const INTEGRATIONS_APP_ID = 'vscode.integrations';

/** The Integrations section's schema (workspace-scoped, vscode-only). */
export const INTEGRATIONS_SETTINGS: AppConfiguration = {
	title: 'Integrations',
	properties: {
		'rocketride.integrations.autoAgentIntegration': {
			type: 'boolean',
			default: true,
			order: 1,
			shells: ['vscode'],
			description: 'Automatically detect and install RocketRide documentation for coding agents (Copilot, Claude Code, Cursor, Windsurf).',
		},
		'rocketride.integrations.copilot': {
			type: 'boolean',
			default: false,
			order: 2,
			shells: ['vscode'],
			description: 'Enable RocketRide integration with GitHub Copilot.',
		},
		'rocketride.integrations.claudeCode': {
			type: 'boolean',
			default: false,
			order: 3,
			shells: ['vscode'],
			description: 'Enable RocketRide integration with Claude Code.',
		},
		'rocketride.integrations.cursor': {
			type: 'boolean',
			default: false,
			order: 4,
			shells: ['vscode'],
			description: 'Enable RocketRide integration with Cursor.',
		},
		'rocketride.integrations.windsurf': {
			type: 'boolean',
			default: false,
			order: 5,
			shells: ['vscode'],
			description: 'Enable RocketRide integration with Windsurf.',
		},
		'rocketride.integrations.claudeMd': {
			type: 'boolean',
			default: false,
			order: 6,
			shells: ['vscode'],
			description: 'Install RocketRide instructions to CLAUDE.md at the repo root (generic agent support).',
		},
		'rocketride.integrations.agentsMd': {
			type: 'boolean',
			default: false,
			order: 7,
			shells: ['vscode'],
			description: 'Install RocketRide instructions to AGENTS.md at the repo root (generic agent support).',
		},
	},
};

/** The integration setting keys (full `rocketride.integrations.*` spelling). */
export const INTEGRATION_SETTING_KEYS: readonly string[] = Object.keys(INTEGRATIONS_SETTINGS.properties);
