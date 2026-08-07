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
 */

import * as vscode from 'vscode';
import type { RocketRideClient } from 'rocketride';

/** Extract all unique ROCKETRIDE_* variable names referenced in a pipeline. */
function extractPipelineEnvVars(pipeline: Record<string, unknown>): string[] {
	const str = JSON.stringify(pipeline);
	const matches = str.matchAll(/\$\{(ROCKETRIDE_[^}]+)\}/g);
	return [...new Set([...matches].map((m) => m[1]))];
}

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
	const referencedVars = extractPipelineEnvVars(pipeline);
	if (referencedVars.length === 0) return [];

	let knownKeys: string[];
	try {
		knownKeys = await client.account.getEnvironmentKeys();
	} catch {
		return [];
	}

	const missing = referencedVars.filter((v) => !knownKeys.includes(v));
	if (missing.length === 0) return [];

	await openWithMissingKeys(missing);
	return missing;
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
