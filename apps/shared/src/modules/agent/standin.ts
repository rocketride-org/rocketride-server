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
// STAND-IN — the model pipeline the agent starts for itself (spec §11)
// =============================================================================

// TEMPORARY (spec §11): delete when Rod's wiring lands

/**
 * Until Rod's backend lands, a run asks its model questions on a small
 * pipeline it starts itself: a webhook source, an Anthropic model, and the
 * answers lane. The model's key is never in the code: the pipeline names the
 * `${ROCKETRIDE_ANTHROPIC_KEY}` placeholder, and the engine fills it from the
 * tester's Variables.
 *
 * Each conversation gets its own pipeline: the engine names a running task by
 * its owner, project and source, so two conversations sharing one pipeline
 * would fail with "Pipeline is already running" (spec §12).
 */

import type { PipelineConfig } from 'rocketride';

import { requireClient, type ClientGetter } from './toolkits/common';

// =============================================================================
// PIPELINE
// =============================================================================

// TEMPORARY (spec §11): delete when Rod's wiring lands
/** The model profile the stand-in pipeline runs. */
const STANDIN_PROFILE = 'claude-sonnet-5';

// TEMPORARY (spec §11): delete when Rod's wiring lands
/**
 * The stand-in pipeline for one conversation: webhook → Anthropic → answers.
 * The shape follows `nodes/src/nodes/llm_anthropic/example.pipe`, with a
 * webhook source in place of chat.
 *
 * @param projectId - The conversation id, so each conversation has its own pipeline.
 * @returns The pipeline, ready for `client.use`.
 */
function standinPipeline(projectId: string): Record<string, unknown> {
	return {
		project_id: projectId,
		source: 'webhook_1',
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' },
			},
			{
				id: 'llm_anthropic_1',
				provider: 'llm_anthropic',
				config: { profile: STANDIN_PROFILE, [STANDIN_PROFILE]: { apikey: '${ROCKETRIDE_ANTHROPIC_KEY}' }, parameters: {} },
				input: [{ lane: 'questions', from: 'webhook_1' }],
			},
			{
				id: 'response_answers_1',
				provider: 'response_answers',
				config: { laneName: 'answers' },
				input: [{ lane: 'answers', from: 'llm_anthropic_1' }],
			},
		],
	};
}

// =============================================================================
// PIPELINES
// =============================================================================

// TEMPORARY (spec §11): delete when Rod's wiring lands
/** The stand-in pipelines of the open conversations, one each, started on the first question. */
export class StandinPipelines {
	/** The host's client getter. */
	private readonly client: ClientGetter;
	/** The token of each conversation's pipeline, as a promise so two asks at once start one. */
	private readonly tokens = new Map<string, Promise<string>>();

	/**
	 * @param client - The host's client getter.
	 */
	constructor(client: ClientGetter) {
		this.client = client;
	}

	/**
	 * The token of a conversation's pipeline, starting the pipeline on the first ask.
	 *
	 * @param conversationId - The conversation the model calls belong to.
	 * @returns The pipeline token. A failed start is not kept, so the next ask tries again.
	 */
	token(conversationId: string): Promise<string> {
		const cached = this.tokens.get(conversationId);
		if (cached) return cached;
		const started = this.start(conversationId);
		this.tokens.set(conversationId, started);
		started.catch(() => {
			if (this.tokens.get(conversationId) === started) this.tokens.delete(conversationId);
		});
		return started;
	}

	/**
	 * Replaces a conversation's pipeline: ends the old one and starts a new one.
	 * It covers a pipeline that failed or ended after 15 idle minutes.
	 *
	 * @param conversationId - The conversation whose pipeline to replace.
	 * @returns The new pipeline's token.
	 */
	async restart(conversationId: string): Promise<string> {
		const old = this.tokens.get(conversationId);
		this.tokens.delete(conversationId);
		if (old) {
			try {
				await requireClient(this.client).terminate(await old);
			} catch {
				// step: it may already have ended; starting a new one is the fix either way
			}
		}
		return this.token(conversationId);
	}

	/**
	 * Starts the conversation's pipeline.
	 *
	 * @param conversationId - The conversation the pipeline serves.
	 * @returns The pipeline token.
	 */
	private async start(conversationId: string): Promise<string> {
		const started = await requireClient(this.client).use({ pipeline: standinPipeline(conversationId) as unknown as PipelineConfig, useExisting: true });
		if (!started.token) throw new Error('The engine returned no token for the model pipeline.');
		return started.token;
	}
}
