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
// TEST-UI — Pipeline Definitions
// =============================================================================
//
// Factory functions that produce real pipeline objects for stress testing.
// Each call generates a unique project_id to avoid server-side collisions
// during concurrent runs.
//
// Pipeline structure:
//   { components: [...], source: '<source node id>', project_id: '<unique>' }
//
// Node wiring:
//   source (webhook/chat) -> processing nodes -> response
//   Each node's `input` array declares which lane it reads from which node.
// =============================================================================

// =============================================================================
// HELPERS
// =============================================================================

/** Generate a unique project ID with an identifying prefix. */
function uid(prefix: string): string {
	return `__test_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
}

// =============================================================================
// PIPELINE FACTORIES
// =============================================================================

/**
 * Echo pipeline: webhook -> response.
 * Simplest possible pipeline — data goes in and comes straight back out.
 * Workhorse for raw throughput and concurrent send stress tests.
 */
export function getEchoPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				name: 'Test webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('echo'),
	};
}

/**
 * Chain pipeline: webhook -> preprocessor_code -> response.
 * Adds a processing node so the server does real work per request.
 * Good for CPU stress and verifying single-stage processing.
 */
export function getChainPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				name: 'Test webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'preproc_1',
				provider: 'preprocessor_code',
				name: 'Pass-through',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'preproc_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('chain'),
	};
}

/**
 * Fan-out pipeline: webhook -> 3x preprocessor_code (parallel) -> response.
 * All three processing nodes read from the same source, testing parallel
 * lane processing inside the engine.
 */
export function getFanOutPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				name: 'Test webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'preproc_1',
				provider: 'preprocessor_code',
				name: 'Fan-out A',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'preproc_2',
				provider: 'preprocessor_code',
				name: 'Fan-out B',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'preproc_3',
				provider: 'preprocessor_code',
				name: 'Fan-out C',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [
					{ lane: 'text', from: 'preproc_1' },
					{ lane: 'text', from: 'preproc_2' },
					{ lane: 'text', from: 'preproc_3' },
				],
			},
		],
		source: 'webhook_1',
		project_id: uid('fanout'),
	};
}

/**
 * Deep pipeline: webhook -> preproc -> preproc -> preproc -> preproc -> response.
 * Long chain (4 stages) that tests deep pipeline execution and event
 * propagation through many nodes.
 */
export function getDeepPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				name: 'Test webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'preproc_1',
				provider: 'preprocessor_code',
				name: 'Stage 1',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'preproc_2',
				provider: 'preprocessor_code',
				name: 'Stage 2',
				config: {},
				input: [{ lane: 'text', from: 'preproc_1' }],
			},
			{
				id: 'preproc_3',
				provider: 'preprocessor_code',
				name: 'Stage 3',
				config: {},
				input: [{ lane: 'text', from: 'preproc_2' }],
			},
			{
				id: 'preproc_4',
				provider: 'preprocessor_code',
				name: 'Stage 4',
				config: {},
				input: [{ lane: 'text', from: 'preproc_3' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'preproc_4' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('deep'),
	};
}

/**
 * Tool pipeline: webhook -> tool_python -> response.
 * For testing client.tool() and pipe.tool() invocations against
 * the Python tool runtime.
 */
export function getToolPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				name: 'Test webhook',
				config: { hideForm: true, mode: 'Source', type: 'webhook' },
			},
			{
				id: 'tool_python_1',
				provider: 'tool_python',
				name: 'Python tool',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('tool'),
	};
}

/**
 * Chat pipeline: chat -> response.
 * Minimal chat source pipeline for client.chat() tests.
 * No LLM required — just tests the chat source path through the engine.
 */
export function getChatPipeline() {
	return {
		components: [
			{
				id: 'chat_1',
				provider: 'chat',
				name: 'Test chat',
				config: { hideForm: true, mode: 'Source', type: 'chat' },
			},
			{
				id: 'response_1',
				provider: 'response',
				config: { lanes: [] },
				input: [{ lane: 'questions', from: 'chat_1' }],
			},
		],
		source: 'chat_1',
		project_id: uid('chat'),
	};
}

// =============================================================================
// BENCHMARK PIPELINES — Real workloads from benchmark-ui
// =============================================================================

/**
 * Embedding pipeline: webhook -> preprocessor_langchain -> embedding_transformer -> response.
 * Exercises CPU (langchain chunking) and GPU (SentenceTransformer MiniLM).
 * Data: send batched text chunks, each ~100 words.
 */
export function getEmbeddingPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { mode: 'Source', type: 'webhook', parameters: {} },
			},
			{
				id: 'preprocessor_1',
				provider: 'preprocessor_langchain',
				name: 'Langchain chunker',
				config: { profile: 'default' },
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'embedding_1',
				provider: 'embedding_transformer',
				name: 'Embedder',
				config: {},
				input: [{ lane: 'documents', from: 'preprocessor_1' }],
			},
			{
				id: 'response_1',
				provider: 'response_documents',
				config: { laneName: 'documents' },
				input: [{ lane: 'documents', from: 'embedding_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('embed'),
	};
}

/**
 * NER pipeline: webhook -> ner -> response.
 * GPU-heavy — GLiNER entity extraction on text.
 * Data: send individual text chunks (~150 words each).
 */
export function getNerPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { mode: 'Source', type: 'webhook', parameters: {} },
			},
			{
				id: 'ner_1',
				provider: 'ner',
				name: 'Entity extraction',
				config: {},
				input: [{ lane: 'text', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response_text',
				config: { laneName: 'text' },
				input: [{ lane: 'text', from: 'ner_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('ner'),
	};
}

/**
 * CPU-only pipeline: webhook -> parse -> response.
 * No GPU nodes — pure CPU workload (Tika text parsing).
 * Data: send text chunks (~200 words).
 */
export function getCpuOnlyPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { mode: 'Source', type: 'webhook', parameters: {} },
			},
			{
				id: 'parse_1',
				provider: 'parse',
				name: 'Tika parser',
				config: {},
				input: [{ lane: 'tags', from: 'webhook_1' }],
			},
			{
				id: 'response_1',
				provider: 'response_text',
				config: { laneName: 'text' },
				input: [{ lane: 'text', from: 'parse_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('cpuonly'),
	};
}

/**
 * Full document pipeline: webhook -> parse -> ocr -> preprocessor -> embedding -> response.
 * Most complex pipeline — exercises every processing stage.
 * Data: send PDFs or text (Tika parses files, OCR reads scanned images).
 */
export function getFullDocumentPipeline() {
	return {
		components: [
			{
				id: 'webhook_1',
				provider: 'webhook',
				config: { mode: 'Source', type: 'webhook', parameters: {} },
			},
			{
				id: 'parse_1',
				provider: 'parse',
				name: 'Tika parser',
				config: {},
				input: [{ lane: 'tags', from: 'webhook_1' }],
			},
			{
				id: 'ocr_1',
				provider: 'ocr',
				name: 'OCR',
				config: {},
				input: [{ lane: 'image', from: 'parse_1' }],
			},
			{
				id: 'preprocessor_1',
				provider: 'preprocessor_langchain',
				name: 'Langchain chunker',
				config: { profile: 'default' },
				input: [
					{ lane: 'text', from: 'parse_1' },
					{ lane: 'text', from: 'ocr_1' },
				],
			},
			{
				id: 'embedding_1',
				provider: 'embedding_transformer',
				name: 'Embedder',
				config: {},
				input: [{ lane: 'documents', from: 'preprocessor_1' }],
			},
			{
				id: 'response_1',
				provider: 'response_documents',
				config: { laneName: 'documents' },
				input: [{ lane: 'documents', from: 'embedding_1' }],
			},
		],
		source: 'webhook_1',
		project_id: uid('fulldoc'),
	};
}

// =============================================================================
// STRESS PIPELINE SELECTOR
// =============================================================================

/**
 * Stress pipeline selector — returns a different pipeline variant based on
 * the index so concurrent stress tests exercise a mix of pipeline complexities.
 *
 * Includes both simple test pipelines and real benchmark workloads.
 * Chat pipeline excluded — requires an LLM to process questions.
 *
 * @param variant - Pipeline slot index; cycled through all variants.
 */
export function getStressPipeline(variant: number) {
	const factories = [
		// Simple test pipelines (fast, no GPU needed)
		getEchoPipeline,
		getChainPipeline,
		getFanOutPipeline,
		getDeepPipeline,
		getToolPipeline,
		// Real benchmark workloads (exercise CPU + GPU processing)
		getEmbeddingPipeline,
		getNerPipeline,
		getCpuOnlyPipeline,
		getFullDocumentPipeline,
	];
	return factories[variant % factories.length]();
}
