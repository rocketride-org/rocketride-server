// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The decision half of the pre-run environment variable check.
 *
 * Split out from `envVarCheck.ts` so it imports neither `vscode` nor the logger
 * and can be asserted directly. `envVarCheck.ts` keeps the side effects.
 *
 * The distinction this module exists to preserve: "every variable is defined"
 * and "the key list could not be fetched" are different answers. Collapsing
 * them into one empty array is what let a transient API failure switch the
 * pre-flight check off without saying so.
 */

/** Extract all unique ROCKETRIDE_* variable names referenced in a pipeline. */
export function extractPipelineEnvVars(pipeline: Record<string, unknown>): string[] {
	const str = JSON.stringify(pipeline);
	const matches = str.matchAll(/\$\{(ROCKETRIDE_[^}]+)\}/g);
	return [...new Set([...matches].map((m) => m[1]))];
}

/** The three genuinely different outcomes of the check. */
export type EnvVarDecision =
	| { kind: 'ok' }
	| { kind: 'missing'; missingKeys: string[] }
	| { kind: 'unverified'; reason: string };

/**
 * Decide what the pre-run check should do.
 *
 * @param referenced Variable names the pipeline refers to.
 * @param knownKeys  The server's known keys, or the Error that prevented reading them.
 */
export function decideEnvVars(referenced: string[], knownKeys: string[] | Error): EnvVarDecision {
	// Nothing referenced: nothing to verify, so a failed fetch would not have
	// mattered either. Checked first so an unrelated outage does not produce a
	// warning about a pipeline that uses no variables.
	if (referenced.length === 0) return { kind: 'ok' };

	if (knownKeys instanceof Error) {
		return { kind: 'unverified', reason: knownKeys.message || 'unknown error' };
	}

	const missingKeys = referenced.filter((v) => !knownKeys.includes(v));
	return missingKeys.length === 0 ? { kind: 'ok' } : { kind: 'missing', missingKeys };
}
