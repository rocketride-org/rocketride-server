/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Database API namespace for the RocketRide TypeScript SDK.
 *
 * Exposes `client.database.query(...)` for issuing raw SQL or Cypher directly
 * against a database pipeline, bypassing the LLM translation layer that the
 * default `client.chat(...)` flow uses.
 */

import type { RocketRideClient } from './client.js';
import type { PIPELINE_RESULT } from './types/index.js';
import { Question, QuestionType } from './schema/Question.js';

// =============================================================================
// DATABASE API CLASS
// =============================================================================

/**
 * Direct database-query namespace on RocketRideClient.
 *
 * Accessed via `client.database` — not instantiated directly. Statements
 * submitted through this namespace bypass the LLM translation layer and
 * safety checks, so the caller is responsible for the SQL/Cypher they pass.
 */
export class DatabaseApi {
	constructor(private readonly client: RocketRideClient) {}

	/**
	 * Execute a raw SQL or Cypher statement against a database pipeline.
	 *
	 * Sends a Question with `type=QuestionType.EXECUTE` so the database node
	 * treats `sql` as the literal statement to run — no LLM call, no
	 * `is_sql_safe` / `_is_cypher_safe` gating.
	 *
	 * @param options.token - Pipeline token for authentication and resource access.
	 * @param options.sql - Raw SQL or Cypher statement to execute.
	 * @param options.onSSE - Optional streaming callback (matches `chat`).
	 * @returns The pipeline response. The `answers` lane carries a JSON-encoded
	 *   payload of shape `{"rows": [...], "affected_rows": N}`.
	 */
	async query(options: {
		token: string;
		sql: string;
		onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>;
	}): Promise<PIPELINE_RESULT> {
		if (typeof options.token !== 'string' || options.token.trim() === '') {
			throw new Error('token must be a non-empty string');
		}
		if (typeof options.sql !== 'string' || options.sql.trim() === '') {
			throw new Error('sql must be a non-empty string');
		}

		const question = new Question({ type: QuestionType.EXECUTE });
		question.addQuestion(options.sql);
		return this.client.chat({ token: options.token, question, onSSE: options.onSSE });
	}
}
