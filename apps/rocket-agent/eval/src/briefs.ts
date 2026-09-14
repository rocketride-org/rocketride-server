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
 * The golden-brief registry (Phase 5, Task 5.1a) — 15 build briefs (B01-B15)
 * + 3 debug briefs (D01-D03) = 18, normative and verbatim from
 * `.superpowers/sdd/plan-phase-5/task-5.1a-brief.md`. Prompts are the
 * literal text sent to the rr-builder session; do not paraphrase.
 *
 * Pass = engine `validate_pipeline` OK AND all `structural` checks pass AND
 * node count falls in `nodeCount`. Every brief also carries the "Universal
 * structural checks applied to every brief" set (see `UNIVERSAL_CHECKS`
 * below), unioned in per-brief.
 *
 * Consumed by: 5.1b runner, 5.1c CI gate, 5.2d playbook (regression gate).
 */

import type { EvalBrief } from './types';

/**
 * Universal structural checks applied to every brief (each is a
 * COMMON_MISTAKES regression case): project_id GUID (Mistake 3) · file
 * extension `.pipe` (Mistake 4) · source reference valid (Mistake 8) ·
 * source config shape (Mistake 5) · non-source inputs wired (Mistake 16) ·
 * acyclic (Mistake 17) · no orphans (Mistake 18) · `${ROCKETRIDE_*}` env
 * vars only (Mistake 11) · lane-type compatibility (Mistake 13) · ui
 * position present / not all `0,0` (component-reference layout rule).
 */
export const UNIVERSAL_CHECKS: string[] = [
	'project-id-guid',
	'pipe-extension',
	'source-reference-valid',
	'source-config-shape',
	'inputs-wired',
	'acyclic',
	'no-orphans',
	'env-key-substitution',
	'lane-type-compatibility',
	'ui-position-present',
];

/** Unions the universal checks with a brief's own specific checks, de-duplicated, order preserved. */
function withUniversal(specific: string[]): string[] {
	return [...new Set([...UNIVERSAL_CHECKS, ...specific])];
}

export const BRIEFS: EvalBrief[] = [
	{
		id: 'webhook-transform',
		title: 'B01 webhook-transform',
		prompt: 'Build a pipeline that accepts text via webhook, transforms it, and returns the transformed text.',
		expectProviders: ['webhook', 'transform', 'response_text'],
		nodeCount: [3, 4],
		structural: withUniversal(['source-config-shape', 'inputs-wired', 'acyclic']),
		runnable: true,
		pipeCount: 1,
	},
	{
		id: 'simple-chatbot',
		title: 'B02 simple-chatbot',
		prompt: 'Make me a chatbot I can talk to from my app. Use OpenAI.',
		expectProviders: ['chat', 'llm_openai', 'response_answers'],
		forbidProviders: ['webhook'],
		nodeCount: [3, 4],
		structural: withUniversal(['chat-source-for-conversation', 'llm-profile-config', 'env-key-substitution']),
		runnable: true,
		pipeCount: 1,
	},
	{
		id: 'rag-ingest-pdf',
		title: 'B03 rag-ingest-pdf',
		prompt: "Ingest uploaded PDF documents into a searchable knowledge base stored in Qdrant, collection 'kb'.",
		expectProviders: ['webhook', 'parse', 'preprocessor_langchain', 'embedding_transformer|embedding_openai', 'qdrant'],
		nodeCount: [5, 6],
		structural: withUniversal(['embedding-before-store', 'no-response-node', 'inputs-wired']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'rag-query-chat',
		title: 'B04 rag-query-chat',
		prompt: "Chatbot that answers questions using documents already stored in Qdrant collection 'kb' (embedded with the transformer model).",
		expectProviders: ['chat', 'embedding_transformer', 'qdrant', 'llm_*', 'response_answers'],
		nodeCount: [5, 7],
		structural: withUniversal(['same-embedding-for-search', 'store-search-mode-wiring', 'inputs-wired']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'rag-prompt-merge',
		title: 'B05 rag-prompt-merge',
		prompt:
			"RAG chatbot over Qdrant collection 'kb' that must answer ONLY from retrieved context — add explicit instructions merging retrieved documents with the question before the LLM.",
		expectProviders: ['chat', 'embedding_transformer', 'qdrant', 'llm_*', 'response_answers', 'prompt'],
		nodeCount: [6, 8],
		structural: withUniversal(['prompt-merges-documents-and-questions', 'instructions-nonempty']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'doc-summarizer',
		title: 'B06 doc-summarizer',
		prompt: 'Summarize uploaded documents and return the summary as text. Use an Anthropic model for the summarization.',
		expectProviders: ['webhook', 'parse', 'summarization', 'llm_anthropic', 'response_text'],
		nodeCount: [4, 6],
		structural: withUniversal(['control-on-controlled-node', 'inputs-wired']),
		runnable: true,
		pipeCount: 1,
	},
	{
		id: 'pii-redaction',
		title: 'B07 pii-redaction',
		prompt: 'Build a pipeline that removes personally identifiable information from uploaded documents and returns the clean text.',
		expectProviders: ['webhook', 'parse', 'anonymize_text', 'response_text'],
		nodeCount: [4, 5],
		structural: withUniversal(['inputs-wired', 'text-lane-chain']),
		runnable: true,
		pipeCount: 1,
	},
	{
		id: 'structured-extraction',
		title: 'B08 structured-extraction',
		prompt: 'Extract structured invoice fields (vendor, date, total) from uploaded documents and return them as answers.',
		expectProviders: ['webhook', 'parse', 'extract_data', 'llm_*', 'response_answers'],
		nodeCount: [4, 6],
		structural: withUniversal(['control-on-controlled-node', 'inputs-wired']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'ocr-ingest',
		title: 'B09 ocr-ingest',
		prompt: "Make scanned image documents searchable: OCR them and store them in Qdrant collection 'scans'.",
		expectProviders: ['webhook|dropper', 'parse', 'ocr', 'preprocessor_langchain', 'embedding_*', 'qdrant'],
		nodeCount: [6, 7],
		structural: withUniversal(['image-to-text-chain', 'embedding-before-store', 'no-response-node']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'audio-search',
		title: 'B10 audio-search',
		prompt: 'Ingest uploaded audio recordings so their transcripts are searchable in a vector database.',
		expectProviders: ['any-source', 'audio_transcribe', 'preprocessor_langchain', 'embedding_*', 'qdrant|chroma'],
		nodeCount: [5, 7],
		structural: withUniversal(['audio-to-text-chain', 'embedding-before-store']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'video-scene-search',
		title: 'B11 video-scene-search',
		prompt:
			"Two pipelines: (1) ingest dropped video files so scenes are searchable by description; (2) a chat pipeline to query them. Share collection 'scenes'.",
		expectProviders: [
			'dropper',
			'frame_grabber',
			'accessibility_describe',
			'preprocessor_langchain',
			'embedding_openai',
			'qdrant',
			'chat',
			'llm_*',
			'response_answers',
		],
		nodeCount: [10, 13],
		structural: withUniversal(['shared-collection-config', 'same-embedding-both-pipes', 'image-to-text-chain']),
		runnable: false,
		pipeCount: 2,
	},
	{
		id: 'agent-http-tool',
		title: 'B12 agent-http-tool',
		prompt: 'A research-assistant agent I can chat with that can call external web APIs to answer questions.',
		expectProviders: ['chat', 'agent_rocketride', 'response_answers', 'llm_*', 'memory_internal', 'tool_http_request'],
		nodeCount: [6, 7],
		structural: withUniversal(['agent-control-plane', 'agent-config-shape']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'agent-db-charts',
		title: 'B13 agent-db-charts',
		prompt: 'An agent that answers questions from our Postgres database and can render charts of the results.',
		expectProviders: ['chat', 'agent_rocketride', 'response_answers', 'llm_*', 'memory_internal', 'db_postgres', 'tool_chartjs'],
		nodeCount: [7, 9],
		structural: withUniversal(['agent-control-plane', 'db-tool-wiring']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'multi-agent-compare',
		title: 'B14 multi-agent-compare',
		prompt: 'Compare how Wave, CrewAI and LangChain agents answer the same question: fan all three out from one chat input.',
		expectProviders: ['chat', 'agent_rocketride', 'agent_crewai', 'agent_langchain', 'llm_*', 'memory_internal', 'response_answers'],
		nodeCount: [7, 9],
		structural: withUniversal(['single-response-multi-agent', 'no-memory-on-crewai-langchain', 'shared-llm-multi-control']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'hierarchical-agents',
		title: 'B15 hierarchical-agents',
		prompt: 'A coordinator agent that can delegate research subtasks to a second agent working as its tool.',
		expectProviders: ['chat', 'agent_rocketride', 'agent_rocketride', 'llm_*', 'llm_*', 'memory_internal', 'memory_internal', 'response_answers'],
		nodeCount: [8, 10],
		structural: withUniversal(['hierarchical-control-chain', 'each-agent-own-memory']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'fix-missing-embedding',
		title: 'D01 fix-missing-embedding',
		prompt: 'This ingestion pipeline fails validation — figure out why and fix it.',
		seedPipe: 'no-embedding.pipe',
		expectProviders: ['webhook', 'parse', 'preprocessor_langchain', 'embedding_*', 'qdrant'],
		nodeCount: [5, 6],
		structural: withUniversal(['embedding-before-store']),
		runnable: false,
		pipeCount: 1,
		minValidateCalls: 2,
	},
	{
		id: 'fix-response-key-mismatch',
		title: 'D02 fix-response-key-mismatch',
		prompt: "My client code reads response.answers and gets undefined. Fix the pipeline so the default key works.",
		seedPipe: 'lane-mismatch.pipe',
		expectProviders: ['chat', 'llm_*', 'response_answers'],
		nodeCount: [3, 3],
		structural: withUniversal(['response-key-default', 'diff-scope-limited']),
		runnable: false,
		pipeCount: 1,
	},
	{
		id: 'fix-orphan-and-missing-input',
		title: 'D03 fix-orphan-and-missing-input',
		prompt: 'Validation rejects this pipeline. Repair it.',
		seedPipe: 'orphan.pipe',
		expectProviders: ['chat', 'llm_*', 'response_answers'],
		nodeCount: [3, 4],
		structural: withUniversal(['inputs-wired', 'no-orphans', 'acyclic']),
		runnable: false,
		pipeCount: 1,
	},
];
