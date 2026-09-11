// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pre-run environment variable check.
 *
 * Mirrors the server's `resolve_pipeline_env()` regex to detect `${ROCKETRIDE_*}`
 * references in a pipeline, then compares against the server's known env keys.
 * If any are missing, opens the Variables page with the missing keys pre-filled
 * so the user can set values before re-running.
 *
 * The decision itself lives in `envVarDecision.ts`, which imports neither
 * `vscode` nor the logger so it can be asserted directly. This module is the
 * side effects.
 */

import * as vscode from 'vscode';
import type { RocketRideClient } from 'rocketride';
import { decideEnvVars, extractPipelineEnvVars } from './envVarDecision';
import { getLogger } from './output';

/**
 * Opens the Variables page and pre-fills the missing keys as empty entries.
 */
async function openWithMissingKeys(missingKeys: string[]): Promise<void> {
	await vscode.commands.executeCommand('rocketride.page.environment.open', missingKeys);
	vscode.window.showWarningMessage(
		`Pipeline references ${missingKeys.length} undefined variable${missingKeys.length > 1 ? 's' : ''}. Please fill in the values in the Variables page, then re-run.`
	);
}

/**
 * Checks a pipeline for missing ROCKETRIDE_* env vars. If any are missing,
 * opens the Variables page with the missing keys pre-filled.
 * Returns the list of missing keys (empty if all present).
 *
 * Used by the sidebar run path which doesn't go through the webview.
 */
export async function checkMissingEnvVars(client: RocketRideClient, pipeline: Record<string, unknown>): Promise<string[]> {
	const referenced = extractPipelineEnvVars(pipeline);
	// Nothing to verify — skip the round-trip entirely, as before.
	if (referenced.length === 0) return [];

	let keys: string[] | Error;
	try {
		keys = await client.account.getEnvironmentKeys();
	} catch (error: unknown) {
		keys = error instanceof Error ? error : new Error(String(error));
	}

	const decision = decideEnvVars(referenced, keys);

	if (decision.kind === 'unverified') {
		// Permissive on purpose — a transient failure should not block a run that
		// would have been fine. What changed is that it is no longer SILENT: this
		// used to return an empty list, which the caller cannot tell apart from
		// "all variables defined", so the gate vanished without a word.
		getLogger().error(
			`envVarCheck: could not read environment keys (${decision.reason}); running without the pre-flight check`
		);
		vscode.window.showWarningMessage(
			`Could not verify environment variables (${decision.reason}). Running without the pre-flight check — an undefined variable will reach the pipeline as a literal \${ROCKETRIDE_*} placeholder.`
		);
		return [];
	}

	if (decision.kind === 'ok') return [];

	await openWithMissingKeys(decision.missingKeys);
	return decision.missingKeys;
}

/**
 * Opens the Variables page with the given missing keys pre-filled.
 * Used by the ProjectProvider host when the webview reports missing vars.
 */
export async function handleMissingEnvVars(missingKeys: string[]): Promise<void> {
	const safeKeys = missingKeys.filter((k) => /^ROCKETRIDE_[A-Z0-9_]+$/.test(k));
	if (safeKeys.length === 0) return;
	await openWithMissingKeys(safeKeys);
}
