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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * node:test suite for the IDE convert-on-open decision (plan §5.6.8, B20):
 * which nodes trigger, once per document revision, no retry after errors or
 * on the editor's own output, the disconnected gear, and the banner model.
 * The fixture is the old-shape `simple-chat-rag.pipe` as it stood on
 * `develop` before the format switch, against a catalog that mirrors the
 * server converter's chunker-style fixture (`test_task_convert.py`). Run via
 * `./builder shared:test`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONNECT_TO_CONVERT, INITIAL_CONVERT_STATE, applyConvertResult, conversionBanner, currentBanner, documentSig, gearMessages, markAttempted, shouldConvert, unknownConfigKeyNodes } from './convertOnOpen';
import type { IConvertOutcome } from './convertOnOpen';

// =============================================================================
// Fixtures — develop's simple-chat-rag.pipe and the schemas it meets today
// =============================================================================

/** `docs/agents/skills/rocketride-designing-pipelines/examples/simple-chat-rag.pipe` on develop. */
const OLD_PIPE = {
	components: [
		{ id: 'chat_1', provider: 'chat', config: { hideForm: true, mode: 'Source', parameters: {}, type: 'chat' } },
		{ id: 'embedding_1', provider: 'embedding_transformer', config: { profile: 'miniAll', parameters: {} }, input: [{ lane: 'questions', from: 'chat_1' }] },
		{ id: 'qdrant_1', provider: 'qdrant', config: { profile: 'local', local: { collection: 'docs' }, parameters: {} }, input: [{ lane: 'questions', from: 'embedding_1' }] },
		{ id: 'llm_1', provider: 'llm_openai', config: { profile: 'openai-4o', 'openai-4o': { apikey: '${ROCKETRIDE_OPENAI_KEY}' }, parameters: {} }, input: [{ lane: 'questions', from: 'qdrant_1' }] },
		{ id: 'response_1', provider: 'response_answers', config: { laneName: 'answers' }, input: [{ lane: 'answers', from: 'llm_1' }] },
	],
	project_id: 'a7f3c2e1-9b4d-4a8e-b1c5-7d6e9f2a8b3c',
	viewport: { x: 0, y: 0, zoom: 1 },
	version: 1,
	docRevision: 3,
};

/** The new-format catalog: selectors with branches, hoisted leaves, constants. */
const CATALOG = {
	chat: {
		properties: [
			{ name: 'hideForm', path: 'hideForm', type: 'boolean', default: false },
			{ name: 'mode', path: 'mode', type: 'constant', default: 'Source' },
			{ name: 'type', path: 'type', type: 'constant', default: 'chat' },
		],
	},
	embedding_transformer: {
		properties: [
			{
				name: 'model',
				path: 'model',
				type: 'string',
				default: 'miniAll',
				enum: {
					miniAll: { properties: [{ name: 'device', path: 'miniAll.device', type: 'string', default: 'cpu' }] },
					mpnet: { properties: [{ name: 'device', path: 'mpnet.device', type: 'string', default: 'cpu' }] },
				},
			},
		],
	},
	qdrant: {
		properties: [
			{
				name: 'profile',
				path: 'profile',
				type: 'string',
				default: 'local',
				enum: {
					local: { properties: [{ name: 'collection', path: 'local.collection', type: 'string', default: 'default' }] },
					cloud: { properties: [{ name: 'apikey', path: 'cloud.apikey', type: 'string', secret: true }] },
				},
			},
		],
	},
	llm_openai: {
		properties: [
			{ name: 'apikey', path: 'apikey', type: 'string', secret: true },
			{
				name: 'model',
				path: 'model',
				type: 'string',
				default: 'gpt-4o',
				enum: {
					'gpt-4o': { properties: [] },
					custom: { properties: [{ name: 'customModel', path: 'custom.customModel', type: 'string' }] },
				},
			},
		],
	},
	response_answers: {
		properties: [{ name: 'laneName', path: 'laneName', type: 'string', default: 'answers' }],
	},
};

/** The same pipe after the server converted it (what `rrext_convert` returns). */
const NEW_PIPE = {
	...OLD_PIPE,
	name: 'a7f3c2e1-9b4d-4a8e-b1c5-7d6e9f2a8b3c',
	components: [
		{ id: 'chat_1', provider: 'chat', name: 'Chat', config: { hideForm: true, mode: 'Source', type: 'chat' } },
		{ id: 'embedding_1', provider: 'embedding_transformer', name: 'Embedding', config: {}, input: [{ lane: 'questions', from: 'chat_1' }] },
		{ id: 'qdrant_1', provider: 'qdrant', name: 'Qdrant', config: { local: { collection: 'docs' } }, input: [{ lane: 'questions', from: 'embedding_1' }] },
		{ id: 'llm_1', provider: 'llm_openai', name: 'OpenAI', config: { apikey: '${ROCKETRIDE_OPENAI_KEY}' }, input: [{ lane: 'questions', from: 'qdrant_1' }] },
		{ id: 'response_1', provider: 'response_answers', name: 'Answers', config: { laneName: 'answers' }, input: [{ lane: 'answers', from: 'llm_1' }] },
	],
};

const CLEAN_REPLY: IConvertOutcome = {
	pipeline: NEW_PIPE,
	warnings: [
		{ message: "the pipeline had no name; named it 'a7f3c2e1-9b4d-4a8e-b1c5-7d6e9f2a8b3c'" },
		{ id: 'chat_1', message: "the component had no name; named it 'Chat'" },
	],
	errors: [],
	touched: true,
};

/** A reply where the LLM node was refused and kept its old config. */
const PARTIAL_REPLY: IConvertOutcome = {
	pipeline: { ...NEW_PIPE, components: NEW_PIPE.components.map((c) => (c.id === 'llm_1' ? OLD_PIPE.components[3] : c)) },
	warnings: [{ id: 'chat_1', message: "the component had no name; named it 'Chat'" }],
	errors: [{ id: 'llm_1', message: "unknown config key 'openai-4o' (candidates: model, apikey)" }],
	touched: true,
};

// =============================================================================
// Which nodes trigger
// =============================================================================

test('the old-shape nodes trigger; a current-format node does not', () => {
	assert.deepEqual(unknownConfigKeyNodes(OLD_PIPE.components, CATALOG), ['chat_1', 'embedding_1', 'qdrant_1', 'llm_1']);
});

test('the converted pipe triggers nothing', () => {
	assert.deepEqual(unknownConfigKeyNodes(NEW_PIPE.components, CATALOG), []);
});

test('a node whose full definition has not landed is not counted', () => {
	const summaryOnly = { ...CATALOG, qdrant: { title: 'Qdrant' } };
	assert.deepEqual(unknownConfigKeyNodes(OLD_PIPE.components, summaryOnly), ['chat_1', 'embedding_1', 'llm_1']);
});

test('a reachable-leaf problem alone (a missing secret) is not a trigger', () => {
	const nodes = [{ id: 'llm_1', provider: 'llm_openai', config: {} }];
	assert.deepEqual(unknownConfigKeyNodes(nodes, CATALOG), []);
});

// =============================================================================
// Once per revision
// =============================================================================

test('the signature follows the name, components and parameters only', () => {
	const a = documentSig(OLD_PIPE);
	assert.equal(documentSig({ ...OLD_PIPE, viewport: { x: 9, y: 9, zoom: 2 }, docRevision: 99 }), a);
	assert.notEqual(documentSig({ ...OLD_PIPE, name: 'renamed' }), a);
	assert.notEqual(documentSig({ ...OLD_PIPE, parameters: { apikey: 'llm_1.apikey' } }), a);
	assert.notEqual(documentSig(NEW_PIPE), a);
});

test('a parameters edit during the pending call drops the reply and the next run sends the current text', () => {
	// The editor keeps the sent signature and compares it to the document as
	// it stands when the reply lands; the API Params page writes `parameters`
	// through the document, so that edit must read as a new text or the
	// stale reply would restore the old map.
	const sentSig = documentSig(OLD_PIPE);
	const pending = markAttempted(INITIAL_CONVERT_STATE, sentSig);
	const edited = { ...OLD_PIPE, parameters: { apikey: 'llm_1.apikey' }, docRevision: 4 };
	assert.notEqual(documentSig(edited), sentSig);
	// The next effect run sees the current text as unsent and asks again
	assert.equal(shouldConvert(pending, documentSig(edited), 4, true), true);
	// ...and the reply for THAT text carries the edited map forward
	const applied = applyConvertResult(markAttempted(pending, documentSig(edited)), edited, { ...CLEAN_REPLY, pipeline: { ...NEW_PIPE, parameters: edited.parameters } });
	assert.deepEqual(applied.nextProject?.parameters, edited.parameters);
	assert.equal(applied.nextProject?.docRevision, 5);
});

test('a flagged document on a connected host converts once', () => {
	const sig = documentSig(OLD_PIPE);
	assert.equal(shouldConvert(INITIAL_CONVERT_STATE, sig, 4, true), true);
	const pending = markAttempted(INITIAL_CONVERT_STATE, sig);
	assert.equal(shouldConvert(pending, sig, 4, true), false);
});

test('no flagged node, or no connection, never converts', () => {
	const sig = documentSig(OLD_PIPE);
	assert.equal(shouldConvert(INITIAL_CONVERT_STATE, sig, 0, true), false);
	assert.equal(shouldConvert(INITIAL_CONVERT_STATE, sig, 4, false), false);
});

test('a clean reply writes the converted text with the revision bumped and is not sent back', () => {
	const sig = documentSig(OLD_PIPE);
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, sig), OLD_PIPE, CLEAN_REPLY);
	assert.ok(applied.nextProject);
	assert.equal(applied.nextProject.docRevision, 4);
	assert.deepEqual(applied.nextProject.components, NEW_PIPE.components);
	// Editor-only fields the server echoed survive
	assert.deepEqual(applied.nextProject.viewport, OLD_PIPE.viewport);
	assert.deepEqual(applied.nodeErrors, {});
	// The written text never goes back, even if a node were still flagged
	assert.equal(shouldConvert(applied.state, documentSig(applied.nextProject), 1, true), false);
	// The author's next edit is a new text and converts again
	assert.equal(shouldConvert(applied.state, documentSig({ ...applied.nextProject, name: 'edited' }), 1, true), true);
});

test('a reply with errors is written for the nodes that converted and not retried until the text changes', () => {
	const sig = documentSig(OLD_PIPE);
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, sig), OLD_PIPE, PARTIAL_REPLY);
	assert.ok(applied.nextProject);
	assert.deepEqual(applied.nodeErrors, { llm_1: "unknown config key 'openai-4o' (candidates: model, apikey)" });
	// The refused node is still flagged on the written text: no second call
	assert.equal(shouldConvert(applied.state, documentSig(applied.nextProject), 1, true), false);
	assert.equal(shouldConvert(applied.state, sig, 1, true), false);
	// A fix by hand is a new text and converts again
	assert.equal(shouldConvert(applied.state, documentSig({ ...applied.nextProject, name: 'fixed' }), 1, true), true);
});

test('an untouched reply writes nothing and is not retried', () => {
	const sig = documentSig(OLD_PIPE);
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, sig), OLD_PIPE, { pipeline: OLD_PIPE, warnings: [], errors: [], touched: false });
	assert.equal(applied.nextProject, null);
	assert.equal(applied.banner, null);
	assert.equal(applied.state.writtenSig, null);
	assert.equal(shouldConvert(applied.state, sig, 4, true), false);
});

test('two refusals on one node read as one message', () => {
	const reply: IConvertOutcome = { pipeline: OLD_PIPE, warnings: [], errors: [{ id: 'llm_1', message: 'a' }, { id: 'llm_1', message: 'b' }, { message: 'pipeline-level' }], touched: false };
	assert.deepEqual(applyConvertResult(INITIAL_CONVERT_STATE, OLD_PIPE, reply).nodeErrors, { llm_1: 'a; b' });
});

// =============================================================================
// The banner
// =============================================================================

test('a clean conversion shows a warning banner listing the notes', () => {
	const banner = conversionBanner(CLEAN_REPLY, documentSig(NEW_PIPE));
	assert.ok(banner);
	assert.equal(banner.variant, 'warning');
	assert.match(banner.title, /converted to the current config format/);
	assert.deepEqual(banner.items, ["the pipeline had no name; named it 'a7f3c2e1-9b4d-4a8e-b1c5-7d6e9f2a8b3c'", "chat_1: the component had no name; named it 'Chat'"]);
});

test('a refusal shows an error banner, errors first, counting nodes not messages', () => {
	const banner = conversionBanner({ ...PARTIAL_REPLY, errors: [...PARTIAL_REPLY.errors, { id: 'llm_1', message: 'second' }] }, documentSig(PARTIAL_REPLY.pipeline));
	assert.ok(banner);
	assert.equal(banner.variant, 'error');
	assert.match(banner.title, /^1 node could not be converted to the current config format; the others were\./);
	assert.equal(banner.items[0], "llm_1: unknown config key 'openai-4o' (candidates: model, apikey)");
	assert.equal(banner.items.at(-1), "chat_1: the component had no name; named it 'Chat'");
});

test('a refusal with nothing converted says so', () => {
	const banner = conversionBanner({ ...PARTIAL_REPLY, touched: false, warnings: [] }, documentSig(OLD_PIPE));
	assert.ok(banner);
	assert.match(banner.title, /^1 node could not be converted to the current config format\. Fix/);
});

test('nothing changed and nothing refused is no banner', () => {
	assert.equal(conversionBanner({ pipeline: NEW_PIPE, warnings: [], errors: [], touched: false }, documentSig(NEW_PIPE)), null);
});

test('a refusal banner is keyed to the text it answered and retires when the text moves on', () => {
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, documentSig(OLD_PIPE)), OLD_PIPE, PARTIAL_REPLY);
	assert.ok(applied.banner && applied.nextProject);
	assert.equal(applied.banner.variant, 'error');
	// It describes the written text, which is what the canvas now holds
	const written = documentSig(applied.nextProject);
	assert.equal(applied.banner.forSig, written);
	assert.equal(currentBanner(applied.banner, written), applied.banner);
	// The author repairs the refused node by hand: no unknown keys remain, no
	// conversion will replace the banner, so the text change retires it
	const repaired = { ...applied.nextProject, components: NEW_PIPE.components };
	assert.equal(currentBanner(applied.banner, documentSig(repaired)), null);
});

test('a refusal with nothing written is keyed to the text that was sent', () => {
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, documentSig(OLD_PIPE)), OLD_PIPE, { ...PARTIAL_REPLY, pipeline: OLD_PIPE, touched: false, warnings: [] });
	assert.equal(applied.nextProject, null);
	assert.equal(applied.banner?.forSig, documentSig(OLD_PIPE));
	assert.equal(currentBanner(applied.banner, documentSig(OLD_PIPE)), applied.banner);
	assert.equal(currentBanner(applied.banner, documentSig(NEW_PIPE)), null);
});

test('a warning banner for an applied conversion outlives later edits (the save retires it)', () => {
	const applied = applyConvertResult(markAttempted(INITIAL_CONVERT_STATE, documentSig(OLD_PIPE)), OLD_PIPE, CLEAN_REPLY);
	assert.ok(applied.banner && applied.nextProject);
	assert.equal(applied.banner.forSig, documentSig(applied.nextProject));
	assert.equal(currentBanner(applied.banner, documentSig({ ...applied.nextProject, name: 'edited after' })), applied.banner);
	assert.equal(currentBanner(null, documentSig(NEW_PIPE)), null);
});

// =============================================================================
// The red gear
// =============================================================================

test('disconnected, every flagged node reads connect to convert', () => {
	assert.deepEqual(gearMessages(['chat_1', 'llm_1'], false, { llm_1: 'refused' }), { chat_1: CONNECT_TO_CONVERT, llm_1: CONNECT_TO_CONVERT });
});

test('connected, a refused node carries the converter message and the rest nothing', () => {
	assert.deepEqual(gearMessages(['chat_1', 'llm_1'], true, { llm_1: 'refused', gone_1: 'stale' }), { llm_1: 'refused' });
});
