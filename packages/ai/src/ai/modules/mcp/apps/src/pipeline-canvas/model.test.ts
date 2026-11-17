/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Tool result to nodes and edges, through the builder's own graph functions
 * (resolved with the canvas stand-ins, as in the bundle).
 */
import { describe, expect, it } from 'vitest';

import { CANVAS_META_KEY, UNKNOWN_ICON, buildCanvasModel, type ToolResultLike, type ViewPipelineSummary } from './model';

const SERVICES = {
	webhook: { title: 'Webhook', classType: ['source'], lanes: { _source: ['tags'] }, invoke: {}, capabilities: 0, icon: 'webhook.svg' },
	agent: { title: 'Agent', classType: ['agent'], lanes: { questions: ['answers'] }, invoke: { llm: {} }, capabilities: 0, icon: 'agent.svg' },
	llm_openai: { title: 'OpenAI', classType: ['llm'], lanes: {}, invoke: {}, capabilities: 1024, icon: 'openai.svg' },
};

const COMPONENTS = [
	{ id: 'webhook_1', provider: 'webhook', config: {}, ui: { position: { x: 0, y: 0 } } },
	{ id: 'agent_1', provider: 'agent', config: {}, input: [{ lane: 'questions', from: 'webhook_1' }], ui: { position: { x: 300, y: 0 } } },
	{ id: 'llm_1', provider: 'llm_openai', config: {}, control: [{ classType: 'llm', from: 'agent_1' }], ui: { position: { x: 300, y: 200 } } },
];

function summaryFor(components: typeof COMPONENTS, extra: Partial<ViewPipelineSummary> = {}): ViewPipelineSummary {
	return {
		ok: true,
		path: '.projects/demo.pipe',
		workspace: '.projects',
		name: 'Demo',
		description: '',
		node_count: components.length,
		truncated: false,
		nodes: components.map((c) => ({ id: c.id, provider: c.provider, title: c.provider })),
		connections: [
			{ from: 'webhook_1', to: 'agent_1', lane: 'questions' },
			{ from: 'agent_1', to: 'llm_1', control: 'llm' },
		],
		...extra,
	};
}

function result(summary: ViewPipelineSummary, meta?: Record<string, unknown>): ToolResultLike {
	return { content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary, _meta: meta, isError: !summary.ok };
}

const META = { [CANVAS_META_KEY]: { pipeline: { components: COMPONENTS }, services: SERVICES, icons: { 'webhook.svg': '<svg/>' } } };

describe('buildCanvasModel', () => {
	it('draws the widget payload with the builder graph functions', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS), META));

		expect(model.kind).toBe('graph');
		if (model.kind !== 'graph') return;
		expect(model.nodes.map((n) => [n.id, n.type, n.position])).toEqual([
			['webhook_1', 'default', { x: 0, y: 0 }],
			['agent_1', 'default', { x: 300, y: 0 }],
			['llm_1', 'default', { x: 300, y: 200 }],
		]);
		// Edge ids and handles exactly as the builder derives them (canvas/util/graph.ts).
		expect(model.edges.map((e) => [e.id, e.sourceHandle, e.targetHandle])).toEqual([
			['webhook_1::agent_1::questions', 'source-questions', 'target-questions'],
			['agent_1::llm_1::llm', 'invoke-source.llm', 'invoke-target'],
		]);
		expect(model.laidOut).toBe(false);
		expect(model.summaryOnly).toBe(false);
		expect(model.icons).toEqual({ 'webhook.svg': '<svg/>' });
	});

	it('makes every node and edge inert', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS), META));
		if (model.kind !== 'graph') throw new Error(model.kind);

		for (const item of [...model.nodes, ...model.edges] as Array<Record<string, unknown>>) {
			expect(item).toMatchObject({ draggable: false, selectable: false, deletable: false, connectable: false, focusable: false });
		}
	});

	it('lays out a pipeline saved without positions so no two nodes share a spot', () => {
		const bare = COMPONENTS.map(({ ui: _ui, ...rest }) => rest);
		const model = buildCanvasModel(result(summaryFor(COMPONENTS), { [CANVAS_META_KEY]: { pipeline: { components: bare }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.laidOut).toBe(true);
		const spots = new Set(model.nodes.map((n) => `${n.position.x},${n.position.y}`));
		expect(spots.size).toBe(3);
		const x = Object.fromEntries(model.nodes.map((n) => [n.id, n.position.x]));
		expect(x.webhook_1).toBeLessThan(x.agent_1);
		expect(x.agent_1).toBeLessThan(x.llm_1);
	});

	it('draws from the summary when the host dropped _meta', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS)));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.summaryOnly).toBe(true);
		expect(model.nodes.map((n) => n.id)).toEqual(['webhook_1', 'agent_1', 'llm_1']);
		expect(model.edges.map((e) => e.id).sort()).toEqual(['agent_1::llm_1::llm', 'webhook_1::agent_1::questions']);
		// No catalog: every provider gets a made-up entry with handles for its edges.
		expect(model.services.agent).toMatchObject({ title: 'agent', icon: UNKNOWN_ICON, lanes: { questions: [] }, invoke: { llm: {} } });
		expect(model.services.webhook).toMatchObject({ lanes: { _out: ['questions'] } });
		expect(model.services.llm_openai).toMatchObject({ capabilities: 1024 });
	});

	it('takes the payload from window.openai metadata when the result has none', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS)), META);
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.summaryOnly).toBe(false);
		expect(model.services.webhook).toEqual(SERVICES.webhook);
	});

	it('gives a provider missing from the catalog the fallback icon and its own name', () => {
		const components = [...COMPONENTS, { id: 'old_1', provider: 'retired_node', config: {}, input: [{ lane: 'answers', from: 'agent_1' }], ui: { position: { x: 600, y: 0 } } }];
		const model = buildCanvasModel(result(summaryFor(components), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.services.retired_node).toMatchObject({ title: 'retired_node', icon: UNKNOWN_ICON, lanes: { answers: [] } });
		// Known providers keep their real entry.
		expect(model.services.agent).toEqual(SERVICES.agent);
	});

	it('puts a group before its children', () => {
		const components = [
			{
				id: 'group_1',
				provider: 'group',
				config: { pipeline: { components: [{ id: 'child', provider: 'webhook', config: {}, ui: { parentId: 'group_1', position: { x: 10, y: 10 } } }] } },
				ui: { nodeType: 'group', position: { x: 0, y: 0 } },
			},
		];
		const model = buildCanvasModel(result(summaryFor(components as never), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.nodes.map((n) => [n.id, n.type, n.parentId])).toEqual([
			['group_1', 'group', undefined],
			['child', 'default', 'group_1'],
		]);
	});

	it('reports an empty pipeline', () => {
		const empty = summaryFor([], { nodes: [], connections: [], node_count: 0 });
		expect(buildCanvasModel(result(empty, { [CANVAS_META_KEY]: { pipeline: { components: [] } } })).kind).toBe('empty');
		expect(buildCanvasModel(result(empty)).kind).toBe('empty');
	});

	it('shows the message and the hint of a tool error', () => {
		const error = { ok: false, error_type: 'NotFound', message: 'No pipeline file at .projects/x.pipe.', hint: 'Call store_list with path .projects to see the saved pipelines.' };

		expect(buildCanvasModel(result(error))).toEqual({ kind: 'error', message: error.message, hint: error.hint });
	});

	it('reads the summary from the text block when structuredContent is missing', () => {
		const summary = summaryFor(COMPONENTS);
		const model = buildCanvasModel({ content: [{ type: 'text', text: JSON.stringify(summary) }], _meta: META });

		expect(model.kind).toBe('graph');
	});

	it('reports a result it cannot read', () => {
		expect(buildCanvasModel({ content: [{ type: 'text', text: 'not json' }] }).kind).toBe('error');
		expect(buildCanvasModel({}).kind).toBe('error');
	});

	it('ignores a malformed payload and falls back to the summary', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS), { [CANVAS_META_KEY]: { pipeline: { components: 'nope' } } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.summaryOnly).toBe(true);
	});
});
