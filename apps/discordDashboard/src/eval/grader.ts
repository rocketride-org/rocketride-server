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
// EVAL GRADER — label the quiet threads, step for step with the reference
// =============================================================================
//
// A port of the reference bot's `eval/grader.ts` (phase 3): for each thread that
// has gone quiet, ask an LLM what it sees, ask the retrieval pipe whether the
// knowledge base already held the answer, and then let the PURE rules in
// `rules.ts` decide the outcome and the cause. The LLM never decides the label —
// it supplies SIGNALS (did the team correct the bot, did the asker confirm, what
// kind of escalation was this) and the ported rules turn those into the same
// label the reference bot's own grader would have produced.
//
// Everything above {@link runGradeBatch} is pure: build the input, parse the
// output, score a retrieval result, apply a grade to a row. `runGradeBatch` is
// the only part that touches the engine or the app's state, and it does four
// things the reference did not have to think about:
//
// ONE ROW AT A TIME. The grader pipe ends in a stateful `prompt` node, which
// accumulates context across requests keyed on the OBJECT NAME. The reference
// worked around that by restarting the task after every send (`SerialPipe`);
// here every send gets a unique object name instead, and the sends are awaited in
// order so two are never in flight on one token. Restarting per row would cost a
// task start per thread.
//
// EXCLUDED ROWS COST NOTHING. `decideOutcome` with no grader signals already
// knows whether a thread is out of the denominator (the opener is on the team, or
// is a test bot, or the bot flagged a manipulation attempt), so those rows are
// saved excluded without an LLM call — the reference's "cheap" pre-check.
//
// EVERY WRITE IS PER ROW, BY ID. A batch takes minutes and the capture is live
// the whole time, so the grade for one row is one `dd_threads` upsert keyed on
// that thread, never a whole conversations array posted back. The upsert's
// update list names exactly the columns a grade owns, so a dismissal or a
// review another admin made while the batch ran survives it.
//
// A PARSE FAILURE LEAVES THE ROW OPEN. It is counted and reported, and the next
// batch will try it again. Writing a half-grade would be worse than writing none.
// =============================================================================

import type { PIPELINE_RESULT, RocketRideClient } from 'shell';
import { EVAL_PIPES, EVAL_TASK_TTL_SECONDS, evalPipelineOf, type EvalPipe } from './pipes';
import { testBotIdsOf, threadInfoOf } from './events';
import { decideCause, decideOutcome, type EvalCause, type EvalEvent, type EvalOutcome, type GraderSignals } from './rules';
import type { DashboardActions } from '../db/useDashboardData';
import type { AppData, BotSettings, ConversationRow, GraderCluster } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Rows graded per click, unless the caller says otherwise. */
export const GRADE_BATCH_LIMIT = 20;

/** Longest text one transcript turn carries — the reference's own clip. */
export const TRANSCRIPT_TEXT_LIMIT = 1500;

/** Longest text sent to the retrieval pipe — the reference's own clip. */
export const RETRIEVAL_TEXT_LIMIT = 4000;

// =============================================================================
// TYPES
// =============================================================================

/** Who spoke one turn of the transcript the grader reads. */
export type GraderRole = 'ralph' | 'team' | 'user' | 'other';

/** One turn of that transcript. */
export interface GraderTurn {
	role: GraderRole;
	text: string;
}

/**
 * The ONE JSON object `eval-grader.pipe` is sent.
 *
 * The field names are the prompt's own contract — see the `prompt_1`
 * instructions in `src/pipelines/eval-grader.pipe`. Changing one here without
 * changing it there makes the model guess.
 */
export interface GraderInput {
	/** The thread's opening question. */
	question: string;
	/** Every event that carried text, oldest first, clipped. */
	transcript: GraderTurn[];
	/** Whether the bot escalated, and what it said when it did. */
	escalation: { present: boolean; text: string };
	/** The clusters already known, so the model reuses one instead of coining it. */
	clusters: GraderCluster[];
}

/**
 * What the grader LLM answers with.
 *
 * Every field is optional: this is a model's JSON, not a schema the app can
 * enforce, and the rules below treat anything missing as "no signal". The index
 * signature is what lets `graderJson` keep fields the app does not read.
 */
export interface GraderOutput {
	/** An existing cluster by id, or a new one to create. */
	cluster?: {
		id?: string | number | null;
		new?: { label?: string; description?: string } | null;
	} | null;
	/** Why the bot escalated, when it did. */
	escalation_category?: GraderSignals['escalation_category'];
	/** What a team member's message in the thread was. */
	team_reply_kind?: GraderSignals['team_reply_kind'];
	/** Whether the asker said it worked. */
	user_signal?: GraderSignals['user_signal'];
	/** A root cause only the model can see. */
	llm_cause?: GraderSignals['llm_cause'];
	/** A knowledge-base draft, proposed only when the TEAM supplied the answer. */
	qa_draft?: { question?: string; answer?: string } | null;
	/** One line of prose about the thread. */
	summary?: string;
	[key: string]: unknown;
}

/** One document `eval-retrieve.pipe` returns. */
export interface RetrievedDocument {
	/** Chroma's DISTANCE for this chunk: lower is closer. */
	score?: number;
	metadata?: { objectId?: string; chunkId?: string | number; [key: string]: unknown };
	text?: string;
	[key: string]: unknown;
}

/** What one retrieval pass tells the analysis. */
export interface RetrievalScore {
	/**
	 * The CLOSEST distance returned — the MINIMUM, not the maximum. Null when the
	 * pipe returned no documents at all.
	 */
	top: number | null;
	/** `objectId:chunkId` of every chunk within `matchDistance`. */
	ids: Set<string>;
}

/** The counts one batch reports, and the causes it decided. */
export interface GradeBatchResult {
	/** Rows that came back with a grade. */
	graded: number;
	/** Rows saved excluded without an LLM call. */
	excluded: number;
	/** Rows whose grader output could not be parsed. Left open. */
	failed: number;
	/** How many rows landed on each cause; `(success)` for the ones that passed. */
	causes: Record<string, number>;
	/** Why the batch stopped early, or null when it ran to the end. */
	error: string | null;
}

/** Everything {@link runGradeBatch} needs from the app. */
export interface GradeBatchOptions {
	/** The shell's connected client. */
	client: RocketRideClient;
	/** The data as the screen holds it — only the ROW SELECTION reads it. */
	data: AppData;
	/** The database writes. Every grade goes through them. */
	actions: DashboardActions;
	/** Unix ms the batch started. */
	now: number;
	/** Rows to grade. Default {@link GRADE_BATCH_LIMIT}. */
	limit?: number;
	/** Called after each row so the button can count up. */
	onProgress?: (done: number, total: number) => void;
}

// =============================================================================
// SELECTION
// =============================================================================

/**
 * The rows a batch should grade, newest first.
 *
 * The reference's `getOpenThreadsForGrading(Date.now() - quietHours * 3600_000,
 * limit)`: a thread is gradeable once it is OPEN and has been quiet long enough
 * that nobody is still reading it. Newest first, because a question asked today
 * is the one somebody wants the answer to.
 *
 * Sample rows are never selected: sample mode disables the button, and a sample
 * row reaching the LLM would spend real money on fiction.
 *
 * @param rows - The captured conversations.
 * @param options.now - Unix ms.
 * @param options.quietHours - `settings.eval.quietHours`.
 * @param options.ignoreQuiet - `settings.eval.gradeNowIgnoresQuiet`: take every
 *        open row regardless of how recently it moved.
 * @param options.limit - How many to take.
 * @returns The rows to grade, newest activity first.
 */
export function selectRowsForGrading(rows: ConversationRow[], options: { now: number; quietHours: number; ignoreQuiet: boolean; limit: number }): ConversationRow[] {
	const cutoff = options.now - options.quietHours * 3600_000;
	return rows
		.filter((row) => row.sample !== true)
		.filter((row) => (row.evalStatus ?? 'open') === 'open')
		.filter((row) => options.ignoreQuiet || (row.lastActivityAt ?? row.updatedAt) < cutoff)
		.sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
		.slice(0, options.limit);
}

// =============================================================================
// CLUSTERS
// =============================================================================

/**
 * The id a cluster label gets.
 *
 * Derived from the label rather than counted, because "upsert by label" then
 * needs no lookup table and survives two sessions grading at once: both derive
 * the same id for the same label, so the two writes agree instead of creating
 * two clusters for one problem.
 *
 * @param label - The label the grader proposed.
 * @returns A slug, or 'cluster' when the label had nothing sluggable in it.
 */
export function clusterIdOf(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return slug.length > 0 ? slug : 'cluster';
}

/**
 * Add a cluster, or update the description of the one that already has its label.
 *
 * The reference's `upsertCluster`. A label collision on the derived id between
 * two DIFFERENT labels gets a numeric suffix, so two clusters never share an id.
 *
 * @param clusters - The clusters known so far.
 * @param label - The label the grader proposed.
 * @param description - Its one-line description.
 * @returns The new list and the cluster's id. The SAME list when nothing changed.
 */
export function upsertCluster(clusters: GraderCluster[], label: string, description: string): { clusters: GraderCluster[]; id: string } {
	const trimmed = label.trim();
	if (trimmed.length === 0) return { clusters, id: '' };

	const held = clusters.findIndex((cluster) => cluster.label === trimmed);
	if (held !== -1) {
		if (clusters[held].description === description || description.length === 0) {
			return { clusters, id: clusters[held].id };
		}
		const next = clusters.slice();
		next[held] = { ...next[held], description };
		return { clusters: next, id: next[held].id };
	}

	let id = clusterIdOf(trimmed);
	for (let suffix = 2; clusters.some((cluster) => cluster.id === id); suffix += 1) {
		id = `${clusterIdOf(trimmed)}-${suffix}`;
	}
	return { clusters: [...clusters, { id, label: trimmed, description }], id };
}

// =============================================================================
// GRADER INPUT
// =============================================================================

/**
 * Who spoke, from an event type.
 *
 * The reference's `roleOf`, unchanged — note that `manipulation_flag` and every
 * reaction fall through to `other` there too, so a reaction does not read as a
 * person talking.
 *
 * @param type - An {@link EvalEvent} type.
 * @returns The transcript role.
 */
export function roleOf(type: string): GraderRole {
	if (type === 'ralph_answer' || type === 'escalation' || type === 'dead_end') return 'ralph';
	if (type === 'team_reply' || type === 'team_mention') return 'team';
	if (type === 'question' || type === 'user_message') return 'user';
	return 'other';
}

/** The thread's events, oldest first. */
function inOrder(events: EvalEvent[]): EvalEvent[] {
	return [...events].sort((a, b) => a.ts - b.ts);
}

/**
 * Everything the team said in the thread, as one block of text.
 *
 * The reference joined `team_reply` and `team_mention` texts with a blank line
 * and used the result twice: as the retrieval query that asks "does the knowledge
 * base already hold this answer", and — by being non-empty — as the fact that
 * there IS a team answer to look for.
 *
 * @param events - The thread's events.
 * @returns The joined text, or '' when the team said nothing.
 */
export function teamTextOf(events: EvalEvent[]): string {
	return inOrder(events)
		.filter((event) => event.type === 'team_reply' || event.type === 'team_mention')
		.map((event) => event.text ?? '')
		.filter((text) => text.length > 0)
		.join('\n\n');
}

/**
 * Build the JSON object the grader pipe is sent.
 *
 * @param row - The thread row, with its event log.
 * @param clusters - The clusters known so far.
 * @returns The grader input.
 */
export function buildGraderInput(row: ConversationRow, clusters: GraderCluster[]): GraderInput {
	const events = inOrder(row.events ?? []);
	const transcript: GraderTurn[] = events
		.filter((event) => (event.text ?? '').length > 0)
		.map((event) => ({
			role: roleOf(event.type),
			text: String(event.text).slice(0, TRANSCRIPT_TEXT_LIMIT),
		}));
	const escalation = events.find((event) => event.type === 'escalation');
	return {
		question: row.question,
		transcript,
		escalation: { present: escalation !== undefined, text: escalation?.text ?? '' },
		clusters,
	};
}

// =============================================================================
// GRADER OUTPUT
// =============================================================================

/**
 * The first `answers` string out of a pipeline result.
 *
 * `result_types` maps a response FIELD to the lane type it holds, and the field
 * is named by the pipe's `response_answers` component (`answers` in the shipped
 * grader pipe). Reading the map rather than the name means a renamed lane does
 * not silently return nothing.
 *
 * @param result - What `client.send` resolved to.
 * @returns The answer text, or '' when the pipeline produced none.
 */
export function firstAnswer(result: PIPELINE_RESULT | undefined): string {
	if (!result) return '';
	const types = (result.result_types ?? {}) as Record<string, string>;
	for (const [field, kind] of Object.entries(types)) {
		if (kind === 'answers' && Array.isArray(result[field])) return String(result[field][0] ?? '');
	}
	return Array.isArray(result.answers) ? String(result.answers[0] ?? '') : '';
}

/**
 * Parse the grader's JSON out of whatever the model wrote.
 *
 * The reference's `parseJson`: the prompt asks for bare JSON, but a model that
 * wraps it in prose or a fence still has one `{ … }` in its answer, and taking
 * the outermost braces recovers it. A failure is null, and a null leaves the row
 * open — never a half-grade.
 *
 * @param text - The answer text.
 * @returns The parsed object, or null.
 */
export function parseGraderOutput(text: string): GraderOutput | null {
	const source = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
	try {
		const parsed = JSON.parse(source) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as GraderOutput;
	} catch {
		return null;
	}
}

/**
 * The signals `decideOutcome` and `decideCause` read, out of the grader's JSON.
 *
 * @param output - The parsed grader output.
 * @returns The signals, with anything the model omitted left undefined.
 */
export function signalsOf(output: GraderOutput): GraderSignals {
	return {
		team_reply_kind: output.team_reply_kind,
		user_signal: output.user_signal,
		escalation_category: output.escalation_category,
		llm_cause: output.llm_cause,
	};
}

// =============================================================================
// RETRIEVAL
// =============================================================================

/**
 * The documents out of a retrieval result.
 *
 * @param result - What `client.send` resolved to.
 * @returns The documents, or [] when the pipeline produced none.
 */
export function retrievedDocuments(result: PIPELINE_RESULT | undefined): RetrievedDocument[] {
	if (!result) return [];
	const types = (result.result_types ?? {}) as Record<string, string>;
	for (const [field, kind] of Object.entries(types)) {
		if (kind === 'documents' && Array.isArray(result[field])) return result[field] as RetrievedDocument[];
	}
	return Array.isArray(result.documents) ? (result.documents as RetrievedDocument[]) : [];
}

/**
 * Score one retrieval pass.
 *
 * THE SIGN IS THE WHOLE POINT. `eval-retrieve.pipe` ends in a `chroma` component
 * and Chroma's `score` is a DISTANCE: a real docs question tops out around 0.78
 * and nonsense sits around 0.91, so lower is closer. Two things follow, and both
 * are the opposite of the reference's:
 *
 * - `top` is the MINIMUM of the scores, not the maximum.
 * - a chunk counts as matched at `score <= matchDistance`, not `>=`.
 *
 * `top` is null rather than 0 for an empty result, because 0 is the BEST possible
 * distance and would read as a perfect hit.
 *
 * @param documents - What the retrieve pipe returned.
 * @param matchDistance - `settings.eval.matchDistance`.
 * @returns The closest distance and the ids of the matching chunks.
 */
export function scoreRetrieval(documents: RetrievedDocument[], matchDistance: number): RetrievalScore {
	const scores = documents.map((document) => document.score).filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
	const ids = new Set<string>();
	for (const document of documents) {
		const score = document.score;
		if (typeof score !== 'number' || !Number.isFinite(score) || score > matchDistance) continue;
		ids.add(`${document.metadata?.objectId ?? ''}:${document.metadata?.chunkId ?? ''}`);
	}
	return { top: scores.length > 0 ? Math.min(...scores) : null, ids };
}

// =============================================================================
// APPLYING A RESULT TO A ROW
// =============================================================================

/** Everything one graded row learns. */
export interface RowGrade {
	outcome: EvalOutcome;
	cause: EvalCause | null;
	/** The grader's JSON plus `_auto_outcome` / `_auto_cause`, as text. */
	graderJson: string;
	qTopScore: number | null;
	aTopScore: number | null;
	clusterId: string | null;
	gradedAt: number;
	/** The KB draft, when the grader proposed one. */
	qaDraft: { question: string; answer: string } | null;
}

/**
 * The reference's `saveGrade`, as a pure row transform.
 *
 * `outcomeSource` and `causeSource` are both `'auto'`: the rules decided this,
 * not a human, and the review stage needs to know which it is looking at before
 * it overwrites either.
 *
 * @param row - The row as it stands.
 * @param grade - What the grading pass produced.
 * @returns The graded row.
 */
export function applyGradeToRow(row: ConversationRow, grade: RowGrade): ConversationRow {
	return {
		...row,
		evalStatus: 'graded',
		evalOutcome: grade.outcome,
		evalCause: grade.cause,
		outcomeSource: 'auto',
		causeSource: 'auto',
		grade: {
			graderJson: grade.graderJson,
			qTopScore: grade.qTopScore,
			aTopScore: grade.aTopScore,
			clusterId: grade.clusterId,
			gradedAt: grade.gradedAt,
		},
		// Only when the grader proposed one: a row that already holds a draft from
		// an earlier pass keeps it rather than having it cleared by a later grade
		// that saw no team answer.
		qaDraft: grade.qaDraft ?? row.qaDraft ?? null,
	};
}

/**
 * The reference's `saveExcluded`, as a pure row transform.
 *
 * No `grade` is written: there was no grader call, so there is nothing to record
 * — and a `grade` object with an empty `graderJson` would read, to the review
 * stage, as a grader that answered with nothing.
 *
 * @param row - The row as it stands.
 * @param reason - `decideOutcome`'s `excluded_reason`.
 * @returns The excluded row.
 */
export function applyExclusionToRow(row: ConversationRow, reason: string): ConversationRow {
	return {
		...row,
		evalStatus: 'graded',
		evalOutcome: 'excluded',
		evalCause: null,
		outcomeSource: 'auto',
		excludedReason: reason,
	};
}

// =============================================================================
// SENDING
// =============================================================================

/**
 * Start an eval pipe, or attach to the task a previous batch left running.
 *
 * `useExisting: true` is the same reasoning as the bot's own start: a second
 * viewer, or this viewer after a reload, must find the task that already exists
 * instead of starting a second one against the same source.
 *
 * @param client - The shell's connected client.
 * @param pipe - One of `EVAL_PIPES`.
 * @returns The task token.
 */
async function startEvalPipe(client: RocketRideClient, pipe: EvalPipe): Promise<string> {
	const result = await client.use({
		pipeline: evalPipelineOf(pipe),
		source: pipe.source,
		useExisting: true,
		ttl: EVAL_TASK_TTL_SECONDS,
		name: `Discord Dashboard ${pipe.label}`,
	});
	return result.token;
}

/**
 * A unique object name for one send.
 *
 * The grader pipe's `prompt` node keys its accumulated context on the object
 * name, so two sends under one name would have the second read the first's
 * context. The counter is per module instance, and the timestamp keeps two app
 * sessions apart.
 */
let sendSeq = 0;
function uniqueName(prefix: string): string {
	sendSeq += 1;
	return `${prefix}-${Date.now()}-${sendSeq}.txt`;
}

/**
 * Send one text object to an eval task and wait for its result.
 *
 * @param client - The shell's connected client.
 * @param token - The task's token.
 * @param text - The payload.
 * @param prefix - Object-name prefix, for the engine's own logs.
 * @returns The pipeline result.
 */
async function sendOne(client: RocketRideClient, token: string, text: string, prefix: string): Promise<PIPELINE_RESULT | undefined> {
	return client.send(token, text, { name: uniqueName(prefix) }, 'text/plain');
}

// =============================================================================
// THE RUNNER
// =============================================================================

/** The message of an unknown throw, never an empty string. */
function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The engine gave no reason.';
}

/**
 * Grade one batch of open rows.
 *
 * The reference's `gradeOnce`, step for step:
 *
 * 1. select the open rows that have gone quiet, newest first;
 * 2. save the excluded ones without an LLM call;
 * 3. ask the grader pipe about each of the rest;
 * 4. ask the retrieval pipe whether the knowledge base held the question, and —
 *    when the team answered — whether it held the team's answer;
 * 5. let `decideOutcome` and `decideCause` decide, and save what they decided.
 *
 * Both tasks are terminated when the batch ends, whether it ended by finishing or
 * by throwing. An engine failure mid-batch stops the batch and is reported on the
 * result: the rows already written keep their grades, and the rest stay open for
 * the next click.
 *
 * @param options - See {@link GradeBatchOptions}.
 * @returns The counts, the causes, and the reason it stopped early if it did.
 */
export async function runGradeBatch(options: GradeBatchOptions): Promise<GradeBatchResult> {
	const { client, data, actions, now, onProgress } = options;
	const settings: BotSettings = data.settings;
	const evalSettings = settings.eval;
	const testAllowBotIds = testBotIdsOf(settings);
	const matchDistance = evalSettings.matchDistance;

	const result: GradeBatchResult = { graded: 0, excluded: 0, failed: 0, causes: {}, error: null };

	const selected = selectRowsForGrading(data.conversations, {
		now,
		quietHours: evalSettings.quietHours,
		ignoreQuiet: evalSettings.gradeNowIgnoresQuiet,
		limit: options.limit ?? GRADE_BATCH_LIMIT,
	});
	if (selected.length === 0) return result;

	// The cheap pass first: an excluded row needs no task at all, so a batch of
	// nothing but internal traffic never starts an LLM.
	const toGrade: ConversationRow[] = [];
	for (const row of selected) {
		const pre = decideOutcome(threadInfoOf(row), row.events ?? [], {}, { testAllowBotIds });
		if (pre.excluded_reason === undefined) {
			toGrade.push(row);
			continue;
		}
		// An exclusion writes no `grade`: there was no grader call, and a grade
		// object with an empty `graderJson` would read, to the review stage, as a
		// grader that answered with nothing.
		await actions.saveGrade(row.id, {
			outcome: 'excluded',
			cause: null,
			graderJson: null,
			qTopScore: null,
			aTopScore: null,
			clusterId: null,
			gradedAt: Date.now(),
			qaDraft: null,
			excludedReason: pre.excluded_reason,
		});
		result.excluded += 1;
		onProgress?.(result.excluded, selected.length);
	}

	if (toGrade.length === 0) {
		await actions.setLastGradedAt(Date.now());
		return result;
	}

	// The clusters the batch offers the model. Held locally as well as written
	// back, so a cluster proposed for the first row is offered to the second.
	let clusters: GraderCluster[] = data.quality.clusters ?? [];
	let graderToken: string | null = null;
	let retrieveToken: string | null = null;

	try {
		// Two tasks, started in order so a failure on the second still leaves the
		// first in `graderToken` for the `finally` below to terminate.
		graderToken = await startEvalPipe(client, EVAL_PIPES.grader);
		const grader = graderToken;
		retrieveToken = await startEvalPipe(client, EVAL_PIPES.retrieve);
		const retriever = retrieveToken;

		/** One retrieval pass, scored with the distance sign. */
		const retrieve = async (text: string): Promise<RetrievalScore> => {
			const sent = await sendOne(client, retriever, text.slice(0, RETRIEVAL_TEXT_LIMIT), 'retr');
			return scoreRetrieval(retrievedDocuments(sent), matchDistance);
		};

		for (const row of toGrade) {
			const events = row.events ?? [];
			const thread = threadInfoOf(row);

			// --- the grader LLM ---------------------------------------------------
			const input = JSON.stringify(buildGraderInput(row, clusters));
			const answer = firstAnswer(await sendOne(client, grader, input, 'grade'));
			const output = parseGraderOutput(answer);
			if (output === null) {
				// Left OPEN on purpose: the next batch tries it again.
				result.failed += 1;
				onProgress?.(result.graded + result.excluded + result.failed, selected.length);
				continue;
			}

			// --- the cluster ------------------------------------------------------
			let clusterId: string | null = output.cluster?.id === undefined || output.cluster?.id === null ? null : String(output.cluster.id);
			const proposed = output.cluster?.new;
			if (proposed?.label) {
				const upserted = upsertCluster(clusters, proposed.label, proposed.description ?? '');
				if (upserted.id.length > 0) {
					// The database upserts BY LABEL and returns the id that won, which
					// is the existing cluster's when another admin coined the same
					// label first — so the grade points at one cluster, not two.
					clusterId = await actions.upsertCluster(upserted.id, proposed.label.trim(), proposed.description ?? '');
					clusters = upserted.clusters;
				}
			}

			// --- retrieval: the doc-gap analysis ----------------------------------
			const questionRetrieval = await retrieve(row.question);
			const teamText = teamTextOf(events);
			let aTop: number | null = null;
			let overlap = false;
			const teamAnswerExists = teamText.length > 0;
			if (teamAnswerExists) {
				const answerRetrieval = await retrieve(teamText);
				aTop = answerRetrieval.top;
				overlap = [...answerRetrieval.ids].some((id) => questionRetrieval.ids.has(id));
			}

			// --- the rules decide -------------------------------------------------
			const signals = signalsOf(output);
			const { outcome } = decideOutcome(thread, events, signals, { testAllowBotIds });
			const cause = decideCause(outcome, events, signals, {
				aTop,
				overlap,
				teamAnswerExists,
				matchDistance,
			});

			const draft = output.qa_draft;
			await actions.saveGrade(row.id, {
				outcome,
				cause,
				graderJson: JSON.stringify({ ...output, _auto_outcome: outcome, _auto_cause: cause }),
				qTopScore: questionRetrieval.top,
				aTopScore: aTop,
				clusterId,
				// This row's own stamp, not the batch's: a batch of twenty rows
				// takes minutes, and "when was this graded" is a per-row fact.
				gradedAt: Date.now(),
				qaDraft: draft?.answer ? { question: draft.question ?? row.question, answer: draft.answer } : null,
				// The rules decided this row is IN the denominator; an exclusion
				// decided earlier (the opener is on the team) stays, because the
				// upsert coalesces a null over the stored value.
				excludedReason: null,
			});

			result.graded += 1;
			const key = cause ?? '(success)';
			result.causes[key] = (result.causes[key] ?? 0) + 1;
			onProgress?.(result.graded + result.excluded + result.failed, selected.length);
		}
	} catch (err) {
		result.error = reasonOf(err);
	} finally {
		// Best effort, both of them: a task the engine already reclaimed (the ttl
		// expired mid-batch) must not turn a finished batch into a failed one.
		if (graderToken !== null) await client.terminate(graderToken).catch(() => undefined);
		if (retrieveToken !== null) await client.terminate(retrieveToken).catch(() => undefined);
	}

	// When the batch FINISHED, not when it started — the screen shows this as
	// "Last graded: 4 min ago", and a twenty-row batch takes minutes.
	await actions.setLastGradedAt(Date.now());
	return result;
}

// =============================================================================
// REPORTING
// =============================================================================

/**
 * The one line a finished batch says.
 *
 * @param result - What {@link runGradeBatch} returned.
 * @returns The toast text.
 */
export function describeGradeBatch(result: GradeBatchResult): string {
	const causes = Object.entries(result.causes)
		.sort((a, b) => b[1] - a[1])
		.map(([cause, count]) => `${cause}:${count}`)
		.join(', ');
	const head = `Graded ${result.graded}, excluded ${result.excluded}, ${result.failed} failed to parse`;
	return `${head}; causes: ${causes.length > 0 ? causes : '(none)'}.`;
}
