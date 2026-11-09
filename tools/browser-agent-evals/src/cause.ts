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
// CAUSE: who a failed trial's failure belongs to
// =============================================================================

/**
 * Task 2.5. Every failed trial carries one label, with its evidence:
 *
 * - runner: the runner itself broke (a driver exception, a failed store
 *   reset or sign-in, a task it cannot drive yet), or a key reached its evidence;
 * - environment: the model could not be used. The known-good call failed (one
 *   question through the same one-node pipeline the Agent tab runs, made
 *   right after every trial and recorded in its result, smoke-models.ts), the picker said the key was
 *   missing, or the turn's error is a provider's;
 * - agent: everything else.
 *
 * The rules apply in that order. Provider errors can come back as
 * normal-looking answers, so the known-good call is the signal to trust.
 */

import type { SmokeRow } from './smoke-models';
import type { TrialResult } from './grade';
import type { BrowserTrialRecord } from './trial';

export type CauseLabel = 'agent' | 'environment' | 'runner';

/** A failed trial's label and the evidence for it. */
export interface Cause {
	label: CauseLabel;
	evidence: string;
	/** The known-good call made after the trial, when one was made. */
	knownGood?: { model: string; answered: boolean; seconds: number; detail: string };
}

/** Statuses that are not failures, so they get no label. */
const NOT_FAILED = new Set(['pass', 'pending']);

/** A run error that comes from the engine's own install, not from the pipeline the agent wrote. */
const ENGINE_INSTALL = /No module named|ModuleNotFoundError|ImportError|incompatible Protobuf|cannot open shared object/i;

/** Error text that a provider or the model path produces, not the agent. */
const PROVIDER_ERROR = /\*\*LLM error\*\*|\b(401|403|429|500|502|503|529)\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication|rate[ _-]?limit|overloaded|quota|could not be reached|not_found_error|ModelNotFound|Profile .* is not defined/i;

/**
 * The label of a graded trial, or null when it did not fail.
 *
 * @param result - The trial's grade.
 * @param record - The trial's record.
 * @param knownGood - The known-good call made after the trial, if any.
 */
export function causeOf(result: TrialResult, record: BrowserTrialRecord, knownGood: SmokeRow | null): Cause | null {
	if (NOT_FAILED.has(result.status)) return null;
	const kg = knownGood ? { knownGood: { model: knownGood.model, answered: knownGood.answered, seconds: knownGood.seconds, detail: knownGood.detail } } : {};
	if (record.browser.leaks.length) return { label: 'runner', evidence: `a key reached the trial's evidence: ${record.browser.leaks.map((l) => `${l.key} in ${l.file}`).join(', ')}`, ...kg };
	if (record.endReason === 'runner_error' || record.endReason === 'not_supported') return { label: 'runner', evidence: `${record.endReason}: ${record.infraError ?? ''}`, ...kg };
	if (knownGood && !knownGood.answered) return { label: 'environment', evidence: `the known-good call to ${knownGood.model} failed: ${knownGood.detail}`, ...kg };
	if (record.endReason === 'environment') return { label: 'environment', evidence: record.infraError ?? 'the model key is missing', ...kg };
	const broken = result.checks.find((c) => c.status === 'fail' && ENGINE_INSTALL.test(c.detail));
	if (broken) return { label: 'environment', evidence: `check ${broken.id} failed inside the engine: ${broken.detail.slice(0, 200)}`, ...kg };
	const turn = record.turns.at(-1)?.result;
	const errorText = [turn?.error ?? '', record.turns.at(-1)?.finalText ?? ''].join('\n');
	if (turn?.outcome === 'failed' && PROVIDER_ERROR.test(errorText)) return { label: 'environment', evidence: `the turn failed with a provider error: ${(turn.error ?? '').slice(0, 200)}`, ...kg };
	return { label: 'agent', evidence: `${result.status}: ${result.why.slice(0, 200)}${knownGood ? `; the known-good call to ${knownGood.model} answered in ${knownGood.seconds}s` : ''}`, ...kg };
}
