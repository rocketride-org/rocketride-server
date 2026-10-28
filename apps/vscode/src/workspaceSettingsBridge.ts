// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE-SETTINGS BRIDGE — shared settings → ConfigManager's sync cache
// =============================================================================
//
// The pipeline-family settings live in the SHARED workspace settings
// (`rocketride.pipeBuilder.*` deltas in the product partition, edited by the
// unified Settings page on either host, roaming with the server). Every
// extension consumer, though, reads them SYNCHRONOUSLY off ConfigManager's
// cache — so this bridge computes the effective values (tool-schema defaults
// ⊕ workspace deltas) and pushes them into that cache, on load and on every
// workspace-settings change.
//
// Defaults-until-loaded is safe by design: all consumers run post-connect
// (pipeline runs, saves, file scaffolding), and the store's load completes
// with the connection.
// =============================================================================

import { getLogger } from './shared/util/output';
import type { WorkspaceStore } from 'shell/src/workspace/workspaceStore';
import { PIPELINES_TOOL_SETTINGS } from 'shared/tools/toolSettings';
import { INTEGRATIONS_SETTINGS, INTEGRATION_SETTING_KEYS } from './shared/integrationsSettings';
import type { ConfigManager, WorkspaceSettingsValues } from './config';

/** The effective value of one pipeBuilder key: workspace delta or schema default. */
function effective(settings: Record<string, unknown>, key: string): unknown {
	const full = `rocketride.pipeBuilder.${key}`;
	return settings[full] !== undefined ? settings[full] : PIPELINES_TOOL_SETTINGS.properties[full]?.default;
}

// =============================================================================
// INTEGRATION VALUES — AgentManager's synchronous read
// =============================================================================

/** Last-pushed effective integration values (defaults until the store loads). */
let integrationValues: Record<string, boolean> = {};

/**
 * The effective value of one integration toggle — AgentManager's read seam
 * (it used to read VS Code configuration; the values are workspace settings
 * now). Accepts the relative spelling its installer map uses.
 *
 * @param key - `integrations.<name>` or the full `rocketride.`-prefixed key.
 * @returns The effective boolean (schema default when unset/unloaded).
 */
export function getIntegrationSetting(key: string): boolean {
	const full = key.startsWith('rocketride.') ? key : `rocketride.${key}`;
	if (full in integrationValues) return integrationValues[full];
	return Boolean(INTEGRATIONS_SETTINGS.properties[full]?.default ?? false);
}

/** Recomputes the integration snapshot; true when any value changed. */
function pushIntegrations(settings: Record<string, unknown>): boolean {
	const next: Record<string, boolean> = {};
	for (const full of INTEGRATION_SETTING_KEYS) {
		const v = settings[full] !== undefined ? settings[full] : INTEGRATIONS_SETTINGS.properties[full]?.default;
		next[full] = Boolean(v ?? false);
	}
	const changed = INTEGRATION_SETTING_KEYS.some((k) => integrationValues[k] !== next[k]);
	integrationValues = next;
	return changed;
}

/**
 * Attaches the bridge: pushes the current effective pipeline values into the
 * ConfigManager cache (and the integration snapshot into this module's read
 * seam), re-pushing on every workspace-store change — a direct store
 * subscription; the extension host owns THE store, no bus hop.
 *
 * @param store - The extension host's WorkspaceStore (busHost.prefs).
 * @param configManager - The ConfigManager singleton.
 * @param onIntegrationsChanged - Fired when any integration toggle's
 *        effective value changed (the caller applies the stubs to the repo).
 * @returns Detach function.
 */
export function attachWorkspaceSettings(store: WorkspaceStore, configManager: ConfigManager, onIntegrationsChanged?: () => void): () => void {
	const push = (notify: boolean): void => {
		const settings = store.getSnapshot().settings ?? {};
		const values: WorkspaceSettingsValues = {
			defaultPipelinePath: String(effective(settings, 'defaultPipelinePath') ?? 'pipelines'),
			pipelineRestartBehavior: String(effective(settings, 'pipelineRestartBehavior') ?? 'prompt') as WorkspaceSettingsValues['pipelineRestartBehavior'],
			pipelineTtl: Number(effective(settings, 'pipelineTTL') ?? 900),
			pipelineTraceLevel: String(effective(settings, 'pipelineTraceLevel') ?? 'full') as WorkspaceSettingsValues['pipelineTraceLevel'],
			taskArguments: String(effective(settings, 'taskArguments') ?? ''),
			pipelineDebugOutput: Boolean(effective(settings, 'pipelineDebugOutput') ?? false),
		};
		configManager.setWorkspaceSettings(values);
		const integrationsChanged = pushIntegrations(settings);
		// The attach-time push seeds the snapshot without firing — connect-time
		// installs are the shell:connected autoInstall pass's job.
		if (notify && integrationsChanged) onIntegrationsChanged?.();
	};

	push(false);
	// One change signal covers prefs AND settings (the store's single seam);
	// recomputing a handful of scalars per change is noise-free and correct.
	const off = store.onPrefsChanged(() => {
		try {
			push(true);
		} catch (err) {
			getLogger().error(`[workspaceSettingsBridge] push failed: ${String(err)}`);
		}
	});
	return off;
}
