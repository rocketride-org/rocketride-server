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
// WAVE LOOP — plan, act, check, until the model is done
// =============================================================================

/**
 * One run of the agent: each wave asks the model for a plan, runs its tool calls, and feeds their
 * summaries into the next question. An answer is accepted only when the host's `FinishRule` finds
 * nothing unchecked; the loop only tells it what each wave ran. A port of Wave's driver
 * (`nodes/src/nodes/agent_rocketride/rocketride_agent.py`) and its executor's bookkeeping. The
 * texts the model reads match Wave's word for word, because Wave's prompt teaches the model to read
 * them. One deviation: the bad-reply note goes in the question's context, not its instructions, so
 * the cached start stays identical.
 */

import { redactText } from '../toolkits/common';
import type { SecretMarkers } from '../toolkits/secretMarkers';
import { RefusedError, type AgentTool, type ToolAct, type ToolStep, type UserTime } from '../tools';
import { CostLimitError } from '../usage';
import { MEMORY_PEEK_TOOL, peek, resolveAnswerRefs, resolveArgRefs, resultKey, RunMemory } from './memory';
import { buildWaveQuestion, heardText, parseReply, type PromptPrefix } from './plan';
import type { HistoryTurn, ModelCall, PlanReply, QuestionSpec, ResultEntry, StopReason, ToolCall } from './plan';
import { previewArgs, summarize, withCommas } from './summary';

// =============================================================================
// OPTIONS AND RESULT
// =============================================================================

/** One call as the finish rule hears it: what ran, with what, and how it ended. */
export interface RanCall {
	tool: string;
	/** The arguments it ran with (references filled in), or as written when they could not be filled in. */
	args: Record<string, unknown>;
	/** The result text, when the call worked. */
	result?: string;
	/** Why the call failed or did not run; a timed-out call says so here. */
	error?: string;
	/** True for a call that timed out in an earlier wave and has since ended; `result` or `error` is how it ended, which the model never read. */
	late?: true;
}

/**
 * What decides whether the work is checked. The host supplies it; the loop
 * tells it what each wave ran and asks it before accepting a done=true. The
 * loop itself still refuses while a timed-out call runs, and in the wave the
 * check tool is called (the model has not read its result yet).
 */
export interface FinishRule {
	/** The tool that checks the work: done=true waits a wave after a call to it, and calling it again is never a repeat. */
	readonly checkTool: string;
	/** A wave starts; `wave` counts from 0. */
	beginWave(wave: number): void;
	/**
	 * A wave's calls have ended.
	 *
	 * @param calls - Every call the wave ran, in call order (memory.peek and calls skipped for missing arguments are left out), then each timed-out call that has ended since the last wave.
	 */
	endWave(calls: RanCall[]): Promise<void>;
	/**
	 * Why the run may not finish yet.
	 *
	 * @returns A refusal naming what is still unchecked, in Wave's style ("Not finished: … before done=true."), or null when nothing is.
	 */
	unchecked(): string | null;
}

/** What a run needs. */
export interface LoopOptions {
	/** What the user asked for. */
	request: string;
	/** Earlier conversation turns, oldest first. */
	history: HistoryTurn[];
	/** The fixed start of every wave question (see buildPrefix). */
	prefix: PromptPrefix;
	/** The tools the model may call, the finish rule's check tool among them. */
	tools: AgentTool[];
	/** Asks the model one question. */
	model: ModelCall;
	finish: FinishRule;
	/** Sends one chunk of progress text to the user. */
	emit: (type: 'thinking', text: string) => void;
	/** The time limit for a tool's calls, in milliseconds; anything but a positive number means TOOL_TIMEOUT_MS. */
	timeoutMs?: (tool: string) => number;
	/** Aborted when the user stops the run; the loop then starts nothing new and ends. */
	signal: AbortSignal;
	/** Takes the messages the user sent since the last take, oldest first. */
	takeQueued: () => string[];
	/**
	 * Lets a prepared call whose step names an act start: resolves with the work to start, or
	 * rejects with the refusal the model reads. Called between prepare and run with the call's
	 * clock stopped, so the user's think time never counts against a limit.
	 */
	approve: (act: ToolAct, run: () => Promise<string>) => Promise<() => Promise<string>>;
	/** The values the file tools hid this run; any other result that quotes one shows its marker. */
	secrets?: SecretMarkers;
	/** Notes for each wave's question (files someone else changed); they go in its context, so the cached start stays the same. */
	notes?: () => string[];
	/** The time the user spends answering tool questions; no call's time limit runs while one is open. */
	userTime?: UserTime;
	/**
	 * Asked after each wave's calls. Text means a call ended the turn to wait
	 * for the user (ask_user): the run stops with 'needs_input', and the text
	 * is its answer.
	 */
	endTurn?: () => string | null;
	/** Drops the question endTurn gave, so the model can ask again. */
	withdrawAsk?: () => void;
	/**
	 * The step limit: the most waves the run takes. Once that many have run,
	 * it plans no more, answers from what it gathered, and stops with
	 * 'limited'. 0 or unset means no limit.
	 */
	maxWaves?: number;
}

/** How a run ended. */
export interface LoopResult {
	/** The answer for the user, with its memory references filled in ('' for a stopped run). */
	answer: string;
	stopReason: StopReason;
	/** How many waves ran, counting the one the run stopped in. */
	waves: number;
	/** How long each model call took, in milliseconds, in call order. */
	modelMs: number[];
	/** How many tool calls the model planned, memory.peek and skipped calls included. */
	toolCalls: number;
}

/** The time limit for a tool call when the options set none: 5 minutes, Wave's default. */
export const TOOL_TIMEOUT_MS = 300_000;

// =============================================================================
// TEXTS — Wave's words, which its prompt teaches the model to read
// =============================================================================

/** The tool the loop runs itself. */
const PEEK_TOOL = MEMORY_PEEK_TOOL.name;

/** Why a done with a check in the same reply is sent back: the model has not read the check's result yet. */
function readTheCheck(checkTool: string): string {
	return `Not finished: read the result of ${checkTool} before done=true.`;
}

const STOPPED_WHILE_RUNNING = 'Still running when the run was stopped; it may still finish.';

const STOPPED_BEFORE_START = 'Not run: the run was stopped first.';

const READ_THE_LATE = 'Not finished: read how the call(s) that timed out ended (the entries marked late) before done=true.';

const LATE_NOTE = 'This call timed out and has now ended; this is how it ended. Plan again any call that was not run while it was still running.';

const STILL_RUNNING = 'Still running when you stopped (these may still finish and change the work):';

const READ_THE_USER = 'Not finished: the user wrote to you while you worked. Read "Messages from the user during this run" before done=true.';

const ASKED_UNSEEN = 'Not asked: the user wrote to you before they saw your question. Read "Messages from the user during this run", then call ask_user again if you still need to.';

/** The role of the best-effort question: a plain answer, not a plan. */
const FALLBACK_ROLE = 'You are a helpful assistant.';

const FALLBACK_QUESTION = 'Based on the above, provide a complete and accurate final answer. The work stopped before it was finished: if something the goal needs is still unknown, say what is missing rather than guessing.';

const FALLBACK_PREVIEW_CHARS = 2000;

const THINKING_ERROR_CHARS = 200;

/** The arguments that name what a call works on, in the order a thinking line looks for them. */
const PRIMARY_ARGS = ['path', 'oldPath', 'target', 'app', 'name', 'task_token', 'project_id', 'method'];

/** The error of a call held back because an earlier call on its files timed out and still runs. */
function heldBackMessage(waitsFor: ToolCall): string {
	const target = primaryArg(waitsFor.args);
	return `Not run: it waits for ${waitsFor.tool}${target ? ` on ${target}` : ''}, which timed out and is still running. You will be told when that call ends; then plan this one again.`;
}

/** The note that sends an unusable reply back, for that one call. */
function retryNote(problems: string[]): string {
	return `Your previous reply was not usable: ${problems.join('; ')}. Reply with exactly one of the two shapes in Response Format.`;
}

/** The entry telling the model why its done=true was not accepted. */
function refusal(wave: number, message: string): ResultEntry {
	return { tool: 'reply-check', key: `wave-${wave}.done`, error: message };
}

/** The entries for what a usable reply got wrong: a bad remove only tidies memory, so it is a note; anything else was dropped, so it is an error. */
function problemEntries(wave: number, problems: string[]): ResultEntry[] {
	return problems.map((problem, i) => {
		const key = `wave-${wave}.check${i}`;
		return problem.startsWith('remove') ? { tool: 'reply-check', key, note: `Ignored: ${problem}` } : { tool: 'reply-check', key, error: `Skipped: ${problem}` };
	});
}

/** The error for a call left out of required arguments: it names them and shows where arguments go. */
function skipMessage(tool: string, missing: string[]): string {
	return `Skipped: ${tool} is missing required argument(s) ${missing.map((name) => `'${name}'`).join(', ')}. Put arguments under "args": {"tool": "${tool}", "args": {...}}`;
}

/** An error's message, for whatever was thrown. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// ENTRIES — what a call leaves in the next prompt
// =============================================================================

/** A result entry; a memory.peek entry also carries Wave's peek fields beside the call's. */
interface Entry extends ResultEntry {
	/** The path the peek read. */
	path?: string;
	/** What the peek read. */
	preview?: string;
	/** Whether a path peek's array was capped. */
	truncated?: boolean;
	/** How many array items a capped peek returned. */
	returned_items?: number;
	/** How many items the capped array has. */
	total_items?: number;
	/** Where a chunk peek started. */
	offset?: number;
	/** How many characters a chunk peek returned. */
	length?: number;
	total_chars?: number;
}

/** A call made ready to run: its arguments resolved, or why it cannot run, or its peek already read. `skipped` marks a call left out for missing required arguments. */
type Prepared = { call: ToolCall; args: Record<string, unknown> } | { call: ToolCall; entry: Entry; skipped?: true };

/** What a wave's calls left behind, in call order. */
interface Acted {
	/** One entry per call. */
	entries: Entry[];
	/** The calls the finish rule hears about: all but memory.peek and those left out for missing required arguments, which neither changed the work nor checked it. */
	ran: RanCall[];
}

/** A call that timed out: what it was, and how it ended once it did. */
interface LateCall {
	call: ToolCall;
	/** How it ended; unset while it runs. */
	ended?: { result: string } | { error: string };
}

/** A canonical text of a value, keys sorted, so two equal calls give the same text. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
		return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	});
}

/** The value stored under a key, storing `value` first when nothing is (Python's setdefault). */
function setDefault(map: Map<string, string>, key: string, value: string): string {
	const prior = map.get(key);
	if (prior !== undefined) return prior;
	map.set(key, value);
	return value;
}

/** The first non-empty string among the arguments that name what a call works on, or ''. */
function primaryArg(args: Record<string, unknown>): string {
	for (const name of PRIMARY_ARGS) {
		const value = args[name];
		if (typeof value === 'string' && value) return value;
	}
	return '';
}

/** A call's tool and what it worked on. */
function callName(call: ToolCall): string {
	const target = primaryArg(call.args);
	return `${call.tool}${target ? ` ${target}` : ''}`;
}

/** One thinking line for a call: what it worked on, and whether it worked. */
function thinkingLine(call: ToolCall, entry: Entry): string {
	const outcome = entry.error === undefined ? 'ok' : `error: ${entry.error.slice(0, THINKING_ERROR_CHARS)}`;
	return `- ${callName(call)} — ${outcome}`;
}

// =============================================================================
// BEST EFFORT — the answer when the run ends unfinished
// =============================================================================

/** A memory.peek entry as one line: what was read, the data, and whether it is all of it (Wave's `_peek_line`). */
function peekLine(entry: Entry): string {
	let text = entry.preview ?? '';
	if (text.length > FALLBACK_PREVIEW_CHARS) {
		text = `${text.slice(0, FALLBACK_PREVIEW_CHARS)} ... (cut at ${withCommas(FALLBACK_PREVIEW_CHARS)} of ${withCommas(text.length)} characters)`;
	}
	const notes: string[] = [];
	if (entry.truncated) notes.push(`showing ${entry.returned_items} of ${entry.total_items} items`);
	if (typeof entry.total_chars === 'number') {
		const start = entry.offset ?? 0;
		notes.push(`characters ${withCommas(start)} to ${withCommas(start + (entry.length ?? 0))} of ${withCommas(entry.total_chars)}`);
	}
	const where = entry.path ? `${entry.path} = ` : '';
	return where + text + (notes.length ? ` (${notes.join('; ')})` : '');
}

/** An entry as one line of what was gathered; errors are named, so the answer does not read them as success. */
function gatheredLine(entry: Entry): string {
	if (entry.error !== undefined) return `- ${entry.tool}: ERROR — ${entry.error}`;
	if ('preview' in entry) return `- ${entry.tool}: ${peekLine(entry)}`;
	return `- ${entry.tool}: ${entry.summary ?? ''}`;
}

/** The answer when even the best-effort call fails: the cause, then the notes and facts as they stand (Wave's `_partial_report`). */
function partialReport(cause: string, lines: string[], scratch: string): string {
	const parts = [`I could not finish: ${cause}.`];
	if (scratch) parts.push('', 'My working notes:', scratch);
	if (lines.length) parts.push('', 'What I gathered:', ...lines);
	return parts.join('\n');
}

/** Whether a run that ends this way pauses at a limit, for Continue. */
function pauses(reason: StopReason): boolean {
	return reason === 'limited' || reason === 'cost_limit';
}

// =============================================================================
// WAVE SCHEDULING — which calls run together, which wait, and how long each may take
// =============================================================================

/**
 * Wave starts every call in a wave at once, which is wrong for calls that change the same file.
 * Here a call starts once every earlier call in the wave whose write paths overlap its own has
 * finished or timed out; a call with no write paths never waits. A call over its per-tool limit is
 * reported as timed out and the wave moves on. The tool cannot be cancelled, so its promise goes
 * into `late` until the loop reads how it ended.
 */

// =============================================================================
// OUTCOMES — what a call left behind
// =============================================================================

/**
 * How one call ended. `unstarted` marks a call that changed nothing: its work never began (prepare
 * failed, act refused, stopped first, or held back behind a timed-out call), or its tool refused it
 * with a RefusedError. The finish rule does not hear of it.
 */
export type CallOutcome = { ok: true; result: string; ms: number } | { ok: false; error: string; ms: number; timedOut: boolean; unstarted?: true };

/**
 * Shows each value the file tools hid as its marker, then runs redactText. Every outcome passes
 * here before anything reads it, so no credential reaches the stored result, the next question, a
 * thinking line or the finish rule.
 */
function redactOutcome(outcome: CallOutcome, secrets?: SecretMarkers): CallOutcome {
	return outcome.ok ? { ...outcome, result: hideSecrets(outcome.result, secrets) } : { ...outcome, error: hideSecrets(outcome.error, secrets) };
}

/** A tool's text with each value the file tools hid shown as its marker, then passed through redactText. */
function hideSecrets(text: string, secrets?: SecretMarkers): string {
	return redactText(secrets ? secrets.hideKnown(text) : text);
}

// =============================================================================
// WRITE PATHS — what a call changes
// =============================================================================

/**
 * Spells a path argument as the file tools do (the first steps of `normalizePath` in
 * `../toolkits/filesystem.ts`), so two spellings of one file compare equal. `.` and `..` are left
 * for the tool to refuse.
 */
function cleanPath(value: unknown): string[] {
	const path = String(value ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((segment) => segment.length > 0)
		.join('/');
	return path ? [path] : [];
}

/**
 * The workspace paths a call changes, spelled as the file tools spell them (see `cleanPath`).
 * Reads and every tool that does not touch workspace files return `[]`, as does
 * a call whose path argument is missing or empty (the tool itself reports that).
 */
function writePaths(call: ToolCall): string[] {
	const { args } = call;
	switch (call.tool) {
		case 'write_file':
		case 'edit_file':
		case 'create_directory':
		case 'delete_file':
			return cleanPath(args.path);
		case 'rename':
			return [...cleanPath(args.oldPath), ...cleanPath(args.newPath)];
		case 'create_app':
			return typeof args.appName === 'string' ? cleanPath(`apps/${args.appName}-ui`) : [];
		default:
			return [];
	}
}

/** True when one path equals the other or is a folder holding it (`apps/x` holds `apps/x/a.ts`, not `apps/xy`). */
function pathsTouch(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when any path in `a` equals, holds or sits under any path in `b`. Empty lists never overlap. */
function overlaps(a: string[], b: string[]): boolean {
	return a.some((x) => b.some((y) => pathsTouch(x, y)));
}

// =============================================================================
// ONE CALL — prepare it, let it through, run it against its time limit
// =============================================================================

/** How the loop gets a call ready and lets it start. */
interface CallSteps {
	/** Gets the call's tool ready with its arguments; throws for a tool the run does not have. */
	prepare: (call: ToolCall) => Promise<ToolStep>;
	approve: LoopOptions['approve'];
}

/** How a piece of work ended against its limit. `clockMs` is the part of `ms` its clock ran, without the time a tool question held it. */
type Timed<T> = { ok: true; value: T; ms: number; clockMs: number } | { ok: false; error: string; ms: number; clockMs: number; timedOut: boolean; refused?: true };

/** What a call the stop kept from starting settles with. */
function notStarted(ms: number): CallOutcome {
	return { ok: false, error: STOPPED_BEFORE_START, ms, timedOut: false, unstarted: true };
}

/**
 * Runs one call and settles with its outcome; never rejects. prepare is timed, and a failure,
 * timeout or stop there is `unstarted`. approve runs only when the step names an act, with the
 * clock stopped; a refusal is `unstarted`. run gets what the limit has left, and a timeout or stop
 * cuts it loose into `late`. `ms` counts prepare and run, never the approval wait or an open tool
 * question. A RefusedError from the run is `unstarted`.
 */
async function runOne(call: ToolCall, steps: CallSteps, limitMs: number, late: Map<Promise<unknown>, LateCall>, signal: AbortSignal, userTime?: UserTime): Promise<CallOutcome> {
	// a call that waited on an overlapping write starts after a stop through here
	if (signal.aborted) return notStarted(0);
	const ready = await timed(() => steps.prepare(call), limitMs, signal, undefined, 0, userTime);
	if (signal.aborted) return notStarted(ready.ms);
	if (!ready.ok) return { ok: false, error: ready.error, ms: ready.ms, timedOut: ready.timedOut, unstarted: true };

	const { act, run } = ready.value;
	let work = run;
	if (act) {
		try {
			work = await steps.approve(act, run);
		} catch (error) {
			return { ok: false, error: messageOf(error), ms: ready.ms, timedOut: false, unstarted: true };
		}
		if (signal.aborted) return notStarted(ready.ms);
	}

	const done = await timed(work, limitMs, signal, (running) => trackLate(late, call, running), ready.clockMs, userTime);
	if (done.ok) return { ok: true, result: done.value, ms: ready.ms + done.ms };
	return { ok: false, error: done.error, ms: ready.ms + done.ms, timedOut: done.timedOut, ...(done.refused ? { unstarted: true as const } : {}) };
}

/**
 * Runs `work` against a limit; never rejects. The work cannot be cancelled, so a timeout or stop
 * hands it to `cutLoose`. `spentMs` of the limit is already used, and the clock stands still while
 * `userTime` has a question open.
 */
function timed<T>(work: () => Promise<T>, limitMs: number, signal: AbortSignal, cutLoose?: (running: Promise<T>) => void, spentMs = 0, userTime?: UserTime): Promise<Timed<T>> {
	const began = performance.now();
	const elapsed = (): number => Math.round(performance.now() - began);
	const leftMs = Math.max(1, limitMs - spentMs);

	return new Promise<Timed<T>>((resolve) => {
		let over = false;
		const running = new Promise<T>((done) => done(work()));

		// step: the clock runs only while no tool question is open; `left` is what remains of the limit
		const limited = Number.isFinite(limitMs) && limitMs > 0;
		let left = leftMs;
		let since = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const expire = (): void => {
			over = true;
			stopHearing();
			signal.removeEventListener('abort', cut);
			cutLoose?.(running);
			resolve({ ok: false, error: `TimeoutError: no result after ${limitMs / 1000} s`, ms: elapsed(), clockMs: leftMs, timedOut: true });
		};
		const arm = (): void => {
			since = performance.now();
			timer = setTimeout(expire, left);
		};
		const pauseOrResume = (): void => {
			if (over || settled) return;
			if (userTime?.asking) {
				if (timer === undefined) return;
				clearTimeout(timer);
				timer = undefined;
				left = Math.max(0, left - (performance.now() - since));
			} else if (timer === undefined) arm();
		};
		const stopHearing = limited && userTime ? userTime.subscribe(pauseOrResume) : () => undefined;
		if (limited && !userTime?.asking) arm();
		// step: the limit used so far, read before the timer is cleared; with no limit it is the elapsed time
		const used = (): number => (limited ? Math.round(leftMs - (timer === undefined ? left : Math.max(0, left - (performance.now() - since)))) : elapsed());

		const cut = (): void => {
			if (over) return;
			over = true;
			const clockMs = used();
			clearTimeout(timer);
			stopHearing();
			cutLoose?.(running);
			resolve({ ok: false, error: STOPPED_WHILE_RUNNING, ms: elapsed(), clockMs, timedOut: false });
		};
		// checked after the work started on purpose: its own synchronous work may have stopped the run
		if (signal.aborted) cut();
		else signal.addEventListener('abort', cut, { once: true });

		const end = (outcome: Timed<T>): void => {
			signal.removeEventListener('abort', cut);
			if (over) return;
			settled = true;
			clearTimeout(timer);
			stopHearing();
			resolve(outcome);
		};
		running.then(
			(value) => end({ ok: true, value, ms: elapsed(), clockMs: used() }),
			(error: unknown) => end({ ok: false, error: messageOf(error), ms: elapsed(), clockMs: used(), timedOut: false, ...(error instanceof RefusedError ? { refused: true as const } : {}) })
		);
	});
}

/**
 * Tracks a call cut loose into `late` until lateReturns() hands over how it ended, so a call that
 * ends before the rest of its wave is still reported. Never rejects, so a late failure is not an
 * unhandled rejection.
 */
function trackLate(late: Map<Promise<unknown>, LateCall>, call: ToolCall, running: Promise<string>): void {
	const lateCall: LateCall = { call };
	const tracked: Promise<void> = running.then(
		(result) => {
			lateCall.ended = { result };
		},
		(error: unknown) => {
			lateCall.ended = { error: messageOf(error) };
		}
	);
	late.set(tracked, lateCall);
}

// =============================================================================
// WAVE — all the calls, in planned order where they touch the same files
// =============================================================================

/**
 * Runs a wave's calls and returns their outcomes in call order. A call starts once every earlier
 * call with overlapping write paths has settled, so calls on different files overlap and calls on
 * one file run as planned. A call is not started when an earlier overlapping call ran past its
 * limit or was held back, or when a timed-out call from an earlier wave still runs on its files: it
 * would land under a change still on its way. A failed prepare or refused act holds nothing back.
 */
async function runWave(calls: ToolCall[], steps: CallSteps, opts: { timeoutMs: (tool: string) => number; late: Map<Promise<unknown>, LateCall>; signal: AbortSignal; userTime?: UserTime }): Promise<CallOutcome[]> {
	const held = calls.map(writePaths);
	const outcomes: Promise<CallOutcome>[] = [];
	// the timed-out call each held-back call waits for, by index; set before that call's outcome settles
	const waitsFor: (ToolCall | undefined)[] = [];
	const holdBack = (i: number, blocking: ToolCall): CallOutcome => {
		waitsFor[i] = blocking;
		return { ok: false, error: heldBackMessage(blocking), ms: 0, timedOut: false, unstarted: true };
	};
	// step: a call that timed out in an earlier wave and still runs holds its files too
	const running = [...opts.late.values()].filter((late) => !late.ended);

	calls.forEach((call, i) => {
		const blocking = running.find((late) => overlaps(held[i], writePaths(late.call)));
		if (blocking) {
			outcomes.push(Promise.resolve(holdBack(i, blocking.call)));
			return;
		}
		const earlier = outcomes.flatMap((outcome, j) => (overlaps(held[i], held[j]) ? [{ outcome, j }] : []));
		const start = (): Promise<CallOutcome> => runOne(call, steps, opts.timeoutMs(call.tool), opts.late, opts.signal, opts.userTime);
		// With nothing to wait for, the call starts now, in this turn, so unrelated calls overlap fully.
		if (earlier.length === 0) {
			outcomes.push(start());
			return;
		}
		outcomes.push(
			Promise.all(earlier.map((e) => e.outcome)).then((settled) => {
				// step: an earlier call on these files ran past its limit (it may still land) or waits for one that did: so does this one
				for (const [k, before] of settled.entries()) {
					const { j } = earlier[k];
					const waits = waitsFor[j];
					if (waits) return holdBack(i, waits);
					if (!before.ok && before.timedOut && !before.unstarted) return holdBack(i, calls[j]);
				}
				return start();
			})
		);
	});

	return Promise.all(outcomes);
}

// =============================================================================
// RUN — the state of one run, and its steps
// =============================================================================

/** Thrown when the run is stopped while a model call is in flight. */
class RunStopped extends Error {}

/** Settles as `work` does, or rejects with RunStopped once the signal aborts; a later result or failure of `work` is dropped. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = (): void => reject(new RunStopped());
		if (signal.aborted) stop();
		else signal.addEventListener('abort', stop, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener('abort', stop);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', stop);
				reject(error);
			}
		);
	});
}

/** One run's memory, results and timed-out calls. */
class WaveRun {
	/** Every stored tool result. */
	readonly memory = new RunMemory();
	/** How long each model call took. */
	readonly modelMs: number[] = [];
	/** How many tool calls the model planned. */
	toolCalls = 0;
	/** The model's working notes, carried from wave to wave. */
	scratch = '';
	/** Every message the user sent during this run, oldest first; each later question shows them in its context. */
	readonly heard: string[] = [];
	/** What every earlier call left behind, oldest first; what the next question shows. */
	private results: Entry[] = [];
	/** The calls that timed out, by the promise that settles when each ends; each stays until lateReturns() hands over how it ended. */
	private readonly late = new Map<Promise<unknown>, LateCall>();
	/** Each call (tool and arguments as written) by the key of its first result. */
	private readonly seenCalls = new Map<string, string>();
	/** Each stored result's text by the key that first held it. */
	private readonly seenResults = new Map<string, string>();
	private readonly removed = new Set<string>();
	private readonly tools: Map<string, AgentTool>;

	constructor(private readonly o: LoopOptions) {
		this.tools = new Map(o.tools.map((tool) => [tool.name, tool]));
	}

	/** Whether the run has anything to answer from: a result, or notes. */
	get gathered(): boolean {
		return this.results.length > 0 || this.scratch.length > 0;
	}

	/**
	 * Takes the messages the user sent since the last take into `heard`, and
	 * returns how many came. Each passes through redactText first: a mid-run
	 * message never goes through AgentSession.execute, so a key pasted into
	 * one would otherwise reach every later question.
	 */
	hear(): number {
		const taken = this.o.takeQueued();
		this.heard.push(...taken.map(redactText));
		return taken.length;
	}

	/** Asks the model, timing the call; a stop rejects at once with RunStopped. */
	private async ask(q: QuestionSpec): Promise<string> {
		const began = performance.now();
		try {
			return await untilStopped(this.o.model(q), this.o.signal);
		} finally {
			this.modelMs.push(Math.round(performance.now() - began));
		}
	}

	/**
	 * Asks for this wave's plan. A reply with nothing to run and no answer is
	 * sent back once, its problems in a note at the end of the context. The
	 * retry was asked only to fix its shape, so the first reply's notes stand
	 * unless the retry writes new ones.
	 */
	async plan(): Promise<PlanReply> {
		const notes = this.o.notes?.() ?? [];
		const state = { request: this.o.request, scratch: this.scratch, results: this.results, notes, heard: this.heard };
		const firstText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, state));
		let reply = parseReply(firstText);
		if (!reply.toolCalls.length && !reply.done) {
			const first = reply.scratch;
			try {
				const retryText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, { ...state, notes: [...notes, retryNote(reply.problems)] }));
				reply = parseReply(retryText);
			} catch (error) {
				// The first reply's notes are all this wave produced; keep them for the best-effort answer.
				if (first.trim()) this.scratch = first;
				throw error;
			}
			if (first && !reply.scratch.trim()) reply = { ...reply, scratch: first };
		}
		// An empty scratch never wipes the notes so far.
		this.scratch = reply.scratch || this.scratch;
		return reply;
	}

	/**
	 * Runs a wave's calls and returns their entries in call order. A call missing a required
	 * argument is skipped with an error, and a call whose reference names nothing does not run.
	 * memory.peek reads memory before this wave's results are stored. Calls that ran (not peek,
	 * skipped or unstarted) are also returned as the finish rule hears them.
	 */
	async act(wave: number, calls: ToolCall[]): Promise<Acted> {
		const prepared = calls.map((call, i): Prepared => {
			const key = resultKey(wave, i);
			const missing = this.missingArgs(call);
			if (missing.length) return { call, entry: { tool: call.tool, key, error: skipMessage(call.tool, missing) }, skipped: true };
			let args: Record<string, unknown>;
			try {
				args = resolveArgRefs(call.args, this.memory);
			} catch (error) {
				return { call, entry: { tool: call.tool, key, error: messageOf(error) } };
			}
			return call.tool === PEEK_TOOL ? { call, entry: this.peek(key, args) } : { call, args };
		});

		const runnable = prepared.flatMap((p) => ('args' in p ? [{ tool: p.call.tool, args: p.args }] : []));
		const steps: CallSteps = { prepare: (call) => this.prepare(call), approve: this.o.approve };
		const outcomes = (await runWave(runnable, steps, { timeoutMs: (tool) => this.limit(tool), late: this.late, signal: this.o.signal, userTime: this.o.userTime })).map((outcome) => redactOutcome(outcome, this.o.secrets));

		let next = 0;
		const ran: RanCall[] = [];
		const entries = prepared.map((p, i) => {
			if ('entry' in p) {
				if (!('skipped' in p) && p.call.tool !== PEEK_TOOL) ran.push({ tool: p.call.tool, args: p.call.args, error: p.entry.error });
				return this.withCall(p.entry, p.call);
			}
			const key = resultKey(wave, i);
			const outcome = outcomes[next++];
			// a refused or unstarted call changed nothing, so a denied delete_file needs no check_app
			if (outcome.ok) ran.push({ tool: p.call.tool, args: p.args, result: outcome.result });
			else if (!outcome.unstarted) ran.push({ tool: p.call.tool, args: p.args, error: outcome.error });
			return this.withCall(outcome.ok ? this.store(p.call.tool, key, outcome.result) : { tool: p.call.tool, key, error: outcome.error }, p.call);
		});
		return { entries, ran };
	}

	/**
	 * The required arguments a call leaves out, in the order its tool's schema
	 * lists them. Only undefined or null is missing: an empty string is an
	 * argument (list_directory takes '' for the root). A tool the loop does not
	 * know has none missing, so it fails as unknown when it runs.
	 */
	private missingArgs(call: ToolCall): string[] {
		const tool = call.tool === PEEK_TOOL ? MEMORY_PEEK_TOOL : this.tools.get(call.tool);
		const required = tool?.parameters.required;
		if (!Array.isArray(required)) return [];
		return required.filter((name): name is string => typeof name === 'string' && (call.args[name] === undefined || call.args[name] === null));
	}

	private prepare(call: ToolCall): Promise<ToolStep> {
		const tool = this.tools.get(call.tool);
		if (!tool) throw new Error(`Unknown tool '${call.tool}'. Use only the tools in Available Tools.`);
		return tool.prepare(call.args);
	}

	/** A tool's time limit: the option's when it is a positive number, else the default. */
	private limit(tool: string): number {
		const ms = this.o.timeoutMs?.(tool);
		return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : TOOL_TIMEOUT_MS;
	}

	/** Runs a memory.peek call. Its result is shown, not stored. */
	private peek(key: string, args: Record<string, unknown>): Entry {
		try {
			return { tool: PEEK_TOOL, key, ...(JSON.parse(peek(this.memory, args)) as Omit<Entry, 'tool' | 'key'>) };
		} catch (error) {
			return { tool: PEEK_TOOL, key, error: messageOf(error) };
		}
	}

	/**
	 * Stores a result and builds its entry. A result identical to one already
	 * stored says so: it never blocks, as repeating a call is often legitimate,
	 * but it tells the model the call brought nothing new. A check that passes
	 * again is news, not a repeat.
	 */
	private store(tool: string, key: string, result: string): Entry {
		this.memory.put(key, result);
		const entry: Entry = { tool, key, summary: summarize(result) };
		if (tool === this.o.finish.checkTool) return entry;
		const prior = setDefault(this.seenResults, result, key);
		if (prior === key) return entry;
		entry.deduplicated = true;
		entry.note = `This result is identical to ${prior}, which is already in memory, so this call produced no new information. Read ${prior} with memory.peek, or change approach: repeating a call that returns the same data will not advance the task.`;
		return entry;
	}

	/**
	 * Puts a short form of the call's arguments beside its entry, as the model
	 * wrote them, and points out a call identical to an earlier one. The note
	 * informs and never blocks: reading a file again after writing it is
	 * legitimate. A check run again is what the rules ask for, so it is never a repeat.
	 */
	private withCall(entry: Entry, call: ToolCall): Entry {
		const { tool, key, ...rest } = entry;
		const shown: Entry = { tool, key };
		if (Object.keys(call.args).length) shown.args = previewArgs(call.args);
		Object.assign(shown, rest);
		if (call.tool === this.o.finish.checkTool) return shown;
		const first = setDefault(this.seenCalls, canonical({ tool: call.tool, args: call.args }), key);
		if (first !== key && this.removed.has(first)) {
			// Read, remove, read again: the model dropped data it still needed.
			shown.note = `Same tool and arguments as ${first}, whose result you removed. If you still need data from a result, keep it in scratch before you remove the result.`;
		} else if (first !== key) {
			// A note that the result is identical already says more.
			shown.note ??= `Same tool and arguments as ${first}.`;
		}
		return shown;
	}

	/** The keys of the entries from earlier waves. */
	earlierKeys(): Set<string> {
		return new Set(this.results.map((entry) => entry.key));
	}

	/** Adds a wave's entries to what the next question shows. */
	record(entries: Entry[]): void {
		this.results.push(...entries);
	}

	/**
	 * Forgets which stored results the keys hold, as soon as a reply asks to
	 * remove them, so no identical-result note made in this wave names a key
	 * about to go. Which calls they answered is kept: a repeat of a removed call
	 * is worth pointing out.
	 */
	forget(keys: string[]): void {
		const gone = new Set(keys);
		for (const [text, key] of this.seenResults) if (gone.has(key)) this.seenResults.delete(text);
	}

	/** Removes keys from memory and their entries from the next question. */
	remove(keys: string[]): void {
		const gone = new Set(keys);
		this.memory.clear(keys);
		for (const key of keys) this.removed.add(key);
		this.results = this.results.filter((entry) => !gone.has(entry.key));
	}

	/**
	 * The timed-out calls that have ended since the last look, a call that
	 * ended before the rest of its own wave included, as the finish rule hears
	 * them: what they did may have landed after a check read the work, and the
	 * model never read how they ended.
	 */
	lateReturns(): RanCall[] {
		const returned: RanCall[] = [];
		for (const [tracked, { call, ended }] of this.late) {
			if (!ended) continue;
			this.late.delete(tracked);
			const shown = 'result' in ended ? { result: hideSecrets(ended.result, this.o.secrets) } : { error: hideSecrets(ended.error, this.o.secrets) };
			returned.push({ tool: call.tool, args: call.args, ...shown, late: true });
		}
		return returned;
	}

	/**
	 * The entries that tell the model how timed-out calls ended, one per call
	 * the last lateReturns() found. A result is stored under its entry's key,
	 * as a result of this wave is, so memory.peek and references can read it.
	 *
	 * @param wave - The wave they are noticed in.
	 * @param returned - The calls, as lateReturns() handed them over.
	 */
	lateEntries(wave: number, returned: RanCall[]): Entry[] {
		return returned.map((call, i) => {
			const key = `wave-${wave}.late${i}`;
			const entry: Entry = { tool: call.tool, key, args: previewArgs(call.args) };
			if (call.error !== undefined) entry.error = call.error;
			else {
				this.memory.put(key, call.result ?? '');
				entry.summary = summarize(call.result ?? '');
			}
			entry.note = LATE_NOTE;
			return entry;
		});
	}

	/**
	 * Why the run may not finish yet, or null if it may. A timed-out call still
	 * running may still change the work, so no check covers it. A call that
	 * ended after the wave's lateReturns(), while endWave ran, counts too: the
	 * model has not read how it ended. Otherwise the finish rule decides.
	 */
	unfinished(): string | null {
		if (this.late.size) {
			return `Not finished: ${this.late.size} call(s) that timed out are still running and may still change the work. A check cannot cover them yet; call ${this.o.finish.checkTool} again after they end.`;
		}
		return this.o.finish.unchecked();
	}

	/**
	 * Sends a wave's thinking chunk: its thought, then a line per call; nothing
	 * when both are empty.
	 */
	think(thought: string, lines: string[]): void {
		const text = [...(thought.trim() ? [thought] : []), ...lines].join('\n');
		if (text) this.o.emit('thinking', text);
	}

	finish(stopReason: StopReason, answer: string, waves: number): LoopResult {
		return { answer, stopReason, waves, modelMs: this.modelMs, toolCalls: this.toolCalls };
	}

	/**
	 * Ends a stopped run. It writes no answer (the chat closes the turn); its
	 * last row names the calls still running, because they may still change
	 * the work.
	 */
	stopped(waves: number): LoopResult {
		const running = [...this.late.values()].filter((lateCall) => !lateCall.ended);
		if (running.length) this.o.emit('thinking', [STILL_RUNNING, ...running.map(({ call }) => `- ${callName(call)}`)].join('\n'));
		return this.finish('stopped', '', waves);
	}

	/**
	 * Ends the run with a best effort from what was gathered; a cost-limit refusal of that question
	 * ends it at `cost_limit`, and a stop during it ends it stopped. A pausing run takes the user's
	 * queued messages before and after the question, so none starts its own turn with a fresh
	 * budget before Continue.
	 */
	async answerFromGathered(reason: StopReason, waves: number): Promise<LoopResult> {
		if (pauses(reason)) this.hear();
		const { answer, costLimited } = await this.bestEffort();
		// step: the user stopped the run while the model answered; bestEffort took the stop as a failed call
		if (this.o.signal.aborted) return this.stopped(waves);
		const stopReason = costLimited ? 'cost_limit' : reason;
		if (pauses(stopReason)) this.hear();
		return this.finish(stopReason, answer, waves);
	}

	/**
	 * Asks for a best-effort answer from what was gathered (Wave's
	 * `_synthesize`): a plain question, not a plan, with the results as lines
	 * and the model's notes. If that call fails or returns nothing, the answer
	 * is the gathered facts as they stand.
	 *
	 * @returns The answer, and whether the cost limit refused the question.
	 */
	private async bestEffort(): Promise<{ answer: string; costLimited: boolean }> {
		const lines = this.results.map(gatheredLine);
		const context = [`Information gathered:\n${lines.length ? lines.join('\n') : '(no results gathered)'}`];
		// The notes hold what the model worked out (counts, names, conclusions).
		if (this.scratch) context.push(`Your working notes from the steps so far:\n${this.scratch}`);
		if (this.heard.length) context.push(heardText(this.heard));
		const q: QuestionSpec = {
			role: FALLBACK_ROLE,
			instructions: [],
			history: [...this.o.history],
			goals: [this.o.request],
			context,
			question: FALLBACK_QUESTION,
			expectJson: false,
			cachePrefix: false,
		};
		let answer: string;
		try {
			answer = await this.ask(q);
		} catch (error) {
			// step: the cost limit refused this request too, so it was never sent
			if (error instanceof CostLimitError) return { answer: partialReport(error.message, lines, this.scratch), costLimited: true };
			const name = error instanceof Error ? error.name : 'Error';
			return { answer: partialReport(`the model call failed (${name}: ${messageOf(error)})`, lines, this.scratch), costLimited: false };
		}
		if (!answer.trim()) return { answer: partialReport('the model returned no text', lines, this.scratch), costLimited: false };
		return { answer, costLimited: false };
	}
}

// =============================================================================
// LOOP — the entry point
// =============================================================================

/**
 * Runs waves until the answer is accepted, a call asks the user (`needs_input`), a reply stays
 * unusable after one retry (`empty_plan`), the model cannot be reached (`error`), the run is
 * stopped (`stopped`), the step limit is reached (`limited`), or the cost limit refuses a request
 * (`cost_limit`); the last two answer with a best effort. A done=true is sent back while a timed-
 * out call runs or ended unread, in the wave the check tool is called, while the finish rule finds
 * something unchecked, or while a mid-run user message is unread. @throws The model's error when it
 * fails before anything was gathered.
 */
export async function runLoop(o: LoopOptions): Promise<LoopResult> {
	const run = new WaveRun(o);
	for (let wave = 0; ; wave++) {
		if (o.signal.aborted) return run.stopped(wave);
		// step: the step limit: no next plan; the answer is the best effort from what was gathered
		if (o.maxWaves !== undefined && o.maxWaves > 0 && wave >= o.maxWaves) return run.answerFromGathered('limited', wave);
		o.finish.beginWave(wave);
		run.hear();
		let reply: PlanReply;
		try {
			reply = await run.plan();
		} catch (error) {
			if (error instanceof RunStopped) return run.stopped(wave + 1);
			// step: the cost limit refused the plan, so it was never sent; the best effort reserves too, and may be refused
			if (error instanceof CostLimitError) return run.answerFromGathered('cost_limit', wave + 1);
			// Nothing gathered: the cause (a bad key, a stopped pipeline) is the useful part.
			if (!run.gathered) throw error;
			return run.answerFromGathered('error', wave + 1);
		}
		const { toolCalls } = reply;

		// step: done with nothing to run — the answer stands unless the work is unchecked,
		// or a timed-out call has ended since and the model has not read how
		if (reply.done && !toolCalls.length) {
			const late = run.lateReturns();
			await o.finish.endWave(late);
			const refused = late.length ? READ_THE_LATE : (run.unfinished() ?? (run.hear() ? READ_THE_USER : null));
			if (!refused) {
				return run.finish('done', resolveAnswerRefs(reply.answer, run.memory), wave + 1);
			}
			// Its remove list is not applied: the answer it sends again may still need those keys.
			run.record([refusal(wave, refused), ...problemEntries(wave, reply.problems), ...run.lateEntries(wave, late)]);
			run.think(reply.thought, []);
			continue;
		}

		// step: still unusable after the retry — record why, then answer from what was gathered
		if (!toolCalls.length) {
			run.record(reply.problems.map((problem, i) => ({ tool: 'reply-check', key: `wave-${wave}.check${i}`, error: `Skipped: ${problem}` })));
			run.think(reply.thought, []);
			return run.answerFromGathered('empty_plan', wave + 1);
		}

		// step: run the calls. Only earlier waves' keys can be removed, and a reply
		// asking to finish keeps its keys in case it is sent back.
		const earlier = run.earlierKeys();
		const removing = reply.askedDone ? [] : reply.remove.filter((key) => earlier.has(key));
		run.forget(removing);
		run.toolCalls += toolCalls.length;
		const { entries, ran } = await run.act(wave, toolCalls);
		const lines = toolCalls.map((call, i) => thinkingLine(call, entries[i]));
		entries.push(...problemEntries(wave, reply.problems));

		// step: tell the finish rule what ran, failed calls included (a write may land before its error),
		// then timed-out calls that ended since; a skipped call never touched the work
		const late = run.lateReturns();
		await o.finish.endWave([...ran, ...late]);
		entries.push(...run.lateEntries(wave, late));
		if (o.signal.aborted) {
			run.think(reply.thought, lines);
			return run.stopped(wave + 1);
		}

		// step: a call asked the user, so the turn ends here with the question as its answer. A message
		// sent during this wave was written before the question showed, so it can't answer it.
		const asked = o.endTurn?.() ?? null;
		if (asked !== null && !run.hear()) {
			run.record(entries);
			run.think(reply.thought, lines);
			return run.finish('needs_input', asked, wave + 1);
		}
		if (asked !== null) {
			o.withdrawAsk?.();
			entries.push(refusal(wave, ASKED_UNSEEN));
		}

		// step: done with calls — the answer stands only if every call worked, the
		// model has read any check it ran and how any timed-out call ended, and the
		// work is checked
		let finished = reply.done && !entries.some((entry) => entry.error !== undefined);
		if (finished && toolCalls.some((call) => call.tool === o.finish.checkTool)) {
			finished = false;
			entries.push(refusal(wave, readTheCheck(o.finish.checkTool)));
		} else if (finished && late.length) {
			finished = false;
			entries.push(refusal(wave, READ_THE_LATE));
		} else if (finished) {
			const refused = run.unfinished() ?? (run.hear() ? READ_THE_USER : null);
			if (refused) {
				finished = false;
				entries.push(refusal(wave, refused));
			}
		}
		run.record(entries);
		if (finished) {
			return run.finish('done', resolveAnswerRefs(reply.answer, run.memory), wave + 1);
		}

		run.think(reply.thought, lines);
		if (removing.length) run.remove(removing);
	}
}
