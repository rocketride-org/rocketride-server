// =============================================================================
// MIT License
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
// GRAPH - ASK A QUESTION (get_query: a preview the user runs, or prose)
// =============================================================================
//
// `get_query` asks the node's language model to write Cypher. Three answers:
//
//   { query, valid: true }     Cypher the node already vetted as read-only: a
//                              PREVIEW. The app puts it in the editor and does
//                              NOT run it; the user presses Run.
//   { answer, valid: false }   the model answered in prose (the question was not
//                              about the graph). That is an answer, not an error.
//   { error, valid: false }    the node could not produce a safe query. A failure.
//
// A pipeline without a language model cannot answer at all. Browsing with Cypher
// still works, so Ask shows an "unavailable" state instead of an error banner,
// and says why. That is told from the text of the raised error: the
// engine's "No control listeners registered for llm" and explicit "no model"
// wording only, never a bare mention of an LLM or a connection, because the
// node's "LLM failed to return a Cypher query." (a connected model that answered
// nothing) and the SDK's "Server is not connected" mean something else. Every
// other failure is described the way the browse editor describes one
// (failures.ts), so an engine without get_query gets the upgrade wording, with
// two differences: Ask always describes a failure as on a read-only connection
// (so a write refusal gets the read-only hint, not the write console's; see
// below), and a timeout gets no hint. The browse editor's timeout note is about a
// database query still running, while Ask's wait is mostly the node's language
// model, and the session's own timeout text already says the node may still be
// working on it and that nothing here can cancel it.
// Generated Cypher never runs automatically.
// =============================================================================

import { describeFailureOf } from './failures';
import { STOP_WAITING_NOTE } from './wording';
import { isPlainObject } from './values';

/** What a `get_query` answer means. */
export type AskAnswer = { kind: 'cypher'; cypher: string } | { kind: 'prose'; text: string };

/**
 * Read a `get_query` answer that passed the shared result check.
 *
 * @param value - The tool's resolved value.
 * @returns The answer, or null when it is neither Cypher nor prose.
 */
export function readAskAnswer(value: unknown): AskAnswer | null {
	if (!isPlainObject(value)) return null;
	if (value.valid === true && typeof value.query === 'string' && value.query.trim() !== '') return { kind: 'cypher', cypher: value.query.trim() };
	if (value.valid === false && typeof value.answer === 'string' && value.answer.trim() !== '') return { kind: 'prose', text: value.answer.trim() };
	return null;
}

/** A failed question, explained. */
export interface IAskFailure {
	headline: string;
	detail: string;
	/** True when the failure looks like the pipeline has no language model. */
	unavailable: boolean;
}

/**
 * Text in a failure that says the pipeline has no language model: the engine's own words when no LLM node listens
 * (filter.callbacks.target.cpp: "No control listeners registered for llm"), and explicit "no model" wording. A bare
 * "LLM" or "not connected" is not enough: "LLM failed to return a Cypher query." comes from a connected model.
 */
const NO_MODEL = /no control listeners registered for llm\b|\bno (llm|language model)\b|\binvoke\.llm\b|\b(llm|language model|model) (is )?(not |un)(configured|available|connected|wired)\b|\bno (chat|llm) (node|connection)\b/i;

/**
 * Explain a failed `get_query`.
 *
 * @param error - The failure: a raised error or a `{valid:false, error}` envelope, as headline and detail.
 * @returns The explanation, with `unavailable` set when the pipeline looks to have no model.
 */
export function explainAskFailure(error: { kind: string; headline: string; detail?: string }): IAskFailure {
	const detail = error.detail ?? '';
	// Only a raised error can mean "no model": an `invalid` verdict is the model's own refusal to write a safe query.
	const unavailable = error.kind === 'raised' && NO_MODEL.test(`${error.headline}\n${detail}`);
	return { headline: error.headline, detail, unavailable };
}

// =============================================================================
// ASKING
// =============================================================================

/** The longest question that is sent. */
export const ASK_MAX_CHARS = 2000;

/** What asking came to. */
export type AskOutcome =
	| { kind: 'cypher'; cypher: string }
	| { kind: 'prose'; text: string }
	/** The pipeline has no language model (or it is not wired): say so, no error banner. */
	| { kind: 'unavailable'; text: string }
	/** Described as the browse editor describes a failure: the node's headline (or the upgrade wording), its text, one hint. */
	| { kind: 'failed'; headline: string; detail: string; hint: string | null; variant: 'error' | 'warning' | 'info' }
	/** The question was too long or empty: nothing was sent. */
	| { kind: 'refused'; text: string }
	/** The answer belongs to a request that was superseded: show nothing. */
	| { kind: 'ignored' };

/**
 * Ask the node's model a question and sort the answer.
 *
 * The Cypher it returns is a PREVIEW: the caller puts it in the editor and the
 * user presses Run. Nothing here runs it.
 *
 * @param question - The user's question.
 * @param call - Sends `get_query` with the (trimmed) question and resolves with its value; may throw the session's error.
 * @param unavailableText - What to say when there is no model.
 * @returns The outcome; never throws.
 */
export async function askQuestion(question: string, call: (question: string) => Promise<unknown>, unavailableText: string): Promise<AskOutcome> {
	const trimmed = question.trim();
	if (trimmed === '') return { kind: 'refused', text: 'Type a question first.' };
	if (trimmed.length > ASK_MAX_CHARS) return { kind: 'refused', text: `That question is longer than ${ASK_MAX_CHARS.toLocaleString('en-US')} characters. Shorten it.` };
	try {
		const answer = readAskAnswer(await call(trimmed));
		return answer ?? { kind: 'failed', headline: 'The node answered with neither a query nor text.', detail: '', hint: null, variant: 'error' };
	} catch (error) {
		const e = (error ?? {}) as { kind?: unknown; headline?: unknown; detail?: unknown; message?: unknown };
		const kind = typeof e.kind === 'string' ? e.kind : 'raised';
		if (kind === 'stale') return { kind: 'ignored' };
		const message = typeof e.message === 'string' ? e.message : String(error);
		const failure = explainAskFailure({ kind, headline: typeof e.headline === 'string' ? e.headline : message.split('\n')[0], ...(typeof e.detail === 'string' ? { detail: e.detail } : {}) });
		if (failure.unavailable) return { kind: 'unavailable', text: unavailableText };
		// Ask sits on the browse surface, so it is described with canWrite false: a raised write refusal gets the
		// read-only hint ("Browsing is read-only. ..."), never the pointer to this connection's write console. The
		// node's refusal of the Cypher its model wrote arrives as a {valid: false, error} verdict (kind `invalid`),
		// which gets no hint at all.
		const notice = describeFailureOf(message, error, false);
		if (notice.ignore) return { kind: 'ignored' };
		// The browse editor's timeout note speaks of a database query; the session's own words say what Ask needs.
		const hint = notice.hint === STOP_WAITING_NOTE ? null : notice.hint;
		return { kind: 'failed', headline: notice.headline, detail: notice.detail, hint, variant: notice.variant };
	}
}
