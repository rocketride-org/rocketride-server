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
// RECORDINGS — the baseline's model replies, rebuilt for L1 replay
// =============================================================================

/**
 * L1 replays what a model said in a recorded trial. The baseline harness
 * (round3/baseline/harness/trial.ts) did not keep the raw replies, but it kept
 * what they asked for: every tool call with its exact arguments and wave,
 * every thinking row (the reply's thought, then one line per call), every
 * model error and the final answer. `fromBaselineRecord` rebuilds each reply
 * from those, in the reply format Wave parses (wave/plan.ts):
 *
 * - A wave's reply is its thought and its calls. A call the finish rule never
 *   hears of (memory.peek, a call skipped for missing arguments) comes from its
 *   thinking line; its arguments beyond the one that line shows are not known.
 * - The accepted wave's reply is done=true with the recorded answer, minus the
 *   lines the code writes ("Checked:", "Not checked:").
 * - A turn that ended stop=error gets the recorded model error at its last
 *   wave, then the recorded best-effort answer.
 * - A retried reply (the first reply of a wave that was unusable) was not
 *   kept, so it is not replayed. The recording counts them.
 *
 * Each recording also carries the baseline's own check results for the trial
 * and the engine's validate verdicts on the trial's final files, keyed by
 * content hash, so L1 can compare its score with the baseline's and score
 * engine_validate where the file is byte for byte the one the engine checked.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './catalog';
import type { RecordedEvent, RecordedTurn } from './models';
import { sha256 } from './score';
import type { ValidateResult } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** One recording: a baseline trial's replies, its scores and its engine verdicts. */
export interface Recording {
	format: 1;
	scenario: string;
	set: string;
	trial: number;
	source: { record: string; harness: string; head: string; model: string };
	turns: RecordedTurn[];
	/** Replies the baseline retried, whose first (unusable) reply was not kept. */
	retriesNotReplayed: number;
	/** The baseline's check results for this trial (check_workspace.py). */
	baseline: { results: Array<{ id: string; kind: string; ok: boolean | null; msg: string }>; verdict: string; passed: number; counted: number };
	/** The engine's validate on each final .pipe, by content sha256. */
	verdicts: Record<string, ValidateResult>;
	/** The final files' sha256, by path. */
	finalFiles: Record<string, string>;
	/** The step and cost limits the trial ran under (0 is off). Absent: it was recorded before the agent had limits, so it replays with both off. */
	limits?: { steps: number; costUsd: number };
}

/** The parts of a baseline trial record the converter reads. */
interface BaselineTurn {
	request: string;
	stopReason: string;
	waves: number;
	runError: string | null;
	harnessStop: string | null;
	thinking: string[];
	finalText: string;
	modelCalls: unknown[];
	modelErrors?: Array<{ kind: string; wave: number; message: string }>;
	calls: Array<{ wave: number; tool: string; args: Record<string, unknown>; error?: string; late?: boolean }>;
	refusals?: Array<{ wave: number; text: string }>;
}

interface BaselineRecord {
	harness: string;
	modelProfile: string;
	variant: string;
	promptId: string;
	trial: number;
	turns: BaselineTurn[];
	pipes: Array<{ path: string; validate: ValidateResult }>;
	finalFiles: Record<string, string>;
}

// =============================================================================
// REBUILDING REPLIES
// =============================================================================

/** A call's thinking line: `- <tool>[ <target>] — ok` or `— error: ...` (loop.ts thinkingLine). */
const CALL_LINE = /^- (\S+)(?: (.*?))? — (ok|error: .*)$/;

/** Lines the code writes into the answer; the model never does (run.ts finalText). */
const OWNED_LINE = /^(?:Checked|Not checked)[*_]*:/;

/** The answer the model gave, without the lines the code added after it. */
function modelAnswer(finalText: string): string {
	return finalText
		.split('\n')
		.filter((line) => !OWNED_LINE.test(line.replace(/^[\s>*+_-]+/, '')))
		.join('\n')
		.trim();
}

/** A wave's reply: its thought and its calls, from the thinking row and the recorded calls. */
function waveReply(thinking: string | undefined, calls: BaselineTurn['calls'], done: { answer: string } | null): string {
	const lines = (thinking ?? '').split('\n');
	const callLines: Array<{ tool: string; target: string }> = [];
	while (lines.length) {
		const m = CALL_LINE.exec(lines[lines.length - 1]);
		if (!m) break;
		callLines.unshift({ tool: m[1], target: m[2] ?? '' });
		lines.pop();
	}
	const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	let next = 0;
	for (const line of callLines) {
		if (next < calls.length && calls[next].tool === line.tool) toolCalls.push({ tool: calls[next].tool, args: calls[next++].args });
		else if (line.tool === 'memory.peek') toolCalls.push({ tool: 'memory.peek', args: line.target ? { key: 'wave-0.r0', path: line.target } : { key: 'wave-0.r0' } });
		else toolCalls.push({ tool: line.tool, args: {} });
	}
	for (; next < calls.length; next++) toolCalls.push({ tool: calls[next].tool, args: calls[next].args });
	const reply: Record<string, unknown> = { thought: lines.join('\n').trim() };
	if (toolCalls.length) reply.tool_calls = toolCalls;
	if (done) {
		reply.done = true;
		reply.answer = done.answer;
	}
	return JSON.stringify(reply);
}

/** The model error a turn hit at its last wave, as the engine's LLM error answer. */
function errorAnswer(turn: BaselineTurn): string {
	const last = turn.modelErrors?.filter((e) => e.wave === turn.waves - 1).at(-1) ?? turn.modelErrors?.at(-1);
	if (last?.message.startsWith('**LLM error**')) return last.message;
	const provider = /^The model provider failed: ([\s\S]*)$/.exec(turn.runError ?? '');
	if (provider) return `**LLM error** — ${provider[1]}`;
	return '**LLM error** — ValueError: Failed to get valid JSON response after 3 attempts. (The baseline record predates error capture; this is the failure its summary names.)';
}

/**
 * Rebuilds one turn's replies.
 *
 * @param turn - The baseline turn.
 * @returns The turn, or why it cannot be replayed.
 */
function rebuildTurn(turn: BaselineTurn): RecordedTurn | string {
	if (turn.harnessStop) return `the turn was cut by the harness (${turn.harnessStop})`;
	const byWave = new Map<number, BaselineTurn['calls']>();
	for (const c of turn.calls.filter((x) => !x.late)) byWave.set(c.wave, [...(byWave.get(c.wave) ?? []), c]);
	const events: RecordedEvent[] = [];
	const last = turn.waves - 1;
	for (let w = 0; w < last; w++) {
		const refused = (turn.refusals ?? []).some((r) => r.wave === w);
		events.push({ wave: w, reply: waveReply(turn.thinking[w], byWave.get(w) ?? [], refused ? { answer: '(the recorded answer was refused; its text was not kept)' } : null) });
	}
	if (turn.stopReason === 'done') events.push({ wave: last, reply: waveReply(undefined, byWave.get(last) ?? [], { answer: modelAnswer(turn.finalText) }) });
	else if (turn.stopReason === 'error') events.push({ wave: last, error: errorAnswer(turn) }, { bestEffort: modelAnswer(turn.finalText) });
	else if (!turn.stopReason && turn.runError) events.push({ wave: last, error: errorAnswer(turn) });
	else return `stop reason ${turn.stopReason || '(none)'} is not replayable`;
	const recordedCalls = turn.calls.filter((c) => !c.late).map((c) => ({ wave: c.wave, tool: c.tool, ok: c.error === undefined }));
	return { request: turn.request, events, recorded: { stopReason: turn.stopReason, waves: turn.waves, finalText: turn.finalText, calls: recordedCalls } };
}

/**
 * Turns one baseline trial record and its checks into a recording.
 *
 * @param recordFile - The baseline record (`runs/<variant>/<prompt>-t<n>.json`).
 * @param set - The recording set's name, such as `claude-369f0511`.
 * @param head - The commit the baseline ran on.
 * @returns The recording, or why the trial cannot be replayed.
 */
export function fromBaselineRecord(recordFile: string, set: string, head: string): Recording | string {
	const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')) as BaselineRecord;
	const checksFile = recordFile.replace(/\.json$/, '.checks.json');
	if (!fs.existsSync(checksFile)) return 'no .checks.json beside it';
	const checks = JSON.parse(fs.readFileSync(checksFile, 'utf8')) as { results: Recording['baseline']['results']; score: { verdict: string; passed: number; counted: number } };
	const turns: RecordedTurn[] = [];
	for (const t of record.turns) {
		const rebuilt = rebuildTurn(t);
		if (typeof rebuilt === 'string') return rebuilt;
		turns.push(rebuilt);
	}
	const retries = record.turns.reduce((n, t) => {
		const expected = t.stopReason === 'error' ? t.waves + 1 : t.waves;
		return n + Math.max(0, t.modelCalls.length - expected);
	}, 0);
	const verdicts: Recording['verdicts'] = {};
	for (const p of record.pipes ?? []) {
		const text = record.finalFiles?.[p.path];
		if (text !== undefined && p.validate && ('errors' in p.validate || 'failed' in p.validate)) verdicts[sha256(text)] = p.validate;
	}
	const text = JSON.stringify({ turns, finalFiles: record.finalFiles });
	if (/sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}/.test(text)) return 'a key-shaped string is in the record; it is not copied';
	return {
		format: 1,
		scenario: record.promptId,
		set,
		trial: record.trial,
		source: { record: path.basename(path.dirname(recordFile)) + '/' + path.basename(recordFile), harness: record.harness, head, model: record.variant === 'scripted' ? 'scripted' : record.modelProfile },
		turns,
		retriesNotReplayed: retries,
		baseline: { results: checks.results, verdict: checks.score.verdict, passed: checks.score.passed, counted: checks.score.counted },
		verdicts,
		finalFiles: Object.fromEntries(Object.entries(record.finalFiles ?? {}).map(([p, t]) => [p, sha256(t)])),
	};
}

// =============================================================================
// LOADING
// =============================================================================

/** The folder recordings live in. */
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

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
	if (r.format !== 1) problems.push(`format ${String(r.format)} is not 1`);
	if (!scenarios.has(r.scenario)) problems.push(`scenario ${r.scenario} does not exist`);
	if (!Array.isArray(r.turns) || r.turns.length === 0) problems.push('it has no turns');
	for (const [i, t] of (r.turns ?? []).entries()) {
		if (typeof t.request !== 'string' || !t.request) problems.push(`turn ${i + 1} has no request`);
		if (!Array.isArray(t.events) || t.events.length === 0) problems.push(`turn ${i + 1} has no replies`);
	}
	if (!r.baseline || !Array.isArray(r.baseline.results)) problems.push('it has no baseline results');
	if (r.limits !== undefined && !(Number.isFinite(r.limits.steps) && r.limits.steps >= 0 && Number.isFinite(r.limits.costUsd) && r.limits.costUsd >= 0)) problems.push('its limits are not two numbers of 0 or more');
	return problems;
}
