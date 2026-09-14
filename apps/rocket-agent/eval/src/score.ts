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
 * Pure, deterministic static scoring library for the RocketRide agent eval
 * suite (Phase 5, Task 5.1a). No network, no model, no engine, no
 * filesystem — every check operates on already-parsed `.pipe` JSON
 * (`Pipe[]`) and a recorded verdict (`validatePass`, `toolCalls`).
 *
 * `structuralChecks` doubles as the COMMON_MISTAKES regression suite: each
 * entry cites the mistake (or doc rule) it guards. Consumed by the 5.1b
 * runner and the 5.1c CI gate.
 */

import type { BriefResult, EvalBrief, Pipe, PipeComponent, SuiteReport, ToolCall } from './types';
import { laneSignatureFor } from './lanes';

// ---------------------------------------------------------------------------
// Graph helpers — edges are derived from input[]/control[] exactly like
// shared-ui derives edges: input[] wires data (from -> this node), control[]
// wires the control plane (invoker -> controlled node).
// ---------------------------------------------------------------------------

interface Edge {
	from: string;
	to: string;
}

function dataEdges(pipe: Pipe): Edge[] {
	const edges: Edge[] = [];
	for (const c of pipe.components) {
		for (const inp of c.input ?? []) edges.push({ from: inp.from, to: c.id });
	}
	return edges;
}

function controlEdges(pipe: Pipe): Edge[] {
	const edges: Edge[] = [];
	for (const c of pipe.components) {
		for (const ctl of c.control ?? []) edges.push({ from: ctl.from, to: c.id });
	}
	return edges;
}

function adjacency(edges: Edge[]): Map<string, string[]> {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (!adj.has(e.from)) adj.set(e.from, []);
		adj.get(e.from)!.push(e.to);
	}
	return adj;
}

/** Every id reachable from `pipe.source`, following data edges and control edges (invoker -> controlled). */
function reachableIds(pipe: Pipe): Set<string> {
	const adj = adjacency([...dataEdges(pipe), ...controlEdges(pipe)]);
	const seen = new Set<string>();
	if (!pipe.source) return seen;
	const queue = [pipe.source];
	seen.add(pipe.source);
	while (queue.length) {
		const cur = queue.shift()!;
		for (const next of adj.get(cur) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	return seen;
}

/** DFS cycle detection (white/gray/black) over data + control edges. */
function hasCycle(pipe: Pipe): boolean {
	const adj = adjacency([...dataEdges(pipe), ...controlEdges(pipe)]);
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const state = new Map<string, number>();
	for (const c of pipe.components) state.set(c.id, WHITE);
	let cyclic = false;

	function dfs(node: string): void {
		state.set(node, GRAY);
		for (const next of adj.get(node) ?? []) {
			const s = state.get(next);
			if (s === GRAY) {
				cyclic = true;
				return;
			}
			if (s === WHITE) dfs(next);
			if (cyclic) return;
		}
		state.set(node, BLACK);
	}

	for (const c of pipe.components) {
		if (state.get(c.id) === WHITE) dfs(c.id);
		if (cyclic) break;
	}
	return cyclic;
}

function collectStrings(value: unknown, out: string[]): void {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
	else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
}

function storeCollection(c: PipeComponent): string | undefined {
	const cfg = c.config as Record<string, unknown> | undefined;
	if (!cfg) return undefined;
	if (typeof cfg.collection === 'string') return cfg.collection;
	const profile = cfg.profile;
	if (typeof profile === 'string') {
		const profileCfg = cfg[profile] as Record<string, unknown> | undefined;
		if (profileCfg && typeof profileCfg.collection === 'string') return profileCfg.collection;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Provider matching — supports family tokens ('llm_*', 'embedding_*'),
// alternation ('webhook|dropper'), and the 'any-source' virtual token, so
// brief.expectProviders can stay verbatim from the golden-brief table.
// ---------------------------------------------------------------------------

const ANY_SOURCE = ['webhook', 'dropper', 'chat'];

function providerMatchesToken(token: string, provider: string): boolean {
	if (token === 'any-source') return ANY_SOURCE.includes(provider);
	if (token.includes('|')) return token.split('|').some((t) => providerMatchesToken(t, provider));
	if (token.endsWith('_*')) return provider.startsWith(token.slice(0, -1));
	return token === provider;
}

function providersOk(pipes: Pipe[], brief: EvalBrief): boolean {
	const allProviders = pipes.flatMap((p) => p.components.map((c) => c.provider));
	const pool = [...allProviders];
	for (const token of brief.expectProviders) {
		const idx = pool.findIndex((p) => providerMatchesToken(token, p));
		if (idx === -1) return false;
		pool.splice(idx, 1); // consume — duplicate tokens (B15's 2x agent_rocketride) require multiple distinct instances
	}
	if (brief.forbidProviders) {
		for (const forbid of brief.forbidProviders) {
			if (allProviders.some((p) => providerMatchesToken(forbid, p))) return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// structuralChecks registry — each check IS a COMMON_MISTAKES regression
// case. Signature: (pipes, brief) => failure message | null (null = pass).
// ---------------------------------------------------------------------------

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LLM_INVOKING_PROVIDERS = ['summarization', 'extract_data'];
const DEFAULT_LANE_NAMES: Record<string, string> = {
	response_answers: 'answers',
	response_text: 'text',
	response_documents: 'documents',
};
/** D02 seed shape (fixtures/broken/lane-mismatch.pipe) — baked in so the diff-scope check stays pure (no filesystem read). */
const D02_SEED_IDS = new Set(['chat_1', 'llm_openai_1', 'response_answers_1']);

export const structuralChecks: Record<string, (pipes: Pipe[], brief: EvalBrief) => string | null> = {
	// --- Universal checks (run on every brief) ------------------------------

	/** Mistake 3: project_id must be a literal GUID, never a `${...}` substitution. */
	'project-id-guid': (pipes) => {
		for (const p of pipes) {
			if (!GUID_RE.test(p.project_id)) return `project_id "${p.project_id}" is not a literal GUID`;
		}
		return null;
	},

	/** Mistake 4: pipeline files must use the .pipe extension. `sourceFile` is scoring metadata set by the runner; absent = pass. */
	'pipe-extension': (pipes) => {
		for (const p of pipes) {
			if (p.sourceFile && !p.sourceFile.endsWith('.pipe')) return `sourceFile "${p.sourceFile}" must use the .pipe extension`;
		}
		return null;
	},

	/** Mistake 8: top-level `source` must reference an existing component id. */
	'source-reference-valid': (pipes) => {
		for (const p of pipes) {
			if (!p.source) return 'pipe has no top-level "source" field';
			if (!p.components.some((c) => c.id === p.source)) return `source "${p.source}" does not match any component id`;
		}
		return null;
	},

	/** Mistake 5: source node config must include hideForm/mode/parameters/type. */
	'source-config-shape': (pipes) => {
		for (const p of pipes) {
			const src = p.components.find((c) => c.id === p.source);
			if (!src) return 'no source component found to check config shape on';
			const cfg = src.config ?? {};
			const missing = ['hideForm', 'mode', 'parameters', 'type'].filter((k) => !(k in cfg));
			if (missing.length) return `source "${src.id}" config missing ${missing.join(', ')}`;
		}
		return null;
	},

	/** Mistake 16: every non-source component needs an `input` array, unless it is control-invoked. */
	'inputs-wired': (pipes) => {
		for (const p of pipes) {
			for (const c of p.components) {
				if (c.id === p.source) continue;
				if (c.control && c.control.length > 0) continue;
				if (!c.input || c.input.length === 0) return `"${c.id}" has no input array and is not control-invoked`;
			}
		}
		return null;
	},

	/** Mistake 17: the component graph (data + control edges) must be acyclic. */
	acyclic: (pipes) => {
		for (const p of pipes) {
			if (hasCycle(p)) return 'pipeline graph contains a cycle';
		}
		return null;
	},

	/** Mistake 18: every non-source component must be reachable from `source`. */
	'no-orphans': (pipes) => {
		for (const p of pipes) {
			const reachable = reachableIds(p);
			for (const c of p.components) {
				if (c.id === p.source) continue;
				if (!reachable.has(c.id)) return `"${c.id}" is orphaned — unreachable from source`;
			}
		}
		return null;
	},

	/** Mistake 11: only `${ROCKETRIDE_*}` env vars are substituted. */
	'env-key-substitution': (pipes) => {
		const re = /\$\{([^}]+)\}/g;
		for (const p of pipes) {
			for (const c of p.components) {
				const strs: string[] = [];
				collectStrings(c.config, strs);
				for (const s of strs) {
					re.lastIndex = 0;
					let m: RegExpExecArray | null;
					while ((m = re.exec(s))) {
						if (!m[1].startsWith('ROCKETRIDE_')) return `"${c.id}" uses "\${${m[1]}}" — env vars must be \${ROCKETRIDE_*}`;
					}
				}
			}
		}
		return null;
	},

	/** Mistake 13: output lane of `from` must match the input lane the target accepts (vendored lane table). Unknown providers are skipped. */
	'lane-type-compatibility': (pipes) => {
		for (const p of pipes) {
			for (const c of p.components) {
				for (const inp of c.input ?? []) {
					const fromComp = p.components.find((x) => x.id === inp.from);
					if (!fromComp) continue; // dangling ref — caught by no-orphans/source-reference-valid
					const fromSig = laneSignatureFor(fromComp.provider);
					const toSig = laneSignatureFor(c.provider);
					if (!fromSig || !toSig) continue;
					if (!fromSig.produces.includes(inp.lane)) return `"${fromComp.id}" (${fromComp.provider}) does not produce lane "${inp.lane}"`;
					if (!toSig.accepts.includes(inp.lane)) return `"${c.id}" (${c.provider}) does not accept lane "${inp.lane}"`;
				}
			}
		}
		return null;
	},

	/** Component-reference layout rule: ui.position present, and not every node left at {0,0}. */
	'ui-position-present': (pipes) => {
		for (const p of pipes) {
			let allZero = true;
			for (const c of p.components) {
				const pos = c.ui?.position;
				if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return `"${c.id}" is missing ui.position`;
				if (pos.x !== 0 || pos.y !== 0) allZero = false;
			}
			if (p.components.length > 0 && allZero) return 'all components are left at ui.position {0,0}';
		}
		return null;
	},

	// --- Brief-specific checks -----------------------------------------------

	/** SDK Mistake 5: chat pipelines must use the `chat` source, not `webhook`. */
	'chat-source-for-conversation': (pipes) => {
		const p = pipes[0];
		const src = p.components.find((c) => c.id === p.source);
		if (!src || src.provider !== 'chat') return `source must be "chat" for a conversational interface, got "${src?.provider}"`;
		return null;
	},

	/** Mistake 14: llm_* nodes need config.profile + a ${ROCKETRIDE_*} apikey nested under it. */
	'llm-profile-config': (pipes) => {
		for (const p of pipes) {
			for (const c of p.components) {
				if (!c.provider.startsWith('llm_')) continue;
				const cfg = (c.config ?? {}) as Record<string, unknown>;
				const profile = cfg.profile;
				if (typeof profile !== 'string' || !profile) return `"${c.id}" is missing config.profile`;
				const profileCfg = cfg[profile] as Record<string, unknown> | undefined;
				const apikey = profileCfg?.apikey;
				if (typeof apikey !== 'string' || !/^\$\{ROCKETRIDE_/.test(apikey)) return `"${c.id}" profile "${profile}" is missing a \${ROCKETRIDE_*} apikey`;
			}
		}
		return null;
	},

	/** Embeddings: Required Before Any Store — a store's "documents" input must come from an embedding_* node. */
	'embedding-before-store': (pipes) => {
		for (const p of pipes) {
			for (const c of p.components) {
				if (!laneSignatureFor(c.provider)?.dualMode) continue;
				for (const inp of c.input ?? []) {
					if (inp.lane !== 'documents') continue;
					const fromComp = p.components.find((x) => x.id === inp.from);
					if (!fromComp || !fromComp.provider.startsWith('embedding_')) {
						return `"${c.id}" receives "documents" directly from "${fromComp?.id ?? inp.from}" (${fromComp?.provider ?? 'unknown'}) — embedding must run before store`;
					}
				}
			}
		}
		return null;
	},

	/** Response Components rule: ingestion pipelines terminate at the store — no response node. */
	'no-response-node': (pipes) => {
		for (const p of pipes) {
			const resp = p.components.find((c) => c.provider.startsWith('response_'));
			if (resp) return `ingestion pipeline has a response node "${resp.id}" — ingestion terminates at the store`;
		}
		return null;
	},

	/** Embeddings section: search must run the same embedding model against the "questions" lane. */
	'same-embedding-for-search': (pipes) => {
		const p = pipes[0];
		const embed = p.components.find((c) => c.provider.startsWith('embedding_') && (c.input ?? []).some((i) => i.lane === 'questions'));
		if (!embed) return 'no embedding_* component wired to the "questions" lane for search';
		return null;
	},

	/** Vector Databases (Stores): search mode requires a "questions" input, not just "documents". */
	'store-search-mode-wiring': (pipes) => {
		const p = pipes[0];
		const store = p.components.find((c) => laneSignatureFor(c.provider)?.dualMode);
		if (!store) return 'no vector store component found';
		if (!(store.input ?? []).some((i) => i.lane === 'questions')) return `"${store.id}" has no "questions" input — not wired for search mode`;
		return null;
	},

	/** The Prompt Node: must collect both "documents" and "questions", then feed an llm_* with "questions". */
	'prompt-merges-documents-and-questions': (pipes) => {
		const p = pipes[0];
		const prompt = p.components.find((c) => c.provider === 'prompt');
		if (!prompt) return 'no "prompt" component found';
		const lanes = (prompt.input ?? []).map((i) => i.lane);
		if (!lanes.includes('documents')) return `"${prompt.id}" has no "documents" input`;
		if (!lanes.includes('questions')) return `"${prompt.id}" has no "questions" input`;
		const llmFed = p.components.some(
			(c) => c.provider.startsWith('llm_') && (c.input ?? []).some((i) => i.lane === 'questions' && i.from === prompt.id),
		);
		if (!llmFed) return `no llm_* component receives "questions" from "${prompt.id}"`;
		return null;
	},

	/** Prompt Nodes config rule: instructions must be a non-empty array. */
	'instructions-nonempty': (pipes) => {
		const p = pipes[0];
		const prompt = p.components.find((c) => c.provider === 'prompt');
		if (!prompt) return 'no "prompt" component found';
		const instructions = (prompt.config as Record<string, unknown>)?.instructions;
		if (!Array.isArray(instructions) || instructions.length === 0) return `"${prompt.id}" config.instructions is empty`;
		return null;
	},

	/** Control Connections rule: `control` goes on the CONTROLLED node (the llm), never on the invoker (summarization/extract_data). */
	'control-on-controlled-node': (pipes) => {
		const p = pipes[0];
		for (const invoker of p.components.filter((c) => LLM_INVOKING_PROVIDERS.includes(c.provider))) {
			if (invoker.control && invoker.control.length > 0) {
				return `"${invoker.id}" carries a control array — control belongs on the invoked LLM, not the invoker`;
			}
			const controlledLlm = p.components.find(
				(c) => c.provider.startsWith('llm_') && (c.control ?? []).some((ctl) => ctl.classType === 'llm' && ctl.from === invoker.id),
			);
			if (!controlledLlm) return `no llm_* node carries control:[{classType:'llm', from:'${invoker.id}'}]`;
		}
		return null;
	},

	/** B07: parse -> anonymize_text -> response_text, each hop on the "text" lane. */
	'text-lane-chain': (pipes) => {
		const p = pipes[0];
		const parse = p.components.find((c) => c.provider === 'parse');
		const anon = p.components.find((c) => c.provider === 'anonymize_text');
		const resp = p.components.find((c) => c.provider === 'response_text');
		if (!parse || !anon || !resp) return 'expected a parse -> anonymize_text -> response_text chain';
		if (!(anon.input ?? []).some((i) => i.lane === 'text' && i.from === parse.id)) return `"${anon.id}" is not fed "text" from "${parse.id}"`;
		if (!(resp.input ?? []).some((i) => i.lane === 'text' && i.from === anon.id)) return `"${resp.id}" is not fed "text" from "${anon.id}"`;
		return null;
	},

	/** Lane Flow Rule 5: image can't go directly to text-only consumers — needs an ocr/accessibility_describe converter. */
	'image-to-text-chain': (pipes) => {
		for (const p of pipes) {
			const imageConsumer = p.components.find(
				(c) => (c.input ?? []).some((i) => i.lane === 'image') && laneSignatureFor(c.provider)?.accepts.includes('image'),
			);
			if (!imageConsumer) continue;
			const fedText = p.components.some((c) => (c.input ?? []).some((i) => i.lane === 'text' && i.from === imageConsumer.id));
			if (!fedText) return `"${imageConsumer.id}" consumes "image" but nothing downstream receives "text" from it`;
			return null;
		}
		return 'no image -> text conversion chain found (ocr / accessibility_describe)';
	},

	/** Transformation Chains: audio -> audio_transcribe -> text. */
	'audio-to-text-chain': (pipes) => {
		for (const p of pipes) {
			const audioConsumer = p.components.find((c) => (c.input ?? []).some((i) => i.lane === 'audio'));
			if (!audioConsumer) continue;
			const fedText = p.components.some((c) => (c.input ?? []).some((i) => i.lane === 'text' && i.from === audioConsumer.id));
			if (!fedText) return `"${audioConsumer.id}" consumes "audio" but nothing downstream receives "text" from it`;
			return null;
		}
		return 'no audio -> text conversion chain found (audio_transcribe)';
	},

	/** Multiple Pipelines: ingestion + query pipelines must share the same store collection name. */
	'shared-collection-config': (pipes) => {
		if (pipes.length < 2) return 'expected 2 pipes to compare collection config';
		const stores = pipes.map((p) => p.components.find((c) => laneSignatureFor(c.provider)?.dualMode));
		if (stores.some((s) => !s)) return 'one or both pipes have no vector store component';
		const collections = stores.map((s) => storeCollection(s!));
		if (collections.some((c) => !c)) return 'one or both store components have no collection configured';
		if (new Set(collections).size !== 1) return `store collections differ across pipes: ${collections.join(' vs ')}`;
		return null;
	},

	/** Embeddings section: ingest and search must use the same embedding provider across both pipes. */
	'same-embedding-both-pipes': (pipes) => {
		if (pipes.length < 2) return 'expected 2 pipes to compare embedding providers';
		const embeds = pipes.map((p) => p.components.find((c) => c.provider.startsWith('embedding_'))?.provider);
		if (embeds.some((e) => !e)) return 'one or both pipes have no embedding_* component';
		if (new Set(embeds).size !== 1) return `embedding providers differ across pipes: ${embeds.join(' vs ')}`;
		return null;
	},

	/** Control Connections + Memory Requirements: agent has no control array; exactly 1 llm+memory control-invoked by it; memory_internal has config.type (Mistake 6). */
	'agent-control-plane': (pipes) => {
		const p = pipes[0];
		const agents = p.components.filter((c) => c.provider === 'agent_rocketride' && (!c.control || c.control.length === 0));
		if (agents.length === 0) return 'no top-level agent_rocketride found';
		for (const agent of agents) {
			const llms = p.components.filter(
				(c) => c.provider.startsWith('llm_') && (c.control ?? []).some((ctl) => ctl.classType === 'llm' && ctl.from === agent.id),
			);
			if (llms.length < 1) return `no llm_* control-invoked by "${agent.id}"`;
			const memories = p.components.filter(
				(c) => c.provider === 'memory_internal' && (c.control ?? []).some((ctl) => ctl.classType === 'memory' && ctl.from === agent.id),
			);
			if (memories.length !== 1) return `"${agent.id}" must have exactly 1 memory_internal control connection, found ${memories.length}`;
			if ((memories[0].config as Record<string, unknown>)?.type !== 'memory_internal') return `"${memories[0].id}" memory_internal config is missing "type"`;
		}
		return null;
	},

	/** Config Patterns > Agent Nodes: instructions/max_waves/parameters, flat in config. */
	'agent-config-shape': (pipes) => {
		const p = pipes[0];
		for (const agent of p.components.filter((c) => c.provider === 'agent_rocketride')) {
			const cfg = (agent.config ?? {}) as Record<string, unknown>;
			const missing = ['instructions', 'max_waves', 'parameters'].filter((k) => !(k in cfg));
			if (missing.length) return `"${agent.id}" config missing ${missing.join(', ')}`;
		}
		return null;
	},

	/** Control Connections generalization: db_postgres/tool_chartjs must carry control from an agent, same as any other invoked tool. */
	'db-tool-wiring': (pipes) => {
		const p = pipes[0];
		const agentIds = new Set(p.components.filter((c) => c.provider === 'agent_rocketride').map((c) => c.id));
		for (const provider of ['db_postgres', 'tool_chartjs']) {
			const comp = p.components.find((c) => c.provider === provider);
			if (!comp) return `no "${provider}" component found`;
			if (!(comp.control ?? []).some((ctl) => agentIds.has(ctl.from))) return `"${comp.id}" has no control connection from an agent`;
		}
		return null;
	},

	/** Mistake 7: one response_answers node with multiple inputs, not one response node per agent. */
	'single-response-multi-agent': (pipes) => {
		const p = pipes[0];
		const responses = p.components.filter((c) => c.provider === 'response_answers');
		if (responses.length !== 1) return `expected exactly 1 response_answers node, found ${responses.length}`;
		const inputs = responses[0].input ?? [];
		if (inputs.length < 2) return `"${responses[0].id}" has ${inputs.length} input(s) — expected multiple agent inputs on one response node`;
		return null;
	},

	/** Memory Requirements by Agent Type: only agent_rocketride has a memory port. */
	'no-memory-on-crewai-langchain': (pipes) => {
		const p = pipes[0];
		const otherAgentIds = new Set(p.components.filter((c) => c.provider === 'agent_crewai' || c.provider === 'agent_langchain').map((c) => c.id));
		for (const mem of p.components.filter((c) => c.provider === 'memory_internal')) {
			for (const ctl of mem.control ?? []) {
				if (otherAgentIds.has(ctl.from)) return `"${mem.id}" is wired to "${ctl.from}" — agent_crewai/agent_langchain have no memory port`;
			}
		}
		return null;
	},

	/** Control Connections: "a single LLM/tool/memory node can be shared by multiple invokers" — one llm, one control entry per agent. */
	'shared-llm-multi-control': (pipes) => {
		const p = pipes[0];
		const llms = p.components.filter((c) => c.provider.startsWith('llm_'));
		if (llms.length !== 1) return `expected exactly 1 shared llm_* node, found ${llms.length}`;
		const agentCount = p.components.filter((c) => ['agent_rocketride', 'agent_crewai', 'agent_langchain'].includes(c.provider)).length;
		const controlCount = (llms[0].control ?? []).length;
		if (controlCount < agentCount) return `"${llms[0].id}" has ${controlCount} control entries but ${agentCount} agents present`;
		return null;
	},

	/** Multi-Agent Pipelines: a sub-agent is invoked as a tool — control:[{classType:'tool', from:<parent>}] and no input lanes. */
	'hierarchical-control-chain': (pipes) => {
		const p = pipes[0];
		const agents = p.components.filter((c) => c.provider === 'agent_rocketride');
		const parent = agents.find((a) => !a.control || a.control.length === 0);
		const child = agents.find((a) => !!parent && (a.control ?? []).some((ctl) => ctl.classType === 'tool' && ctl.from === parent.id));
		if (!parent || !child) return 'expected a parent agent_rocketride and a sub-agent controlled as its tool';
		if (child.input && child.input.length > 0) return `"${child.id}" is invoked as a tool — it must have no input lanes`;
		return null;
	},

	/** Memory Requirements: each agent_rocketride owns exactly 1 memory_internal, never shared. */
	'each-agent-own-memory': (pipes) => {
		const p = pipes[0];
		const agents = p.components.filter((c) => c.provider === 'agent_rocketride');
		const memories = p.components.filter((c) => c.provider === 'memory_internal');
		const ownersOf = (agentId: string) => memories.filter((m) => (m.control ?? []).some((ctl) => ctl.classType === 'memory' && ctl.from === agentId));
		for (const agent of agents) {
			const owned = ownersOf(agent.id);
			if (owned.length !== 1) return `"${agent.id}" must control exactly 1 memory_internal, found ${owned.length}`;
		}
		for (const mem of memories) {
			const owners = (mem.control ?? []).filter((ctl) => ctl.classType === 'memory').map((ctl) => ctl.from);
			if (owners.length > 1) return `"${mem.id}" is shared by ${owners.length} agents — each agent must have its own memory`;
		}
		return null;
	},

	/** Mistake 1: a customized laneName must be restored to the lane's default key. */
	'response-key-default': (pipes) => {
		for (const p of pipes) {
			for (const c of p.components) {
				const def = DEFAULT_LANE_NAMES[c.provider];
				if (!def) continue;
				const laneName = (c.config as Record<string, unknown>)?.laneName;
				if (laneName !== undefined && laneName !== def) return `"${c.id}" laneName is "${String(laneName)}", expected default "${def}"`;
			}
		}
		return null;
	},

	/** D02: the fix must be scoped to the laneName field — at most 2 component ids may differ from the seed pipe. */
	'diff-scope-limited': (pipes) => {
		const p = pipes[0];
		const ids = new Set(p.components.map((c) => c.id));
		const diff = [...new Set([...ids, ...D02_SEED_IDS])].filter((id) => ids.has(id) !== D02_SEED_IDS.has(id));
		if (diff.length > 2) return `${diff.length} component id(s) differ from the seed pipe — fix should be scoped to laneName`;
		return null;
	},
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function scorePipe(pipes: Pipe[], brief: EvalBrief, validatePass: boolean, toolCalls: ToolCall[]): BriefResult {
	const structuralFailures: string[] = [];
	for (const checkName of brief.structural) {
		const check = structuralChecks[checkName];
		if (!check) {
			structuralFailures.push(`${checkName}: unknown structural check`);
			continue;
		}
		const failure = check(pipes, brief);
		if (failure) structuralFailures.push(`${checkName}: ${failure}`);
	}

	const totalNodes = pipes.reduce((sum, p) => sum + p.components.length, 0);
	const nodeCountOk = totalNodes >= brief.nodeCount[0] && totalNodes <= brief.nodeCount[1];
	const provOk = providersOk(pipes, brief);

	let pass = validatePass && structuralFailures.length === 0 && nodeCountOk && provOk;
	if (brief.minValidateCalls !== undefined) {
		const validateCalls = toolCalls.filter((t) => t.tool === 'validate_pipeline').length;
		if (validateCalls < brief.minValidateCalls) pass = false;
	}

	// Phase 5, 5.1c fix-up: `validatePass` above may itself have come from the stub engine's
	// local structural-check approximation (no recorded/live-engine verdict for this pipe digest)
	// rather than a real engine — `toolCalls` already carries that provenance per-call
	// (`ToolCall.approximated`, set by the runner's MCP tap), so surface it on the result instead
	// of silently letting an approximated `pass:true` read as a real engine verdict.
	const approximated = toolCalls.some((t) => t.tool === 'validate_pipeline' && t.approximated === true);

	return {
		briefId: brief.id,
		validatePass,
		structuralFailures,
		nodeCountOk,
		providersOk: provOk,
		toolCalls,
		pass,
		...(approximated ? { approximated: true } : {}),
	};
}

export function scoreSuite(mode: 'replay' | 'live', results: BriefResult[]): SuiteReport {
	const passRate = results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length;
	const approximatedCount = results.filter((r) => r.approximated).length;
	return { mode, results, passRate, gate: passRate >= 0.8, approximatedCount };
}
