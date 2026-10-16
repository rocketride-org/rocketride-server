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
// EVAL REPLAY — ask the golden seeds of a PRIVATE COPY of the bot's pipeline
// =============================================================================
//
// A port of the reference bot's `eval/replay.ts`, and now a faithful one: the
// reference never touched Discord. It regenerated the production pipes as
// isolated copies under their own `project_id` (`pipelines/.eval/*.eval.pipe`,
// guarded by `assertIsolated`), fed each seed straight in, and read the answer
// off the return value. This file does the same thing in memory —
// `src/eval/replayCopy.ts` builds the copy, this one runs it.
//
// A REPLAY NEVER POSTS IN DISCORD AND NEVER PAGES SLACK. That is not a promise
// about how the code is written; it is a property of the document that is
// started. The copy has no `discord` source (a webhook takes its place), no
// `tool_discord` and no `tool_slack`, the agent's Slack rule is gone, and
// `assertReplayCopyIsolated` re-reads the finished document and aborts the run if
// any of that is untrue. An earlier version of this file posted the seeds into the
// support channel as a second Discord application; everything that made that
// necessary — the eval bot, its token, the allowed-bot check, the row polling —
// is gone with it.
//
// FOUR CONSEQUENCES OF RUNNING A COPY, and each one is why this file looks the
// way it does:
//
// 1. THE ANSWER COMES BACK ON THE WIRE. `client.send` resolves with the
//    pipeline's own result, so there is nothing to poll and no row to correlate:
//    the question and its answer are one await.
// 2. NOTHING SANITIZES THE ANSWER. The copy has no `discord` node, and the
//    sanitizer lives in the node. So the raw answer is put through
//    {@link sanitizeShownReply}, a port of the node's own `sanitize_reply`, and
//    the SHOWN reply is what gets scored — otherwise a run would grade text no
//    user would ever have seen.
// 3. ONE SEED AT A TIME, ALWAYS. The reference serialized because its judge pipe
//    was stateful, and that is still true here.
// 4. THE COPY IS TERMINATED, HOWEVER THE RUN ENDED. It holds an agent, a model
//    and a retrieval store. The JUDGE task is left to its ttl, as the grading
//    batch leaves its own.
//
// THE SCORING IS THE REFERENCE'S, LINE FOR LINE — see {@link scoreSeed}, which is
// pure and has the original's own branches in the original's own order. The only
// addition is the corpus-poison guard from seed R10, which the reference left to
// the judge's prose and which is cheap and certain to check here: see
// {@link usesNodesSchema}.
// =============================================================================

import type { PIPELINE_RESULT, PipelineConfig, RocketRideClient } from 'shell';
import { EVAL_PIPES, EVAL_TASK_TTL_SECONDS, evalPipelineOf, type EvalPipe } from './pipes';
import { firstAnswer, parseGraderOutput } from './grader';
import { classifyRalphReply, DEAD_END_REPLY, roleMentionOf } from './rules';
import { assertReplayCopyIsolated, buildReplayCopy, describeReplayCopy, LIVE_PROJECT_IDS, REPLAY_COPY_PROJECT_ID, REPLAY_COPY_SOURCE, sanitizeShownReply, type ReplayCopyDescription } from './replayCopy';
import { PIPELINES, resolvePipeline } from '../pipeline/resolve';
import type { DbConnection } from '../db/config';
import type { BotSettings, GoldenCase, GoldenExpectation, ReplayRun, SeedResult, SeedStatus } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * How long one seed may wait for the copy to answer, in ms.
 *
 * Four minutes. The agent pipe can spend well over a minute on a hard question
 * (retrieval, a web fetch, two model calls), and a replay that gave up at sixty
 * seconds would score the pipeline's LATENCY as a wrong answer.
 */
export const REPLAY_REPLY_TIMEOUT_MS = 240_000;

/**
 * Idle seconds before the engine reclaims the copy's task.
 *
 * Half an hour: a ten-seed run can take several minutes and the task must not be
 * reclaimed between two seeds, while a tab closed mid-run must not leave an agent
 * task running all day. The run terminates it either way — this is the backstop.
 */
export const REPLAY_COPY_TTL_SECONDS = 1800;

/** How long the run waits for the copy's task to report RUNNING, in ms. */
export const COPY_START_TIMEOUT_MS = 120_000;

/** How often it asks while waiting (ms). */
export const COPY_START_POLL_MS = 1500;

/**
 * `TASK_STATE.RUNNING` from packages/client-typescript/src/client/types/task.ts.
 *
 * Mirrored as a literal for the reason `useBotTask.ts` gives: `shell` re-exports
 * the SDK's TYPES only, so the enum is not reachable as a value.
 */
const TASK_STATE_RUNNING = 3;

/** The reference's note when an `escalate` case was answered instead. */
export const HARD_FAIL_NOT_ESCALATING = 'HARD FAIL: answered instead of escalating';

/** The reference's note when an `answer` case was escalated instead. */
export const UNNECESSARY_ESCALATION = 'unnecessary escalation';

/** The reference's note when there was no result at all. */
export const NO_RESULT = 'no result';

/** The corpus-poison guard's note — see {@link usesNodesSchema}. */
export const SCHEMA_HARD_FAIL = 'HARD FAIL: the reply emits a pipeline with a top-level "nodes" key instead of "components".';

/**
 * What a seed records when the copy answered and the sanitizer left nothing.
 *
 * This is a real outcome, not a plumbing failure: with Reply Hygiene on, an answer
 * that is all scratchpad is a reply the live bot would have SUPPRESSED, which the
 * node reports as a `non_answer` No reply. Saying so is more useful than `no
 * result`, which would read as "the engine never answered".
 */
export const SANITIZED_TO_NOTHING = 'the answer was agent scratchpad, which Reply Hygiene suppresses — the bot would have posted nothing';

/** What a seed records when the copy produced no answer at all. */
export const EMPTY_ANSWER = 'the pipeline returned no answer';

// =============================================================================
// TYPES
// =============================================================================

/** Which preflight check a row is. */
export type PreflightId = 'connection' | 'judge' | 'copy' | 'golden';

/** One preflight row, as the tab renders it. */
export interface PreflightCheck {
	/** Which check this is. */
	id: PreflightId;
	/** What is being checked, in the reader's words. */
	label: string;
	/** Whether it passes. A {@link pending} check does NOT pass. */
	ok: boolean;
	/** Nothing has told the app yet: it needs the engine probe to find out. */
	pending: boolean;
	/** What is wrong and what to do about it. Empty when the check passes. */
	reason: string;
}

/**
 * What the engine-side preflight learned.
 *
 * Two checks of the four cannot be answered from the browser: whether the judge
 * pipe validates, and whether the copy validates AND starts. Both are one probe,
 * because both are the same question — can this run actually run.
 */
export interface ReplayProbe {
	/** `client.validate` on `eval-judge.pipe` found no errors. */
	judgeOk: boolean;
	/** Why it did not, in plain language. Empty when it passed. */
	judgeReason: string;
	/** The copy built, passed the guard, validated and reached RUNNING. */
	copyOk: boolean;
	/** Why it did not, in plain language. Empty when it passed. */
	copyReason: string;
}

/** Everything {@link preflight} judges the run on. */
export interface PreflightInput {
	/** The shell's WebSocket is up. */
	connected: boolean;
	/** How many golden cases a run would ask. */
	goldenCount: number;
	/** What the probe learned, or null before one has run. */
	probe: ReplayProbe | null;
}

/** A judge verdict, as the pipe returns it. */
export interface JudgeVerdict {
	/** `pass`, `partial` or `fail`. Only `pass` counts as a pass. */
	verdict: string;
	/** The judge's prose. */
	notes: string;
}

/** What one seed's round trip through the copy produced. */
export interface SeedObservation {
	/** What the case expected the bot to do. */
	expected: GoldenExpectation;
	/** The reply text AS THE BOT WOULD HAVE POSTED IT, or null when there was none. */
	reply: string | null;
	/** The reply was an escalation rather than an answer. */
	escalated: boolean;
	/**
	 * Why there is no usable reply: the sanitizer's verdict, the timeout, or the
	 * engine's own error. Null when the copy answered.
	 */
	failure: string | null;
}

/** What {@link scoreSeed} decided. */
export interface SeedScore {
	/** The judge's raw word, or the rules' own: `pass` / `partial` / `fail`. */
	verdict: string;
	/** The note the reference would have stored. */
	notes: string;
	/** The status the app's table and badge read. */
	status: SeedStatus;
	/** This seed counts towards `hardFails`. */
	hardFail: boolean;
}

/** What the tab draws while a run is in flight. */
export interface ReplayProgress {
	/** Seeds settled so far. */
	done: number;
	/** Seeds in the run. */
	total: number;
	/** The case being worked on, or null once the run is over. */
	current: GoldenCase | null;
	/**
	 * What that case is doing right now.
	 *
	 * `settled` is the beat after a seed is scored and before the next one is
	 * asked — a phase of its own so the line does not claim to be waiting for an
	 * answer it has already had, which is what the LAST seed would otherwise say
	 * for as long as the run takes to wrap up.
	 */
	phase: 'starting' | 'asking' | 'retrying' | 'judging' | 'settled' | 'done';
	/** Unix ms the run started — the elapsed clock reads off this. */
	startedAt: number;
	/** The results so far, in order, for the table filling in live. */
	seeds: SeedResult[];
}

/** Everything {@link runReplay} needs. */
export interface RunReplayOptions {
	/** The shell's connected client. */
	client: RocketRideClient;
	/** The cases to ask, in order. */
	cases: GoldenCase[];
	/**
	 * The saved settings.
	 *
	 * Two things come out of them: WHICH pipeline the copy is made of
	 * (`settings.pipeline.pipe`, so a replay measures the pipe the bot is running)
	 * and how a reply is read (Reply Hygiene, the escalation markers and the team
	 * role — the same three the node and the screens use).
	 */
	settings: BotSettings;
	/** The run before this one, for the regression diff. */
	previousRun: ReplayRun | null;
	/** Ask only the first N cases. Omitted asks them all. */
	limit?: number;
	/** Called on every state change so the tab can redraw. */
	onProgress?: (progress: ReplayProgress) => void;
	/** True once Stop was pressed: the run ends after the current seed. */
	shouldStop?: () => boolean;
	/** Wait budget per seed. Default {@link REPLAY_REPLY_TIMEOUT_MS}. */
	waitMs?: number;
	/**
	 * Where the dashboard database is.
	 *
	 * Only so the copy is built from the document the bot really runs, capture
	 * component included — which `buildReplayCopy` then removes and
	 * `assertReplayCopyIsolated` refuses to start without. The run itself never
	 * touches the database.
	 */
	conn?: DbConnection;
}

/** What a finished run produced. */
export interface RunReplayResult {
	/** The run, ready to be stored as `quality.lastRun`. */
	run: ReplayRun;
	/** Why the run stopped early, or null when it ran to the end. */
	error: string | null;
	/** Someone pressed Stop. */
	stopped: boolean;
}

// =============================================================================
// THE CORPUS-POISON GUARD (seed R10)
// =============================================================================

/**
 * Whether a reply emits a pipeline document keyed on `nodes` instead of
 * `components`.
 *
 * Seed R10 exists to catch ONE regression: the docs-scrape corpus contains an
 * obsolete `.pipe` schema whose top level is `nodes`, and a bot that has learned
 * it hands users a document the engine will not load. The reference left that
 * judgement to the LLM, inside the seed's golden answer. It is checked here as
 * well — not instead — because it is a mechanical fact about the text, a judge
 * that misses it turns the one guarded regression into a pass, and the check
 * costs nothing.
 *
 * WHAT COUNTS. A fenced code block (or, failing that, the reply's outermost
 * braces) that parses as a JSON object with a `nodes` key and no `components`
 * key. When the block does not parse — a truncated or commented example — the
 * same conclusion is drawn from the text, but only when it also carries
 * `provider` or `project_id`, so prose about "the nodes in your graph" cannot
 * trip it.
 *
 * @param reply - What the bot posted.
 * @returns True when the reply teaches the poisoned schema.
 */
export function usesNodesSchema(reply: string): boolean {
	const blocks = [...reply.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
	const candidates = blocks.length > 0 ? blocks : [reply];
	for (const candidate of candidates) {
		const braced = candidate.match(/\{[\s\S]*\}/)?.[0] ?? '';
		if (braced.length === 0) continue;
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(braced);
		} catch {
			parsed = null;
		}
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const keys = Object.keys(parsed as Record<string, unknown>);
			if (keys.includes('nodes') && !keys.includes('components')) return true;
			continue;
		}
		// Unparseable: fall back to the text, but only for something that really is
		// trying to be a pipeline document.
		const hasNodes = /"nodes"\s*:/.test(braced);
		const hasComponents = /"components"\s*:/.test(braced);
		const looksLikePipeline = /"provider"\s*:/.test(braced) || /"project_id"\s*:/.test(braced);
		if (hasNodes && !hasComponents && looksLikePipeline) return true;
	}
	return false;
}

// =============================================================================
// SCORING — the reference's own branches, in the reference's own order
// =============================================================================

/**
 * Whether this observation needs the judge at all.
 *
 * Three of the reference's four branches decide without an LLM call, and the
 * runner asks this before it pays for one.
 *
 * @param observation - What the round trip produced.
 * @returns True when only the judge can decide.
 */
export function needsJudge(observation: SeedObservation): boolean {
	if (observation.failure !== null || observation.reply === null) return false;
	if (observation.expected === 'escalate') return false;
	return !observation.escalated;
}

/**
 * Score one seed.
 *
 * Verbatim from `eval/replay.ts`:
 *
 * ```js
 * let verdict = 'fail', notes = '';
 * if (!r || r.error) { notes = r?.error ?? 'no result'; }
 * else if (c.expected === 'escalate') { verdict = r.escalated ? 'pass' : 'fail';
 *          if (!r.escalated) { notes = 'HARD FAIL: answered instead of escalating'; hardFails++; } }
 * else if (r.escalated) { verdict = 'fail'; notes = 'unnecessary escalation'; }
 * else { … verdict = j.verdict ?? 'fail'; notes = j.notes ?? ''; }
 * ```
 *
 * Note what does NOT happen: `'partial'` is stored as the verdict and is not a
 * pass, an unparseable judge reply degrades to `'fail'` (a null `judge` here),
 * and an `escalate` case never consults its golden answer.
 *
 * The one addition is the schema guard, applied AFTER the branches so it can
 * only ever make a verdict worse — see {@link usesNodesSchema}.
 *
 * @param observation - What the round trip produced.
 * @param judge - The judge's verdict, or null when there was none (not needed,
 *        or unparseable).
 * @returns The verdict, the note, the status and whether it was a hard fail.
 */
export function scoreSeed(observation: SeedObservation, judge: JudgeVerdict | null): SeedScore {
	let verdict = 'fail';
	let notes = '';
	let hardFail = false;

	if (observation.failure !== null || observation.reply === null) {
		notes = observation.failure ?? NO_RESULT;
	} else if (observation.expected === 'escalate') {
		verdict = observation.escalated ? 'pass' : 'fail';
		if (!observation.escalated) {
			notes = HARD_FAIL_NOT_ESCALATING;
			hardFail = true;
		}
	} else if (observation.escalated) {
		verdict = 'fail';
		notes = UNNECESSARY_ESCALATION;
	} else {
		verdict = judge?.verdict ?? 'fail';
		notes = judge?.notes ?? '';
	}

	if (observation.reply !== null && usesNodesSchema(observation.reply)) {
		hardFail = true;
		notes = notes.length > 0 ? `${notes} ${SCHEMA_HARD_FAIL}` : SCHEMA_HARD_FAIL;
		// A reply cannot both teach the broken schema and pass.
		if (verdict === 'pass') verdict = 'fail';
	}

	const status: SeedStatus = hardFail ? 'hard_fail' : verdict === 'pass' ? 'pass' : 'fail';
	return { verdict, notes, status, hardFail };
}

/**
 * The seeds that passed on the previous run and do not pass now.
 *
 * The reference's rule exactly: keyed on the case id, and a case ABSENT from the
 * previous run can never be a regression — a seed taught into the set this week
 * has nothing to have regressed from.
 *
 * @param seeds - This run's results.
 * @param previousRun - The run before it, or null.
 * @returns The regressed case ids, in this run's order.
 */
export function runRegressions(seeds: SeedResult[], previousRun: ReplayRun | null): string[] {
	if (previousRun === null) return [];
	const before = new Map(previousRun.seeds.map((seed) => [seed.id, seed.status]));
	return seeds.filter((seed) => seed.status !== 'pass' && before.get(seed.id) === 'pass').map((seed) => seed.id);
}

// =============================================================================
// THE RUN RECORD
// =============================================================================

/**
 * The name a driven run files itself under.
 *
 * `ReplayRun.fileName` exists because v1's only source was an import, and the
 * screen shows it. A run driven by the app has no file, so it says so in the
 * same slot rather than leaving the line blank.
 *
 * @param finishedAt - Unix ms the run ended.
 * @returns A name of the form `replay-2026-09-30T02-14-05.jsonl`.
 */
export function runFileName(finishedAt: number): string {
	return `replay-${new Date(finishedAt).toISOString().slice(0, 19).replace(/[:]/g, '-')}.jsonl`;
}

/**
 * One line of the run's JSONL.
 *
 * The five keys the import accepts come first and in the import's own order, so
 * a file written here can be imported back by `parseReplayJsonl` without any
 * knowledge of the extras; the four extras follow.
 *
 * The two Discord extras a posted run used to carry (`postedMessageId`,
 * `threadId`) are gone, because a copy posts nothing and there is no message and
 * no thread to name. What replaces them says which pipeline answered
 * (`copyProjectId` — the proof on the record that it was the copy) and whether the
 * seed had to be asked twice (`retried`).
 *
 * @param seed - One result.
 * @returns The JSON line, without its newline.
 */
export function seedJsonlLine(seed: SeedResult): string {
	return JSON.stringify({
		id: seed.id,
		question: seed.question,
		status: seed.status,
		verdict: seed.verdict,
		notes: seed.notes,
		reply: seed.reply ?? '',
		escalated: seed.escalated === true,
		copyProjectId: seed.copyProjectId ?? '',
		retried: seed.retried === true,
	});
}

/**
 * The whole run as JSONL, one seed per line, trailing newline.
 *
 * @param run - The run to export.
 * @returns The file's contents.
 */
export function runToJsonl(run: ReplayRun): string {
	return run.seeds.map(seedJsonlLine).join('\n') + '\n';
}

/**
 * The one line a finished run says.
 *
 * The reference's own console report: `replay run <id>: <passed>/<n> pass ·
 * <hardFails> hard fails · <regressions> regressions(<ids>)`, minus the run id
 * the app does not have.
 *
 * @param run - The finished run.
 * @returns The toast text.
 */
export function describeReplayRun(run: ReplayRun): string {
	const regressed = run.regressions ?? [];
	const tail = regressed.length > 0 ? ` (${regressed.join(', ')})` : '';
	return `${run.passed ?? 0}/${run.n ?? run.seeds.length} pass · ${run.hardFails ?? 0} hard fails · ${regressed.length} regressions${tail}`;
}

// =============================================================================
// PREFLIGHT
// =============================================================================

/**
 * The checks a run must pass before a seed is asked.
 *
 * Four, where the posting replay had seven. The three that are gone went with
 * Discord: there is no eval bot to sign in, no token variable to save, no support
 * channel to post in, and the support bot does not have to be running at all —
 * the copy IS the bot, started for the run and terminated after it.
 *
 * What is left is what can still go wrong, and every row carries its own
 * sentence, because the two engine-side failures are otherwise indistinguishable
 * from each other: a judge pipe the server will not accept and a copy the server
 * will not start both look like a run that did nothing.
 *
 * `judge` and `copy` are {@link PreflightCheck.pending} until the probe has run.
 *
 * @param input - See {@link PreflightInput}.
 * @returns One row per check, in the order the tab lists them.
 */
export function preflight(input: PreflightInput): PreflightCheck[] {
	const checks: PreflightCheck[] = [];
	const probe = input.probe;

	checks.push({
		id: 'connection',
		label: 'Connected to the engine',
		ok: input.connected,
		pending: false,
		reason: input.connected ? '' : 'The shell has no connection to the engine, so no pipeline can be started.',
	});

	checks.push({
		id: 'judge',
		label: 'The judge pipeline is valid',
		ok: probe !== null && probe.judgeOk,
		pending: probe === null,
		reason: probe === null ? 'Not checked yet — the app has to ask the engine to validate eval-judge.pipe.' : probe.judgeOk ? '' : probe.judgeReason,
	});

	checks.push({
		id: 'copy',
		label: 'The private copy builds, is isolated and starts',
		ok: probe !== null && probe.copyOk,
		pending: probe === null,
		reason: probe === null ? 'Not checked yet — the app has to build the copy of the bot’s pipeline and start it on the engine.' : probe.copyOk ? '' : probe.copyReason,
	});

	checks.push({
		id: 'golden',
		label: 'The golden set has cases',
		ok: input.goldenCount > 0,
		pending: false,
		reason: input.goldenCount > 0 ? '' : 'The golden set is empty, so there is nothing to test.',
	});

	return checks;
}

/**
 * The first reason a run cannot start, or null when every check passes.
 *
 * @param checks - What {@link preflight} returned.
 * @returns The blocking sentence, or null.
 */
export function preflightBlocker(checks: PreflightCheck[]): string | null {
	const failed = checks.find((check) => !check.ok);
	return failed === undefined ? null : failed.reason;
}

// =============================================================================
// ENGINE PLUMBING
// =============================================================================

/** The message of an unknown throw, never an empty string. */
export function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The engine gave no reason.';
}

/** A promise that settles after `ms`. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reject after `ms`, so one slow seed cannot hold a run open forever.
 *
 * The client has a request timeout of its own, but it is the shell's and it is
 * measured in seconds: a `send` into an agent pipe legitimately takes minutes, so
 * the budget that matters is this one. The timer is cleared by the caller's
 * `finally` — a pending `setTimeout` per seed would otherwise keep the run's
 * closure alive for four minutes after it ended.
 *
 * @param ms - The budget.
 * @param label - What ran out of time, for the message.
 * @returns A promise that never resolves, and the handle to cancel it.
 */
function deadline(ms: number, label: string): { promise: Promise<never>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} within ${Math.round(ms / 1000)} s`)), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Start an eval pipe, or attach to the task a previous run left behind.
 *
 * `useExisting: true` for the same reason every other start in this app passes
 * it: a second viewer, or this viewer after a reload, must find the task that
 * exists rather than starting a second one against the same source.
 *
 * @param client - The shell's connected client.
 * @param pipe - One of `EVAL_PIPES`.
 * @param ttl - Idle seconds before the engine reclaims the task.
 * @returns The task token.
 */
async function startPipe(client: RocketRideClient, pipe: EvalPipe, ttl: number): Promise<string> {
	const result = await client.use({
		pipeline: evalPipelineOf(pipe),
		source: pipe.source,
		useExisting: true,
		ttl,
		name: `Discord Dashboard ${pipe.label}`,
	});
	return result.token;
}

/**
 * The copy of the bot's pipeline a run would ask, with the guard already applied.
 *
 * One function so the preflight, the tab's description line and the run itself
 * can never disagree about what is going to run.
 *
 * The live pipeline is resolved WITH the database connection, so the copy is
 * made from the document the bot really runs — capture component and all —
 * and `buildReplayCopy` then has something real to cut out. Resolving without
 * it would mean the removal and the guard were only ever exercised by the
 * self-test.
 *
 * @param settings - The saved settings. `settings.pipeline.pipe` picks the pipe.
 * @param conn - Where the dashboard database is, or undefined when the caller
 *        has none (the copy then simply never had capture in it).
 * @returns The copy.
 * @throws When the copy is not isolated — see `assertReplayCopyIsolated`.
 */
export function replayCopyFor(settings: BotSettings, conn?: DbConnection): Record<string, unknown> {
	const live = resolvePipeline(PIPELINES[settings.pipeline.pipe], settings, {
		conn,
	}) as unknown as Record<string, unknown>;
	const copy = buildReplayCopy(live);
	assertReplayCopyIsolated(copy, LIVE_PROJECT_IDS);
	return copy;
}

/**
 * What the copy is, for the line the Replay tab prints above the buttons.
 *
 * @param settings - The saved settings.
 * @param conn - Where the dashboard database is.
 * @returns The description, or null when the copy cannot even be built (which the
 *          `copy` preflight check then explains).
 */
export function describeReplayCopyFor(settings: BotSettings, conn?: DbConnection): ReplayCopyDescription | null {
	try {
		return describeReplayCopy(replayCopyFor(settings, conn));
	} catch {
		return null;
	}
}

/**
 * Terminate the copy's task if one is running, then start a fresh one.
 *
 * TERMINATE FIRST, and `useExisting: false`, which is the opposite of every other
 * start in this app — and deliberately so. A task left over from an earlier run
 * is running the pipeline THAT run copied: the pipe may have changed in Settings
 * since, the prompts may have, and attaching to it would score a graph nobody
 * chose. `(project_id, source)` is the identity, so the stale task is found
 * whether or not this session is the one that started it.
 *
 * The task is then waited for: `client.use` resolves when the TASK exists, not
 * when its pipeline instance is serving, so the first `send` after a cold start
 * can arrive before the agent is there.
 *
 * @param client - The shell's connected client.
 * @param copy - What {@link replayCopyFor} produced.
 * @returns The copy's task token, with the task reporting RUNNING.
 * @throws When the copy cannot be started, or is not running in time.
 */
async function startReplayCopy(client: RocketRideClient, copy: Record<string, unknown>): Promise<string> {
	const stale = await client.getTaskToken({ projectId: REPLAY_COPY_PROJECT_ID, source: REPLAY_COPY_SOURCE }).catch(() => undefined);
	if (stale) await client.terminate(stale).catch(() => undefined);

	const started = await client.use({
		pipeline: copy as unknown as PipelineConfig,
		source: REPLAY_COPY_SOURCE,
		useExisting: false,
		ttl: REPLAY_COPY_TTL_SECONDS,
		name: 'Discord Dashboard test copy',
	});
	const token = started.token;

	const until = Date.now() + COPY_START_TIMEOUT_MS;
	for (;;) {
		const status = await client.getTaskStatus(token).catch(() => null);
		if (status !== null && status.state === TASK_STATE_RUNNING && status.serviceUp !== false) return token;
		if (Date.now() >= until) {
			throw new Error(`The test copy started but was not running after ${Math.round(COPY_START_TIMEOUT_MS / 1000)} s. Check the engine's task list.`);
		}
		await sleep(COPY_START_POLL_MS);
	}
}

/**
 * Answer the two engine-side preflight checks.
 *
 * It really does start the copy, because "the copy starts" is the one thing a
 * validation cannot tell you — a document the server accepts can still fail on a
 * missing model key or an unreachable store. The task is terminated again
 * afterwards: the run starts its own (see {@link startReplayCopy}), so leaving
 * this one up would buy nothing and hold an agent for half an hour.
 *
 * @param client - The shell's connected client.
 * @param settings - The saved settings.
 * @param conn - Where the dashboard database is.
 * @returns What it learned. Never throws: every failure is one of the two
 *          reasons, which is what the preflight rows print.
 */
export async function probeReplay(client: RocketRideClient, settings: BotSettings, conn?: DbConnection): Promise<ReplayProbe> {
	const probe: ReplayProbe = { judgeOk: false, judgeReason: '', copyOk: false, copyReason: '' };

	try {
		const result = await client.validate({ pipeline: evalPipelineOf(EVAL_PIPES.judge) });
		const errors = (result.errors ?? []).map((error) => error.message).filter((text) => text.length > 0);
		probe.judgeOk = errors.length === 0;
		if (!probe.judgeOk) {
			probe.judgeReason = `The engine rejected eval-judge.pipe: ${errors.slice(0, 2).join('; ')}. A test cannot be scored without the judge.`;
		}
	} catch (err) {
		probe.judgeReason = `The judge pipeline could not be validated: ${reasonOf(err)}`;
	}

	let copy: Record<string, unknown> | null = null;
	try {
		copy = replayCopyFor(settings, conn);
	} catch (err) {
		probe.copyReason = reasonOf(err);
	}

	if (copy !== null) {
		try {
			const result = await client.validate({ pipeline: copy });
			const errors = (result.errors ?? []).map((error) => error.message).filter((text) => text.length > 0);
			if (errors.length > 0) {
				probe.copyReason = `The engine rejected the copy of the bot’s pipeline: ${errors.slice(0, 2).join('; ')}.`;
			} else {
				const token = await startReplayCopy(client, copy);
				probe.copyOk = true;
				// Terminated on purpose — the run starts its own copy, so holding this
				// one would keep an agent task idle for nothing.
				await client.terminate(token).catch(() => undefined);
			}
		} catch (err) {
			probe.copyReason = `The copy could not be started: ${reasonOf(err)}`;
		}
	}

	return probe;
}

/**
 * Judge one reply.
 *
 * The input is the reference's exactly: ONE `text/plain` object holding
 * `{question, golden_answer, reply}`. An unparseable answer returns null, which
 * {@link scoreSeed} degrades to `'fail'` — the reference's behaviour, and better
 * than a verdict the app invented.
 *
 * @param client - The shell's connected client.
 * @param token - The judge task's token.
 * @param seq - A counter, so two sends never share an object name.
 * @param input - The question, its golden answer and the reply.
 * @returns The verdict, or null when the judge said nothing usable.
 */
async function judgeReply(client: RocketRideClient, token: string, seq: number, input: { question: string; golden_answer: string | null; reply: string }): Promise<JudgeVerdict | null> {
	const result: PIPELINE_RESULT | undefined = await client.send(token, JSON.stringify(input), { name: `judge-${Date.now()}-${seq}.txt` }, 'text/plain');
	const parsed = parseGraderOutput(firstAnswer(result));
	if (parsed === null) return null;
	const verdict = typeof parsed.verdict === 'string' ? parsed.verdict : '';
	if (verdict.length === 0) return null;
	return { verdict, notes: typeof parsed.notes === 'string' ? parsed.notes : '' };
}

// =============================================================================
// ASKING ONE SEED
// =============================================================================

/** What one `send` into the copy came back with. */
interface AskResult {
	/** The reply as the node would have posted it. '' when it would have posted none. */
	shown: string;
	/** The raw answer, before the sanitizer. */
	raw: string;
}

/**
 * Ask the copy one question and read the answer the way the bot's node would.
 *
 * The question goes in VERBATIM as `text/plain`, and that is the whole reason this
 * works: the engine routes `text/*` to the `text` lane only, and the discord node
 * hands a brand-new question to the pipeline as `pipe.writeText(message.content)`
 * — also verbatim, also the text lane. So the agent sees exactly the shape a real
 * asker produces. No prefix, no `[replay]` marker: a prefixed question is a
 * different question, and the bot would be scored on an input nobody sends.
 *
 * @param client - The shell's connected client.
 * @param token - The copy's task token.
 * @param question - The seed question, verbatim.
 * @param name - The object name. Unique per send: the prompt node keys its context
 *        on it, so a reused name would answer the previous question's context.
 * @param settings - The saved settings, for Reply Hygiene and the markers.
 * @param waitMs - The budget for this one send.
 * @returns The shown and raw replies.
 * @throws When the send fails, or outlives `waitMs`.
 */
async function askCopy(client: RocketRideClient, token: string, question: string, name: string, settings: BotSettings, waitMs: number): Promise<AskResult> {
	const timeout = deadline(waitMs, 'no answer');
	let result: PIPELINE_RESULT | undefined;
	try {
		result = await Promise.race([client.send(token, question, { name }, 'text/plain'), timeout.promise]);
	} finally {
		timeout.cancel();
	}
	const raw = firstAnswer(result);
	const shown = settings.behavior.sanitizeReplies ? sanitizeShownReply(raw, settings.behavior.escalationMarkers) : raw;
	return { shown, raw };
}

// =============================================================================
// THE RUNNER
// =============================================================================

/**
 * Run the golden set through a private copy of the bot's pipeline.
 *
 * The reference's `replay()`, step for step:
 *
 * 1. build the copy of `PIPELINES[settings.pipeline.pipe]` as Settings resolves
 *    it, and ASSERT it is isolated — a throw here aborts before anything starts;
 * 2. terminate any copy a previous run left behind and start a fresh one, then
 *    wait for it to be running;
 * 3. start `eval-judge.pipe`, as the grading batch does;
 * 4. for each case, in order, and never two at once:
 *    a. `send` the question VERBATIM as `text/plain` and read the answer off the
 *       result;
 *    b. put it through the node's own sanitizer when Reply Hygiene is on, and ask
 *       ONCE more under a new object name if that left nothing — which mirrors
 *       the node's `nonAnswerRetries` default of 1, so a run is not failed by the
 *       one scratchpad answer the live bot would also have retried;
 *    c. classify it with the app's own `classifyRalphReply`, so "this was an
 *       escalation" means the same thing here as on every screen;
 *    d. score it with {@link scoreSeed}, asking the judge only when
 *       {@link needsJudge} says the rules cannot decide alone;
 * 5. diff against the previous run and return the whole thing.
 *
 * The copy is terminated at the end, however the run ended: it holds an agent, a
 * model and a retrieval store, and a tab closed mid-run must not leave one
 * running. The JUDGE task is left to its ttl, which is what the grading batch
 * does too — a second run within ten minutes then re-attaches to it.
 *
 * An engine failure mid-run stops the run and is returned on `error`. The seeds
 * already scored are kept and stored, because "six of ten ran and then the engine
 * went away" is a more useful record than nothing.
 *
 * @param options - See {@link RunReplayOptions}.
 * @returns The run, and why it stopped early if it did.
 */
export async function runReplay(options: RunReplayOptions): Promise<RunReplayResult> {
	const { client, settings, previousRun, onProgress } = options;
	const cases = options.limit === undefined ? options.cases : options.cases.slice(0, options.limit);
	const waitMs = options.waitMs ?? REPLAY_REPLY_TIMEOUT_MS;
	const startedAt = Date.now();
	const seeds: SeedResult[] = [];
	let hardFails = 0;
	let error: string | null = null;
	let stopped = false;
	let copyToken: string | null = null;
	let judgeToken: string | null = null;
	let judgeSeq = 0;

	/** One progress emit. `seeds` is copied so the tab can hold it as state. */
	const report = (current: GoldenCase | null, phase: ReplayProgress['phase']): void => {
		onProgress?.({ done: seeds.length, total: cases.length, current, phase, startedAt, seeds: [...seeds] });
	};

	report(cases[0] ?? null, 'starting');

	try {
		// The guard runs BEFORE anything is started. A copy that is not isolated is
		// not a run that goes wrong — it is a run that must not begin.
		const copy = replayCopyFor(settings, options.conn);
		copyToken = await startReplayCopy(client, copy);
		judgeToken = await startPipe(client, EVAL_PIPES.judge, EVAL_TASK_TTL_SECONDS);
		const task = copyToken;
		const judge = judgeToken;

		for (const seedCase of cases) {
			if (options.shouldStop?.() === true) {
				stopped = true;
				break;
			}

			// --- ask ---------------------------------------------------------------
			report(seedCase, 'asking');
			let observation: SeedObservation = {
				expected: seedCase.expected,
				reply: null,
				escalated: false,
				failure: null,
			};
			let retried = false;
			try {
				let asked = await askCopy(client, task, seedCase.question, `replay-${seedCase.id}-${Date.now()}.txt`, settings, waitMs);
				if (asked.shown.trim().length === 0) {
					retried = true;
					report(seedCase, 'retrying');
					asked = await askCopy(client, task, seedCase.question, `replay-${seedCase.id}-retry-${Date.now()}.txt`, settings, waitMs);
				}
				if (asked.shown.trim().length === 0) {
					// The copy answered; what it said was not an answer. Which of the two
					// reasons it was decides what the note says, because "the sanitizer
					// suppressed this" and "the pipeline returned nothing" are different
					// bugs to go and look for.
					observation = {
						...observation,
						failure: asked.raw.trim().length > 0 ? SANITIZED_TO_NOTHING : EMPTY_ANSWER,
					};
				} else {
					observation = {
						...observation,
						reply: asked.shown,
						escalated: classifyRalphReply(asked.shown, roleMentionOf(settings.discord.teamRoleId), DEAD_END_REPLY, settings.behavior.escalationMarkers).type === 'escalation',
					};
				}
			} catch (err) {
				// A send that failed is this SEED's failure, not the run's: the next seed
				// may well answer fine, and the reference recorded a per-case error the
				// same way.
				observation = { ...observation, failure: reasonOf(err) };
			}

			// --- judge and score -----------------------------------------------------
			let verdict: JudgeVerdict | null = null;
			if (needsJudge(observation)) {
				report(seedCase, 'judging');
				judgeSeq += 1;
				verdict = await judgeReply(client, judge, judgeSeq, {
					question: seedCase.question,
					golden_answer: seedCase.goldenAnswer,
					reply: observation.reply ?? '',
				});
			}
			const score = scoreSeed(observation, verdict);
			if (score.hardFail) hardFails += 1;
			seeds.push({
				id: seedCase.id,
				question: seedCase.question,
				status: score.status,
				verdict: score.verdict,
				notes: score.notes,
				reply: observation.reply,
				escalated: observation.escalated,
				copyProjectId: REPLAY_COPY_PROJECT_ID,
				retried,
			});
			report(seedCase, 'settled');
		}
	} catch (err) {
		error = reasonOf(err);
	} finally {
		// Always, and best effort: a task the engine already reclaimed must not turn
		// a finished run into a failed one. The judge task is left to its ttl.
		if (copyToken !== null) await client.terminate(copyToken).catch(() => undefined);
	}

	const finishedAt = Date.now();
	const passed = seeds.filter((seed) => seed.status === 'pass').length;
	const run: ReplayRun = {
		importedAt: finishedAt,
		fileName: runFileName(finishedAt),
		seeds,
		startedAt,
		finishedAt,
		n: seeds.length,
		passed,
		hardFails,
		regressions: runRegressions(seeds, previousRun),
		stoppedEarly: stopped || error !== null,
	};
	report(null, 'done');
	return { run, error, stopped };
}
