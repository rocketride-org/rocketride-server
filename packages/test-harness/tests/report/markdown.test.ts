import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../../src/report/markdown';
import type { RunReport } from '../../src/report/schema';

function baseReport(overrides: Partial<RunReport> = {}): RunReport {
	return {
		schema_version: 1,
		run_started: '2026-05-12T20:00:00.000Z',
		run_ended: '2026-05-12T20:01:00.000Z',
		duration_ms: 60000,
		tier: 'smoke',
		mock_llm: true,
		server: { mode: 'spawn', url: 'http://localhost:5565', port: 5565 },
		summary: { pass: 0, logic_failure: 0, infra_failure: 0, timeout: 0, total: 0 },
		pipelines: [],
		...overrides,
	};
}

describe('renderMarkdown', () => {
	it('renders summary counts in the table', () => {
		const md = renderMarkdown(
			baseReport({
				summary: { pass: 3, logic_failure: 1, infra_failure: 1, timeout: 0, total: 5 },
			}),
		);
		expect(md).toContain('| Pass | 3 |');
		expect(md).toContain('| Logic failure | 1 |');
		expect(md).toContain('| Infra failure | 1 |');
		expect(md).toContain('| **Total** | **5** |');
	});

	it('marks coverage as failing when there are gaps', () => {
		const md = renderMarkdown(
			baseReport({
				coverage: {
					known_count: 5,
					covered_count: 1,
					excluded_count: 3,
					gap_count: 1,
					covered: ['parse'],
					gaps: ['embedding_image'],
					excluded: [{ node: 'qdrant', reason: 'requires running qdrant instance' }],
					stale_warnings: [],
				},
			}),
		);
		expect(md).toContain('Gap: **1** ← fails the run');
		expect(md).toContain('`embedding_image`');
		expect(md).toContain('`qdrant`: requires running qdrant instance');
	});

	it('does not show the failing-run marker when gap is zero', () => {
		const md = renderMarkdown(
			baseReport({
				coverage: {
					known_count: 2,
					covered_count: 2,
					excluded_count: 0,
					gap_count: 0,
					covered: ['parse', 'response'],
					gaps: [],
					excluded: [],
					stale_warnings: [],
				},
			}),
		);
		expect(md).toContain('Gap: **0**');
		expect(md).not.toContain('fails the run');
	});

	it('renders logic and infra failure sections separately', () => {
		const md = renderMarkdown(
			baseReport({
				summary: { pass: 0, logic_failure: 1, infra_failure: 1, timeout: 0, total: 2 },
				pipelines: [
					{
						pipeline: 'smoke/broken',
						result: 'logic_failure',
						duration_ms: 100,
						exercised_nodes: ['parse'],
						error_message: 'TypeError: cannot read property foo',
						trace_path: 'traces/smoke__broken.json',
					},
					{
						pipeline: 'smoke/throttled',
						result: 'infra_failure',
						duration_ms: 100,
						exercised_nodes: ['llm_openai'],
						infra_signature: 'rate_limit_error',
						trace_path: 'traces/smoke__throttled.json',
					},
				],
			}),
		);
		expect(md).toContain('### Logic');
		expect(md).toContain('smoke/broken');
		expect(md).toContain('### Infra');
		expect(md).toContain('matched `rate_limit_error`');
	});

	it('shows the timings table sorted slowest-first', () => {
		const md = renderMarkdown(
			baseReport({
				summary: { pass: 2, logic_failure: 0, infra_failure: 0, timeout: 0, total: 2 },
				pipelines: [
					{ pipeline: 'fast', result: 'pass', duration_ms: 500, exercised_nodes: [], trace_path: 'traces/fast.json' },
					{ pipeline: 'slow', result: 'pass', duration_ms: 5000, exercised_nodes: [], trace_path: 'traces/slow.json' },
				],
			}),
		);
		const timingsSection = md.split('## Timings')[1] ?? '';
		const slowIdx = timingsSection.indexOf('slow');
		const fastIdx = timingsSection.indexOf('fast');
		expect(slowIdx).toBeGreaterThanOrEqual(0);
		expect(fastIdx).toBeGreaterThan(slowIdx); // slow appears first
	});

	it('reports a coverage-skipped reason when /services was unreachable', () => {
		const md = renderMarkdown(
			baseReport({
				skipped_coverage: { reason: 'GET /services failed: 500 Internal Server Error' },
			}),
		);
		expect(md).toContain('_Skipped: GET /services failed: 500 Internal Server Error_');
	});
});
