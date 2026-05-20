// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pre-run environment variable check.
 *
 * Mirrors the server's `resolve_pipeline_env()` regex to detect `${ROCKETRIDE_*}`
 * references in a pipeline, then compares against the server's known env keys.
 * If any are missing, pre-fills them as empty entries in the user scope and
 * opens the Variables page so the user can fill them in before re-running.
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
 * Adds missing env var keys (with empty values) to the user scope on the
 * server, then opens the Variables page so the user can fill them in.
 */
export async function prefillMissingEnvVars(client: RocketRideClient, missingKeys: string[]): Promise<void> {
	const currentUserEnv = await client.account.getEnv('user');
	const merged = { ...currentUserEnv };
	for (const key of missingKeys) {
		if (!(key in merged)) {
			merged[key] = '';
		}
	}
	await client.account.setEnv('user', merged);

	await vscode.commands.executeCommand('rocketride.page.environment.open');
	await vscode.commands.executeCommand('rocketride.page.environment.refreshUser');
	vscode.window.showWarningMessage(
		`Pipeline references ${missingKeys.length} undefined variable${missingKeys.length > 1 ? 's' : ''}. Please fill in the values in the Variables page, then re-run.`
	);
}

/**
 * Checks a pipeline for missing ROCKETRIDE_* env vars. If any are missing,
 * pre-fills them as empty entries in the user scope, opens the Variables page,
 * and shows a warning. Returns the list of missing keys (empty if all present).
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
		// Server may not support env_keys (e.g. OSS) — skip the check
		return [];
	}

	const missing = referencedVars.filter((v) => !knownKeys.includes(v));
	if (missing.length === 0) return [];

	await prefillMissingEnvVars(client, missing);
	return missing;
}
