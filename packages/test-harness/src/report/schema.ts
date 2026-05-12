/**
 * Run-level report data model. Emitted alongside the per-pipeline trace
 * JSONs as report.json + rendered to report.md.
 */

import type { CoverageDiff } from '../coverage/diff';
import type { ExclusionWarning } from '../coverage/exclusions';
import type { PipelineResultBucket } from '../runner/schema';

export type PipelineSummary = {
	pipeline: string;
	result: PipelineResultBucket;
	duration_ms: number;
	exercised_nodes: string[];
	error_message?: string;
	infra_signature?: string;
	trace_path: string; // relative to run dir, e.g. "traces/smoke__llm_openai.json"
};

export type RunReport = {
	schema_version: 1;
	run_started: string;
	run_ended: string;
	duration_ms: number;
	tier: string;
	mock_llm: boolean;
	server: {
		mode: 'spawn' | 'external';
		url: string;
		port: number;
	};
	summary: {
		pass: number;
		logic_failure: number;
		infra_failure: number;
		timeout: number;
		total: number;
	};
	coverage?: {
		known_count: number;
		covered_count: number;
		excluded_count: number;
		gap_count: number;
		covered: string[];
		gaps: string[];
		excluded: Array<{ node: string; reason: string }>;
		stale_warnings: ExclusionWarning[];
	};
	pipelines: PipelineSummary[];
	skipped_coverage?: { reason: string };
};

export function emptyCoverageFrom(diff: CoverageDiff, staleWarnings: ExclusionWarning[]): NonNullable<RunReport['coverage']> {
	return {
		known_count: diff.knownCount,
		covered_count: diff.covered.length,
		excluded_count: diff.excluded.length,
		gap_count: diff.gaps.length,
		covered: diff.covered,
		gaps: diff.gaps,
		excluded: diff.excluded,
		stale_warnings: staleWarnings,
	};
}
