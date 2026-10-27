// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// REPORT — the six counts, the provenance, and the comparison with the baseline
// =============================================================================

/**
 * Writes what a run found: results.json for machines, report.md for people,
 * and human-review.md with every ASK scenario's first answer for a person to
 * score. The six statuses are counted separately, overall, by scenario type
 * and by model, and never folded into one score. A pending check or scenario
 * is never counted as a pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import { scrub } from './canary';
import type { Recording } from './recordings';
import type { Layer, RunStatus, ScenarioResult } from './types';

/** The statuses, in report order. */
export const STATUSES: RunStatus[] = ['pass', 'fail', 'error', 'incomplete', 'abstain', 'pending'];

/** Where the run came from: everything a reader needs to reproduce it. */
export interface Provenance {
	layer: Layer;
	startedAt: string;
	checkout: { path: string; commit: string; branch: string; dirtyFiles: number; base: string };
	model: string;
	settings: Record<string, unknown>;
	guides: unknown;
	engine: unknown;
	keys: string;
	command: string;
}

/** An L1 result next to the baseline's score of the same trial. */
export interface Comparison {
	recording: string;
	scenario: string;
	set: string;
	trial: number;
	baseline: { verdict: string; passed: number; counted: number };
	replay: { passed: number; counted: number; status: RunStatus };
	/** The checks both scored, and the ones whose result differs. */
	same: number;
	differ: Array<{ id: string; baseline: boolean | null; replay: string }>;
	added: Array<{ id: string; status: string }>;
	callMismatches: number;
	diverged: string | null;
	/** Whether the replay's final workspace is byte for byte the recorded one, and the paths that differ. */
	finalFiles: { same: boolean; differ: string[] };
}

/**
 * Compares an L1 result with the baseline's results for the same trial.
 *
 * @param result - The replay's result.
 * @param rec - The recording.
 * @param file - The recording's file name.
 * @param mismatches - Change calls whose outcome differs from the recording.
 * @param diverged - Why the replay left its recording, or null.
 * @param finalFiles - The replay's final workspace, path to sha256.
 * @returns The comparison.
 */
export function compare(result: ScenarioResult, rec: Recording, file: string, mismatches: number, diverged: string | null, finalFiles: Record<string, string>): Comparison {
	const differ: Comparison['differ'] = [];
	const added: Comparison['added'] = [];
	let same = 0;
	for (const c of result.checks) {
		const b = rec.baseline.results.find((r) => r.id === c.id);
		if (!b || b.ok === null) {
			if (c.status !== 'not_in_layer') added.push({ id: c.id, status: c.status });
			continue;
		}
		const replayOk = c.status === 'pass' ? true : c.status === 'fail' ? false : null;
		if (replayOk === b.ok) same++;
		else differ.push({ id: c.id, baseline: b.ok, replay: c.status });
	}
	const scoredBoth = result.checks.filter((c) => rec.baseline.results.some((r) => r.id === c.id && r.ok !== null) && !c.soft);
	const out: Comparison = {
		recording: file,
		scenario: rec.scenario,
		set: rec.set,
		trial: rec.trial,
		baseline: { verdict: rec.baseline.verdict, passed: rec.baseline.passed, counted: rec.baseline.counted },
		replay: { passed: scoredBoth.filter((c) => c.status === 'pass').length, counted: scoredBoth.length, status: result.status },
		same,
		differ,
		added,
		callMismatches: mismatches,
		diverged,
		finalFiles: { same: false, differ: [] },
	};
	const paths = new Set([...Object.keys(rec.finalFiles), ...Object.keys(finalFiles)]);
	out.finalFiles.differ = [...paths].filter((p) => rec.finalFiles[p] !== finalFiles[p]).sort();
	out.finalFiles.same = out.finalFiles.differ.length === 0;
	return out;
}

/** The six counts over some results. */
export function counts(results: ScenarioResult[]): Record<RunStatus, number> {
	const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
	for (const r of results) out[r.status]++;
	return out;
}

function row(cells: Array<string | number>): string {
	return `| ${cells.map((c) => scrub(String(c)).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
}

function countTable(title: string, groups: Map<string, ScenarioResult[]>): string[] {
	const lines = [`### ${title}`, '', row(['', ...STATUSES, 'total']), row(['---', ...STATUSES.map(() => '---'), '---'])];
	for (const [name, rs] of groups) {
		const c = counts(rs);
		lines.push(row([name, ...STATUSES.map((s) => c[s]), rs.length]));
	}
	return [...lines, ''];
}

function groupBy(results: ScenarioResult[], key: (r: ScenarioResult) => string): Map<string, ScenarioResult[]> {
	const out = new Map<string, ScenarioResult[]>();
	for (const r of results) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
	return out;
}

/**
 * Writes the run's files.
 *
 * @param dir - The output folder.
 * @param prov - The provenance.
 * @param results - Every scored trial, and every scenario that ran no trial.
 * @param comparisons - L1 only: each replay next to its baseline score.
 * @param invalid - Scenarios that failed validation (the run refuses to start when there are any).
 * @returns The report's path.
 */
export function writeReport(dir: string, prov: Provenance, results: ScenarioResult[], comparisons: Comparison[], invalid: Array<{ id: string; problems: string[] }>): string {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'results.json'), scrub(JSON.stringify({ provenance: prov, counts: counts(results), results, comparisons, invalid }, null, 2)));

	const md: string[] = [`# Eval report: ${prov.layer}`, ''];
	md.push('## Provenance', '');
	md.push(`- Checkout: ${prov.checkout.path}, branch ${prov.checkout.branch}, commit ${prov.checkout.commit}${prov.checkout.dirtyFiles ? ` with ${prov.checkout.dirtyFiles} uncommitted files` : ', clean'}. Base: ${prov.checkout.base}.`);
	md.push(`- Model: ${prov.model}. Settings: ${JSON.stringify(prov.settings)}.`);
	md.push(`- Guide bundle: ${JSON.stringify(prov.guides)}.`);
	md.push(`- Engine: ${typeof prov.engine === 'string' ? prov.engine : JSON.stringify(prov.engine)}.`);
	md.push(`- Keys: ${prov.keys}. Values are never read into the report.`);
	md.push(`- Started ${prov.startedAt}. Command: \`${prov.command}\`.`, '');
	if (invalid.length) {
		md.push('## Invalid scenarios (nothing ran)', '');
		for (const v of invalid) md.push(`- ${v.id}: ${v.problems.join('; ')}`);
		md.push('');
	}

	md.push('## Counts', '');
	const c = counts(results);
	md.push(STATUSES.map((s) => `${s} ${c[s]}`).join(', ') + `, of ${results.length}.`, '');
	md.push('Error is left out of the denominator. Pending is never a pass: it is a scenario with no recording (L1), a scenario this layer does not run, an ASK scenario waiting for a person, or a check whose input, service or engine verdict is missing.', '');
	md.push(
		...countTable(
			'By type',
			groupBy(results, (r) => r.type)
		)
	);
	md.push(
		...countTable(
			'By model',
			groupBy(results, (r) => r.model)
		)
	);

	md.push('## Results', '');
	md.push(row(['scenario', 'trial', 'model', 'status', 'counted checks', 'pending checks', 'blockers', 'why']));
	md.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
	for (const r of results) md.push(row([r.scenario, r.trial || '-', r.model, r.status, r.counted.total ? `${r.counted.passed}/${r.counted.total}` : '-', r.counted.pending, r.blockersFired.join(', ') || '-', r.why.slice(0, 220)]));
	md.push('');

	const ran = results.filter((r) => r.record);
	if (ran.length) {
		md.push('## Diagnostics (never pass or fail)', '');
		md.push(row(['scenario', 'trial', 'turns', 'waves per turn', 'tool calls', 'model calls', 'repeated identical calls', 'longest run', 'tool errors', 'GATE_STATE failures', 'done refusals', 'confirms', 'tokens in/out/cache read', 'cost', 'wall s']));
		md.push(row(Array(15).fill('---')));
		for (const r of ran) {
			const d = r.diagnostics as Record<string, unknown> & { tokens: { input: number; output: number; cacheRead: number } | null };
			md.push(row([r.scenario, r.trial, String(d.turns), (d.wavesPerTurn as number[]).join('/'), String(d.toolCalls), String(d.modelCalls), String(d.repeated), String(d.longestRun), String(d.toolErrors), String(d.gateStateWriteFailures), String(d.doneRefusals), String(d.confirms), d.tokens ? `${d.tokens.input}/${d.tokens.output}/${d.tokens.cacheRead}` : 'not reported', d.costUsd === null || d.costUsd === undefined ? '-' : `$${(d.costUsd as number).toFixed(2)}`, Math.round(Number(d.wallMs) / 1000)]));
		}
		md.push('');
	}

	if (comparisons.length) {
		md.push('## L1 against the recorded baseline', '');
		md.push('The baseline column is check_workspace.py\'s score of the original trial. The replay column scores the same checks on the replayed trial. "Added" lists checks the baseline could not run that this runner scores.', '');
		md.push(row(['scenario', 'recording', 'baseline', 'replay, same checks', 'checks that agree', 'checks that differ', 'added', 'replay status', 'final files as recorded', 'change calls that differ', 'replay']));
		md.push(row(Array(11).fill('---')));
		for (const x of comparisons) {
			md.push(row([x.scenario, x.recording, `${x.baseline.verdict} ${x.baseline.passed}/${x.baseline.counted}`, `${x.replay.passed}/${x.replay.counted}`, x.same, x.differ.map((d) => `${d.id} (baseline ${d.baseline}, replay ${d.replay})`).join('; ') || 'none', x.added.map((a) => `${a.id} ${a.status}`).join(', ') || '-', x.replay.status, x.finalFiles.same ? 'yes' : `no: ${x.finalFiles.differ.join(', ')}`, x.callMismatches, x.diverged ?? 'followed the recording']));
		}
		md.push('');
	}

	md.push('## Checks', '');
	for (const r of results.filter((x) => x.checks.length)) {
		md.push(`### ${r.scenario}${r.trial ? ` t${r.trial}` : ''} (${r.status})`, '');
		for (const ck of r.checks) md.push(`- ${ck.id} (${ck.kind}${ck.soft ? ', soft' : ''}${ck.blocker ? ', blocker' : ''}): ${ck.status}${ck.detail ? `. ${ck.detail.slice(0, 300)}` : ''}`);
		if (r.record) md.push(`- record: ${r.record}`);
		md.push('');
	}
	const report = path.join(dir, 'report.md');
	fs.writeFileSync(report, scrub(md.join('\n')));

	const asks = results.filter((r) => r.human);
	if (asks.length) {
		const h: string[] = ['# ASK scenarios: for a person to score', '', 'The runner does not judge these. For each, read the first answer and answer the judge question yes, no or unknown.', ''];
		for (const r of asks) {
			h.push(`## ${r.scenario} t${r.trial} (${r.model})`, '');
			for (const j of r.human?.judge ?? []) h.push(`- Question (${j.id}, passes on ${j.pass_on}): ${j.question}`, '- Answer: ___');
			h.push('', 'Deterministic checks on turn 1 and the end state:', ...r.checks.map((ck) => `- ${ck.id}: ${ck.status}${ck.detail ? ` (${ck.detail.slice(0, 160)})` : ''}`), '', 'First answer:', '', '```', r.human?.answer ?? '', '```', '');
		}
		fs.writeFileSync(path.join(dir, 'human-review.md'), scrub(h.join('\n')));
	}
	return report;
}
