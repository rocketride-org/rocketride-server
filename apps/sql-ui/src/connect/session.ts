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
// CONNECT — SESSION (tool invocation bound to one endpoint)
// =============================================================================
//
// A thin SQL face over the shared tool session
// (shared/explorer/connect/session): it drives the node's shared SQL tools
// (execute / get_schema / refresh_schema / dialect) through the endpoint
// store, which owns the task token. The SqlSession contract is unchanged.
//
// Retry is no longer "a fresh token lookup returned a different token" (task
// tokens are deterministic, so that never fired after a restart). It is the
// shared rule: one retry, idempotent tools only, only on the server's
// TASK_STOPPED code, and only after re-discovery finds the SAME endpoint
// running again. `execute` is repeated only when the caller marks the
// statement a read.
//
// It runs where the engine connection is: the full app's realm, or the dev
// tool's CONTROLLER. A dev-tool frame never holds one (sqlEnv.ts REMOTE).
//
// APPLY is the one place the app opens a transaction: `begin`, every
// statement on the session id it returned, each checked against the rows it
// must change, then `commit`. Anything that goes wrong after `begin` sends
// `rollback` (and never `commit`), even a throw of the app's own; none of
// these is ever sent twice. A node that has no `begin` tool gets nothing
// else: the apply is refused as `transactions-unavailable`, and the caller
// asks the user before sending the statements one by one. An outcome counts
// as known only when the answer is a refusal listed below (REFUSED); a
// dropped connection or a stopped wait is unknown. The session id lives only
// inside one apply call, and is cut out of any message that names it.
//
// Port of f63da6e22 (connect/session.ts).
// =============================================================================

import { ExplorerToolError, isStaleError, readErrorMessage } from 'shared/explorer/errors';
import { TRANSIENT_TASK_CODE } from 'shared/explorer/connect/session';
import type { IToolSession } from 'shared/explorer/connect/session';
import type { IGenerationTicket } from 'shared/explorer/generation';
import { APPLY_STATEMENT_WAIT_MS, TRANSACTIONS_UNAVAILABLE_CODE, statementWaitMs } from './tools';
import type {
	SqlApplyFailure,
	SqlApplyResult,
	SqlApplyStatement,
	SqlEndpoint,
	SqlExecuteResult,
	SqlSchemaResponse,
	SqlSession,
	SqlDialect,
	SqlGetSqlResult,
} from './types';

// =============================================================================
// DIALECT MAPPING
// =============================================================================

/** Dialect strings this app recognises from the node's `dialect` tool. */
const KNOWN_DIALECTS: ReadonlySet<string> = new Set(['mysql', 'postgres', 'clickhouse', 'neo4j']);

/**
 * Map a node-reported dialect string onto the app's SqlDialect union.
 *
 * @param value - The raw dialect string from the node.
 * @returns The matching SqlDialect, or 'unknown'.
 */
export function toDialect(value: unknown): SqlDialect {
	return typeof value === 'string' && KNOWN_DIALECTS.has(value) ? (value as SqlDialect) : 'unknown';
}

// =============================================================================
// APPLY HELPERS
// =============================================================================

/**
 * The engine's answer for a tool the node does not have
 * (`data_conn.py` `_tool`: `No handler found for tool "begin" on node "db_1"`).
 */
const UNKNOWN_TOOL = /\bno handler found for tool\b|\bunknown tool\b/i;

/**
 * Answers that say the call was refused and nothing it asked for took
 * effect: the node's own refusals and wrapped database errors (the
 * database rolled the statement back), SQLAlchemy's DBAPI error prefix, and
 * the transport's "never sent". An ALLOW-LIST: anything not on it (a dropped
 * connection, `Request timed out`, an answer that was not understood) leaves
 * the outcome unknown. Matched anywhere in the message, since the server may
 * put its own words in front.
 */
const REFUSED: readonly RegExp[] = [
	/\bSQL execution failed:/i,
	/\bexecute tool is disabled for this node\b/i,
	/\bexceeded max(?:_execute)?_rows=\d+/i,
	/\bunknown or expired (?:transaction )?session\b/i,
	/\bcommit refused:/i,
	/\btoo many open DB transactions\b/i,
	/\bplaceholder \$\d+ out of range\b/i,
	/"(?:sql|params|row_mode|session_id)" (?:is required|must be)/i,
	/\((?:psycopg2|psycopg|pymysql|MySQLdb|clickhouse_driver|clickhouse_connect)\.[\w.]+\)/,
	UNKNOWN_TOOL,
	/\bcould not send request\b|\bwebsocket not connected\b|\bnot connected to (?:the )?server\b/i,
];

/**
 * A database connection that broke during the call, or a wait that ran
 * out: whether a COMMIT (or a per-statement change's own commit) took
 * effect cannot be known, even when the text carries a DBAPI error prefix
 * or the node's wrapper. Checked before the {@link REFUSED} list wherever
 * the call may have committed (review P4 R2-I3).
 */
const CONNECTION_LOST = /\b(?:OperationalError|InterfaceError)\b|server closed the connection|lost connection|gone away|broken pipe|connection (?:was |is )?(?:already )?(?:closed|reset|lost|terminated|aborted)|terminating connection|could not (?:send|receive) data|time(?:d)? ?out\b|timeout/i;

/** The node's answer for a session it no longer holds (reaped, rolled back, or committed). */
const SESSION_GONE = /\bunknown or expired (?:transaction )?session\b/i;

/** The node's session id in its own messages (`unknown or expired transaction session: <id>`). */
const SESSION_IN_TEXT = /(\bsession(?: id)?:?\s+)[0-9a-f]{16,}/gi;

/**
 * Whether a failed call says the node has no such tool.
 *
 * @param error - What the call threw.
 * @returns True for the engine's no-handler answer (or a local `upgrade` refusal).
 */
function isUnknownTool(error: unknown): boolean {
	return error instanceof ExplorerToolError && (error.kind === 'upgrade' || UNKNOWN_TOOL.test(error.message));
}

/**
 * Whether a failed call that may have committed (the COMMIT, or a
 * per-statement change, which commits as it runs) is known to have taken no
 * effect: nothing was sent (no task, no token, a local refusal, the
 * server's pre-dispatch TASK_STOPPED), or the answer is a refusal on the
 * {@link REFUSED} list that is not about a broken connection.
 *
 * @param error - What the call threw.
 * @returns True only when its outcome is known.
 */
function refusedForCertain(error: unknown): boolean {
	if (!(error instanceof ExplorerToolError)) return false;
	if (error.kind === 'unavailable' || error.kind === 'upgrade' || error.kind === 'invalid') return true;
	if (error.code === TRANSIENT_TASK_CODE) return true;
	if (error.kind !== 'raised') return false;
	if (CONNECTION_LOST.test(error.message)) return false;
	return REFUSED.some((pattern) => pattern.test(error.message));
}

/**
 * A message with any session id cut out (a frame must never see one, dead or alive).
 *
 * @param text - The message.
 * @param sessionId - The session this apply opened, if any.
 * @returns The message, the id replaced by `<session>`.
 */
function redactSession(text: string, sessionId: string | null): string {
	const cut = sessionId ? text.split(sessionId).join('<session>') : text;
	return cut.replace(SESSION_IN_TEXT, '$1<session>');
}

/** A failure before its rollback is known. */
type OpenFailure = Omit<SqlApplyFailure, 'rollbackConfirmed'>;

/**
 * A failure record for a call that threw.
 *
 * @param error - What the call threw.
 * @param index - The statement (or, for the commit, the statement count).
 * @param stage - What failed.
 * @param committed - How many statements are saved for certain.
 * @param unknown - Whether the failing call's own outcome is unknown.
 * @returns The record (the message verbatim, the code when there is one).
 */
function failureOf(error: unknown, index: number, stage: SqlApplyFailure['stage'], committed: number, unknown: boolean): OpenFailure {
	const code = error instanceof ExplorerToolError ? error.code : undefined;
	return { index, stage, message: readErrorMessage(error), ...(code !== undefined ? { code } : {}), committed, unknown };
}

/**
 * The rows a statement reported changing.
 *
 * @param result - The `execute` answer.
 * @returns The count, or null when the node reported none.
 */
function affectedOf(result: SqlExecuteResult | undefined): number | null {
	const value = result?.affected_rows;
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Why a statement's row count does not match what it had to change.
 *
 * @param statement - The statement.
 * @param affected - The rows it reported changing.
 * @returns The sentence, or null when it matches (or nothing was expected).
 */
function expectMismatch(statement: SqlApplyStatement, affected: number | null): string | null {
	if (statement.expect === undefined || affected === statement.expect) return null;
	const want = `${statement.expect} row${statement.expect === 1 ? '' : 's'}`;
	if (affected === null) return `The database did not say how many rows the statement changed; it must change exactly ${want}.`;
	const why = affected < statement.expect ? 'The row may have changed or gone since it was read.' : 'Its key matched more rows than it names.';
	return `The statement changed ${affected} row${affected === 1 ? '' : 's'}; it must change exactly ${want}. ${why}`;
}

/**
 * The refusal an atomic apply gets where there is no transaction to have.
 *
 * @param tool - What found out (`begin`, or `apply` for a dialect known to have none).
 * @param message - The sentence.
 * @returns The error (`transactions-unavailable`; nothing was sent).
 */
export function transactionsUnavailable(tool: string, message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'upgrade', tool, code: TRANSACTIONS_UNAVAILABLE_CODE, message });
}

// =============================================================================
// SESSION IMPLEMENTATION
// =============================================================================

/** SqlSession over the shared tool session. */
class SqlToolSession implements SqlSession {
	/** The endpoint this session is bound to. */
	readonly endpoint: SqlEndpoint;

	/** The shared session (it reads the task token from the store's vault at call time). */
	private readonly session: IToolSession;

	/**
	 * @param session - The shared session for the endpoint.
	 * @param endpoint - The endpoint to bind to (the app's token-free description).
	 */
	constructor(session: IToolSession, endpoint: SqlEndpoint) {
		this.session = session;
		this.endpoint = endpoint;
	}

	/** @inheritdoc */
	async execute(sql: string, opts?: { params?: unknown[]; idempotent?: boolean; generation?: IGenerationTicket }): Promise<SqlExecuteResult> {
		// Omit `params` entirely when there is nothing to bind: the node's
		// placeholder rewriting is skipped for an empty list, so an unbound
		// statement keeps travelling exactly as it did before.
		const params = opts?.params;
		const input = params && params.length > 0 ? { sql, params } : { sql };
		// Default NO retry: an unmarked statement may well be a write. The wait
		// is the node's published statement deadline plus a pad, or none. The
		// caller's ticket goes down with the call (port of 740b69c6d), so a
		// request it abandoned is never sent again by the session's retry.
		const generation = opts?.generation;
		return this.session.invoke<SqlExecuteResult>('execute', input, {
			idempotent: opts?.idempotent === true,
			timeoutMs: statementWaitMs(this.session.info()),
			...(generation === undefined ? {} : { generation }),
		});
	}

	/**
	 * Apply app-written statements (see {@link SqlSession.applyBatch}).
	 * Runs exactly what it is given: the list's gate and the dialect rule
	 * (a ClickHouse session undoes nothing, so an atomic apply there is
	 * refused before anything is sent) belong to the engine core, the only
	 * caller in this realm.
	 *
	 * @param statements - The statements, in order.
	 * @param opts - Apply options.
	 * @param opts.atomic - Run them inside one transaction (refused when the node has no `begin`).
	 * @returns What ran.
	 */
	async applyBatch(statements: SqlApplyStatement[], opts: { atomic: boolean }): Promise<SqlApplyResult> {
		if (!opts.atomic) return this.applyEach(statements);
		let sessionId: string;
		try {
			sessionId = await this.begin();
		} catch (error) {
			// A node older than the transaction tools. The user was told "one
			// transaction", so nothing else is sent: the caller asks again,
			// with the per-statement wording, before it sends `atomic: false`.
			if (isUnknownTool(error)) throw transactionsUnavailable('begin', 'This node has no transaction tools, so nothing was applied.');
			throw error;
		}
		return this.applyInTransaction(sessionId, statements);
	}

	/**
	 * Open a transaction session.
	 *
	 * @returns Its session id.
	 * @throws ExplorerToolError when the node refused, or answered without an id.
	 */
	private async begin(): Promise<string> {
		const result = await this.session.invoke<{ session_id?: unknown }>('begin', {});
		const id = result?.session_id;
		if (typeof id !== 'string' || id === '') {
			throw new ExplorerToolError({ kind: 'malformed', tool: 'begin', message: 'begin answered without a session id, so nothing was applied.' });
		}
		return id;
	}

	/**
	 * Send one statement of an apply, once. It waits the node's published
	 * statement deadline (plus pad), or, when the node publishes none, as
	 * long as it takes: the wait any statement gets, and the designer's
	 * before applyBatch. Only inside a transaction is that capped, at the
	 * time the node keeps an idle transaction ({@link APPLY_STATEMENT_WAIT_MS}):
	 * a statement committed on its own holds no transaction, and a long
	 * ALTER cut off at 5 minutes would be reported "may have run" and
	 * dropped from the plan while it kept running.
	 *
	 * @param statement - The statement.
	 * @param sessionId - The transaction session, or null to commit it on its own.
	 * @returns The node's answer.
	 */
	private sendOne(statement: SqlApplyStatement, sessionId: string | null): Promise<SqlExecuteResult> {
		const params = statement.params;
		const input = {
			sql: statement.sql,
			...(params && params.length > 0 ? { params } : {}),
			...(sessionId !== null ? { session_id: sessionId } : {}),
		};
		const deadline = statementWaitMs(this.session.info());
		const waitMs = sessionId === null ? deadline : Math.min(deadline ?? APPLY_STATEMENT_WAIT_MS, APPLY_STATEMENT_WAIT_MS);
		return this.session.invoke<SqlExecuteResult>('execute', input, { idempotent: false, timeoutMs: waitMs });
	}

	/**
	 * Roll a session back, once, and say what the node answered.
	 *
	 * @param sessionId - The session.
	 * @returns `done`: rolled back now; `gone`: the node holds the session no
	 *          longer (it was finalised: reaped, closed, or committed);
	 *          `unconfirmed`: no answer that says either (a timeout, a lost
	 *          connection, a refusal), so its locks may still be held.
	 */
	private async rollback(sessionId: string): Promise<'done' | 'gone' | 'unconfirmed'> {
		try {
			await this.session.invoke('rollback', { session_id: sessionId });
			return 'done';
		} catch (error) {
			return error instanceof ExplorerToolError && error.kind === 'raised' && SESSION_GONE.test(error.message) ? 'gone' : 'unconfirmed';
		}
	}

	/**
	 * Every statement on one transaction session, then commit; roll back on
	 * the first failure or row-count mismatch, and on any throw of the app's
	 * own (which then propagates).
	 *
	 * @param sessionId - The session `begin` opened.
	 * @param statements - The statements.
	 * @returns What ran.
	 */
	private async applyInTransaction(sessionId: string, statements: SqlApplyStatement[]): Promise<SqlApplyResult> {
		const results: SqlApplyResult['results'] = [];
		const done = (failure: OpenFailure, rollbackConfirmed: boolean): SqlApplyResult => ({
			transactional: true,
			results,
			failure: { ...failure, message: redactSession(failure.message, sessionId), rollbackConfirmed },
		});
		// Nothing is committed on any of these paths: the rollback (or, when it
		// cannot get through, the node's idle reaper) undoes what ran.
		const stop = async (failure: OpenFailure): Promise<SqlApplyResult> => done(failure, (await this.rollback(sessionId)) !== 'unconfirmed');
		let committing = false;
		try {
			for (const [index, statement] of statements.entries()) {
				let result: SqlExecuteResult;
				try {
					result = await this.sendOne(statement, sessionId);
				} catch (error) {
					return await stop(failureOf(error, index, 'statement', 0, false));
				}
				const affected = affectedOf(result);
				results.push({ affected_rows: affected ?? 0 });
				const mismatch = expectMismatch(statement, affected);
				if (mismatch !== null) return await stop({ index, stage: 'expect', message: mismatch, committed: 0, unknown: false });
			}
			committing = true;
			try {
				await this.session.invoke('commit', { session_id: sessionId });
			} catch (error) {
				// A refusal the node gives closes the session after rolling it
				// back (PostgreSQL refuses to commit an aborted transaction; a
				// database error at commit ends it too). Any other failure may
				// have committed: a rollback the node still carries out proves it
				// did not (the session was open), while a session the node no
				// longer holds, or no answer at all, leaves it unknown.
				const refused = refusedForCertain(error);
				const rollback = await this.rollback(sessionId);
				const unknown = !refused && rollback !== 'done';
				return done(failureOf(error, statements.length, 'commit', 0, unknown), refused || rollback !== 'unconfirmed');
			}
			return { transactional: true, results, failure: null };
		} catch (error) {
			// A throw of the app's own (none of the paths above): never leave the
			// transaction open on it. After the commit was sent there is nothing
			// left to undo here.
			if (!committing) await this.rollback(sessionId);
			throw error;
		}
	}

	/**
	 * Every statement on its own (each commits as it runs), stopping at the
	 * first failure or row-count mismatch.
	 *
	 * @param statements - The statements.
	 * @returns What ran.
	 */
	private async applyEach(statements: SqlApplyStatement[]): Promise<SqlApplyResult> {
		const results: SqlApplyResult['results'] = [];
		for (const [index, statement] of statements.entries()) {
			let result: SqlExecuteResult;
			try {
				result = await this.sendOne(statement, null);
			} catch (error) {
				// The ones before it committed; it did not, unless the answer
				// leaves that open (a dropped connection, a stopped wait).
				return { transactional: false, results, failure: { ...failureOf(error, index, 'statement', index, !refusedForCertain(error)), rollbackConfirmed: true } };
			}
			const affected = affectedOf(result);
			results.push({ affected_rows: affected ?? 0 });
			// It ran and committed: counted, and nothing after it is sent.
			const mismatch = expectMismatch(statement, affected);
			if (mismatch !== null) return { transactional: false, results, failure: { index, stage: 'expect', message: mismatch, committed: index + 1, unknown: false, rollbackConfirmed: true } };
		}
		return { transactional: false, results, failure: null };
	}

	/** @inheritdoc */
	async getSchema(table?: string): Promise<SqlSchemaResponse> {
		return this.session.invoke<SqlSchemaResponse>('get_schema', table ? { table } : {});
	}

	/** @inheritdoc */
	async refreshSchema(): Promise<SqlSchemaResponse> {
		try {
			return await this.session.invoke<SqlSchemaResponse>('refresh_schema', {});
		} catch (error) {
			// A dropped (superseded) result is not a failure of the tool.
			if (isStaleError(error)) throw error;
			// ANY other failure falls back. A node without the tool and a node
			// that simply could not answer are indistinguishable at this layer,
			// and matching the engine's error wording would rot the first time it
			// changed. Serve the task-start snapshot and flag it, rather than
			// present it as freshly reflected; when the fallback ALSO fails, its
			// error is the one the caller sees.
			const schema = await this.getSchema();
			return { ...schema, stale: true };
		}
	}

	/** @inheritdoc */
	async dialect(): Promise<SqlDialect> {
		const result = await this.session.invoke<{ dialect?: string }>('dialect', {});
		return toDialect(result?.dialect);
	}

	/** @inheritdoc */
	async getSql(question: string): Promise<SqlGetSqlResult> {
		return this.session.invoke<SqlGetSqlResult>('get_sql', { question });
	}
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a live session bound to one database endpoint.
 *
 * @param session - The endpoint store's session for the endpoint (`store.session(client, endpoint)`).
 * @param endpoint - The app's token-free description of the endpoint.
 * @returns The bound session.
 */
export function createSqlSession(session: IToolSession, endpoint: SqlEndpoint): SqlSession {
	return new SqlToolSession(session, endpoint);
}
