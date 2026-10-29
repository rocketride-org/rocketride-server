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
// TOOL SETTINGS — the builtin tools' setting declarations (PURE LEAF)
// =============================================================================
//
// The ONE source of truth for the tools' settings schemas, consumed by:
//   - builtins.tsx (stamps each manifest's `configuration`)
//   - the ext host's ConfigManager bridge (defaults; Phase 6)
//   - the VS Code settings webview (registry input; Phase 5)
//
// A pure .ts data leaf ON PURPOSE: the extension host compiles this module
// too, so nothing here may import React, components, or assets (builtins.tsx
// carries `.svg?url` imports the ext-host bundle cannot resolve — settings
// code must NEVER import it; it imports THIS).
//
// Key spelling stays `rocketride.pipeBuilder.*` (the historical cloud keys)
// so existing override values keep applying — nav labels are not keys: the
// section renders as "Pipelines" under the "Rocket Builder" group.
//
// Path settings are VIRTUAL-workspace-relative, shared by both hosts: the
// cloud maps `apps/` → its physical `.appdev` tree in its mount translation;
// VS Code resolves against the workspace folder.
// =============================================================================

import type { AppConfiguration } from 'shell/src/components/workspace/types';
import type { SettingsContribution } from 'shell/src/components/workspace/settingsContributions';
import { BUILTIN_PIN_PREFIX } from 'shell/src/workspace/devToolPins';

/** The settings-nav group every DEV TOOL's section folds under. */
export const TOOL_SETTINGS_GROUP = { id: 'rocket-builder', label: 'Rocket Builder' } as const;

/**
 * The PRODUCT partition builtin tool settings store into
 * (`rocketride.pipeBuilder.workspace.json`). Builtins are host-resident —
 * they deliberately mint no partition files of their own; the same partition
 * already holds the product's prefs on both hosts (devToolPins et al.).
 */
export const TOOL_SETTINGS_OWNER = 'rocketride.pipeBuilder';

/** The pipelines tool's settings (section "Pipelines" under Rocket Builder). */
export const PIPELINES_TOOL_SETTINGS: AppConfiguration = {
	title: 'Pipelines',
	properties: {
		'rocketride.pipeBuilder.pipelineRestartBehavior': {
			type: 'string',
			enum: ['auto', 'manual', 'prompt'],
			enumDescriptions: [
				'Automatically restart when the .pipe changes',
				'Do not automatically restart',
				'Prompt to restart when .pipe changes',
			],
			default: 'prompt',
			order: 1,
			description: 'Behavior when a .pipe file changes while the pipeline is running.',
		},
		'rocketride.pipeBuilder.pipelineTTL': {
			type: 'integer',
			enum: [900, 1800, 3600, 14400, 28800, 0],
			enumDescriptions: ['15 minutes', '30 minutes', '1 hour', '4 hours', '8 hours', 'Run forever or until you stop it'],
			default: 900,
			order: 2,
			description: 'Default idle timeout before a running pipeline is shut down.',
		},
		'rocketride.pipeBuilder.pipelineTraceLevel': {
			type: 'string',
			enum: ['none', 'metadata', 'summary', 'full'],
			default: 'full',
			order: 3,
			description: 'Controls tracing verbosity for pipeline execution.',
		},
		'rocketride.pipeBuilder.taskArguments': {
			type: 'string',
			default: '',
			order: 4,
			description: 'Additional command-line arguments passed to each pipeline task.',
		},
		'rocketride.pipeBuilder.pipelineDebugOutput': {
			type: 'boolean',
			default: false,
			order: 5,
			description: 'Enable full debug output for pipeline tasks (--trace=debugOut).',
		},
		'rocketride.pipeBuilder.defaultPipelinePath': {
			type: 'string',
			default: 'pipelines',
			order: 6,
			description: 'Workspace-relative directory for new pipeline files.',
		},
		'rocketride.pipeBuilder.autoCommit': {
			type: 'boolean',
			default: true,
			order: 7,
			// Staging is the cloud workspace's mechanism — VS Code files are native.
			shells: ['saas', 'oss'],
			description: 'Write saved changes straight to your workspace on the server. Turn this off to review, diff, and commit changes yourself - saves (yours and the agent\'s) stay local until you commit them. Cloud workspaces only.',
		},
		// The agent's settings: it runs in the cloud builder only (its tool's manifest `shells`).
		'rocketride.pipeBuilder.agentApproval': {
			type: 'string',
			enum: ['ask', 'auto'],
			enumDescriptions: ['Ask first: the agent waits for your OK before it publishes, submits for review, changes a deployment or a schedule, or deletes a file.', "Don't ask: the agent does those without asking. Nothing judges the risk for you in this mode; it simply doesn't ask. Account, team and billing changes stay blocked."],
			default: 'ask',
			order: 8,
			shells: ['saas', 'oss'],
			description: 'Whether the agent asks before outward actions and deletes, in every agent chat. Account, team, member and billing changes are refused in both modes.',
		},
		'rocketride.pipeBuilder.agentStepLimit': {
			type: 'number',
			default: 60,
			order: 9,
			shells: ['saas', 'oss'],
			description: 'The most steps the agent takes in one turn. At the limit it pauses and asks; Continue starts a new turn with a fresh budget. 0 means no limit.',
		},
		'rocketride.pipeBuilder.agentCostLimit': {
			type: 'number',
			default: 2,
			order: 10,
			shells: ['saas', 'oss'],
			description: "The most one agent turn's estimated model cost may reach, in US dollars. At the limit it pauses and asks; Continue starts a new turn with a fresh budget. The estimate counts 4 characters as a token and leaves out the model's thinking, so a turn can cost more than the limit. 0 means no limit, and a model with no known price has none.",
		},
		'rocketride.pipeBuilder.agentAllowScheduleChanges': {
			type: 'boolean',
			default: false,
			order: 11,
			shells: ['saas', 'oss'],
			description: 'Let the agent set, pause and resume deployment schedules without asking. Always allow on a card turns this on.',
		},
		'rocketride.pipeBuilder.agentAllowDeploymentToggles': {
			type: 'boolean',
			default: false,
			order: 12,
			shells: ['saas', 'oss'],
			description: 'Let the agent turn deployments on and off without asking. Always allow on a card turns this on. Removing a deployment always asks.',
		},
	},
};

/** The apps tool's settings (section "Apps" under Rocket Builder). */
export const APPS_TOOL_SETTINGS: AppConfiguration = {
	title: 'Apps',
	properties: {
		'rocketride.appdev.defaultAppPath': {
			type: 'string',
			default: 'apps',
			order: 1,
			description: 'Workspace-relative directory new apps are scaffolded into.',
		},
	},
};

/**
 * The builtin tools' settings CONTRIBUTIONS — the exact rows the cloud's
 * `registerBuiltinTool()` derives from the manifests, spelled once so a realm
 * that does not mount the tools (the VS Code settings webview) registers the
 * SAME sections: same appIds (`builtin.<tool>` — the pin spelling), same
 * Rocket Builder group, same product storage partition. Registration order
 * here matches builtins.tsx registration order (Apps before Pipelines).
 */
export const TOOL_SETTINGS_CONTRIBUTIONS: readonly SettingsContribution[] = [
	{
		appId: `${BUILTIN_PIN_PREFIX}apps`,
		name: 'Apps',
		group: TOOL_SETTINGS_GROUP,
		storageAppId: TOOL_SETTINGS_OWNER,
		configuration: APPS_TOOL_SETTINGS,
	},
	{
		appId: `${BUILTIN_PIN_PREFIX}pipelines`,
		name: 'Pipelines',
		group: TOOL_SETTINGS_GROUP,
		storageAppId: TOOL_SETTINGS_OWNER,
		configuration: PIPELINES_TOOL_SETTINGS,
	},
];
