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
// TEACH RALPH — the knowledge-base writeback
// =============================================================================
//
// The reference bot's `eval/ingest.ts`, adapted from qdrant to Chroma. This is
// the ONLY path in the app that writes into the knowledge base the bot answers
// from, and it runs from a click on the Review tab rather than from a CLI step.
//
// What one approved pair becomes: a markdown document whose H1 is the question
// and whose body is the answer, sent to `eval-kb-writeback.pipe` under the
// stable name `ralph-qa-<threadId>.md`. The pipe splits, embeds and stores it in
// the same `ROCKETRIDE_DOCS` Chroma collection `eval-retrieve.pipe` reads and the
// bot's own RAG pipe retrieves from. The stable name is what makes a re-teach
// REPLACE the old document instead of adding a second copy of the same answer.
//
// THE LANDING CHECK IS THE WHOLE DESIGN. `ingestedAt` is set only when the
// document can actually be found in the collection, because the task-status poll
// never reports the store step's completion: it says the send succeeded, which is
// not the same as "the bot can now retrieve this". So the runner queries the
// retrieval pipe with the question and looks for a returned chunk carrying the
// objectId the send handed back. Ten attempts, two seconds apart. A pair that
// never shows keeps `ingestedAt: null`, the card says so, and the reviewer can
// retry — which is strictly better than a card that claims the bot learned
// something it did not.
//
// RUNS ARE SERIALISED. A module-level promise chain, like the reference's: two
// reviewers (or one reviewer clicking twice) must not have two writeback runs
// against the same task at once, because the pipe instance is shared and a
// half-written document is not something the landing check can distinguish from
// a slow one.
// =============================================================================

import type { RocketRideClient } from 'shell';
import { EVAL_PIPES, EVAL_TASK_TTL_SECONDS, evalPipelineOf, type EvalPipe } from './pipes';
import { retrievedDocuments } from './grader';
import type { ApprovedQa } from '../db/repo';
import type { BotSettings } from '../state/types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** How many times the landing check asks the retrieval pipe. */
export const KB_VERIFY_ATTEMPTS = 10;

/** How long it waits between those attempts (ms). */
export const KB_VERIFY_PAUSE_MS = 2000;

/** Longest question the landing check sends — the retrieval pipe's own clip. */
const RETRIEVAL_TEXT_LIMIT = 4000;

// =============================================================================
// TYPES
// =============================================================================

/** What one writeback run did. */
export interface TeachResult {
	/** Thread ids whose document was verified in the collection. */
	ingested: string[];
	/** Thread ids that were sent but never showed up. Still approved, still pending. */
	pending: string[];
	/** Why the run stopped early, or null when it ran to the end. */
	error: string | null;
}

/** Everything {@link teachApproved} needs from the app. */
export interface TeachOptions {
	/** The shell's connected client. */
	client: RocketRideClient;
	/**
	 * The pairs to write — `dd_qa_pairs` rows that are approved and have no
	 * `ingested_at`. A run settles the whole backlog, not just the one just
	 * taught, which is what the reference did and why it returns what it wrote.
	 */
	pending: ApprovedQa[];
	/** The settings. Reserved for the tunables a later stage reads. */
	settings: BotSettings;
	/** Stamp one pair as verified in the collection. */
	markIngested: (id: number, objectId: string, documentName: string) => Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/** The message of an unknown throw, never an empty string. */
function reasonOf(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	const text = String(err ?? '');
	return text.length > 0 ? text : 'The engine gave no reason.';
}

/** Wait. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The document's identity in the knowledge base.
 *
 * Keyed on the THREAD, so re-teaching the same thread replaces its document
 * rather than adding a second answer to the same question. (The reference
 * keyed it on the `qa_pairs` row id; the pair is about one thread, and two
 * documents for one question is exactly what the stable name prevents.)
 *
 * @param threadId - The pair's thread, or null for a pair with none.
 * @returns e.g. `ralph-qa-1234567890.md`.
 */
export function kbDocumentName(threadId: string | null): string {
	return `ralph-qa-${threadId ?? 'manual'}.md`;
}

/**
 * The markdown one approved pair becomes.
 *
 * H1 = the question, body = the answer. The H1 is what makes a retrieved chunk
 * readable as an answer to something rather than as a fragment of prose.
 *
 * @param question - The approved question.
 * @param answer - The approved answer.
 * @returns The document text.
 */
export function kbDocumentOf(question: string, answer: string): string {
	return `# ${question}\n\n${answer}\n`;
}

/** Start an eval pipe, or attach to a task a previous run left warm. */
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

/** A unique object name for one landing-check query. */
let checkSeq = 0;
function checkName(): string {
	checkSeq += 1;
	return `kbcheck-${Date.now()}-${checkSeq}.txt`;
}

// =============================================================================
// THE RUN
// =============================================================================

/**
 * Write every approved, un-ingested pair into the knowledge base.
 *
 * One pair at a time, and for each one:
 *
 * 1. send `# question\n\nanswer\n` as `text/markdown` under the stable document
 *    name, and keep the `objectId` the send hands back;
 * 2. query the retrieval pipe with the question, up to ten times two seconds
 *    apart, looking for a chunk whose `metadata.objectId` is that objectId;
 * 3. stamp `ingestedAt` only if it was found.
 *
 * The writeback task is terminated at the end. The RETRIEVAL task is left to its
 * ttl on purpose: it is shared with the grader by task identity, so terminating
 * it here could kill a grading batch running in another tab.
 *
 * @param options - See {@link TeachOptions}.
 * @returns What the run wrote — see {@link TeachResult}.
 */
async function runTeach(options: TeachOptions): Promise<TeachResult> {
	const { client, pending, markIngested } = options;
	const result: TeachResult = { ingested: [], pending: [], error: null };

	// Oldest approval first, so a backlog drains in the order it was approved.
	const todo = [...pending].sort((a, b) => a.approvedAt - b.approvedAt);
	if (todo.length === 0) return result;

	let writebackToken: string | null = null;

	try {
		writebackToken = await startEvalPipe(client, EVAL_PIPES.kbWriteback);
		const retrieveToken = await startEvalPipe(client, EVAL_PIPES.retrieve);

		for (const approved of todo) {
			const key = approved.threadId ?? String(approved.id);
			const name = kbDocumentName(approved.threadId);
			const sent = await client.send(writebackToken, kbDocumentOf(approved.question, approved.answer), { name }, 'text/markdown');
			const objectId = sent?.objectId ?? '';

			// No objectId means there is nothing to look for, so the pair stays
			// pending rather than being marked on the strength of a send that
			// reported nothing back.
			let landed = false;
			if (objectId.length > 0) {
				for (let attempt = 0; attempt < KB_VERIFY_ATTEMPTS && !landed; attempt += 1) {
					const probe = await client.send(retrieveToken, approved.question.slice(0, RETRIEVAL_TEXT_LIMIT), { name: checkName() }, 'text/plain');
					landed = retrievedDocuments(probe).some((document) => document.metadata?.objectId === objectId);
					if (!landed && attempt < KB_VERIFY_ATTEMPTS - 1) await sleep(KB_VERIFY_PAUSE_MS);
				}
			}

			if (landed) {
				// The objectId and the document name go on the row with the stamp:
				// `ingested_at` says it landed, and these two say as what — which is
				// the only way to find the document again from the database.
				await markIngested(approved.id, objectId, name);
				result.ingested.push(key);
			} else {
				result.pending.push(key);
			}
		}
	} catch (err) {
		result.error = reasonOf(err);
	} finally {
		// Best effort: a task the engine already reclaimed must not turn a run that
		// wrote three documents into a failed one.
		if (writebackToken !== null) await client.terminate(writebackToken).catch(() => undefined);
	}

	return result;
}

/**
 * The serialisation chain. One writeback run at a time, per app session.
 *
 * `chain.then(run, run)` rather than `chain.then(run)`: a rejected predecessor
 * must not stop the next run from starting, which is the reference's own shape.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Write the approved pairs into the knowledge base, one run at a time.
 *
 * @param options - See {@link TeachOptions}.
 * @returns What the run wrote.
 */
export function teachApproved(options: TeachOptions): Promise<TeachResult> {
	const run = (): Promise<TeachResult> => runTeach(options);
	const next = chain.then(run, run);
	// The chain itself must never reject, or every later run would be handed a
	// rejected predecessor and the queue would unwind.
	chain = next.catch(() => undefined);
	return next;
}

/**
 * Run any other knowledge-base write on the same chain.
 *
 * The Knowledge screen's "Add document" sends through the same writeback pipe
 * and terminates the same task, so it queues behind a teach run (and a teach
 * run behind it) for the reason in the header.
 *
 * @param run - The write.
 * @returns What it returned.
 */
export function serializeKbWrite<T>(run: () => Promise<T>): Promise<T> {
	const next = chain.then(run, run);
	chain = next.catch(() => undefined);
	return next;
}

// =============================================================================
// REPORTING
// =============================================================================

/**
 * The one line a finished run says.
 *
 * @param result - What {@link teachApproved} returned.
 * @param threadId - The thread the reviewer just taught, so the line can speak
 *        about THEIR click before the backlog.
 * @returns The toast text.
 */
export function describeTeachResult(result: TeachResult, threadId: string): string {
	const mine = result.ingested.includes(threadId);
	const others = result.ingested.filter((id) => id !== threadId).length;
	const extra = others > 0 ? ` (+${others} pending pair${others === 1 ? '' : 's'} settled)` : '';
	if (result.error !== null) {
		return `Q/A approved, but the KB write failed: ${result.error} Retry from the card.`;
	}
	if (mine) {
		return `Q/A approved and added to Ralph’s KB${extra}. He’ll use it on the next matching question.`;
	}
	return 'Q/A approved. The KB write has not shown up in the collection yet — retry from the card.';
}
