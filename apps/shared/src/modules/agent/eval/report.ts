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
// REPORT: the seven counts, the provenance, and each replay against its recording
// =============================================================================

/**
 * Writes what a run found: results.json for machines and report.md for
 * people. The seven statuses are counted separately, overall and by model,
 * and never folded into one score. A pending check or scenario is never
 * counted as a pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import { scrub } from './canary';
import type { Recording } from './recordings';
import type { Layer, RunStatus, ScenarioResult } from './types';

/** The statuses, in report order. */
export const STATUSES: RunStatus[] = ['pass', 'fail', 'error', 'incomplete', 'needs_input', 'abstain', 'pending'];

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

/** An L1 replay next to the live trial it was recorded from. */
export interface Comparison {
	recording: string;
	scenario: string;
	set: string;
	trial: number;
	status: { recorded: RunStatus; replay: RunStatus };
	/** The checks whose status differs from the recorded trial's. */
	differ: Array<{ id: string; recorded: string; replay: string }>;
	/** The turns that ended otherwise and the tool calls that differ (recordings.ts mismatches). */
	mismatches: string[];
	diverged: string | null;
	/** Whether the replay's final workspace is byte for byte the recorded one, and the paths that differ. */
	finalFiles: { same: boolean; differ: string[] };
}

/**
 * Compares an L1 result with the live trial it was recorded from.
 *
 * @param result - The replay's result.
 * @param rec - The recording.
 * @param file - The recording's file name.
 * @param mismatches - The turn ends and tool calls that differ from the recording.
 * @param diverged - Why the replay left its recording, or null.
 * @param finalFiles - The replay's final workspace, path to sha256.
 * @returns The comparison.
 */
export function compare(result: ScenarioResult, rec: Recording, file: string, mismatches: string[], diverged: string | null, finalFiles: Record<string, string>): Comparison {
	const ids = new Set([...Object.keys(rec.expected.checks), ...result.checks.map((c) => c.id)]);
	const differ = [...ids].map((id) => ({ id, recorded: rec.expected.checks[id] ?? 'absent', replay: result.checks.find((c) => c.id === id)?.status ?? 'absent' })).filter((d) => d.recorded !== d.replay);
	const paths = new Set([...Object.keys(rec.finalFiles), ...Object.keys(finalFiles)]);
	const filesDiffer = [...paths].filter((p) => rec.finalFiles[p] !== finalFiles[p]).sort();
	return {
		recording: file,
		scenario: rec.scenario,
		set: rec.set,
		trial: rec.trial,
		status: { recorded: rec.expected.status, replay: result.status },
		differ,
		mismatches,
		diverged,
		finalFiles: { same: filesDiffer.length === 0, differ: filesDiffer },
	};
}

/** Whether a replay reproduced its recorded trial exactly. */
export function reproduces(x: Comparison): boolean {
	return x.status.recorded === x.status.replay && !x.differ.length && !x.mismatches.length && !x.diverged && x.finalFiles.same;
}

/** The seven counts over some results. */
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
 * @param comparisons - L1 only: each replay next to its recorded trial.
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
	md.push('Error is left out of the denominator. Needs_input is a run whose last turn ended needs_input where the scenario expects another outcome: ask_user asked, or the step or cost limit paused it. Pending is never a pass: it is a scenario with no recording (L1), a scenario this layer does not run, or a check whose input or service is missing.', '');
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
		md.push("Turn results are the product's own TurnResult per turn (outcome/reason). The estimated cost is the agent's meter, from characters at the stand-in model's price, the figure its cost limit checks; the cost column is the provider's token counts at list price, where the provider reports them.", '');
		md.push(row(['scenario', 'trial', 'turns', 'turn results', 'waves per turn', 'tool calls', 'model calls', 'repeated identical calls', 'longest run', 'tool errors', 'GATE_STATE failures', 'done refusals', 'confirms', 'tokens in/out/cache read', 'cost', 'est. tokens in/out', 'est. cost', 'wall s']));
		md.push(row(Array(18).fill('---')));
		for (const r of ran) {
			// a crashed trial's record is its log, with no diagnostics
			if (!Array.isArray(r.diagnostics.wavesPerTurn)) {
				md.push(row([r.scenario, r.trial, 'no record', ...Array(15).fill('-')]));
				continue;
			}
			const d = r.diagnostics as Record<string, unknown> & { tokens: { input: number; output: number; cacheRead: number } | null; estimatedTokens: { input: number; output: number } | null; estimatedCostUsd: number | null };
			md.push(row([r.scenario, r.trial, String(d.turns), ((d.turnResults as string[] | undefined) ?? []).join(', '), (d.wavesPerTurn as number[]).join('/'), String(d.toolCalls), String(d.modelCalls), String(d.repeated), String(d.longestRun), String(d.toolErrors), String(d.gateStateWriteFailures), String(d.doneRefusals), String(d.confirms), d.tokens ? `${d.tokens.input}/${d.tokens.output}/${d.tokens.cacheRead}` : 'not reported', d.costUsd === null || d.costUsd === undefined ? '-' : `$${(d.costUsd as number).toFixed(2)}`, d.estimatedTokens ? `${d.estimatedTokens.input}/${d.estimatedTokens.output}` : '-', d.estimatedCostUsd === null || d.estimatedCostUsd === undefined ? '-' : `~$${d.estimatedCostUsd.toFixed(2)}`, Math.round(Number(d.wallMs) / 1000)]));
		}
		md.push('');
	}

	if (comparisons.length) {
		md.push('## L1 against the recorded trials', '');
		md.push('A replay reproduces when its status and every check match the live trial it was recorded from, its final files are the same, each turn ends with the same TurnResult outcome and reason, every tool call has the same wave, tool, outcome, arguments and result, and it used every recorded reply.', '');
		md.push(row(['scenario', 'recording', 'reproduces', 'status recorded/replay', 'checks that differ', 'final files as recorded', 'turns and calls that differ', 'replay']));
		md.push(row(Array(8).fill('---')));
		for (const x of comparisons) {
			md.push(row([x.scenario, x.recording, reproduces(x) ? 'yes' : 'NO', `${x.status.recorded}/${x.status.replay}`, x.differ.map((d) => `${d.id} (${d.recorded}, replay ${d.replay})`).join('; ') || 'none', x.finalFiles.same ? 'yes' : `no: ${x.finalFiles.differ.join(', ')}`, x.mismatches.slice(0, 3).join('; ') || 'none', x.diverged ?? 'followed the recording']));
		}
		md.push('');
	}

	md.push('## Checks', '');
	for (const r of results.filter((x) => x.checks.length)) {
		md.push(`### ${r.scenario}${r.trial ? ` t${r.trial}` : ''} (${r.status})`, '');
		for (const ck of r.checks) md.push(`- ${ck.id} (${ck.kind}${ck.blocker ? ', blocker' : ''}): ${ck.status}${ck.detail ? `. ${ck.detail.slice(0, 300)}` : ''}`);
		if (r.record) md.push(`- record: ${r.record}`);
		md.push('');
	}
	const report = path.join(dir, 'report.md');
	fs.writeFileSync(report, scrub(md.join('\n')));

	return report;
}
