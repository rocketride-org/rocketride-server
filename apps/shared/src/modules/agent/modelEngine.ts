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
// MODEL ENGINE — a model call on a small pipeline the agent starts for itself
// =============================================================================

/**
 * The one implementation of the seam in model.ts, and all that client.process() replaces: a pipeline
 * of webhook source, the provider's node and answers lane, one per conversation and model. The key is
 * never in code or in the browser: the pipeline names the Variable and the engine fills it at task
 * start. This is the agent's only runtime import of 'rocketride', which is undefined under shared:test.
 */

import { Answer, Question } from 'rocketride';
import type { AnswerError, PIPELINE_RESULT, PipelineConfig, RocketRideClient } from 'rocketride';

import { ModelFailure, PROVIDER_IDS, type ChatModel, type ModelChoice, type ModelOffer, type ModelRequest, type ModelResponse, type ProviderId, type ProviderOffer } from './model';
import { messageOf, NOT_CONNECTED_MESSAGE, type ClientGetter } from './toolkits/common';
import { readTokens, type Tokens } from './usage';

// =============================================================================
// PROVIDERS
// =============================================================================

/** One provider this build can run with a single key. */
interface ProviderRow {
	/** The node. */
	readonly service: string;
	readonly title: string;
	/** The credentials.json `suggests` of the node's llm.apikey field, which the browser cannot read. agent.test.ts fails when they disagree. */
	readonly variable: string;
	/**
	 * What the picker offers, by the node's profile names. A short list, not the node's catalog: that also holds
	 * OpenRouter's names, which the provider's own API refuses. Each has a price in usage.ts.
	 */
	readonly models: readonly ModelOffer[];
}

const PROVIDERS: Readonly<Record<ProviderId, ProviderRow>> = {
	anthropic: {
		service: 'llm_anthropic',
		title: 'Anthropic',
		variable: 'ROCKETRIDE_ANTHROPIC_KEY',
		models: [
			{ model: 'claude-fable-5-1', title: 'Claude Fable 5.1' },
			{ model: 'claude-opus-5-5', title: 'Claude Opus 5.5' },
			{ model: 'claude-opus-5', title: 'Claude Opus 5' },
			{ model: 'claude-sonnet-5-5', title: 'Claude Sonnet 5.5' },
			{ model: 'claude-haiku-5-5', title: 'Claude Haiku 5.5' },
		],
	},
	openai: {
		service: 'llm_openai',
		title: 'OpenAI',
		variable: 'ROCKETRIDE_OPENAI_KEY',
		models: [
			{ model: 'gpt-6-astra', title: 'GPT-6 Astra' },
			{ model: 'gpt-6-1-sol', title: 'GPT-6.1 Sol' },
			{ model: 'gpt-6-sol', title: 'GPT-6 Sol' },
			{ model: 'gpt-6-luna', title: 'GPT-6 Luna' },
			{ model: 'openai-5-4', title: 'GPT-5.4' },
			{ model: 'openai-5-4-mini', title: 'GPT-5.4 mini' },
		],
	},
};

// =============================================================================
// THE PIPELINE
// =============================================================================

type ModelPipeline = Record<string, unknown> & { project_id: string };

/**
 * webhook -> the provider's node -> answers. The engine's task identity includes project_id, so a
 * changed choice is a new task (`useExisting` would hand back one with the old config), a task only
 * holds its conversation's team's key, and a restart in one conversation cannot touch another. The
 * cut to safe characters leaves no dot, which ids built today must not contain.
 */
function modelPipeline(choice: ModelChoice, row: ProviderRow, conversationId: string): ModelPipeline {
	const { model } = choice;
	const node = `${row.service}_1`;
	return {
		project_id: `${conversationId}-${choice.provider}-${model}`.replace(/[^A-Za-z0-9_-]/g, '_'),
		source: 'webhook_1',
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' },
			},
			{
				id: node,
				provider: row.service,
				config: { profile: model, [model]: { apikey: `\${${row.variable}}` }, parameters: {} },
				input: [{ lane: 'questions', from: 'webhook_1' }],
			},
			{
				id: 'response_answers_1',
				provider: 'response_answers',
				config: { laneName: 'answers' },
				input: [{ lane: 'answers', from: node }],
			},
		],
	};
}

// =============================================================================
// THE TASKS
// =============================================================================

/** The tasks of the open conversations, each started on its first question. A task ends after 15 idle minutes. */
class ModelTasks {
	/** The token of each task, as a promise so two asks at once start one. */
	private readonly tokens = new Map<string, Promise<string>>();

	/**
	 * The token of a pipeline's task, starting it on the first ask.
	 *
	 * @returns The token. A failed start is not kept, so the next ask tries again.
	 */
	token(client: RocketRideClient, pipeline: ModelPipeline): Promise<string> {
		const id = pipeline.project_id;
		const cached = this.tokens.get(id);
		if (cached) return cached;
		const started = this.start(client, pipeline);
		this.tokens.set(id, started);
		started.catch(() => {
			if (this.tokens.get(id) === started) this.tokens.delete(id);
		});
		return started;
	}

	/** Replaces a pipeline's task: ends the old one and starts a new one, which reads the Variables again. */
	async restart(client: RocketRideClient, pipeline: ModelPipeline): Promise<string> {
		const old = this.tokens.get(pipeline.project_id);
		this.tokens.delete(pipeline.project_id);
		if (old) {
			try {
				await client.terminate(await old);
			} catch {
				// step: it may already have ended; starting a new one is the fix either way
			}
		}
		return this.token(client, pipeline);
	}

	private async start(client: RocketRideClient, pipeline: ModelPipeline): Promise<string> {
		const started = await client.use({ pipeline: pipeline as unknown as PipelineConfig, useExisting: true });
		if (!started.token) throw new Error('The engine returned no token for the model pipeline.');
		return started.token;
	}
}

const tasks = new ModelTasks();

/**
 * The model pipelines whose node refused a turn (`tools_unsupported`), by project_id. Each is asked
 * in text for the rest of its conversation, so later turns skip the refusal's round trip. A model
 * switch is a new project_id, so it tries native again. Page lifetime, like `tasks`.
 */
const textOnly = new Set<string>();

// =============================================================================
// THE KEY
// =============================================================================

/** The account's Variable names, or null when they cannot be read: the turn goes on, and the engine's own error names the Variable. */
async function readKeyNames(client: RocketRideClient): Promise<readonly string[] | null> {
	try {
		return await client.account.getEnvironmentKeys();
	} catch (err) {
		console.log(`[agent] could not read the Variable names: ${messageOf(err)}`);
		return null;
	}
}

function keyState(names: readonly string[] | null, row: ProviderRow): ProviderOffer['key'] {
	if (names === null) return 'unknown';
	return names.includes(row.variable) ? 'set' : 'missing';
}

// =============================================================================
// THE FAILURES
// =============================================================================

/** The start of the answer the pipeline writes when the provider call failed (packages/ai/src/ai/common/llm_base.py:95). */
const LLM_ERROR_PREFIX = '**LLM error** — ';

/** What the engine raises for an absent Variable (packages/ai/src/ai/common/config.py:61), however it arrives. */
const NO_VARIABLE = /no variable named/i;

/** Text about the key itself. It also arrives thrown: the Anthropic node refuses a badly formed key when its task starts (llm_anthropic/anthropic.py:93). */
const BAD_KEY = /invalid[ _-]+(?:[\w-]+[ _-]+)?api[ _-]?key|api[ _-]?key not valid/i;

/** A provider's refusal (the list in packages/ai/src/ai/common/chat.py:348). Only an answer's text means this: a thrown 401 may be the user's RocketRide session. */
const PROVIDER_REFUSAL = /\b40[13]\b|authentication|unauthori[sz]ed|forbidden/i;

/** The provider is busy or down: asking again now would bill again and likely fail. */
const PROVIDER_BUSY = /\b429\b|\b5\d\d\b|overloaded|rate[ _-]?limit|timeout|timed out/i;

/**
 * The one place provider and engine failures get a meaning.
 *
 *   what happened                                retryable  billed  key
 *   no client (the ask below)                    no         no      -
 *   no Variable of that name (the ask below), or
 *     `no variable named`, however it arrives    no         no      missing
 *   a refusal                                    yes        no      rejected
 *   the task's start threw                       yes        no      -
 *   the chat threw                               yes        yes     -
 *   the provider is busy or down                 no         yes     -
 *   any other **LLM error**                      yes        yes     -
 *   an empty answer (readAnswer)                 no         yes     -
 *   a turn the engine refused (invalid_request)  no         no      -
 *   a turn the provider failed (provider_error)  as any other answer's text: it names the exception type
 *
 * Retrying refusals is what makes a fixed key work. A Variable reaches a task only at its start
 * (task_engine.py:779), and the browser cannot see a value change, so a refusal is not believed until
 * a freshly started task repeats it. "Any other" is retryable for the same reason: a key error this
 * list fails to recognise costs one restart and cannot strand the user behind a stale task.
 */
function failureOfText(text: string, row: ProviderRow, arrived: 'answer' | 'start' | 'chat'): ModelFailure {
	if (NO_VARIABLE.test(text)) return missingKey(row);
	if (BAD_KEY.test(text) || (arrived === 'answer' && PROVIDER_REFUSAL.test(text))) {
		return new ModelFailure(`${row.title} refused the key in ${row.variable}.`, { retryable: true, billed: false, key: { state: 'rejected', provider: row.title, variable: row.variable } });
	}
	if (arrived === 'start') return new ModelFailure(`The model pipeline stopped responding: ${text}`, { retryable: true, billed: false });
	if (arrived === 'chat') return new ModelFailure(`The model pipeline stopped responding: ${text}`, { retryable: true, billed: true });
	return new ModelFailure(`The model provider failed: ${text}`, { retryable: !PROVIDER_BUSY.test(text), billed: true });
}

function missingKey(row: ProviderRow): ModelFailure {
	return new ModelFailure(`${row.variable} is not set in Variables.`, { retryable: false, billed: false, key: { state: 'missing', provider: row.title, variable: row.variable } });
}

/** A failed turn's error, read as the session's policy needs it; `tokens` is what the provider billed before it failed. */
function failureOfError(error: AnswerError, row: ProviderRow, tokens: Tokens | undefined): ModelFailure {
	// step: invalid_request means our own turn broke a rule, so asking again repeats it
	const failure = error.code === 'invalid_request' ? new ModelFailure(`The engine refused the agent's turn: ${error.message}`, { retryable: false, billed: false }) : failureOfText(error.message, row, 'answer');
	return billedWith(failure, tokens);
}

/** A failure with what the provider billed for it, when the engine reported that. */
function billedWith(failure: ModelFailure, tokens: Tokens | undefined): ModelFailure {
	return tokens ? new ModelFailure(failure.message, { retryable: failure.retryable, billed: failure.billed, key: failure.key, tokens }) : failure;
}

/**
 * Reads what a pipeline answered into what the session acts on, or throws the failure it stands
 * for. A turn answers with the model's message, or an error; a node without native tool calling
 * refuses before any provider call. A text answer to a turn comes from an engine that predates
 * turn mode, so that model is asked in text too. The counts are the turn answer's own, or for a
 * text answer the result's `tokens` key, where the response node sums them; every billed failure
 * read here carries them, the `**LLM error**` answer and an empty one included.
 */
function readAnswer(result: PIPELINE_RESULT, asked: ModelRequest['kind'], row: ProviderRow): ModelResponse {
	const entries: unknown = result.answers;
	if (!Array.isArray(entries) || entries.length === 0) throw new ModelFailure('The model returned no answer.', { retryable: false, billed: true });
	const answer = Answer.fromResult(result);
	const tokens = readTokens(answer.tokens ?? result.tokens);
	if (answer.error?.code === 'tools_unsupported') return { kind: 'unsupported' };
	if (answer.error) throw failureOfError(answer.error, row, tokens);
	if (asked === 'turn' && answer.message) return { kind: 'turn', message: answer.message, stop: answer.stopReason ?? 'end_turn', ...(tokens ? { tokens } : {}) };
	const text = answer.getText();
	if (text.startsWith(LLM_ERROR_PREFIX)) throw billedWith(failureOfText(text.slice(LLM_ERROR_PREFIX.length), row, 'answer'), tokens);
	if (asked === 'turn') return { kind: 'unsupported' };
	if (text.trim() === '') throw billedWith(new ModelFailure('The model returned no answer.', { retryable: false, billed: true }), tokens);
	return { kind: 'text', text, ...(tokens ? { tokens } : {}) };
}

// =============================================================================
// THE MODEL
// =============================================================================

/**
 * Builds the client's Question. A turn sets cachePrefix, which the engine's turn-mode cache reads
 * too (chat.py), and checks the turn rules here, so a broken turn never reaches a pipe.
 */
function toRocketRideQuestion(request: ModelRequest): Question {
	if (request.kind === 'turn') {
		const question = new Question({ cachePrefix: true, role: request.system.role });
		for (const { title, text } of request.system.instructions) question.addInstruction(title, text);
		question.messages = [...request.messages];
		question.tools = [...request.tools];
		question.checkTurn();
		return question;
	}
	const q = request.spec;
	const question = new Question({ expectJson: q.expectJson, cachePrefix: q.cachePrefix, role: q.role });
	for (const { title, text } of q.instructions) question.addInstruction(title, text);
	for (const turn of q.history) question.addHistory({ role: turn.role, content: turn.content });
	for (const goal of q.goals) question.addGoal(goal);
	for (const item of q.context) question.addContext(item);
	question.addQuestion(q.question);
	return question;
}

/**
 * Opens a model for one turn. Sync, no I/O: nothing starts until the first send.
 *
 * @param conversationId - Scopes the task behind the model.
 */
export function openChatModel(choice: ModelChoice, conversationId: string, client: ClientGetter): ChatModel {
	const row = PROVIDERS[choice.provider];
	const pipeline = modelPipeline(choice, row, conversationId);
	// step: the names are read once a turn, and the engine's own error covers a change during it
	let names: Promise<readonly string[] | null> | undefined;
	return {
		name: choice.model,
		send: async (request, o) => {
			if (request.kind === 'turn' && textOnly.has(pipeline.project_id)) return { kind: 'unsupported' };
			const c = client();
			if (!c) throw new ModelFailure(NOT_CONNECTED_MESSAGE, { retryable: false, billed: false });
			names ??= readKeyNames(c);
			if (keyState(await names, row) === 'missing') throw missingKey(row);
			let token: string;
			try {
				token = await (o?.fresh ? tasks.restart(c, pipeline) : tasks.token(c, pipeline));
			} catch (error) {
				throw failureOfText(messageOf(error), row, 'start');
			}
			let question: Question;
			try {
				question = toRocketRideQuestion(request);
			} catch (error) {
				throw new ModelFailure(`The agent broke a turn rule: ${messageOf(error)}`, { retryable: false, billed: false });
			}
			let result: PIPELINE_RESULT;
			try {
				result = await c.chat({ token, question });
			} catch (error) {
				throw failureOfText(messageOf(error), row, 'chat');
			}
			const response = readAnswer(result, request.kind, row);
			if (response.kind === 'unsupported' && !textOnly.has(pipeline.project_id)) {
				textOnly.add(pipeline.project_id);
				console.log(`[agent] ${choice.model} has no native tool calling; asking in text`);
			}
			return response;
		},
	};
}

// =============================================================================
// THE OFFERS
// =============================================================================

/**
 * Everything the picker shows. Key states are read fresh every call.
 *
 * @returns One offer per provider.
 */
export async function readModelOffers(client: ClientGetter): Promise<ProviderOffer[]> {
	const c = client();
	if (!c) return [];
	const names = await readKeyNames(c);
	return PROVIDER_IDS.map((provider) => {
		const row = PROVIDERS[provider];
		return { provider, title: row.title, key: keyState(names, row), models: row.models };
	});
}
