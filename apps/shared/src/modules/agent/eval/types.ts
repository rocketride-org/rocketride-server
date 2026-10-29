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
// EVAL TYPES: scenarios, trial records and results
// =============================================================================

/**
 * The shapes every part of the runner shares. A scenario is data under
 * `data/scenarios/`. A trial record is what one trial process writes. A
 * result is what scoring makes of a record.
 */

import type { TurnResult } from '../turn';
import type { RecordedEvent } from './models';

// =============================================================================
// SCENARIOS
// =============================================================================

/** Where a trial runs: L1 replays recorded replies on a fake engine, L2 asks a live model on a fake engine, L3 asks a live model on the real engine. */
export type Layer = 'L1' | 'L2' | 'L3';

/** One hidden check, in the order the scenario lists it. Its other fields depend on its kind. */
export interface ScenarioCheck {
	id: string;
	kind: string;
	path?: string;
	/** A blocker that fails makes the trial fail, however its last turn ended. */
	blocker?: boolean;
	[field: string]: unknown;
}

/**
 * One eval scenario. It starts from an empty workspace, and its reference
 * solution is `data/references/<id>.json`.
 */
export interface Scenario {
	id: string;
	prompt: string;
	/** What the simulated user sends when the agent asks, up to `max` times. */
	followup: { text: string; max: number };
	/** The Variable names the run has. */
	variables: string[];
	checks: ScenarioCheck[];
	/** What makes the scenario hard, which its checks are built around. */
	hard_because: string;
}

// =============================================================================
// TRIAL RECORD
// =============================================================================

/** One tool call the finish rule heard, as the loop handed it over. */
export interface RecordedCall {
	wave: number;
	tool: string;
	args: Record<string, unknown>;
	error?: string;
	late?: boolean;
	resultChars?: number;
	/** recordings.ts callDigest of the arguments, and of the result or error. */
	argsHash: string;
	resultHash: string;
}

/** One model call, measured. */
export interface ModelCallRecord {
	ms: number;
	questionChars: number;
	answerChars: number;
	/** Token counts the model call returned, when it returned any. */
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	error?: string;
}

/** One turn of the conversation. */
export interface TurnRecord {
	turn: number;
	request: string;
	waves: number;
	endedOnItsOwn: boolean;
	harnessStop: null | 'waves' | 'time';
	runError: null | string;
	wallMs: number;
	modelCalls: ModelCallRecord[];
	modelErrors: Array<{ kind: string; wave: number; callIndex: number; message: string }>;
	calls: RecordedCall[];
	refusals: Array<{ wave: number; text: string }>;
	thinking: string[];
	finalText: string;
	repeats: Array<{ tool: string; args: string; count: number; waves: number[] }>;
	toolErrors: number;
	gateStateWriteFailures: number;
	changed: boolean;
	asked: null | { rule: string; options: boolean };
	finishedAfter: boolean;
	reply: null | string;
	followupKind: null | 'approval' | 'retry';
	/** How the product says the turn ended (its TurnResult), or null when the turn left none, as a turn the harness cut off may. */
	result: null | TurnResultRecord;
	/** L2: the model's replies, in order, which `run.ts record` turns into an L1 recording. */
	replies: RecordedEvent[];
}

/** A turn's TurnResult as the record keeps it: no ids, no answer (the turn record has it), and the runs it started as a count. */
export type TurnResultRecord = Omit<TurnResult, 'turnId' | 'messageId' | 'finalText' | 'runsStarted'> & { runsStarted: number };

/** What a canary scan found for one canary_absent check. Names and surfaces only, never values. */
export interface CanaryScan {
	/** The surfaces the check lists. */
	surfaces: string[];
	/** The surfaces that could be read. */
	scanned: string[];
	/** The surfaces that could not be read, with why. */
	missing: Array<{ surface: string; why: string }>;
	/** Each canary seen, by name, and where. */
	hits: Array<{ surface: string; canary: string; count: number }>;
	/** How many values were scanned for. */
	values: number;
}

/** What run_output saw. Never a value from the run beyond a short excerpt. */
export interface RunOutputResult {
	status: 'pass' | 'fail' | 'pending';
	detail: string;
	excerpt?: string;
}

/** The validate a save or the end of the trial ran on one pipeline. */
export type ValidateResult = { errors: string[] } | { failed: string };

/** Everything one trial process writes. */
export interface TrialRecord {
	harness: string;
	layer: Layer;
	scenario: string;
	prompt: string;
	trial: number;
	startedAt: string;
	/** The model as the trial named it, such as `claude-sonnet-5` or `replay:<recording>`. */
	model: string;
	/** The model's settings. */
	settings: Record<string, unknown>;
	engine: unknown;
	engineVariables: string[];
	variablesMissing: string[];
	scope: unknown;
	maxFollowups: number;
	turns: TurnRecord[];
	approvalTurns: number;
	retryTurns: number;
	finished: boolean;
	endReason: string;
	totalWallMs: number;
	totalModelMs: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
	costUsd: number | null;
	confirms: Array<{ title: string; answer: string }>;
	shellMissing: string[];
	pipes: Array<{ path: string; validate: ValidateResult }>;
	finalFiles: Record<string, string>;
	/** Results of canary_absent checks, by check id. */
	canary: Record<string, CanaryScan>;
	/** Results of run_output checks, by check id. */
	runOutput: Record<string, RunOutputResult>;
	/** The session file and catalog the chat saved, when the save worked. */
	session: { saved: boolean; error?: string; messages: number };
	/** Set when the infrastructure failed: the engine, the provider, the runner, or a replay that left its recording. */
	infraError: string | null;
	/** L1 only: how the replay went. */
	replay: null | { recording: string; consumed: number; recorded: number; diverged: string | null; mismatches: string[] };
}

// =============================================================================
// RESULTS
// =============================================================================

/** How one check ended. `not_in_layer` checks are listed, never counted. */
export type CheckStatus = 'pass' | 'fail' | 'pending' | 'not_in_layer';

/** One check's result. */
export interface CheckResult {
	id: string;
	kind: string;
	status: CheckStatus;
	detail: string;
	blocker: boolean;
}

/** The seven ways a scenario run ends, counted separately. */
export type RunStatus = 'pass' | 'fail' | 'error' | 'incomplete' | 'needs_input' | 'abstain' | 'pending';

/** One scored trial. */
export interface ScenarioResult {
	scenario: string;
	layer: Layer;
	trial: number;
	model: string;
	status: RunStatus;
	/** Why the status is what it is, in one line. */
	why: string;
	checks: CheckResult[];
	blockersFired: string[];
	counted: { passed: number; total: number; pending: number; notInLayer: number };
	diagnostics: Record<string, unknown>;
	record: string | null;
}
