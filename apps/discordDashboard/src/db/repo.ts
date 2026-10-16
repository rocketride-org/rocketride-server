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
// THE REPOSITORY — every statement the app runs, written out
// =============================================================================
//
// EVERY statement is a named constant with `$n` placeholders and every value
// is a bind. Nothing here interpolates, nothing here is generated, and no SQL
// is ever built from user input — which is the whole reason the app talks to
// a database through a node's `execute` tool rather than through an LLM's
// natural-language surface.
//
// THREE THINGS THE WIRE DOES TO VALUES, and all three are why the readers
// below exist rather than the rows being used raw:
//
// 1. JSONB COMES BACK AS TEXT. The node's `_sanitize_value` runs
//    `json.dumps` over anything the driver parsed into a dict or a list, so
//    `payload`, `grader_json`, `qa_draft`, `regressions` and `fields` arrive
//    as JSON STRINGS. {@link readJson} is what turns them back.
// 2. TIMESTAMPS COME BACK AS ISO STRINGS (`isoformat`), not epoch ms.
//    {@link readMs} parses them, and tolerates a number in case a driver ever
//    hands one over.
// 3. JSONB GOES OUT AS TEXT TOO, and has to be cast: `CAST($n AS jsonb)`,
//    never `$n::jsonb`. SQLAlchemy's `text()` will not read `:b2::jsonb` as a
//    bind followed by a cast — its bind pattern refuses a name followed by a
//    colon — so the `::` spelling silently stops binding.
//
// UPSERT, NOT UPDATE. `dd_threads` has no row until something writes one, and
// the thing that creates a thread is an EVENT, which the app never inserts.
// So every thread write is `INSERT … ON CONFLICT (thread_id) DO UPDATE`, with
// the update list naming exactly the columns that write owns — a grade must
// not clear a dismissal, and a dismissal must not clear a grade.
// =============================================================================

import type { Exec, DbRow } from './gateway';
import type { GoldenCase, GoldenExpectation, GraderCluster, ReplayRun, SeedResult, SeedStatus, SettingsSlice } from '../state/types';
import type { EvalCause, EvalOutcome } from '../eval/rules';

// =============================================================================
// VALUE READERS
// =============================================================================

/** A column as a string, or '' when it is null or absent. */
function readText(row: DbRow, key: string): string {
	const value = row[key];
	return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** A column as a string, or null when it is null, absent or empty. */
function readTextOrNull(row: DbRow, key: string): string | null {
	const value = row[key];
	if (value == null) return null;
	const text = typeof value === 'string' ? value : String(value);
	return text.length > 0 ? text : null;
}

/** A column as a finite number, or null. */
function readNumber(row: DbRow, key: string): number | null {
	const value = row[key];
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** A column as a boolean. Absent is false. */
function readBool(row: DbRow, key: string): boolean {
	const value = row[key];
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return value === 't' || value.toLowerCase() === 'true';
	return value === 1;
}

/**
 * A `TIMESTAMPTZ` column as Unix ms, or null.
 *
 * The node hands timestamps over as `isoformat()` strings. A number is
 * accepted too so a different driver cannot silently produce `null` here.
 */
export function readMs(row: DbRow, key: string): number | null {
	const value = row[key];
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || value.length === 0) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * A `JSONB` column as a parsed value, or null.
 *
 * It arrives as JSON TEXT (see the header). An object that somehow arrives
 * already parsed is passed through, and a string that will not parse is null
 * rather than a throw — one corrupt row must not stop a load.
 */
export function readJson(row: DbRow, key: string): unknown {
	const value = row[key];
	if (value == null) return null;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

/** A value as a JSON string, for a `CAST($n AS jsonb)` bind. */
function asJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

/** Unix ms as an ISO string, for a `CAST($n AS timestamptz)` bind. Null stays null. */
function asStamp(ms: number | null | undefined): string | null {
	return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

// =============================================================================
// SETTINGS
// =============================================================================

/** Read every settings slice with its version. */
export const SQL_SETTINGS_LOAD = `
SELECT slice, value, version FROM dd_settings`;

/**
 * Write one slice, if nobody else has since it was read.
 *
 * The optimistic-concurrency check IS the `version = $3` clause: zero rows
 * back means somebody else's save landed first, and the caller reloads rather
 * than overwriting it.
 */
export const SQL_SETTINGS_UPDATE = `
UPDATE dd_settings SET value = CAST($2 AS jsonb), version = version + 1, updated_by = $4, updated_at = now()
WHERE slice = $1 AND version = $3
RETURNING version`;

/**
 * Create a slice that has no row yet.
 *
 * `DO NOTHING RETURNING version` is the same test from the other side: two
 * sessions saving a never-before-saved slice race, one inserts, and the other
 * gets zero rows and is told it conflicted.
 */
export const SQL_SETTINGS_INSERT = `
INSERT INTO dd_settings (slice, value, version, updated_by) VALUES ($1, CAST($2 AS jsonb), 1, $3)
ON CONFLICT (slice) DO NOTHING
RETURNING version`;

/** One stored settings slice. */
export interface StoredSlice {
	/** The slice's JSON, as the database holds it. */
	value: unknown;
	/** Its version — what the next save has to present. */
	version: number;
}

/**
 * Every settings slice the database holds.
 *
 * A slice with no row is simply absent; the caller falls back to
 * `DEFAULT_SETTINGS` for it and saves it with version 0, which takes the
 * insert path.
 *
 * @param exec - The gateway's statement runner.
 * @returns Slice name to its value and version.
 */
export async function loadSettings(exec: Exec): Promise<Record<string, StoredSlice>> {
	const rows = await exec(SQL_SETTINGS_LOAD);
	const out: Record<string, StoredSlice> = {};
	for (const row of rows) {
		const slice = readText(row, 'slice');
		if (slice.length === 0) continue;
		out[slice] = { value: readJson(row, 'value'), version: readNumber(row, 'version') ?? 1 };
	}
	return out;
}

/** What a settings save did. */
export interface SaveSettingsResult {
	/** Somebody else wrote this slice first. The caller reloads. */
	conflict: boolean;
	/** The new version, when the write landed. */
	version?: number;
}

/**
 * Write one settings slice under optimistic concurrency.
 *
 * @param exec - The gateway's statement runner.
 * @param slice - Which sub-page.
 * @param value - Its whole value.
 * @param expectedVersion - The version the caller read. 0 (or less) means
 *        "there was no row", which takes the insert path.
 * @param user - Who saved it, for `updated_by`.
 * @returns Whether it conflicted, and the new version if it did not.
 */
export async function saveSettingsSlice(exec: Exec, slice: SettingsSlice, value: unknown, expectedVersion: number, user: string): Promise<SaveSettingsResult> {
	const rows = expectedVersion > 0 ? await exec(SQL_SETTINGS_UPDATE, [slice, asJson(value), expectedVersion, user]) : await exec(SQL_SETTINGS_INSERT, [slice, asJson(value), user]);
	if (rows.length === 0) return { conflict: true };
	return { conflict: false, version: readNumber(rows[0], 'version') ?? expectedVersion + 1 };
}

// =============================================================================
// EVENTS
// =============================================================================

/**
 * One page of the capture log, in insertion order.
 *
 * `seq > $1` is the whole incremental-read contract: the app remembers the
 * highest seq it has folded and asks for what came after. `LIMIT $2` pages a
 * cold start without ever asking for a result set the node would refuse.
 */
export const SQL_EVENTS_SINCE = `
SELECT seq, event_type, message_id, event_key, thread_id, channel_id, guild_id,
       author_id, author_is_bot, occurred_at, text, payload, source
FROM dd_events
WHERE seq > $1
ORDER BY seq ASC
LIMIT $2`;

/** One row of `dd_events`, with its payload parsed. */
export interface EventRow {
	/** Insertion order. The incremental cursor. */
	seq: number;
	/** `message` | `outbound` | `no_reply` | `reaction`; `slack_page` on imported rows. */
	eventType: string;
	/** The Discord message this event is about. */
	messageId: string;
	/** The dedupe disambiguator — see the schema's `event_key` rules. */
	eventKey: string;
	/** `metadata.threadId`, or null (always null for `slack_page`). */
	threadId: string | null;
	/** Node-side event time, Unix ms. */
	occurredAt: number;
	/** The exact SSE body the node broadcast. */
	payload: unknown;
	/** The node's `captureSource` label, e.g. `discord:discord_1+tool_slack`. */
	source: string;
}

/** Read one page of events. */
export async function loadEventsSince(exec: Exec, seq: number, limit: number): Promise<EventRow[]> {
	const rows = await exec(SQL_EVENTS_SINCE, [seq, limit]);
	return rows.map((row) => ({
		seq: readNumber(row, 'seq') ?? 0,
		eventType: readText(row, 'event_type'),
		messageId: readText(row, 'message_id'),
		eventKey: readText(row, 'event_key'),
		threadId: readTextOrNull(row, 'thread_id'),
		occurredAt: readMs(row, 'occurred_at') ?? 0,
		payload: readJson(row, 'payload'),
		source: readText(row, 'source'),
	}));
}

// =============================================================================
// THREADS
// =============================================================================

/** The eval state the app keeps per thread. */
export const SQL_THREADS_LOAD = `
SELECT thread_id, eval_status, outcome, outcome_source, cause, cause_source, excluded_reason,
       cluster_id, q_top_score, a_top_score, grader_json, qa_draft, graded_at,
       reviewed_by, reviewed_at, dismissed, replay
FROM dd_threads`;

/** What one grading pass writes. The review columns are untouched. */
export const SQL_THREAD_GRADE = `
INSERT INTO dd_threads (thread_id, eval_status, outcome, outcome_source, cause, cause_source,
                        excluded_reason, cluster_id, q_top_score, a_top_score,
                        grader_json, qa_draft, graded_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        CAST($11 AS jsonb), CAST($12 AS jsonb), CAST($13 AS timestamptz), now())
ON CONFLICT (thread_id) DO UPDATE SET
  eval_status = EXCLUDED.eval_status,
  outcome = EXCLUDED.outcome,
  outcome_source = EXCLUDED.outcome_source,
  cause = EXCLUDED.cause,
  cause_source = EXCLUDED.cause_source,
  excluded_reason = COALESCE(EXCLUDED.excluded_reason, dd_threads.excluded_reason),
  cluster_id = EXCLUDED.cluster_id,
  q_top_score = EXCLUDED.q_top_score,
  a_top_score = EXCLUDED.a_top_score,
  grader_json = EXCLUDED.grader_json,
  qa_draft = COALESCE(EXCLUDED.qa_draft, dd_threads.qa_draft),
  graded_at = EXCLUDED.graded_at,
  updated_at = now()`;

/**
 * What one reviewer's click writes.
 *
 * Every column is `COALESCE(EXCLUDED.x, dd_threads.x)` except the three the
 * review always stamps: a verdict that changed only the cause must not clear
 * the outcome, which is the reference's own dynamic `UPDATE` spelled out.
 */
export const SQL_THREAD_REVIEW = `
INSERT INTO dd_threads (thread_id, eval_status, outcome, outcome_source, cause, cause_source,
                        excluded_reason, reviewed_by, reviewed_at, updated_at)
VALUES ($1, 'reviewed', $2, $3, $4, $5, $6, $7, CAST($8 AS timestamptz), now())
ON CONFLICT (thread_id) DO UPDATE SET
  eval_status = 'reviewed',
  outcome = COALESCE(EXCLUDED.outcome, dd_threads.outcome),
  outcome_source = COALESCE(EXCLUDED.outcome_source, dd_threads.outcome_source),
  cause = COALESCE(EXCLUDED.cause, dd_threads.cause),
  cause_source = COALESCE(EXCLUDED.cause_source, dd_threads.cause_source),
  excluded_reason = COALESCE(EXCLUDED.excluded_reason, dd_threads.excluded_reason),
  reviewed_by = EXCLUDED.reviewed_by,
  reviewed_at = EXCLUDED.reviewed_at,
  updated_at = now()`;

/** The append-only audit row every review action leaves behind. */
export const SQL_REVIEW_INSERT = `
INSERT INTO dd_reviews (thread_id, action, fields, reviewer) VALUES ($1, $2, CAST($3 AS jsonb), $4)`;

/** Remove a thread from "Needs you", or put it back. Shared across admins. */
export const SQL_THREAD_DISMISS = `
INSERT INTO dd_threads (thread_id, dismissed, updated_at) VALUES ($1, $2, now())
ON CONFLICT (thread_id) DO UPDATE SET dismissed = EXCLUDED.dismissed, updated_at = now()`;

/** Mark a thread as opened by the replay bot rather than by a real asker. */
export const SQL_THREAD_REPLAY = `
INSERT INTO dd_threads (thread_id, replay, updated_at) VALUES ($1, $2, now())
ON CONFLICT (thread_id) DO UPDATE SET replay = EXCLUDED.replay, updated_at = now()`;

/** One thread's eval state, as the fold overlays it onto a conversation row. */
export interface ThreadState {
	threadId: string;
	evalStatus: 'open' | 'graded' | 'reviewed';
	outcome: EvalOutcome | null;
	outcomeSource: 'auto' | 'review' | null;
	cause: EvalCause | null;
	causeSource: 'auto' | 'review' | null;
	excludedReason: string | null;
	clusterId: string | null;
	qTopScore: number | null;
	aTopScore: number | null;
	/** The grader's JSON, verbatim, as TEXT — the row holds it as text too. */
	graderJson: string | null;
	qaDraft: { question: string; answer: string } | null;
	gradedAt: number | null;
	reviewedBy: string | null;
	reviewedAt: number | null;
	dismissed: boolean;
	replay: boolean;
}

/** The `{question, answer}` shape, out of a `qa_draft` JSONB value. */
function readPair(value: unknown): { question: string; answer: string } | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const question = typeof record.question === 'string' ? record.question : '';
	const answer = typeof record.answer === 'string' ? record.answer : '';
	return answer.length > 0 || question.length > 0 ? { question, answer } : null;
}

/** Read every thread's eval state. */
export async function loadThreads(exec: Exec): Promise<ThreadState[]> {
	const rows = await exec(SQL_THREADS_LOAD);
	return rows
		.map((row) => {
			const status = readText(row, 'eval_status');
			const grader = readJson(row, 'grader_json');
			return {
				threadId: readText(row, 'thread_id'),
				evalStatus: status === 'graded' || status === 'reviewed' ? status : 'open',
				outcome: readTextOrNull(row, 'outcome') as EvalOutcome | null,
				outcomeSource: readTextOrNull(row, 'outcome_source') as 'auto' | 'review' | null,
				cause: readTextOrNull(row, 'cause') as EvalCause | null,
				causeSource: readTextOrNull(row, 'cause_source') as 'auto' | 'review' | null,
				excludedReason: readTextOrNull(row, 'excluded_reason'),
				clusterId: readTextOrNull(row, 'cluster_id'),
				qTopScore: readNumber(row, 'q_top_score'),
				aTopScore: readNumber(row, 'a_top_score'),
				// Back to TEXT: `ConversationRow.grade.graderJson` is the model's own
				// JSON as a string, and `autoCauseOf` / `graderSummaryOf` parse it.
				graderJson: grader === null ? null : JSON.stringify(grader),
				qaDraft: readPair(readJson(row, 'qa_draft')),
				gradedAt: readMs(row, 'graded_at'),
				reviewedBy: readTextOrNull(row, 'reviewed_by'),
				reviewedAt: readMs(row, 'reviewed_at'),
				dismissed: readBool(row, 'dismissed'),
				replay: readBool(row, 'replay'),
			} satisfies ThreadState;
		})
		.filter((state) => state.threadId.length > 0);
}

/** What one grading pass learned about a thread. */
export interface GradeWrite {
	/** `graded`, always — an excluded row is graded too. */
	outcome: EvalOutcome;
	cause: EvalCause | null;
	/** Null for an exclusion: there was no grader call to record. */
	graderJson: string | null;
	qTopScore: number | null;
	aTopScore: number | null;
	clusterId: string | null;
	gradedAt: number;
	qaDraft: { question: string; answer: string } | null;
	/** Set only by the cheap pre-check that saves a row excluded. */
	excludedReason: string | null;
}

/** Write one grade. */
export async function saveGrade(exec: Exec, threadId: string, grade: GradeWrite): Promise<void> {
	await exec(SQL_THREAD_GRADE, [threadId, 'graded', grade.outcome, 'auto', grade.cause, grade.cause === null ? null : 'auto', grade.excludedReason, grade.clusterId, grade.qTopScore, grade.aTopScore, grade.graderJson === null ? null : grade.graderJson, grade.qaDraft === null ? null : asJson(grade.qaDraft), asStamp(grade.gradedAt)]);
}

/** What one reviewer's click changes. Anything omitted is left alone. */
export interface ReviewWrite {
	outcome?: EvalOutcome;
	cause?: EvalCause;
	excludedReason?: string;
}

/**
 * Apply a review and record it, in one transaction.
 *
 * Two statements, and they belong together: a verdict without its audit row
 * is a label nobody can account for, and an audit row without its verdict is
 * a record of something that did not happen.
 *
 * @param tx - The gateway's transaction runner.
 * @param threadId - The thread.
 * @param patch - What the control changed.
 * @param reviewer - Who clicked.
 * @param action - The audit label: resolve, fail, exclude, confirm, cause, teach.
 * @param now - Unix ms.
 */
export async function applyReview(tx: <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>, threadId: string, patch: ReviewWrite, reviewer: string, action: string, now: number): Promise<void> {
	await tx((exec) => applyReviewIn(exec, threadId, patch, reviewer, action, now));
}

/**
 * The same two statements, on a transaction somebody else opened.
 *
 * A teach is a review AND an approved pair AND a golden case, and all four
 * statements belong in one transaction — which this is what lets the caller
 * build.
 *
 * @param exec - A statement runner already inside a transaction.
 * @param threadId - The thread.
 * @param patch - What the control changed.
 * @param reviewer - Who clicked.
 * @param action - The audit label.
 * @param now - Unix ms.
 */
export async function applyReviewIn(exec: Exec, threadId: string, patch: ReviewWrite, reviewer: string, action: string, now: number): Promise<void> {
	// `excludedReason` forces the outcome, exactly as `applyReview` in
	// `src/eval/review.ts` does — the two must not be able to disagree.
	const outcome = patch.excludedReason !== undefined ? 'excluded' : (patch.outcome ?? null);
	await exec(SQL_THREAD_REVIEW, [threadId, outcome, outcome === null ? null : 'review', patch.cause ?? null, patch.cause === undefined ? null : 'review', patch.excludedReason ?? null, reviewer, asStamp(now)]);
	await insertReview(exec, threadId, action, patch, reviewer);
}

/** Append one audit row. Exposed so a teach can record itself inside its own transaction. */
export async function insertReview(exec: Exec, threadId: string, action: string, fields: unknown, reviewer: string): Promise<void> {
	await exec(SQL_REVIEW_INSERT, [threadId, action, asJson(fields ?? {}), reviewer]);
}

/** Drop a thread from "Needs you", or put it back. */
export async function setDismissed(exec: Exec, threadId: string, dismissed: boolean): Promise<void> {
	await exec(SQL_THREAD_DISMISS, [threadId, dismissed]);
}

/** Flag a thread as replay traffic. */
export async function markReplay(exec: Exec, threadId: string, replay: boolean): Promise<void> {
	await exec(SQL_THREAD_REPLAY, [threadId, replay]);
}

// =============================================================================
// CLUSTERS
// =============================================================================

/** Every cluster the grader has proposed, in the order it made them. */
export const SQL_CLUSTERS_LOAD = `
SELECT id, label, description FROM dd_clusters ORDER BY created_at ASC, id ASC`;

/**
 * Add a cluster, or refresh the description of the one that has its label.
 *
 * BY LABEL, which is the unique key: two sessions grading at once derive the
 * same id for the same label, and `ON CONFLICT (label)` makes the second
 * write an update of the first rather than a second cluster for one problem.
 * `RETURNING id` is therefore the id that WON, not necessarily the one passed.
 */
export const SQL_CLUSTER_UPSERT = `
INSERT INTO dd_clusters (id, label, description) VALUES ($1, $2, $3)
ON CONFLICT (label) DO UPDATE SET
  description = CASE WHEN EXCLUDED.description = '' THEN dd_clusters.description ELSE EXCLUDED.description END
RETURNING id`;

/** Read the cluster list. */
export async function loadClusters(exec: Exec): Promise<GraderCluster[]> {
	const rows = await exec(SQL_CLUSTERS_LOAD);
	return rows.map((row) => ({
		id: readText(row, 'id'),
		label: readText(row, 'label'),
		description: readText(row, 'description'),
	}));
}

/**
 * Upsert one cluster by label.
 *
 * @returns The id the database settled on — the existing cluster's when the
 *          label was already known, which is what the grade then points at.
 */
export async function upsertCluster(exec: Exec, id: string, label: string, description: string): Promise<string> {
	const rows = await exec(SQL_CLUSTER_UPSERT, [id, label, description]);
	return rows.length > 0 ? readText(rows[0], 'id') : id;
}

// =============================================================================
// TEACH RALPH
// =============================================================================

/** Approve one Q/A pair. `ingested_at` stays null until a landing check passes. */
export const SQL_QA_INSERT_APPROVED = `
INSERT INTO dd_qa_pairs (thread_id, question, answer, status, approved_by, approved_at)
VALUES ($1, $2, $3, 'approved', $4, CAST($5 AS timestamptz))
RETURNING id`;

/**
 * Retire the pairs a re-teach replaces.
 *
 * Re-teaching a thread INSERTS a new pair rather than editing the old one —
 * `needsFreshPair` in `src/eval/review.ts` says why, and an ingested pair must
 * keep its `ingested_at` so the history of what reached the knowledge base
 * stays true. What must not survive is an EARLIER pair for the same thread
 * that never landed: the writeback would then write the same document twice,
 * once with the answer the reviewer has just replaced. Dropping those back to
 * `draft` takes them out of the backlog without deleting what somebody wrote.
 */
export const SQL_QA_SUPERSEDE = `
UPDATE dd_qa_pairs SET status = 'draft'
WHERE thread_id = $1 AND status = 'approved' AND ingested_at IS NULL`;

/** The backlog a writeback run drains: approved, and not yet in the knowledge base. */
export const SQL_QA_PENDING = `
SELECT id, thread_id, question, answer, approved_by, approved_at
FROM dd_qa_pairs
WHERE status = 'approved' AND ingested_at IS NULL
ORDER BY approved_at ASC, id ASC`;

/** Stamp a pair as verified in the collection, with what it was written as. */
export const SQL_QA_MARK_INGESTED = `
UPDATE dd_qa_pairs SET ingested_at = now(), kb_object_id = $2, kb_document = $3 WHERE id = $1`;

/**
 * The newest approved pair per thread, for the row overlay.
 *
 * `DISTINCT ON (thread_id)` with the matching `ORDER BY`: re-teaching a
 * thread inserts a SECOND pair (the reference's own behaviour — an ingested
 * pair is never edited in place), and the card has to show the latest one.
 */
export const SQL_QA_BY_THREAD = `
SELECT DISTINCT ON (thread_id) thread_id, question, answer, approved_by, approved_at, ingested_at
FROM dd_qa_pairs
WHERE status = 'approved' AND thread_id IS NOT NULL
ORDER BY thread_id, approved_at DESC, id DESC`;

/** One approved pair, as the Review card and the writeback read it. */
export interface ApprovedQa {
	/** The `dd_qa_pairs` row id — what `markQaIngested` writes against. */
	id: number;
	threadId: string | null;
	question: string;
	answer: string;
	approvedBy: string;
	approvedAt: number;
	/** Unix ms the document was verified in the collection, or null. */
	ingestedAt: number | null;
}

/**
 * Approve one pair, retiring any earlier one for the thread that never landed.
 *
 * @returns The new pair's id — what a knowledge-base write stamps against.
 */
export async function insertApprovedQa(exec: Exec, threadId: string | null, question: string, answer: string, approvedBy: string, now: number): Promise<number> {
	if (threadId !== null) await exec(SQL_QA_SUPERSEDE, [threadId]);
	const rows = await exec(SQL_QA_INSERT_APPROVED, [threadId, question, answer, approvedBy, asStamp(now)]);
	return rows.length > 0 ? (readNumber(rows[0], 'id') ?? 0) : 0;
}

/** Read one row of `dd_qa_pairs`. */
function toApprovedQa(row: DbRow): ApprovedQa {
	return {
		id: readNumber(row, 'id') ?? 0,
		threadId: readTextOrNull(row, 'thread_id'),
		question: readText(row, 'question'),
		answer: readText(row, 'answer'),
		approvedBy: readText(row, 'approved_by'),
		approvedAt: readMs(row, 'approved_at') ?? 0,
		ingestedAt: readMs(row, 'ingested_at'),
	};
}

/** The pairs a writeback run would write, oldest approval first. */
export async function loadPendingQa(exec: Exec): Promise<ApprovedQa[]> {
	const rows = await exec(SQL_QA_PENDING);
	return rows.map((row) => ({ ...toApprovedQa(row), ingestedAt: null }));
}

/** The newest approved pair per thread, for the row overlay. */
export async function loadApprovedQaByThread(exec: Exec): Promise<ApprovedQa[]> {
	const rows = await exec(SQL_QA_BY_THREAD);
	return rows.map(toApprovedQa);
}

/** Stamp a pair as landed. */
export async function markQaIngested(exec: Exec, id: number, objectId: string, documentName: string): Promise<void> {
	await exec(SQL_QA_MARK_INGESTED, [id, objectId, documentName]);
}

// =============================================================================
// THE GOLDEN SET
// =============================================================================

/** Every taught or manual case. The ten `R01`..`R10` seeds are code, not rows. */
export const SQL_GOLDEN_LOAD = `
SELECT id, question, expected, golden_answer, source, thread_id, active, created_at
FROM dd_golden_cases
ORDER BY created_at ASC, id ASC`;

/** Seed or re-seed one case. Re-teaching a thread is a correction, not a second case. */
export const SQL_GOLDEN_UPSERT = `
INSERT INTO dd_golden_cases (id, question, expected, golden_answer, source, thread_id, active, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, CAST($8 AS timestamptz))
ON CONFLICT (id) DO UPDATE SET
  question = EXCLUDED.question,
  expected = EXCLUDED.expected,
  golden_answer = EXCLUDED.golden_answer,
  source = EXCLUDED.source,
  thread_id = EXCLUDED.thread_id,
  active = EXCLUDED.active`;

/** Read the stored golden cases. */
export async function loadGolden(exec: Exec): Promise<GoldenCase[]> {
	const rows = await exec(SQL_GOLDEN_LOAD);
	return rows.map((row) => ({
		id: readText(row, 'id'),
		question: readText(row, 'question'),
		expected: (readText(row, 'expected') === 'escalate' ? 'escalate' : 'answer') as GoldenExpectation,
		goldenAnswer: readTextOrNull(row, 'golden_answer'),
		source: (readText(row, 'source') || 'manual') as GoldenCase['source'],
		threadId: readText(row, 'thread_id'),
		active: readBool(row, 'active'),
		createdAt: readMs(row, 'created_at') ?? 0,
	}));
}

/** Write one golden case. */
export async function upsertGolden(exec: Exec, entry: GoldenCase): Promise<void> {
	await exec(SQL_GOLDEN_UPSERT, [entry.id, entry.question, entry.expected, entry.goldenAnswer, entry.source, entry.threadId, entry.active, asStamp(entry.createdAt) ?? asStamp(Date.now())]);
}

// =============================================================================
// REPLAY RUNS
// =============================================================================

/** Record one run and get its id back. */
export const SQL_RUN_INSERT = `
INSERT INTO dd_replay_runs (file_name, imported, started_at, finished_at, recorded_at,
                            n, passed, hard_fails, regressions, copy_project_id, stopped_early)
VALUES ($1, $2, CAST($3 AS timestamptz), CAST($4 AS timestamptz), CAST($5 AS timestamptz),
        $6, $7, $8, CAST($9 AS jsonb), $10, $11)
RETURNING id`;

/** One seed's verdict. `DO NOTHING` because `(run_id, case_id)` is the key. */
export const SQL_RESULT_INSERT = `
INSERT INTO dd_replay_results (run_id, case_id, ord, question, status, verdict, notes, reply, escalated, retried)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (run_id, case_id) DO NOTHING`;

/** The newest runs — the Quality screen shows this one and the one before it. */
export const SQL_RUNS_RECENT = `
SELECT id, file_name, imported, started_at, finished_at, recorded_at,
       n, passed, hard_fails, regressions, copy_project_id, stopped_early
FROM dd_replay_runs
ORDER BY recorded_at DESC, id DESC
LIMIT $1`;

/**
 * One run's seeds, in run order.
 *
 * One statement per run rather than `WHERE run_id = ANY($1)`: an array bind
 * through the `$n` rewriter is a shape this app does not need, and there are
 * only ever two runs to fetch.
 */
export const SQL_RESULTS_FOR_RUN = `
SELECT case_id, ord, question, status, verdict, notes, reply, escalated, retried
FROM dd_replay_results
WHERE run_id = $1
ORDER BY ord ASC, case_id ASC`;

/** The three verdicts a seed may carry. */
const SEED_STATUSES: SeedStatus[] = ['pass', 'fail', 'hard_fail'];

/** Read one run's header, without its seeds. */
function toRun(row: DbRow): { id: number; copyProjectId: string | null; run: ReplayRun } {
	const regressions = readJson(row, 'regressions');
	return {
		id: readNumber(row, 'id') ?? 0,
		// On the run, not on every seed: `SeedResult.copyProjectId` is the proof
		// the answer came from the private copy, and every seed of one run came
		// from the same one.
		copyProjectId: readTextOrNull(row, 'copy_project_id'),
		run: {
			importedAt: readMs(row, 'recorded_at') ?? 0,
			fileName: readText(row, 'file_name'),
			seeds: [],
			startedAt: readMs(row, 'started_at') ?? undefined,
			finishedAt: readMs(row, 'finished_at') ?? undefined,
			n: readNumber(row, 'n') ?? undefined,
			passed: readNumber(row, 'passed') ?? undefined,
			hardFails: readNumber(row, 'hard_fails') ?? undefined,
			regressions: Array.isArray(regressions) ? regressions.filter((entry): entry is string => typeof entry === 'string') : [],
			stoppedEarly: readBool(row, 'stopped_early'),
		},
	};
}

/** Read one seed result. */
function toSeed(row: DbRow, copyProjectId: string | null): SeedResult {
	const status = readText(row, 'status');
	return {
		id: readText(row, 'case_id'),
		question: readText(row, 'question'),
		status: (SEED_STATUSES.includes(status as SeedStatus) ? status : 'fail') as SeedStatus,
		verdict: readText(row, 'verdict'),
		notes: readText(row, 'notes'),
		reply: readTextOrNull(row, 'reply'),
		escalated: readBool(row, 'escalated'),
		copyProjectId,
		retried: readBool(row, 'retried'),
	};
}

/**
 * Store one run and every seed it produced, in one transaction.
 *
 * The run row and its results are one fact: a half-written run would show up
 * on the Quality screen as a run that asked nothing, and the regression diff
 * would read it as every seed having vanished.
 *
 * @param tx - The gateway's transaction runner.
 * @param run - The finished run.
 * @param imported - True when the seeds came from a JSONL file rather than
 *        from a run this app drove.
 * @returns The new run's id.
 */
export async function insertRun(tx: <T>(fn: (exec: Exec) => Promise<T>) => Promise<T>, run: ReplayRun, imported: boolean): Promise<number> {
	return tx(async (exec) => {
		const copyProjectId = run.seeds.find((seed) => (seed.copyProjectId ?? '').length > 0)?.copyProjectId ?? null;
		const rows = await exec(SQL_RUN_INSERT, [run.fileName, imported, asStamp(run.startedAt ?? null), asStamp(run.finishedAt ?? null), asStamp(run.importedAt), run.n ?? run.seeds.length, run.passed ?? run.seeds.filter((seed) => seed.status === 'pass').length, run.hardFails ?? run.seeds.filter((seed) => seed.status === 'hard_fail').length, asJson(run.regressions ?? []), copyProjectId, run.stoppedEarly === true]);
		const id = rows.length > 0 ? (readNumber(rows[0], 'id') ?? 0) : 0;
		if (id === 0) throw new Error('The database did not return a run id.');
		await insertResults(exec, id, run.seeds);
		return id;
	});
}

/** Write one run's seeds, in file order. */
export async function insertResults(exec: Exec, runId: number, seeds: SeedResult[]): Promise<void> {
	for (let index = 0; index < seeds.length; index += 1) {
		const seed = seeds[index];
		await exec(SQL_RESULT_INSERT, [runId, seed.id, index, seed.question, seed.status, seed.verdict, seed.notes, seed.reply ?? null, seed.escalated === true, seed.retried === true]);
	}
}

/**
 * The most recent runs, newest first, with their seeds.
 *
 * @param exec - The gateway's statement runner.
 * @param limit - How many. The Quality screen wants 2.
 * @returns The runs, newest first.
 */
export async function loadRecentRuns(exec: Exec, limit: number): Promise<ReplayRun[]> {
	const headers = (await exec(SQL_RUNS_RECENT, [limit])).map(toRun);
	const out: ReplayRun[] = [];
	for (const header of headers) {
		const rows = await exec(SQL_RESULTS_FOR_RUN, [header.id]);
		out.push({ ...header.run, seeds: rows.map((row) => toSeed(row, header.copyProjectId)) });
	}
	return out;
}

// =============================================================================
// THE KNOWLEDGE CATALOG
// =============================================================================

/**
 * Every catalogued document, newest first, WITHOUT its text.
 *
 * The list is a few hundred rows and the docs pages run to half a megabyte
 * each, so the text is read one document at a time when it is opened.
 */
export const SQL_KB_LIST = `
SELECT object_id, name, title, source, route, chars, added_by, added_at
FROM dd_kb_documents
ORDER BY added_at DESC, title ASC`;

/** One document's full text. */
export const SQL_KB_CONTENT = `
SELECT content FROM dd_kb_documents WHERE object_id = $1`;

/**
 * Catalogue one document, or replace what the catalog holds for it.
 *
 * By `object_id`, which the knowledge base derives from the document NAME: a
 * document sent again under the same name replaces itself in the collection,
 * and so it replaces its catalog row too.
 */
export const SQL_KB_UPSERT = `
INSERT INTO dd_kb_documents (object_id, name, title, source, route, content, chars, added_by, added_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CAST($9 AS timestamptz))
ON CONFLICT (object_id) DO UPDATE SET
  name = EXCLUDED.name,
  title = EXCLUDED.title,
  source = EXCLUDED.source,
  route = EXCLUDED.route,
  content = EXCLUDED.content,
  chars = EXCLUDED.chars,
  added_by = EXCLUDED.added_by,
  added_at = EXCLUDED.added_at`;

/**
 * Catalogue a taught answer from the pair that was just verified in the KB.
 *
 * Read out of `dd_qa_pairs` rather than passed in, so the row says exactly what
 * Teach Ralph sent: `kbDocumentOf` in `src/eval/teach.ts` is `# question`, a
 * blank line, the answer and a newline, which is what `chr(10)` spells here.
 */
export const SQL_KB_UPSERT_TAUGHT = `
INSERT INTO dd_kb_documents (object_id, name, title, source, route, content, chars, added_by, added_at)
SELECT $2, $3, question, 'taught', NULL,
       '# ' || question || chr(10) || chr(10) || answer || chr(10),
       char_length('# ' || question || chr(10) || chr(10) || answer || chr(10)),
       approved_by, COALESCE(approved_at, now())
FROM dd_qa_pairs
WHERE id = $1
ON CONFLICT (object_id) DO UPDATE SET
  name = EXCLUDED.name,
  title = EXCLUDED.title,
  source = EXCLUDED.source,
  route = EXCLUDED.route,
  content = EXCLUDED.content,
  chars = EXCLUDED.chars,
  added_by = EXCLUDED.added_by,
  added_at = EXCLUDED.added_at`;

/** Where a document in the knowledge base came from. */
export type KbSource = 'corpus' | 'taught' | 'uploaded';

/** The sources, for the stored value's test. */
const KB_SOURCES: KbSource[] = ['corpus', 'taught', 'uploaded'];

/** One catalogued document, as the Knowledge screen lists it. */
export type KbDocument = {
	/** The knowledge base's id for it — every chunk carries it as `metadata.objectId`. */
	objectId: string;
	/** The name it was sent under, e.g. `docs__nodes__chunker.md`. */
	name: string;
	/** Its title: the page title, the taught question, or what the uploader typed. */
	title: string;
	source: KbSource;
	/** The docs route, for a docs page; null otherwise. */
	route: string | null;
	/** Length of the stored text, in characters. */
	chars: number;
	/** Who taught or added it; null for the docs pages. */
	addedBy: string | null;
	/** When it was added, Unix ms. */
	addedAt: number;
};

/** What one catalog write holds — a document and its full text. */
export interface KbDocumentWrite {
	objectId: string;
	name: string;
	title: string;
	source: KbSource;
	route: string | null;
	content: string;
	addedBy: string | null;
	addedAt: number;
}

/** Read the catalog, newest first. */
export async function loadKbDocuments(exec: Exec): Promise<KbDocument[]> {
	const rows = await exec(SQL_KB_LIST);
	return rows
		.map((row) => {
			const source = readText(row, 'source');
			return {
				objectId: readText(row, 'object_id'),
				name: readText(row, 'name'),
				title: readText(row, 'title'),
				source: (KB_SOURCES.includes(source as KbSource) ? source : 'uploaded') as KbSource,
				route: readTextOrNull(row, 'route'),
				chars: readNumber(row, 'chars') ?? 0,
				addedBy: readTextOrNull(row, 'added_by'),
				addedAt: readMs(row, 'added_at') ?? 0,
			} satisfies KbDocument;
		})
		.filter((document) => document.objectId.length > 0);
}

/** One document's full text, or null when the catalog has no such row. */
export async function loadKbContent(exec: Exec, objectId: string): Promise<string | null> {
	const rows = await exec(SQL_KB_CONTENT, [objectId]);
	return rows.length > 0 ? readText(rows[0], 'content') : null;
}

/** Write one catalog row. */
export async function upsertKbDocument(exec: Exec, document: KbDocumentWrite): Promise<void> {
	await exec(SQL_KB_UPSERT, [
		document.objectId,
		document.name,
		document.title,
		document.source,
		document.route,
		document.content,
		// Code points, as Postgres' `char_length` and the seed count them.
		Array.from(document.content).length,
		document.addedBy,
		asStamp(document.addedAt),
	]);
}

/** Catalogue the taught answer one verified pair became. */
export async function upsertTaughtKbDocument(exec: Exec, qaId: number, objectId: string, documentName: string): Promise<void> {
	await exec(SQL_KB_UPSERT_TAUGHT, [qaId, objectId, documentName]);
}

// =============================================================================
// META
// =============================================================================

/** One key/value fact. */
export const SQL_META_GET = `
SELECT value FROM dd_meta WHERE key = $1`;

/** Write one key/value fact. */
export const SQL_META_SET = `
INSERT INTO dd_meta (key, value) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

/** The key holding when the last grading batch finished. */
export const META_LAST_GRADED_AT = 'last_graded_at';

/** Read one fact, or null when it has never been written. */
export async function getMeta(exec: Exec, key: string): Promise<string | null> {
	const rows = await exec(SQL_META_GET, [key]);
	return rows.length > 0 ? readTextOrNull(rows[0], 'value') : null;
}

/** Write one fact. */
export async function setMeta(exec: Exec, key: string, value: string): Promise<void> {
	await exec(SQL_META_SET, [key, value]);
}

// =============================================================================
// CHANGE SIGNATURE — what another tab or admin changed since the last look
// =============================================================================

/**
 * One cheap fingerprint per app-written table.
 *
 * The 5-second poll reads `dd_events` incrementally, but everything else
 * (grades, reviews, settings, golden cases, runs, Teach Ralph records) is
 * written by whichever tab acted. Without this, a second tab never sees those
 * writes until it reloads. Each column changes whenever its table does: a
 * settings save bumps a version, every `dd_threads` write stamps `updated_at`,
 * the rest are append-or-upsert tables whose count/max id/latest stamp moves.
 */
export const SQL_CHANGE_SIGNATURE = `
SELECT
  (SELECT COALESCE(SUM(version), 0) || ':' || COUNT(*) FROM dd_settings) AS settings,
  (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at)::text, '') FROM dd_threads) AS threads,
  (SELECT COALESCE(MAX(id), 0) FROM dd_reviews) AS reviews,
  (SELECT COUNT(*) FROM dd_clusters) AS clusters,
  (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at)::text, '') FROM dd_golden_cases) AS golden,
  (SELECT COALESCE(MAX(id), 0) FROM dd_replay_runs) AS runs,
  (SELECT COALESCE(MAX(id), 0) || ':' || COUNT(ingested_at) FROM dd_qa_pairs) AS qa,
  (SELECT COALESCE(MAX(value), '') FROM dd_meta WHERE key = 'last_graded_at') AS meta,
  (SELECT COUNT(*) || ':' || COALESCE(MAX(added_at)::text, '') FROM dd_kb_documents) AS kb`;

/** The tables the signature covers, in the order the reloads should run. */
export type SignatureKey = 'settings' | 'threads' | 'reviews' | 'clusters' | 'golden' | 'runs' | 'qa' | 'meta' | 'kb';

/** Read the fingerprint of every app-written table. */
export async function loadChangeSignature(exec: Exec): Promise<Record<SignatureKey, string>> {
	const rows = await exec(SQL_CHANGE_SIGNATURE, []);
	const row = (rows[0] ?? {}) as Record<string, unknown>;
	const read = (key: SignatureKey) => String(row[key] ?? '');
	return {
		settings: read('settings'),
		threads: read('threads'),
		reviews: read('reviews'),
		clusters: read('clusters'),
		golden: read('golden'),
		runs: read('runs'),
		qa: read('qa'),
		meta: read('meta'),
		kb: read('kb'),
	};
}
