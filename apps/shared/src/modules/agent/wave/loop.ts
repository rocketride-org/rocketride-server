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
 * One run of the agent. Each wave asks the model for a plan, runs the plan's
 * tool calls, and feeds their summaries into the next wave's question. The
 * run ends when the model's answer is accepted, on a reply that stays unusable,
 * when the model cannot be reached, or when the user stops it; there is no
 * wave limit. Messages the user sends during the run reach the next question.
 *
 * An answer is accepted only when the host's finish rule (`FinishRule`) finds
 * nothing left unchecked, so the model cannot skip checking. The loop knows
 * nothing of what is checked or how: it tells the rule what each wave ran and
 * asks it. A reply that cannot be used is sent back once, saying why. When the
 * run ends without an accepted answer, the loop asks for a best-effort answer
 * from what was gathered, and failing that writes one itself.
 *
 * This is a port of Wave's driver (`nodes/src/nodes/agent_rocketride/
 * rocketride_agent.py`) and the result bookkeeping of its executor
 * (`executor.py`). The texts the model reads match Wave's word for word, as
 * Wave's prompt teaches the model to read them. One change: the note that
 * sends a bad reply back goes in the question's context, not its
 * instructions, so the cached start stays identical on every call.
 */

import { redactText } from '../toolkits/common';
import type { SecretMarkers } from '../toolkits/secretMarkers';
import type { AgentTool, ToolAct, ToolStep } from '../tools';
import { MEMORY_PEEK_TOOL, peek, resolveAnswerRefs, resolveArgRefs, resultKey, RunMemory } from './memory';
import { buildWaveQuestion, heardText, parseReply, type PromptPrefix } from './plan';
import type { HistoryTurn, ModelCall, PlanReply, QuestionSpec, ResultEntry, StopReason, ToolCall } from './plan';
import { previewArgs, summarize, withCommas } from './summary';

// =============================================================================
// OPTIONS AND RESULT
// =============================================================================

/** One call as the finish rule hears it: what ran, with what, and how it ended. */
export interface RanCall {
	/** The tool. */
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
	/**
	 * A wave starts.
	 *
	 * @param wave - The wave number, from 0.
	 */
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
	/** Decides when the work is checked; the loop asks it before accepting a done=true. */
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
	 * Lets a prepared call whose step names an act start, or refuses it.
	 * Resolves with the work to start; rejects with the refusal the model
	 * reads (blocked, declined, not answered). The loop calls it between the
	 * call's prepare and its run with the call's clock stopped, so the user's
	 * think time never counts against a limit. A step with no act never
	 * reaches it.
	 */
	approve: (act: ToolAct, run: () => Promise<string>) => Promise<() => Promise<string>>;
	/** The values the file tools hid this run; any other result that quotes one shows its marker. */
	secrets?: SecretMarkers;
}

/** How a run ended. */
export interface LoopResult {
	/** The answer for the user, with its memory references filled in ('' for a stopped run). */
	answer: string;
	/** Why the run stopped. */
	stopReason: StopReason;
	/** How many waves ran, counting the one the run stopped in. */
	waves: number;
	/** How long each model call took, in milliseconds, in call order. */
	modelMs: number[];
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

/** What a call still running when the run was stopped leaves behind. */
const STOPPED_WHILE_RUNNING = 'Still running when the run was stopped; it may still finish.';

/** What a call the stop kept from starting leaves behind. */
const STOPPED_BEFORE_START = 'Not run: the run was stopped first.';

/** Why a done is sent back in the wave a timed-out call is found to have ended: the model has not read how. */
const READ_THE_LATE = 'Not finished: read how the call(s) that timed out ended (the entries marked late) before done=true.';

/** What a late entry tells the model. */
const LATE_NOTE = 'This call timed out and has now ended; this is how it ended. Plan again any call that was not run while it was still running.';

/** The heading of a stopped run's last row, over the calls still running. */
const STILL_RUNNING = 'Still running when you stopped (these may still finish and change the work):';

/** Why a done is sent back while a message the user sent during the run is unread. */
const READ_THE_USER = 'Not finished: the user wrote to you while you worked. Read "Messages from the user during this run" before done=true.';

/** The role of the best-effort question: a plain answer, not a plan. */
const FALLBACK_ROLE = 'You are a helpful assistant.';

/** The best-effort question. */
const FALLBACK_QUESTION = 'Based on the above, provide a complete and accurate final answer. The work stopped before it was finished: if something the goal needs is still unknown, say what is missing rather than guessing.';

/** Most characters of a peek's data the best-effort question shows. */
const FALLBACK_PREVIEW_CHARS = 2000;

/** Most characters of a call's error a thinking line shows. */
const THINKING_ERROR_CHARS = 200;

/** The arguments that name what a call works on, in the order a thinking line looks for them. */
const PRIMARY_ARGS = ['path', 'oldPath', 'target', 'app', 'name', 'task_token', 'project_id', 'method'];

/**
 * The error of a call that was not started because an earlier call on the same files timed out and still runs.
 *
 * @param waitsFor - The call that timed out.
 */
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
	/** How long the stored text is. */
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
	/** The call as it ran. */
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

// =============================================================================
// WAVE SCHEDULING — which calls run together, which wait, and how long each may take
// =============================================================================

/**
 * Wave's Python loop starts every call in a wave at once. That is wrong for
 * calls that change the same file: two edits of one file, or an edit under a
 * folder that an earlier call renames, must run in the order the model planned
 * them. This section keeps the parallelism and adds that order. A call starts as
 * soon as every EARLIER call in the wave whose write paths overlap its own has
 * finished or timed out. A call with no write paths (a read, a check, a deploy
 * query) never waits and never holds anything back.
 *
 * Each call also has a time limit, set per tool. A call over its limit is
 * reported as timed out and the wave moves on; the tool itself cannot be
 * cancelled, so its promise goes into `late`, beside a record of the call that
 * also keeps how it ended, until the loop reads that. A call in `late` with no
 * ending yet may still be changing things.
 */

// =============================================================================
// OUTCOMES — what a call left behind
// =============================================================================

/**
 * How one call ended: its result, or the error that stopped it (with whether
 * the time limit did). `unstarted` marks a call whose work never began
 * (prepare failed or timed out, its act was refused, a stop came first, or
 * it waits for a timed-out call on its files), so it changed nothing and the
 * finish rule does not hear of it.
 */
export type CallOutcome = { ok: true; result: string; ms: number } | { ok: false; error: string; ms: number; timedOut: boolean; unstarted?: true };

/**
 * An outcome with each value the file tools hid shown as its marker, then
 * passed through redactText. Every outcome goes through it before anything
 * reads it, so no credential in a tool's result, its prepare error or its
 * refusal reaches the stored result, the next question, a thinking line or
 * the finish rule.
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
 * Spells a path argument the way the file tools do, so two spellings of one file compare equal.
 * This mirrors the first steps of `normalizePath` in `../toolkits/filesystem.ts`: the argument becomes text
 * (`path: 7` is the file `7`), `\` becomes `/`, and empty segments go (`apps//x/` is `apps/x`).
 * It does not refuse `.` or `..`; the tool does that when it runs. A path that is empty after
 * this gives no path.
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
	/** The loop option. */
	approve: LoopOptions['approve'];
}

/** How a piece of work ended against its limit: its value, or the error that stopped it. */
type Timed<T> = { ok: true; value: T; ms: number } | { ok: false; error: string; ms: number; timedOut: boolean };

/** What a call the stop kept from starting settles with. */
function notStarted(ms: number): CallOutcome {
	return { ok: false, error: STOPPED_BEFORE_START, ms, timedOut: false, unstarted: true };
}

/**
 * Runs one call and settles with its outcome; never rejects. Three steps:
 *
 * 1. prepare: the tool reads what it needs and says what it is about to do,
 *    timed against the call's limit. A failure or timeout is `unstarted`, and
 *    a prepare still going is dropped, since it only reads.
 * 2. approve: only when the step names an act, with the clock stopped. A
 *    refusal is the outcome (`unstarted`), and the run never starts.
 * 3. run: the work, timed with what the limit has left. A timeout or a stop
 *    cuts it loose into `late`.
 *
 * A limit that is not a positive finite number means no limit. A stop before
 * step 3 means the run never starts. `ms` counts steps 1 and 3, not the wait.
 */
async function runOne(call: ToolCall, steps: CallSteps, limitMs: number, late: Map<Promise<unknown>, LateCall>, signal: AbortSignal): Promise<CallOutcome> {
	// a call that waited on an overlapping write starts after a stop through here
	if (signal.aborted) return notStarted(0);
	const ready = await timed(() => steps.prepare(call), limitMs, signal);
	if (signal.aborted) return notStarted(ready.ms);
	if (!ready.ok) return { ...ready, unstarted: true };

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

	const done = await timed(work, limitMs, signal, (running) => trackLate(late, call, running), ready.ms);
	return done.ok ? { ok: true, result: done.value, ms: ready.ms + done.ms } : { ...done, ms: ready.ms + done.ms };
}

/**
 * Runs `work` against a limit and settles with how it ended; never rejects.
 * A limit that is not a positive finite number means no limit. A stop cuts
 * the work loose like a timeout does. The work itself cannot be cancelled, so
 * once cut loose it is handed to `cutLoose` (or dropped without one).
 * `spentMs` of the limit is already used, so the work gets what is left, and
 * a timeout still names the whole limit.
 */
function timed<T>(work: () => Promise<T>, limitMs: number, signal: AbortSignal, cutLoose?: (running: Promise<T>) => void, spentMs = 0): Promise<Timed<T>> {
	const began = performance.now();
	const elapsed = (): number => Math.round(performance.now() - began);
	const leftMs = Math.max(1, limitMs - spentMs);

	return new Promise<Timed<T>>((resolve) => {
		let over = false;
		const running = new Promise<T>((done) => done(work()));

		const timer =
			Number.isFinite(limitMs) && limitMs > 0
				? setTimeout(() => {
						over = true;
						signal.removeEventListener('abort', cut);
						cutLoose?.(running);
						resolve({ ok: false, error: `TimeoutError: no result after ${limitMs / 1000} s`, ms: elapsed(), timedOut: true });
					}, leftMs)
				: undefined;

		const cut = (): void => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			cutLoose?.(running);
			resolve({ ok: false, error: STOPPED_WHILE_RUNNING, ms: elapsed(), timedOut: false });
		};
		// checked after the work started on purpose: its own synchronous work may have stopped the run
		if (signal.aborted) cut();
		else signal.addEventListener('abort', cut, { once: true });

		running.then(
			(value) => {
				signal.removeEventListener('abort', cut);
				if (over) return;
				clearTimeout(timer);
				resolve({ ok: true, value, ms: elapsed() });
			},
			(error: unknown) => {
				signal.removeEventListener('abort', cut);
				if (over) return;
				clearTimeout(timer);
				resolve({ ok: false, error: messageOf(error), ms: elapsed(), timedOut: false });
			}
		);
	});
}

/**
 * Tracks a call the wave stopped waiting for in `late`, from the moment it is
 * cut loose until lateReturns() hands over how it ended, so a call that ends
 * before the rest of its wave is still reported. The tracker never rejects,
 * so a late failure is not an unhandled rejection; it notes how the call
 * ended, and lateReturns() hides its secrets as redactOutcome does.
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
 * Runs a wave's calls and returns their outcomes in call order.
 *
 * A call starts once every earlier call in the wave with overlapping write
 * paths has settled or timed out, so calls on different files run together and
 * calls on the same file run as planned. The call's clock starts when it
 * starts, not while it waits, and stops while the user is asked for an OK; a
 * call waiting for an OK holds back only later calls on its own paths. A call
 * that outlives its limit is reported as `timedOut` and sits in `opts.late`
 * until the run reads how it ended.
 *
 * A call is not started, or prepared, when one of those earlier calls ran
 * past its limit or was held back that way, or when a call that timed out in
 * an earlier wave still runs on its files: it would land before or under a
 * change still on its way. A call whose prepare failed or timed out, or whose
 * act was refused, holds nothing back, since nothing of it can land.
 *
 * @param calls - The wave's tool calls, in the order the model planned them.
 * @param steps - Gets each call ready and lets it start; a throw becomes an `ok: false` outcome.
 * @param opts.timeoutMs - The time limit in milliseconds for a tool; zero or infinity means none.
 * @param opts.late - Collects each timed-out call by the promise that tracks it, with how it ended once it does.
 * @param opts.signal - The run's stop signal: running calls are cut loose and waiting ones never start.
 */
async function runWave(calls: ToolCall[], steps: CallSteps, opts: { timeoutMs: (tool: string) => number; late: Map<Promise<unknown>, LateCall>; signal: AbortSignal }): Promise<CallOutcome[]> {
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
		const start = (): Promise<CallOutcome> => runOne(call, steps, opts.timeoutMs(call.tool), opts.late, opts.signal);
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
	/** The keys the model removed. */
	private readonly removed = new Set<string>();
	/** The tools by name. */
	private readonly tools: Map<string, AgentTool>;

	/** Starts a run. */
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
		const state = { request: this.o.request, scratch: this.scratch, results: this.results, notes: [], heard: this.heard };
		const firstText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, state));
		let reply = parseReply(firstText);
		if (!reply.toolCalls.length && !reply.done) {
			const first = reply.scratch;
			try {
				const retryText = await this.ask(buildWaveQuestion(this.o.prefix, this.o.history, { ...state, notes: [retryNote(reply.problems)] }));
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
	 * Runs a wave's calls and returns their entries, in call order. A call
	 * missing a required argument is skipped, with an error telling the model
	 * where arguments go. Arguments are resolved next, and a call whose
	 * reference names nothing does not run. memory.peek reads memory here,
	 * before this wave's results are stored; every other call goes through the
	 * scheduler. Every call but memory.peek, the skipped ones and those whose
	 * work never started (refused, stopped first, or held back by a timed-out
	 * call) is also handed back as the finish rule hears it.
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
		const outcomes = (await runWave(runnable, steps, { timeoutMs: (tool) => this.limit(tool), late: this.late, signal: this.o.signal })).map((outcome) => redactOutcome(outcome, this.o.secrets));

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

	/** Gets one call ready on its tool. */
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

	/** The run's result. */
	finish(stopReason: StopReason, answer: string, waves: number): LoopResult {
		return { answer, stopReason, waves, modelMs: this.modelMs };
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
	 * Asks for a best-effort answer from what was gathered (Wave's
	 * `_synthesize`): a plain question, not a plan, with the results as lines
	 * and the model's notes. If that call fails or returns nothing, the answer
	 * is the gathered facts as they stand.
	 */
	async bestEffort(): Promise<string> {
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
			const name = error instanceof Error ? error.name : 'Error';
			return partialReport(`the model call failed (${name}: ${messageOf(error)})`, lines, this.scratch);
		}
		if (!answer.trim()) return partialReport('the model returned no text', lines, this.scratch);
		return answer;
	}
}

// =============================================================================
// LOOP — the entry point
// =============================================================================

/**
 * Runs waves until the model's answer is accepted, a reply stays unusable
 * after one retry (`empty_plan`), the model cannot be reached (`error`), or
 * the run is stopped (`stopped`, with no answer).
 * Each wave plans, runs its calls, tells the finish rule what ran, and records
 * their entries for the next question. A done=true is sent back, with the
 * reason in an entry, while a timed-out call still runs, in the wave the check
 * tool is called, in the wave a timed-out call is found to have ended (each
 * such call gets an entry saying how it ended), while the finish rule finds
 * something unchecked, and while a message the user sent during the run is
 * unread. Every
 * wave sends one thinking chunk except the one whose answer is accepted, which
 * goes out as the answer instead.
 *
 * @param o - The run's request, prompt start, tools, model and hooks.
 * @returns The answer and how the run ended.
 * @throws The model's error when it fails before anything was gathered.
 */
export async function runLoop(o: LoopOptions): Promise<LoopResult> {
	const run = new WaveRun(o);
	for (let wave = 0; ; wave++) {
		if (o.signal.aborted) return run.stopped(wave);
		o.finish.beginWave(wave);
		run.hear();
		let reply: PlanReply;
		try {
			reply = await run.plan();
		} catch (error) {
			if (error instanceof RunStopped) return run.stopped(wave + 1);
			// Nothing gathered: the cause (a bad key, a stopped pipeline) is the useful part.
			if (!run.gathered) throw error;
			return run.finish('error', await run.bestEffort(), wave + 1);
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
			return run.finish('empty_plan', await run.bestEffort(), wave + 1);
		}

		// step: run the calls. Only earlier waves' keys can be removed, and a reply
		// asking to finish keeps its keys in case it is sent back.
		const earlier = run.earlierKeys();
		const removing = reply.askedDone ? [] : reply.remove.filter((key) => earlier.has(key));
		run.forget(removing);
		const { entries, ran } = await run.act(wave, toolCalls);
		const lines = toolCalls.map((call, i) => thinkingLine(call, entries[i]));
		entries.push(...problemEntries(wave, reply.problems));

		// step: tell the finish rule what ran this wave, failed calls included (a
		// write may have landed before its error), then any timed-out call that has
		// ended since: what it did may have landed after a check read the work. A
		// call skipped for missing arguments never touched the work or a check, so
		// the rule never hears of it.
		const late = run.lateReturns();
		await o.finish.endWave([...ran, ...late]);
		entries.push(...run.lateEntries(wave, late));
		if (o.signal.aborted) {
			run.think(reply.thought, lines);
			return run.stopped(wave + 1);
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
