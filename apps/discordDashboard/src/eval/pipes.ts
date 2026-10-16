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
// EVAL PIPES — the four loop pipelines, and the identity each task is keyed on
// =============================================================================
//
// The four `.pipe` documents the eval loop drives, imported the way
// `src/pipeline/resolve.ts` imports the bot's own pipes: a browser bundle cannot
// load a pipeline by `filepath`, so the JSON travels IN the bundle and reaches
// the engine through `client.use({ pipeline })`.
//
// These are NOT the bot's pipes, and the difference matters twice:
//
// 1. They are REQUEST/RESPONSE, not always-on. Each is started with a short
//    `ttl` when a batch begins and terminated when it ends, so nothing keeps an
//    engine task warm between clicks. The bot's pipes run with `ttl: 0`.
// 2. Nothing in them is substituted by the app. The only placeholder they carry
//    is `${ROCKETRIDE_OPENAI_KEY}`, which the SERVER resolves from its saved
//    variables (`resolve_pipeline_env`) — so no secret passes through the
//    browser, and there is no `resolvePipeline` equivalent here.
//
// The one thing the app has to know about each is its IDENTITY: `use`,
// `getTaskToken` and `terminate` address a task by (project id, source
// component), so a batch can attach to a task a previous batch left running
// rather than starting a second one.
// =============================================================================

import type { PipelineConfig } from 'shell';
import graderPipe from '../pipelines/eval-grader.pipe';
import retrievePipe from '../pipelines/eval-retrieve.pipe';
import judgePipe from '../pipelines/eval-judge.pipe';
import kbWritebackPipe from '../pipelines/eval-kb-writeback.pipe';

// =============================================================================
// TYPES
// =============================================================================

/** The eval pipes, by the name the app calls them. */
export type EvalPipeId = 'grader' | 'retrieve' | 'judge' | 'kbWriteback';

/** One eval pipe: the document, and how a task running it is addressed. */
export interface EvalPipe {
	/** The name the app calls it. */
	id: EvalPipeId;
	/** One line for a toast or an error message. */
	label: string;
	/** The parsed `.pipe` document, exactly as it is on disk. */
	pipeline: Record<string, unknown>;
	/** The document's `project_id` — half of the task identity. */
	projectId: string;
	/** The source component data is sent to — the other half. */
	source: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The source component of a pipeline document.
 *
 * The server's own resolution order, minus the explicit-option step: the
 * top-level `source` field when the document names one, otherwise the single
 * component whose `config.mode` is `'Source'`. `pipeIdentity` in
 * `src/pipeline/resolve.ts` does the same thing but falls back to the `discord`
 * component, which none of these pipes has — they are all webhook-sourced.
 *
 * @param raw - A parsed `.pipe` document.
 * @returns The source component's id, or '' when the document declares none.
 */
function sourceOf(raw: Record<string, unknown>): string {
	const declared = typeof raw.source === 'string' ? raw.source : '';
	if (declared.length > 0) return declared;
	const components = (raw.components ?? []) as Record<string, unknown>[];
	const source = components.find((component) => {
		const config = (component.config ?? {}) as Record<string, unknown>;
		return config.mode === 'Source';
	});
	return String(source?.id ?? '');
}

/**
 * Describe one imported pipe.
 *
 * @param id - The name the app calls it.
 * @param label - One line for a message.
 * @param pipeline - The parsed document.
 * @returns The pipe and its task identity.
 */
function describe(id: EvalPipeId, label: string, pipeline: Record<string, unknown>): EvalPipe {
	return {
		id,
		label,
		pipeline,
		projectId: String(pipeline.project_id ?? ''),
		source: sourceOf(pipeline),
	};
}

// =============================================================================
// API
// =============================================================================

/**
 * The eval loop's pipes.
 *
 * `grader` and `retrieve` are the grading stage's; `judge` is the replay stage's;
 * `kbWriteback` belongs to the knowledge-base stage. All four identities live in
 * one place.
 *
 * The replay stage has no pipe of its own any more. It used to carry one — a
 * `tool_discord` node holding a second Discord application, which posted the seeds
 * into the support channel. A replay now asks a private COPY of the bot's own
 * pipeline instead (`src/eval/replayCopy.ts`), which is built in memory from
 * whatever the bot is running and therefore cannot be a file here.
 */
export const EVAL_PIPES: Record<EvalPipeId, EvalPipe> = {
	grader: describe('grader', 'grader', graderPipe),
	retrieve: describe('retrieve', 'retrieval', retrievePipe),
	judge: describe('judge', 'judge', judgePipe),
	kbWriteback: describe('kbWriteback', 'knowledge-base writeback', kbWritebackPipe),
};

/**
 * How long an eval task may sit idle before the engine reclaims it, in seconds.
 *
 * Not `0` (the bot's value, meaning "never"): a grading batch is a burst of
 * sends over a minute or two, and a tab closed mid-batch must not leave an LLM
 * task running. Ten minutes is long enough that the grader and the retrieval
 * pipe survive a slow batch without being restarted between rows.
 */
export const EVAL_TASK_TTL_SECONDS = 600;

/**
 * A pipe's document in the shape `client.use({ pipeline })` wants.
 *
 * A cast, not a conversion: the `.pipe` files are typed `Record<string,
 * unknown>` by the ambient `*.pipe` module declaration, and the SDK's
 * `PipelineConfig` is the same JSON with names on its fields. Nothing is
 * substituted — see the header.
 *
 * @param pipe - One of {@link EVAL_PIPES}.
 * @returns The pipeline to start.
 */
export function evalPipelineOf(pipe: EvalPipe): PipelineConfig {
	return pipe.pipeline as unknown as PipelineConfig;
}
