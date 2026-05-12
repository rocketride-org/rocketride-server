/**
 * Render RunReport → human-readable markdown.
 *
 * Sections: Summary, Coverage (with gaps + excluded), Failures (logic + infra),
 * Timings. Mirrors the layout in the plan document.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

import type { RunReport } from './schema';

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(2)}s`;
	const m = Math.floor(s / 60);
	const rem = (s % 60).toFixed(1);
	return `${m}m ${rem}s`;
}

function truncate(text: string, max = 240): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + '…';
}

export function renderMarkdown(report: RunReport): string {
	const lines: string[] = [];

	lines.push(`# Harness Run ${report.run_started}`);
	lines.push('');
	lines.push(`- Tier: \`${report.tier}\``);
	lines.push(`- Mock LLM: \`${report.mock_llm ? 'ROCKETRIDE_MOCK=1' : 'real APIs'}\``);
	lines.push(`- Server: ${report.server.mode} at \`${report.server.url}\` (port ${report.server.port})`);
	lines.push(`- Duration: ${formatDuration(report.duration_ms)}`);
	lines.push('');

	lines.push('## Summary');
	lines.push('');
	lines.push('| Bucket | Count |');
	lines.push('|--------|-------|');
	lines.push(`| Pass | ${report.summary.pass} |`);
	lines.push(`| Logic failure | ${report.summary.logic_failure} |`);
	lines.push(`| Infra failure | ${report.summary.infra_failure} |`);
	lines.push(`| Timeout | ${report.summary.timeout} |`);
	lines.push(`| **Total** | **${report.summary.total}** |`);
	lines.push('');

	if (report.coverage) {
		const cov = report.coverage;
		lines.push('## Coverage');
		lines.push('');
		lines.push(`- /services nodes: **${cov.known_count}**`);
		lines.push(`- Covered: **${cov.covered_count}**`);
		lines.push(`- Excluded: **${cov.excluded_count}**`);
		lines.push(`- Gap: **${cov.gap_count}**${cov.gap_count > 0 ? ' ← fails the run' : ''}`);
		lines.push('');

		if (cov.gaps.length > 0) {
			lines.push('### Coverage gaps');
			lines.push('');
			for (const node of cov.gaps) {
				lines.push(`- \`${node}\`: no pipeline exercises this node. Add coverage or add to coverage-exclusions.json with a reason.`);
			}
			lines.push('');
		}

		if (cov.excluded.length > 0) {
			lines.push('### Excluded nodes');
			lines.push('');
			for (const { node, reason } of cov.excluded) {
				lines.push(`- \`${node}\`: ${reason}`);
			}
			lines.push('');
		}

		if (cov.stale_warnings.length > 0) {
			lines.push('### Stale exclusions (>90 days)');
			lines.push('');
			for (const warning of cov.stale_warnings) {
				lines.push(`- \`${warning.node}\`: ${warning.message}`);
			}
			lines.push('');
		}
	} else if (report.skipped_coverage) {
		lines.push('## Coverage');
		lines.push('');
		lines.push(`_Skipped: ${report.skipped_coverage.reason}_`);
		lines.push('');
	}

	const logic = report.pipelines.filter((p) => p.result === 'logic_failure');
	const infra = report.pipelines.filter((p) => p.result === 'infra_failure');
	const timeouts = report.pipelines.filter((p) => p.result === 'timeout');

	if (logic.length > 0 || infra.length > 0 || timeouts.length > 0) {
		lines.push('## Failures');
		lines.push('');

		if (logic.length > 0) {
			lines.push('### Logic');
			lines.push('');
			for (const p of logic) {
				lines.push(`- **${p.pipeline}**: ${truncate(p.error_message ?? 'no error message')}`);
				lines.push(`  - Trace: \`${p.trace_path}\``);
			}
			lines.push('');
		}

		if (infra.length > 0) {
			lines.push('### Infra');
			lines.push('');
			for (const p of infra) {
				lines.push(`- **${p.pipeline}**: matched \`${p.infra_signature}\`. Skipped from totals.`);
				lines.push(`  - Trace: \`${p.trace_path}\``);
			}
			lines.push('');
		}

		if (timeouts.length > 0) {
			lines.push('### Timeout');
			lines.push('');
			for (const p of timeouts) {
				lines.push(`- **${p.pipeline}**: no terminal apaevt_flow op:end within timeout.`);
				lines.push(`  - Trace: \`${p.trace_path}\``);
			}
			lines.push('');
		}
	}

	const slowest = [...report.pipelines].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5);
	if (slowest.length > 0) {
		lines.push('## Timings');
		lines.push('');
		lines.push('| Pipeline | Duration |');
		lines.push('|----------|----------|');
		for (const p of slowest) {
			lines.push(`| ${p.pipeline} | ${formatDuration(p.duration_ms)} |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

export function writeReports(runDir: string, report: RunReport): { md: string; json: string } {
	const mdPath = join(runDir, 'report.md');
	const jsonPath = join(runDir, 'report.json');
	writeFileSync(mdPath, renderMarkdown(report), 'utf8');
	writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
	return { md: mdPath, json: jsonPath };
}
