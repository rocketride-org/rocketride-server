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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BRIEFS, UNIVERSAL_CHECKS } from '../eval/src/briefs';
import { structuralChecks, scorePipe, scoreSuite } from '../eval/src/score';
import type { BriefResult, EvalBrief, Pipe, PipeComponent } from '../eval/src/types';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function mk(id: string, provider: string, opts: Partial<PipeComponent> = {}): PipeComponent {
	return {
		id,
		provider,
		config: {},
		ui: { position: { x: 20, y: 200 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true },
		...opts,
	};
}

function mkPipe(components: PipeComponent[], opts: Partial<Pipe> = {}): Pipe {
	return {
		components,
		project_id: '11111111-1111-4111-8111-111111111111',
		viewport: { x: 0, y: 0, zoom: 1 },
		version: 1,
		source: components[0]?.id,
		...opts,
	};
}

function loadFixture(name: string): Pipe {
	const raw = fs.readFileSync(path.join(__dirname, '..', 'eval', 'fixtures', 'broken', name), 'utf8');
	return JSON.parse(raw) as Pipe;
}

// Any real brief works as the `brief` argument — none of the check functions read it.
const STUB_BRIEF: EvalBrief = BRIEFS[0];

function run(checkName: string, pipes: Pipe[]): string | null {
	const check = structuralChecks[checkName];
	if (!check) throw new Error(`missing structural check "${checkName}"`);
	return check(pipes, STUB_BRIEF);
}

// A minimal always-valid webhook chain, reused as a base and mutated per test.
function webhookChain(): PipeComponent[] {
	return [
		mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
		mk('parse_1', 'parse', { config: {}, input: [{ lane: 'tags', from: 'webhook_1' }] }),
		mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'parse_1' }] }),
	];
}

// ---------------------------------------------------------------------------
// Brief registry sanity
// ---------------------------------------------------------------------------

describe('BRIEFS registry', () => {
	test('has exactly 18 golden briefs (15 build + 3 debug)', () => {
		expect(BRIEFS).toHaveLength(18);
		const buildBriefs = BRIEFS.filter((b) => b.title.startsWith('B'));
		const debugBriefs = BRIEFS.filter((b) => b.title.startsWith('D'));
		expect(buildBriefs).toHaveLength(15);
		expect(debugBriefs).toHaveLength(3);
	});

	test('every brief has a non-empty verbatim prompt, structural checks, and a valid node-count range', () => {
		for (const brief of BRIEFS) {
			expect(brief.prompt.length).toBeGreaterThan(0);
			expect(brief.structural.length).toBeGreaterThan(0);
			expect(brief.nodeCount[0]).toBeLessThanOrEqual(brief.nodeCount[1]);
			expect(brief.pipeCount).toBeGreaterThanOrEqual(1);
			for (const checkName of brief.structural) {
				expect(structuralChecks[checkName]).toBeDefined();
			}
		}
	});

	test('universal checks are present on every brief', () => {
		for (const brief of BRIEFS) {
			for (const universal of UNIVERSAL_CHECKS) {
				expect(brief.structural).toContain(universal);
			}
		}
	});

	test('B02 forbids webhook and B11 spans 2 pipes with node count [10,13]', () => {
		const b02 = BRIEFS.find((b) => b.id === 'simple-chatbot')!;
		expect(b02.forbidProviders).toContain('webhook');
		const b11 = BRIEFS.find((b) => b.id === 'video-scene-search')!;
		expect(b11.pipeCount).toBe(2);
		expect(b11.nodeCount).toEqual([10, 13]);
	});

	test('D01 requires at least 2 validate_pipeline calls', () => {
		const d01 = BRIEFS.find((b) => b.id === 'fix-missing-embedding')!;
		expect(d01.minValidateCalls).toBe(2);
		expect(d01.seedPipe).toBe('no-embedding.pipe');
	});

	test('prompts match the golden-brief table verbatim (spot check)', () => {
		expect(BRIEFS.find((b) => b.id === 'simple-chatbot')!.prompt).toBe('Make me a chatbot I can talk to from my app. Use OpenAI.');
		expect(BRIEFS.find((b) => b.id === 'fix-orphan-and-missing-input')!.prompt).toBe('Validation rejects this pipeline. Repair it.');
	});
});

// ---------------------------------------------------------------------------
// Universal structural checks
// ---------------------------------------------------------------------------

describe('project-id-guid (Mistake 3)', () => {
	test('passes for a literal GUID', () => {
		expect(run('project-id-guid', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails for a ${...} substitution', () => {
		const pipe = mkPipe(webhookChain(), { project_id: '${ROCKETRIDE_PROJECT_ID}' });
		expect(run('project-id-guid', [pipe])).toMatch(/GUID/);
	});
});

describe('pipe-extension (Mistake 4)', () => {
	test('passes when sourceFile ends in .pipe, and when absent', () => {
		expect(run('pipe-extension', [mkPipe(webhookChain(), { sourceFile: 'my_pipeline.pipe' })])).toBeNull();
		expect(run('pipe-extension', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails for a .json sourceFile', () => {
		expect(run('pipe-extension', [mkPipe(webhookChain(), { sourceFile: 'my_pipeline.json' })])).toMatch(/\.pipe/);
	});
});

describe('source-reference-valid (Mistake 8)', () => {
	test('passes when source matches a component id', () => {
		expect(run('source-reference-valid', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails when source references a non-existent id', () => {
		const pipe = mkPipe(webhookChain(), { source: 'webhook_2' });
		expect(run('source-reference-valid', [pipe])).toMatch(/webhook_2/);
	});
});

describe('source-config-shape (Mistake 5)', () => {
	test('passes when source config has hideForm/mode/parameters/type', () => {
		expect(run('source-config-shape', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails for an empty source config', () => {
		const components = [mk('webhook_1', 'webhook', { config: {} }), ...webhookChain().slice(1)];
		expect(run('source-config-shape', [mkPipe(components)])).toMatch(/missing/);
	});
});

describe('inputs-wired (Mistake 16)', () => {
	test('passes when every non-source node has input, and control-invoked nodes are exempt', () => {
		expect(run('inputs-wired', [mkPipe(webhookChain())])).toBeNull();
		const controlled = [
			mk('chat_1', 'chat', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'chat' } }),
			mk('agent_rocketride_1', 'agent_rocketride', { config: {}, input: [{ lane: 'questions', from: 'chat_1' }] }),
			mk('llm_openai_1', 'llm_openai', { config: {}, control: [{ classType: 'llm', from: 'agent_rocketride_1' }] }),
		];
		expect(run('inputs-wired', [mkPipe(controlled)])).toBeNull();
	});
	test('fails when a non-source node has no input array and no control array', () => {
		const components = [mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }), mk('response_answers_1', 'response_answers', { config: {} })];
		expect(run('inputs-wired', [mkPipe(components)])).toMatch(/no input array/);
	});
});

describe('acyclic (Mistake 17)', () => {
	test('passes for a linear chain', () => {
		expect(run('acyclic', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails for a cycle', () => {
		const components = [
			mk('comp_a', 'parse', { config: {}, input: [{ lane: 'text', from: 'comp_b' }] }),
			mk('comp_b', 'parse', { config: {}, input: [{ lane: 'text', from: 'comp_a' }] }),
		];
		expect(run('acyclic', [mkPipe(components, { source: 'comp_a' })])).toMatch(/cycle/);
	});
});

describe('no-orphans (Mistake 18)', () => {
	test('passes when every node is reachable from source', () => {
		expect(run('no-orphans', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails for an unconnected component', () => {
		const components = [...webhookChain(), mk('llm_openai_orphan', 'llm_openai', { config: {} })];
		expect(run('no-orphans', [mkPipe(components)])).toMatch(/orphaned/);
	});
});

describe('env-key-substitution (Mistake 11)', () => {
	test('passes for a ${ROCKETRIDE_*} key', () => {
		const components = [mk('llm_openai_1', 'llm_openai', { config: { profile: 'openai-4o', 'openai-4o': { apikey: '${ROCKETRIDE_OPENAI_KEY}' } } })];
		expect(run('env-key-substitution', [mkPipe(components)])).toBeNull();
	});
	test('fails for a bad-prefix ${OPENAI_KEY}', () => {
		const components = [mk('llm_openai_1', 'llm_openai', { config: { profile: 'openai-4o', 'openai-4o': { apikey: '${OPENAI_KEY}' } } })];
		expect(run('env-key-substitution', [mkPipe(components)])).toMatch(/OPENAI_KEY/);
	});
});

describe('lane-type-compatibility (Mistake 13)', () => {
	test('passes for a matching tags -> text hop', () => {
		expect(run('lane-type-compatibility', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails when a "text" output is wired into a "questions"-only input', () => {
		const components = [
			mk('parse_1', 'parse', { config: {} }),
			mk('llm_openai_1', 'llm_openai', { config: {}, input: [{ lane: 'text', from: 'parse_1' }] }),
		];
		expect(run('lane-type-compatibility', [mkPipe(components, { source: 'parse_1' })])).toMatch(/does not accept lane "text"/);
	});
});

describe('ui-position-present (component-reference layout rule)', () => {
	test('passes when positions are set and not all at {0,0}', () => {
		expect(run('ui-position-present', [mkPipe(webhookChain())])).toBeNull();
	});
	test('fails when every component sits at {0,0}', () => {
		const components = webhookChain().map((c) => ({ ...c, ui: { ...c.ui, position: { x: 0, y: 0 } } }));
		expect(run('ui-position-present', [mkPipe(components)])).toMatch(/0,0/);
	});
	test('fails when ui.position is missing', () => {
		const components = [{ ...webhookChain()[0], ui: undefined }, ...webhookChain().slice(1)];
		expect(run('ui-position-present', [mkPipe(components)])).toMatch(/missing ui.position/);
	});
});

// ---------------------------------------------------------------------------
// Brief-specific structural checks
// ---------------------------------------------------------------------------

describe('chat-source-for-conversation (SDK Mistake 5)', () => {
	const chatSrc = mk('chat_1', 'chat', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'chat' } });
	test('passes for a chat source', () => {
		expect(run('chat-source-for-conversation', [mkPipe([chatSrc])])).toBeNull();
	});
	test('fails when webhook is used for a conversational pipeline', () => {
		const webhookSrc = mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } });
		expect(run('chat-source-for-conversation', [mkPipe([webhookSrc])])).toMatch(/chat/);
	});
});

describe('llm-profile-config (Mistake 14)', () => {
	test('passes for a profile with a ${ROCKETRIDE_*} apikey', () => {
		const components = [mk('llm_openai_1', 'llm_openai', { config: { profile: 'openai-4o', 'openai-4o': { apikey: '${ROCKETRIDE_OPENAI_KEY}' } } })];
		expect(run('llm-profile-config', [mkPipe(components)])).toBeNull();
	});
	test('fails for an empty llm config', () => {
		const components = [mk('llm_openai_1', 'llm_openai', { config: {} })];
		expect(run('llm-profile-config', [mkPipe(components)])).toMatch(/profile/);
	});
});

describe('embedding-before-store', () => {
	test('passes when an embedding_* node feeds the store', () => {
		const components = [
			mk('preprocessor_langchain_1', 'preprocessor_langchain', { config: {} }),
			mk('embedding_transformer_1', 'embedding_transformer', { config: {}, input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }] }),
			mk('qdrant_1', 'qdrant', { config: {}, input: [{ lane: 'documents', from: 'embedding_transformer_1' }] }),
		];
		expect(run('embedding-before-store', [mkPipe(components)])).toBeNull();
	});
	test('fails when the store receives "documents" directly, skipping embedding (D01 bug)', () => {
		const seed = loadFixture('no-embedding.pipe');
		expect(run('embedding-before-store', [seed])).toMatch(/embedding must run before store/);
	});
});

describe('no-response-node', () => {
	test('passes for an ingestion pipeline with no response node', () => {
		const components = [mk('qdrant_1', 'qdrant', { config: {} })];
		expect(run('no-response-node', [mkPipe(components)])).toBeNull();
	});
	test('fails when a response node is present in an ingestion pipeline', () => {
		const components = [mk('qdrant_1', 'qdrant', { config: {} }), mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'qdrant_1' }] })];
		expect(run('no-response-node', [mkPipe(components)])).toMatch(/response node/);
	});
});

describe('same-embedding-for-search', () => {
	test('passes when embedding_* is wired to the questions lane', () => {
		const components = [mk('embedding_transformer_1', 'embedding_transformer', { config: {}, input: [{ lane: 'questions', from: 'chat_1' }] })];
		expect(run('same-embedding-for-search', [mkPipe(components)])).toBeNull();
	});
	test('fails when no embedding is wired for search', () => {
		expect(run('same-embedding-for-search', [mkPipe([mk('qdrant_1', 'qdrant', { config: {} })])])).toMatch(/questions/);
	});
});

describe('store-search-mode-wiring', () => {
	test('passes when the store has a "questions" input', () => {
		const components = [mk('qdrant_1', 'qdrant', { config: {}, input: [{ lane: 'questions', from: 'embedding_transformer_1' }] })];
		expect(run('store-search-mode-wiring', [mkPipe(components)])).toBeNull();
	});
	test('fails when the store only has a "documents" input (ingest-only wiring)', () => {
		const components = [mk('qdrant_1', 'qdrant', { config: {}, input: [{ lane: 'documents', from: 'embedding_transformer_1' }] })];
		expect(run('store-search-mode-wiring', [mkPipe(components)])).toMatch(/search mode/);
	});
});

describe('prompt-merges-documents-and-questions', () => {
	function base(promptInput: PipeComponent['input']): Pipe {
		const components = [
			mk('prompt_1', 'prompt', { config: { instructions: ['Answer only from context.'] }, input: promptInput }),
			mk('llm_openai_1', 'llm_openai', { config: {}, input: [{ lane: 'questions', from: 'prompt_1' }] }),
		];
		return mkPipe(components, { source: 'qdrant_1' });
	}
	test('passes when prompt collects documents + questions and feeds the LLM', () => {
		expect(run('prompt-merges-documents-and-questions', [base([{ lane: 'documents', from: 'qdrant_1' }, { lane: 'questions', from: 'qdrant_1' }])])).toBeNull();
	});
	test('fails when the prompt is missing the "documents" input', () => {
		expect(run('prompt-merges-documents-and-questions', [base([{ lane: 'questions', from: 'qdrant_1' }])])).toMatch(/documents/);
	});
});

describe('instructions-nonempty', () => {
	test('passes for a non-empty instructions array', () => {
		const components = [mk('prompt_1', 'prompt', { config: { instructions: ['Use context.'] } })];
		expect(run('instructions-nonempty', [mkPipe(components)])).toBeNull();
	});
	test('fails for an empty instructions array', () => {
		const components = [mk('prompt_1', 'prompt', { config: { instructions: [] } })];
		expect(run('instructions-nonempty', [mkPipe(components)])).toMatch(/empty/);
	});
});

describe('control-on-controlled-node', () => {
	test('passes when the llm carries control:[{classType:"llm", from: summarization_id}]', () => {
		const components = [
			mk('summarization_1', 'summarization', { config: {}, input: [{ lane: 'text', from: 'parse_1' }] }),
			mk('llm_anthropic_1', 'llm_anthropic', { config: {}, control: [{ classType: 'llm', from: 'summarization_1' }] }),
		];
		expect(run('control-on-controlled-node', [mkPipe(components, { source: 'parse_1' })])).toBeNull();
	});
	test('fails when control is placed on the invoker instead of the LLM', () => {
		const components = [
			mk('summarization_1', 'summarization', { config: {}, control: [{ classType: 'llm', from: 'llm_anthropic_1' }] }),
			mk('llm_anthropic_1', 'llm_anthropic', { config: {} }),
		];
		expect(run('control-on-controlled-node', [mkPipe(components)])).toMatch(/control belongs on the invoked LLM/);
	});
});

describe('text-lane-chain (B07)', () => {
	test('passes for parse -> anonymize_text -> response_text', () => {
		const components = [
			mk('parse_1', 'parse', { config: {} }),
			mk('anonymize_text_1', 'anonymize_text', { config: {}, input: [{ lane: 'text', from: 'parse_1' }] }),
			mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'anonymize_text_1' }] }),
		];
		expect(run('text-lane-chain', [mkPipe(components)])).toBeNull();
	});
	test('fails when response_text bypasses anonymize_text', () => {
		const components = [
			mk('parse_1', 'parse', { config: {} }),
			mk('anonymize_text_1', 'anonymize_text', { config: {} }),
			mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'parse_1' }] }),
		];
		expect(run('text-lane-chain', [mkPipe(components)])).toMatch(/anonymize_text_1/);
	});
});

describe('image-to-text-chain', () => {
	test('passes for ocr consuming image and feeding text downstream', () => {
		const components = [
			mk('parse_1', 'parse', { config: {} }),
			mk('ocr_1', 'ocr', { config: {}, input: [{ lane: 'image', from: 'parse_1' }] }),
			mk('preprocessor_langchain_1', 'preprocessor_langchain', { config: {}, input: [{ lane: 'text', from: 'ocr_1' }] }),
		];
		expect(run('image-to-text-chain', [mkPipe(components)])).toBeNull();
	});
	test('fails when ocr output is a dead end', () => {
		const components = [mk('parse_1', 'parse', { config: {} }), mk('ocr_1', 'ocr', { config: {}, input: [{ lane: 'image', from: 'parse_1' }] })];
		expect(run('image-to-text-chain', [mkPipe(components)])).toMatch(/nothing downstream/);
	});
});

describe('audio-to-text-chain', () => {
	test('passes for audio_transcribe feeding text downstream', () => {
		const components = [
			mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
			mk('audio_transcribe_1', 'audio_transcribe', { config: {}, input: [{ lane: 'audio', from: 'webhook_1' }] }),
			mk('preprocessor_langchain_1', 'preprocessor_langchain', { config: {}, input: [{ lane: 'text', from: 'audio_transcribe_1' }] }),
		];
		expect(run('audio-to-text-chain', [mkPipe(components)])).toBeNull();
	});
	test('fails when audio_transcribe output is a dead end', () => {
		const components = [
			mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
			mk('audio_transcribe_1', 'audio_transcribe', { config: {}, input: [{ lane: 'audio', from: 'webhook_1' }] }),
		];
		expect(run('audio-to-text-chain', [mkPipe(components)])).toMatch(/nothing downstream/);
	});
});

describe('shared-collection-config (B11)', () => {
	function qdrantWithCollection(collection: string): Pipe {
		return mkPipe([mk('qdrant_1', 'qdrant', { config: { profile: 'local', local: { host: 'localhost', port: 6333, collection } } })]);
	}
	test('passes when both pipes share the same collection', () => {
		expect(run('shared-collection-config', [qdrantWithCollection('scenes'), qdrantWithCollection('scenes')])).toBeNull();
	});
	test('fails when collections differ across pipes', () => {
		expect(run('shared-collection-config', [qdrantWithCollection('scenes'), qdrantWithCollection('other')])).toMatch(/differ/);
	});
});

describe('same-embedding-both-pipes (B11)', () => {
	function withEmbedding(provider: string): Pipe {
		return mkPipe([mk(`${provider}_1`, provider, { config: {} })]);
	}
	test('passes when both pipes use the same embedding provider', () => {
		expect(run('same-embedding-both-pipes', [withEmbedding('embedding_openai'), withEmbedding('embedding_openai')])).toBeNull();
	});
	test('fails when embedding providers differ across pipes', () => {
		expect(run('same-embedding-both-pipes', [withEmbedding('embedding_openai'), withEmbedding('embedding_transformer')])).toMatch(/differ/);
	});
});

function agentTrio(agentId = 'agent_rocketride_1', memoryConfig: Record<string, unknown> = { type: 'memory_internal' }): PipeComponent[] {
	return [
		mk('chat_1', 'chat', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'chat' } }),
		mk(agentId, 'agent_rocketride', { config: { instructions: [], max_waves: 10, parameters: {} }, input: [{ lane: 'questions', from: 'chat_1' }] }),
		mk(`llm_openai_for_${agentId}`, 'llm_openai', { config: {}, control: [{ classType: 'llm', from: agentId }] }),
		mk(`memory_for_${agentId}`, 'memory_internal', { config: memoryConfig, control: [{ classType: 'memory', from: agentId }] }),
	];
}

describe('agent-control-plane (Control Connections + Memory Requirements)', () => {
	test('passes for a well-formed agent with 1 llm + 1 memory (config.type set — Mistake 6)', () => {
		expect(run('agent-control-plane', [mkPipe(agentTrio())])).toBeNull();
	});
	test('fails when memory_internal config is empty (Mistake 6)', () => {
		expect(run('agent-control-plane', [mkPipe(agentTrio('agent_rocketride_1', {}))])).toMatch(/missing "type"/);
	});
	test('fails when the agent itself carries a control array', () => {
		const components = agentTrio().map((c) => (c.id === 'agent_rocketride_1' ? { ...c, control: [{ classType: 'llm', from: 'somewhere' }] } : c));
		expect(run('agent-control-plane', [mkPipe(components)])).toMatch(/no top-level agent_rocketride found/);
	});
});

describe('agent-config-shape (Config Patterns > Agent Nodes)', () => {
	test('passes when config has instructions/max_waves/parameters', () => {
		const components = [mk('agent_rocketride_1', 'agent_rocketride', { config: { instructions: [], max_waves: 10, parameters: {} } })];
		expect(run('agent-config-shape', [mkPipe(components)])).toBeNull();
	});
	test('fails for an empty agent config', () => {
		const components = [mk('agent_rocketride_1', 'agent_rocketride', { config: {} })];
		expect(run('agent-config-shape', [mkPipe(components)])).toMatch(/missing/);
	});
});

describe('db-tool-wiring (B13)', () => {
	function base(dbControl: boolean): Pipe {
		const components = [
			mk('agent_rocketride_1', 'agent_rocketride', { config: {} }),
			mk('db_postgres_1', 'db_postgres', { config: {}, control: dbControl ? [{ classType: 'tool', from: 'agent_rocketride_1' }] : [] }),
			mk('tool_chartjs_1', 'tool_chartjs', { config: {}, control: [{ classType: 'tool', from: 'agent_rocketride_1' }] }),
		];
		return mkPipe(components);
	}
	test('passes when db_postgres and tool_chartjs are both controlled by the agent', () => {
		expect(run('db-tool-wiring', [base(true)])).toBeNull();
	});
	test('fails when db_postgres has no control connection', () => {
		expect(run('db-tool-wiring', [base(false)])).toMatch(/db_postgres_1/);
	});
});

describe('single-response-multi-agent (Mistake 7)', () => {
	test('passes for a single response_answers node with multiple agent inputs', () => {
		const components = [
			mk('response_answers_1', 'response_answers', {
				config: {},
				input: [{ lane: 'answers', from: 'agent_rocketride_1' }, { lane: 'answers', from: 'agent_crewai_1' }, { lane: 'answers', from: 'agent_langchain_1' }],
			}),
		];
		expect(run('single-response-multi-agent', [mkPipe(components)])).toBeNull();
	});
	test('fails for a two-response-node fixture (one per agent)', () => {
		const components = [
			mk('response_1', 'response_answers', { config: {}, input: [{ lane: 'answers', from: 'agent_rocketride_1' }] }),
			mk('response_2', 'response_answers', { config: {}, input: [{ lane: 'answers', from: 'agent_crewai_1' }] }),
		];
		expect(run('single-response-multi-agent', [mkPipe(components)])).toMatch(/exactly 1 response_answers/);
	});
});

describe('no-memory-on-crewai-langchain', () => {
	test('passes when memory is only wired to agent_rocketride', () => {
		expect(run('no-memory-on-crewai-langchain', [mkPipe(agentTrio())])).toBeNull();
	});
	test('fails when memory is wired to agent_crewai', () => {
		const components = [mk('agent_crewai_1', 'agent_crewai', { config: {} }), mk('memory_internal_1', 'memory_internal', { config: { type: 'memory_internal' }, control: [{ classType: 'memory', from: 'agent_crewai_1' }] })];
		expect(run('no-memory-on-crewai-langchain', [mkPipe(components)])).toMatch(/memory port/);
	});
});

describe('shared-llm-multi-control (B14)', () => {
	function threeAgents(sharedLlm: boolean): Pipe {
		const agents = ['agent_rocketride_1', 'agent_crewai_1', 'agent_langchain_1'].map((id, i) => mk(id, i === 0 ? 'agent_rocketride' : i === 1 ? 'agent_crewai' : 'agent_langchain', { config: {} }));
		const llms = sharedLlm
			? [mk('llm_openai_1', 'llm_openai', { config: {}, control: agents.map((a) => ({ classType: 'llm', from: a.id })) })]
			: agents.map((a) => mk(`llm_for_${a.id}`, 'llm_openai', { config: {}, control: [{ classType: 'llm', from: a.id }] }));
		return mkPipe([...agents, ...llms]);
	}
	test('passes for one shared llm with a control entry per agent', () => {
		expect(run('shared-llm-multi-control', [threeAgents(true)])).toBeNull();
	});
	test('fails when each agent gets its own llm node', () => {
		expect(run('shared-llm-multi-control', [threeAgents(false)])).toMatch(/exactly 1 shared llm_\* node/);
	});
});

describe('hierarchical-control-chain (B15)', () => {
	function base(childHasInput: boolean): Pipe {
		const components = [
			mk('agent_rocketride_1', 'agent_rocketride', { config: {} }),
			mk('agent_rocketride_2', 'agent_rocketride', {
				config: {},
				control: [{ classType: 'tool', from: 'agent_rocketride_1' }],
				input: childHasInput ? [{ lane: 'questions', from: 'chat_1' }] : undefined,
			}),
		];
		return mkPipe(components);
	}
	test('passes when the sub-agent has no input lanes', () => {
		expect(run('hierarchical-control-chain', [base(false)])).toBeNull();
	});
	test('fails when the sub-agent is also data-fed', () => {
		expect(run('hierarchical-control-chain', [base(true)])).toMatch(/no input lanes/);
	});
});

describe('each-agent-own-memory (B15)', () => {
	test('passes when each agent controls its own distinct memory', () => {
		const components = [
			mk('agent_rocketride_1', 'agent_rocketride', { config: {} }),
			mk('agent_rocketride_2', 'agent_rocketride', { config: {} }),
			mk('memory_1', 'memory_internal', { config: { type: 'memory_internal' }, control: [{ classType: 'memory', from: 'agent_rocketride_1' }] }),
			mk('memory_2', 'memory_internal', { config: { type: 'memory_internal' }, control: [{ classType: 'memory', from: 'agent_rocketride_2' }] }),
		];
		expect(run('each-agent-own-memory', [mkPipe(components)])).toBeNull();
	});
	test('fails when two agents share one memory node', () => {
		const components = [
			mk('agent_rocketride_1', 'agent_rocketride', { config: {} }),
			mk('agent_rocketride_2', 'agent_rocketride', { config: {} }),
			mk('memory_1', 'memory_internal', {
				config: { type: 'memory_internal' },
				control: [{ classType: 'memory', from: 'agent_rocketride_1' }, { classType: 'memory', from: 'agent_rocketride_2' }],
			}),
		];
		expect(run('each-agent-own-memory', [mkPipe(components)])).toMatch(/shared by 2 agents/);
	});
});

describe('response-key-default (Mistake 1)', () => {
	test('passes for the default "answers" laneName', () => {
		const components = [mk('response_answers_1', 'response_answers', { config: { laneName: 'answers' } })];
		expect(run('response-key-default', [mkPipe(components)])).toBeNull();
	});
	test('fails for a customized laneName like "chat_response"', () => {
		const components = [mk('response_answers_1', 'response_answers', { config: { laneName: 'chat_response' } })];
		expect(run('response-key-default', [mkPipe(components)])).toMatch(/chat_response/);
	});
});

describe('diff-scope-limited (D02)', () => {
	test('passes when the fix keeps the seed ids', () => {
		const seed = loadFixture('lane-mismatch.pipe');
		seed.components[2].config.laneName = 'answers';
		expect(run('diff-scope-limited', [seed])).toBeNull();
	});
	test('fails when the fix rewrites far more than the seed shape', () => {
		const rewritten = mkPipe([
			mk('webhook_1', 'webhook', { config: {} }),
			mk('parse_1', 'parse', { config: {} }),
			mk('preprocessor_langchain_1', 'preprocessor_langchain', { config: {} }),
			mk('embedding_transformer_1', 'embedding_transformer', { config: {} }),
			mk('qdrant_1', 'qdrant', { config: {} }),
		]);
		expect(run('diff-scope-limited', [rewritten])).toMatch(/differ from the seed/);
	});
});

// ---------------------------------------------------------------------------
// D01/D02/D03 seed-vs-fixed integration (fixtures/broken/*.pipe)
// ---------------------------------------------------------------------------

describe('debug-brief fixtures (fixtures/broken/*.pipe)', () => {
	test('D01: seed fails embedding-before-store, fixed version passes', () => {
		const seed = loadFixture('no-embedding.pipe');
		expect(run('embedding-before-store', [seed])).not.toBeNull();

		const fixed: Pipe = JSON.parse(JSON.stringify(seed));
		fixed.components.splice(3, 0, mk('embedding_transformer_1', 'embedding_transformer', { config: { profile: 'miniLM', parameters: {} }, input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }] }));
		fixed.components[4].input = [{ lane: 'documents', from: 'embedding_transformer_1' }];
		expect(run('embedding-before-store', [fixed])).toBeNull();
	});

	test('D02: seed fails response-key-default, fixed version passes', () => {
		const seed = loadFixture('lane-mismatch.pipe');
		expect(run('response-key-default', [seed])).not.toBeNull();

		const fixed: Pipe = JSON.parse(JSON.stringify(seed));
		fixed.components[2].config.laneName = 'answers';
		expect(run('response-key-default', [fixed])).toBeNull();
		expect(run('diff-scope-limited', [fixed])).toBeNull();
	});

	test('D03: seed fails inputs-wired + no-orphans, fixed version passes', () => {
		const seed = loadFixture('orphan.pipe');
		expect(run('inputs-wired', [seed])).not.toBeNull();
		expect(run('no-orphans', [seed])).not.toBeNull();

		const fixed: Pipe = JSON.parse(JSON.stringify(seed));
		fixed.components = fixed.components.filter((c) => c.id !== 'llm_openai_2');
		const response = fixed.components.find((c) => c.id === 'response_answers_1')!;
		response.input = [{ lane: 'answers', from: 'llm_openai_1' }];
		expect(run('inputs-wired', [fixed])).toBeNull();
		expect(run('no-orphans', [fixed])).toBeNull();
		expect(run('acyclic', [fixed])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// scorePipe / scoreSuite entry points
// ---------------------------------------------------------------------------

describe('scorePipe', () => {
	test('passes a fully valid B01-shaped pipe against the webhook-transform brief', () => {
		const brief = BRIEFS.find((b) => b.id === 'webhook-transform')!;
		const components = [
			mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
			mk('transform_1', 'transform', { config: {}, input: [{ lane: 'tags', from: 'webhook_1' }] }),
			mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'transform_1' }] }),
		];
		const result = scorePipe([mkPipe(components)], brief, true, []);
		expect(result.structuralFailures).toEqual([]);
		expect(result.nodeCountOk).toBe(true);
		expect(result.providersOk).toBe(true);
		expect(result.pass).toBe(true);
	});

	test('fails when the engine verdict itself is false, even with a structurally clean pipe', () => {
		const brief = BRIEFS.find((b) => b.id === 'webhook-transform')!;
		const components = [
			mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
			mk('transform_1', 'transform', { config: {}, input: [{ lane: 'tags', from: 'webhook_1' }] }),
			mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'transform_1' }] }),
		];
		const result = scorePipe([mkPipe(components)], brief, false, []);
		expect(result.pass).toBe(false);
	});

	test('D01 fails without 2 validate_pipeline calls even if structurally fixed', () => {
		const brief = BRIEFS.find((b) => b.id === 'fix-missing-embedding')!;
		const seed = loadFixture('no-embedding.pipe');
		const fixed: Pipe = JSON.parse(JSON.stringify(seed));
		fixed.components.splice(3, 0, mk('embedding_transformer_1', 'embedding_transformer', { config: {}, input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }] }));
		fixed.components[4].input = [{ lane: 'documents', from: 'embedding_transformer_1' }];

		const onlyOneCall = scorePipe([fixed], brief, true, [{ tool: 'validate_pipeline', ok: true }]);
		expect(onlyOneCall.pass).toBe(false);

		const twoCalls = scorePipe([fixed], brief, true, [
			{ tool: 'validate_pipeline', ok: false },
			{ tool: 'validate_pipeline', ok: true },
		]);
		expect(twoCalls.pass).toBe(true);
	});

	// Phase 5, Task 5.1c fix-up: `approximated` provenance, surfaced from the runner's ToolCall
	// tap onto the BriefResult so a pass/fail computed against the stub's local structural-check
	// fallback is never silently indistinguishable from a real engine verdict.
	describe('approximated provenance (5.1c fix-up)', () => {
		const brief = BRIEFS.find((b) => b.id === 'webhook-transform')!;
		const cleanPipe = [
			mkPipe([
				mk('webhook_1', 'webhook', { config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } }),
				mk('transform_1', 'transform', { config: {}, input: [{ lane: 'tags', from: 'webhook_1' }] }),
				mk('response_text_1', 'response_text', { config: {}, input: [{ lane: 'text', from: 'transform_1' }] }),
			]),
		];

		test('sets approximated:true when a validate_pipeline toolCall carries it, even if pass is true', () => {
			const result = scorePipe(cleanPipe, brief, true, [{ tool: 'validate_pipeline', ok: true, approximated: true }]);
			expect(result.pass).toBe(true);
			expect(result.approximated).toBe(true);
		});

		test('leaves approximated unset when no validate_pipeline call was approximated', () => {
			const result = scorePipe(cleanPipe, brief, true, [{ tool: 'validate_pipeline', ok: true }]);
			expect(result.approximated).toBeUndefined();
		});

		test('leaves approximated unset when there were no validate_pipeline calls at all', () => {
			const result = scorePipe(cleanPipe, brief, true, []);
			expect(result.approximated).toBeUndefined();
		});
	});
});

describe('scoreSuite', () => {
	function results(passCount: number, total: number): BriefResult[] {
		return Array.from({ length: total }, (_, i) => ({
			briefId: `brief-${i}`,
			validatePass: true,
			structuralFailures: [],
			nodeCountOk: true,
			providersOk: true,
			toolCalls: [],
			pass: i < passCount,
		}));
	}

	test('15/18 passes -> passRate 0.833, gate true', () => {
		const report = scoreSuite('replay', results(15, 18));
		expect(report.passRate).toBeCloseTo(0.833, 3);
		expect(report.gate).toBe(true);
	});

	test('14/18 passes -> gate false', () => {
		const report = scoreSuite('replay', results(14, 18));
		expect(report.gate).toBe(false);
	});

	test('approximatedCount (5.1c fix-up): counts results flagged approximated, independent of pass/fail', () => {
		const clean = results(18, 18);
		expect(scoreSuite('replay', clean).approximatedCount).toBe(0);

		const withApproximation = clean.map((r, i) => (i < 3 ? { ...r, approximated: true } : r));
		const report = scoreSuite('replay', withApproximation);
		expect(report.approximatedCount).toBe(3);
		expect(report.passRate).toBe(1); // approximatedCount is orthogonal to passRate/gate — score.ts's own 0.8 gate formula is untouched
	});
});
