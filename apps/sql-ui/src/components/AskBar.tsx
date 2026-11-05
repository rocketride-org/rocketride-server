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
// SQL-UI — ASK (a question in words becomes SQL to review; nothing runs)
// =============================================================================
//
// The bar above the query editor sends a question to the database node's
// `get_sql` tool (SqlSession.getSql). The node's LLM writes the query, the
// node checks it with EXPLAIN, and the SQL comes back NOT executed:
//
//   valid SQL         opens in a NEW query instance, marked generated (the
//                     editor's "Generated preview" banner), the question as a
//                     comment above it. Nothing runs until the user presses
//                     Run, and Run applies the usual checks.
//   anything else     the node's own text, verbatim: its refusal (its
//                     safety check refuses a query that starts with WITH), the
//                     database's error, the model's answer in words, or the
//                     node's MissingLlmError when no LLM is connected to it.
//
// A direct connection's pipeline is the database node alone, so it never has
// an LLM: the bar is disabled there and says why. What is sent to the model
// is spelled out under the bar (ASK_CONTEXT_TEXT).
// =============================================================================

import React, { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, InputField } from 'shell';
import { MAX_QUESTION_CHARS, isDirectEndpointKey } from '../connect';
import type { SqlEndpoint, SqlGetSqlResult, SqlSession } from '../connect';
import { useSqlEnv } from '../sqlEnv';
import { useSqlPageNav } from '../pageNav';
import type { SqlQuerySeed } from '../pageNav';
import { announce } from '../a11y/announce';

// =============================================================================
// WORDING
// =============================================================================

/** Why the bar is disabled on a direct connection. */
export const ASK_DIRECT_TEXT = 'Ask needs a pipeline whose database node has an LLM connected.';

/** Exactly what goes to the model, and what does not happen (db_instance_base._buildSQLQueryOnce). */
export const ASK_CONTEXT_TEXT = 'Your question goes to the LLM connected to this pipeline\'s database node, through the node\'s get_sql tool, '
	+ 'together with the node\'s schema (table and column names, their types, primary and foreign keys) and the database description set on the node, if any. '
	+ 'No rows are sent. The node checks each draft with EXPLAIN, which does not run it; when the database rejects a draft, its error message goes back to the model for another try. '
	+ 'Nothing runs until you press Run. The node\'s safety check refuses queries that start with WITH: it returns only statements that start with SELECT or EXPLAIN.';

/** When the node answered with neither SQL nor text. */
const NO_ANSWER_TEXT = 'The node returned no SQL and no answer.';

// =============================================================================
// THE ANSWER
// =============================================================================

/** What one question came back as. */
export type AskOutcome =
	| { kind: 'sql'; sql: string }
	| { kind: 'refused'; text: string }
	| { kind: 'answer'; text: string }
	| { kind: 'failed'; text: string };

/**
 * Map the node's answer onto what the bar does: open valid SQL, else show
 * the node's own text, verbatim.
 *
 * @param result - What get_sql answered.
 * @returns The outcome.
 */
export function askOutcome(result: SqlGetSqlResult): AskOutcome {
	const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
	const sql = result.valid === true ? text(result.sql) : null;
	if (sql !== null) return { kind: 'sql', sql };
	const error = text(result.error);
	if (error !== null) return { kind: 'refused', text: error };
	const answer = text(result.answer);
	if (answer !== null) return { kind: 'answer', text: answer };
	return { kind: 'refused', text: NO_ANSWER_TEXT };
}

/**
 * Ask one question. Only `getSql` is called: whatever SQL comes back is
 * handed back, never run.
 *
 * @param session - The connection's session (only its getSql is used).
 * @param question - The question.
 * @returns The outcome; a failure (MissingLlmError, a timeout) is its own text.
 */
export async function runAsk(session: Pick<SqlSession, 'getSql'>, question: string): Promise<AskOutcome> {
	try {
		return askOutcome(await session.getSql(question));
	} catch (error) {
		return { kind: 'failed', text: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The query instance valid SQL opens in: the question as a comment above the
 * SQL, marked generated so the editor says to review it before Run.
 *
 * @param question - The question asked.
 * @param sql - The SQL the node wrote.
 * @returns The page seed (a NEW instance).
 */
export function askSeed(question: string, sql: string): SqlQuerySeed {
	const asked = question.replace(/\s+/g, ' ').trim().slice(0, 200);
	return { sql: `-- Asked: ${asked}\n${sql.trim()}`, origin: 'generated' };
}

/**
 * Why the bar cannot ask on a connection, or null when it can.
 *
 * @param endpoint - The connection.
 * @param ready - Whether the engine is reachable.
 * @returns The reason, or null.
 */
export function askRefusal(endpoint: SqlEndpoint, ready: boolean): string | null {
	if (isDirectEndpointKey(endpoint.key)) return ASK_DIRECT_TEXT;
	if (!ready) return 'Not connected.';
	return null;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	root: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
	} as CSSProperties,

	// The reason Ask is off sits on this row, wrapping to a line of its own
	// only where it does not fit: a line below cost the results a row (live L2).
	row: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 8,
	} as CSSProperties,

	input: {
		flex: '1 1 320px',
		minWidth: 0,
	} as CSSProperties,

	reason: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	meta: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	context: {
		fontSize: 11,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	reply: {
		margin: 0,
		padding: '6px 8px',
		borderRadius: 6,
		background: 'var(--rr-bg-widget)',
		fontSize: 12,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	} as CSSProperties,
};

/** The label above the node's own text, per outcome. */
const REPLY_LABEL: Record<Exclude<AskOutcome['kind'], 'sql'>, string> = {
	refused: 'The node did not return SQL:',
	answer: 'The node\'s model answered in words instead of SQL:',
	failed: 'Ask failed:',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Ask bar: a question in, SQL to review out (in a new query instance).
 *
 * @param props - The connection.
 * @param props.endpoint - The connection the question is about.
 * @returns The bar.
 */
export const AskBar: React.FC<{ endpoint: SqlEndpoint }> = ({ endpoint }) => {
	const env = useSqlEnv();
	const pageNav = useSqlPageNav();
	const [question, setQuestion] = useState('');
	const [asking, setAsking] = useState(false);
	const [reply, setReply] = useState<Exclude<AskOutcome, { kind: 'sql' }> | null>(null);
	// Each question's turn: an answer to an older one (or after Stop waiting) is dropped.
	const turnRef = useRef(0);
	const refusal = askRefusal(endpoint, env.ready);

	/** Send the question; valid SQL opens in a new query instance, nothing runs. */
	const ask = async (): Promise<void> => {
		const asked = question.trim();
		if (asked === '' || asking || refusal !== null) return;
		const turn = ++turnRef.current;
		setAsking(true);
		setReply(null);
		announce('Asking the database node for SQL');
		const outcome = await runAsk(env.getSession(endpoint), asked);
		if (turn !== turnRef.current) return;
		setAsking(false);
		if (outcome.kind === 'sql') {
			pageNav.openQuery(askSeed(asked, outcome.sql));
			announce('The node wrote SQL for your question. It opened in a new query; nothing has run.');
			return;
		}
		setReply(outcome);
		announce(`${REPLY_LABEL[outcome.kind]} ${outcome.text}`);
	};

	/** Stop waiting: the node may still answer, and that answer is dropped. */
	const stopWaiting = (): void => {
		turnRef.current += 1;
		setAsking(false);
	};

	return (
		<div style={styles.root}>
			<div style={styles.row}>
				<InputField
					style={styles.input}
					aria-label="Ask the database node to write SQL"
					placeholder="Ask in plain words, e.g. orders from the last 7 days"
					value={question}
					maxLength={MAX_QUESTION_CHARS}
					disabled={refusal !== null}
					onChange={(event) => setQuestion(event.target.value)}
					// Not while an input method is composing: its Enter picks a candidate.
					onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void ask(); }}
				/>
				{asking ? (
					<Button variant="ghost" title="Stop waiting for the node's answer. It is not cancelled." onClick={stopWaiting}>Stop waiting</Button>
				) : (
					<Button
						variant="secondary"
						disabled={refusal !== null || question.trim() === ''}
						title={refusal ?? 'The node writes SQL for the question; it opens in a new query and nothing runs'}
						onClick={() => { void ask(); }}
					>
						Ask
					</Button>
				)}
				{/* Why the bar is disabled, as text: a tooltip alone is not an answer. */}
				{refusal !== null && <span style={styles.reason}>{refusal}</span>}
			</div>
			{refusal === null && (
				<details style={styles.context}>
					<summary>What Ask sends, and what it does not do</summary>
					{ASK_CONTEXT_TEXT}
				</details>
			)}
			{/* Announced when it arrives (announce above), so not a live region too. */}
			{reply && (
				<div>
					<div style={styles.meta}>{REPLY_LABEL[reply.kind]}</div>
					<pre style={styles.reply}>{reply.text}</pre>
				</div>
			)}
		</div>
	);
};

export default AskBar;
