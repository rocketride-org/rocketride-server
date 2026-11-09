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
// SMOKE MODELS: each eval model answers through the Agent tab's model path
// =============================================================================

/**
 * Task 0.2. Asks each model one short question the way the Agent tab does
 * (apps/shared/src/modules/agent/modelEngine.ts modelPipeline and
 * openChatModel): a one-node pipeline per provider, webhook -> the provider's
 * node -> answers, whose key is the `${ROCKETRIDE_..._KEY}` Variable, started
 * with client.use and asked with client.chat. Prints a table: model, answered,
 * seconds, whether the engine lists the key's name, and the error or the
 * answer's length. Never prints a key.
 *
 *   EVAL_ARGS="smoke" ./builder browser-agent:eval
 *   EVAL_ARGS="smoke --models anthropic/claude-haiku-5-5,openai/gpt-6-luna" ./builder browser-agent:eval
 */

import { Question, RocketRideClient } from 'rocketride';
import type { PipelineConfig } from 'rocketride';

import { providerRow, type ModelPick } from './driver';
import type { Scrubber } from './evidence';

/** The models the eval uses, the dead catalog profile the proof run picked, and the one only chore/sync-models has. */
export const SMOKE_MODELS = ['anthropic/claude-haiku-5-5', 'openai/gpt-6-luna', 'anthropic/claude-haiku-latest', 'openai/gpt-6-luna-pro'];

/** The prefix the provider nodes put on an error they return as an answer (modelEngine.ts LLM_ERROR_PREFIX). */
const LLM_ERROR_PREFIX = '**LLM error** — ';
const QUESTION = 'Reply with one word: what colour is a clear daytime sky?';
const ASK_MS = 120_000;

/** One row of the table. */
export interface SmokeRow {
	model: string;
	answered: boolean;
	seconds: number;
	/** Whether getEnvironmentKeys() listed the provider's key name. */
	keyListed: boolean;
	/** The answer's length, or the error, scrubbed. */
	detail: string;
	/** Fields of the chat result besides the answer, as the engine returned them (usage when it reports any). */
	extra?: Record<string, unknown>;
}

/** The pipeline the Agent tab runs for a model (modelEngine.ts modelPipeline), under a project id of its own. */
export function smokePipeline(pick: ModelPick, service: string, variable: string): Record<string, unknown> & { project_id: string } {
	const node = `${service}_1`;
	return {
		project_id: `eval-smoke-${pick.provider}-${pick.model}`.replace(/[^A-Za-z0-9_-]/g, '_'),
		source: 'webhook_1',
		components: [
			{ id: 'webhook_1', provider: 'webhook', config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } },
			{ id: node, provider: service, config: { profile: pick.model, [pick.model]: { apikey: `\${${variable}}` }, parameters: {} }, input: [{ lane: 'questions', from: 'webhook_1' }] },
			{ id: 'response_answers_1', provider: 'response_answers', config: { laneName: 'answers' }, input: [{ lane: 'answers', from: node }] },
		],
	};
}

/**
 * Asks each model once.
 *
 * @param engineUri - The engine.
 * @param apiKey - The API key to connect with.
 * @param models - provider/model specs.
 * @param scrubber - For error text, which can quote what the provider got.
 */
export async function smokeModels(engineUri: string, apiKey: string, models: ModelPick[], scrubber: Scrubber): Promise<SmokeRow[]> {
	const client = new RocketRideClient({ uri: engineUri, env: {} });
	await client.connect(apiKey);
	const rows: SmokeRow[] = [];
	try {
		const names = await client.account.getEnvironmentKeys();
		for (const pick of models) {
			const row = providerRow(pick.provider);
			const t0 = Date.now();
			const out: SmokeRow = { model: `${pick.provider}/${pick.model}`, answered: false, seconds: 0, keyListed: names.includes(row.variable), detail: '' };
			let token: string | undefined;
			try {
				const started = await client.use({ pipeline: smokePipeline(pick, row.service, row.variable) as unknown as PipelineConfig, useExisting: true });
				token = started.token;
				if (!token) throw new Error('the engine returned no token');
				const question = new Question({});
				question.addQuestion(QUESTION);
				const result = (await withTimeout(client.chat({ token, question }), ASK_MS)) as { answers?: unknown[]; [field: string]: unknown };
				const first = result.answers?.[0];
				const text = typeof first === 'string' ? first : first == null ? '' : JSON.stringify(first);
				const { answers: _answers, ...extra } = result;
				if (Object.keys(extra).length) out.extra = JSON.parse(scrubber.scrub(JSON.stringify(extra)).slice(0, 2000)) as Record<string, unknown>;
				if (text.startsWith(LLM_ERROR_PREFIX)) out.detail = scrubber.scrub(text.slice(LLM_ERROR_PREFIX.length)).slice(0, 300);
				else if (!text.trim()) out.detail = 'empty answer';
				else {
					out.answered = true;
					out.detail = `${text.length} characters`;
				}
			} catch (err) {
				out.detail = scrubber
					.scrub(err instanceof Error ? err.message : String(err))
					.split('\n')[0]
					.slice(0, 300);
			} finally {
				out.seconds = Math.round((Date.now() - t0) / 100) / 10;
				if (token) await client.terminate(token).catch(() => {});
			}
			rows.push(out);
		}
	} finally {
		await client.disconnect();
	}
	return rows;
}

/** The rows as a Markdown table. */
export function smokeTable(rows: SmokeRow[]): string {
	const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const lines = ['| Model | Answered | Seconds | Key name listed | Detail |', '| --- | --- | --- | --- | --- |'];
	for (const r of rows) lines.push(`| ${r.model} | ${r.answered ? 'yes' : 'no'} | ${r.seconds} | ${r.keyListed ? 'yes' : 'no'} | ${cell(r.detail)} |`);
	return lines.join('\n');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms).unref())]);
}
