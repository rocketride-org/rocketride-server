// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Extracts all unique ROCKETRIDE_* variable names referenced in a pipeline.
 *
 * Mirrors the server's `resolve_pipeline_env()` approach: stringify the
 * pipeline to JSON, then match all `${ROCKETRIDE_*}` placeholders.
 */
export function extractPipelineEnvVars(pipeline: Record<string, unknown>): string[] {
	const str = JSON.stringify(pipeline);
	const matches = str.matchAll(/\$\{(ROCKETRIDE_[^}]+)\}/g);
	return [...new Set([...matches].map((m) => m[1]))];
}
