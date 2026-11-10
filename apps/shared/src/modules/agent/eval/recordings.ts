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
// RECORDINGS: a live L2 trial's model replies, for L1 replay
// =============================================================================

/**
 * L1 replays what a model said in a live L2 trial: every reply in the order
 * the trial asked, with how the trial scored and the files it ended with.
 * `run.ts record` makes one from an L2 run. A replay reproduces when it
 * scores every check the same, ends with the same files, ends each turn with
 * the same TurnResult outcome and reason, makes the same tool calls in the
 * same waves with the same arguments and, outside SERVED_READS, the same
 * results, and uses every reply. Anything else means the agent's loop, its
 * tools, what they read or the scoring changed how the recorded replies play
 * out: record again after a change that should do that.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isReferencePath } from '../../vfs/referenceTree';
import { DATA_DIR } from './catalog';
import type { RecordedTurn } from './models';
import { sha256 } from './score';
import type { CheckStatus, RecordedCall, RunStatus, ScenarioResult, TrialRecord, TurnRecord } from './types';

/** One tool call as a recording keeps it: digests of what the loop sent and what it got back. */
export interface CallDigest {
	wave: number;
	tool: string;
	ok: boolean;
	/** callDigest of the arguments. */
	args: string;
	/** callDigest of the result, or of the error when the call failed; '' for a SERVED_READS call. */
	result: string;
}

/** One recorded turn: the replies it got, how the product said it ended, and the calls it made. */
export interface RecordingTurn extends RecordedTurn {
	/** The turn's TurnResult outcome and reason, or null when it left none. */
	ended: { outcome: string; reason: string } | null;
	calls: CallDigest[];
}

/** One recording: a live trial's replies, how it scored and the files it ended with. */
export interface Recording {
	format: 3;
	scenario: string;
	set: string;
	trial: number;
	/** The live trial it came from. */
	source: { head: string; model: string; recordedAt: string };
	turns: RecordingTurn[];
	/** The step and cost limits the trial ran under (0 is off). */
	limits: { steps: number; costUsd: number };
	/** The trial's status and each check's status. */
	expected: { status: RunStatus; checks: Record<string, CheckStatus> };
	/** The final files' sha256, by path. */
	finalFiles: Record<string, string>;
}

export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

// =============================================================================
// CALL DIGESTS
// =============================================================================

/**
 * What can differ between a live trial and its replay when the loop sends and
 * gets the same things. Each is replaced before a call is hashed.
 */
const NONDETERMINISTIC: Array<[RegExp, string]> = [
	// the session id, which is the stand-in's project_id, and any other UUID
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
	// the fake engine's run tokens, numbered in the order the runs started
	[/\b(task|standin)-\d+\b/g, '$1-<n>'],
	// a run's start time, from the clock (engine.ts getTaskStatus)
	[/("startTime"\s*:\s*)\d+/g, '$1<time>'],
	// the synthetic Variable values each trial makes (canary.ts syntheticVariables)
	[/rrEvalVar[0-9a-f]{24}/g, '<variable>'],
];

// Reads of the guides under .rocketride/ and of the node catalog: their text changes with docs and services.json, not the agent, so only outcome and arguments count.
const SERVED_READS = { tools: new Set(['read_file', 'search_files', 'list_directory', 'stat_file']), methods: new Set(['getServices', 'getService']) };

function servedRead(c: RecordedCall): boolean {
	if (c.tool === 'rocketride_client') return SERVED_READS.methods.has(String(c.args.method));
	return SERVED_READS.tools.has(c.tool) && isReferencePath(String(c.args.path ?? '').replace(/^\/+/, ''));
}

/** JSON with object keys sorted, so the same value always gives the same text. */
export function stableJson(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
	return `{${Object.keys(v as object)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
		.join(',')}}`;
}

/**
 * The digest of what one call sent or got back, with the NONDETERMINISTIC parts replaced.
 *
 * @param value - The arguments, or the result or error text.
 * @returns Its sha256.
 */
export function callDigest(value: unknown): string {
	let text = typeof value === 'string' ? value : stableJson(value);
	for (const [re, to] of NONDETERMINISTIC) text = text.replace(re, to);
	return sha256(text);
}

function digestOf(c: RecordedCall): CallDigest {
	return { wave: c.wave, tool: c.tool, ok: c.error === undefined, args: c.argsHash, result: servedRead(c) ? '' : c.resultHash };
}

function endedOf(t: TurnRecord | undefined): RecordingTurn['ended'] {
	return t?.result ? { outcome: t.result.outcome, reason: t.result.reason } : null;
}

/**
 * Where a replay's turns differ from its recording's: how each turn ended, and
 * each call's wave, tool, outcome, arguments and result.
 *
 * @param recorded - The recording's turns.
 * @param replayed - The replay's turns.
 * @returns One line per difference; empty when they match.
 */
export function mismatches(recorded: RecordingTurn[], replayed: TurnRecord[]): string[] {
	const out: string[] = [];
	const said = (e: RecordingTurn['ended']) => (e ? `${e.outcome}/${e.reason}` : 'no result');
	const callSaid = (c: CallDigest | undefined) => (c ? `${c.tool} ${c.ok ? 'ok' : 'error'}` : 'none');
	for (let i = 0; i < Math.max(recorded.length, replayed.length); i++) {
		const want = recorded[i]?.ended ?? null;
		const got = endedOf(replayed[i]);
		if (said(want) !== said(got)) out.push(`turn ${i + 1} ended ${said(got)}, recorded ${said(want)}`);
		const wantCalls = recorded[i]?.calls ?? [];
		const gotCalls = (replayed[i]?.calls ?? []).filter((c) => !c.late).map(digestOf);
		for (let k = 0; k < Math.max(wantCalls.length, gotCalls.length); k++) {
			const [w, g] = [wantCalls[k], gotCalls[k]];
			const differ = w && g ? (['wave', 'tool', 'ok', 'args', 'result'] as const).filter((f) => w[f] !== g[f]) : null;
			if (!differ || differ.length) out.push(`turn ${i + 1} call ${k + 1}: recorded ${callSaid(w)}, replayed ${callSaid(g)}${differ ? `, differs in ${differ.join(', ')}` : ''}`);
		}
	}
	return out;
}

// =============================================================================
// RECORDINGS
// =============================================================================

/**
 * A recording of one scored L2 trial.
 *
 * @param record - The trial record.
 * @param result - Its score.
 * @param set - The recording set's name.
 * @param head - The commit the trial ran on.
 * @returns The recording, or why the trial cannot be one.
 */
export function fromTrial(record: TrialRecord, result: ScenarioResult, set: string, head: string): Recording | string {
	const label = `${record.scenario} trial ${record.trial}`;
	if (record.layer !== 'L2') return `${label} ran in ${record.layer}; only an L2 trial keeps its replies`;
	if (result.status === 'error') return `${label} is an error (${result.why}), so it did not run as the model would`;
	const limits = record.settings.limits as { steps?: number; costUsd?: number } | undefined;
	return {
		format: 3,
		scenario: record.scenario,
		set,
		trial: record.trial,
		source: { head, model: record.model, recordedAt: record.startedAt },
		turns: record.turns.map((t) => ({ request: t.request, events: t.replies, ended: endedOf(t), calls: t.calls.filter((c) => !c.late).map(digestOf) })),
		limits: { steps: limits?.steps ?? 0, costUsd: limits?.costUsd ?? 0 },
		expected: { status: result.status, checks: Object.fromEntries(result.checks.map((c) => [c.id, c.status])) },
		finalFiles: Object.fromEntries(Object.entries(record.finalFiles).map(([p, text]) => [p, sha256(text)])),
	};
}

/**
 * Every recording, sorted by scenario, set and trial.
 *
 * @returns Each recording with the path it was read from.
 */
export function loadRecordings(): Array<{ file: string; recording: Recording }> {
	if (!fs.existsSync(RECORDINGS_DIR)) return [];
	const out: Array<{ file: string; recording: Recording }> = [];
	for (const scenario of fs.readdirSync(RECORDINGS_DIR).sort()) {
		const dir = path.join(RECORDINGS_DIR, scenario);
		if (!fs.statSync(dir).isDirectory()) continue;
		for (const f of fs.readdirSync(dir).sort()) {
			if (f.endsWith('.json')) out.push({ file: path.join(dir, f), recording: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Recording });
		}
	}
	return out;
}

/**
 * Checks a recording's shape before it is replayed.
 *
 * @param r - The recording.
 * @param scenarios - The scenario ids that exist.
 * @returns Its problems; empty when it is usable.
 */
export function validateRecording(r: Recording, scenarios: Set<string>): string[] {
	const problems: string[] = [];
	if (r.format !== 3) problems.push(`format ${String(r.format)} is not 3; record it again with run.ts record`);
	if (!scenarios.has(r.scenario)) problems.push(`scenario ${r.scenario} does not exist`);
	if (!Array.isArray(r.turns) || r.turns.length === 0) problems.push('it has no turns');
	for (const [i, t] of (r.turns ?? []).entries()) {
		if (typeof t.request !== 'string' || !t.request) problems.push(`turn ${i + 1} has no request`);
		if (!Array.isArray(t.events) || t.events.length === 0) problems.push(`turn ${i + 1} has no replies`);
		if (!Array.isArray(t.calls) || t.ended === undefined) problems.push(`turn ${i + 1} has no calls or no ended`);
	}
	if (!r.expected?.checks) problems.push('it has no expected checks');
	if (!(Number.isFinite(r.limits?.steps) && r.limits.steps >= 0 && Number.isFinite(r.limits?.costUsd) && r.limits.costUsd >= 0)) problems.push('its limits are not two numbers of 0 or more');
	return problems;
}
