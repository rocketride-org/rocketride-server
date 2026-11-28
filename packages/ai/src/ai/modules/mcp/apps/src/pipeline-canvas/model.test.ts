/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Tool result to nodes and edges, through the builder's own graph functions
 * (resolved with the canvas stand-ins, as in the bundle).
 */
import { describe, expect, it } from 'vitest';

import { CANVAS_META_KEY, UNKNOWN_ICON, buildCanvasModel, displayPath, formatBytes, type ToolResultLike, type ViewPipelineSummary } from './model';

const SERVICES = {
	webhook: { title: 'Webhook', classType: ['source'], lanes: { _source: ['questions'] }, invoke: {}, capabilities: 0, icon: 'webhook.svg' },
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
		const at = Object.fromEntries(model.nodes.map((n) => [n.id, n.position]));
		// Data flows left to right; the LLM the agent invokes sits under the agent.
		expect(at.webhook_1.x).toBeLessThan(at.agent_1.x);
		expect(at.llm_1.x).toBe(at.agent_1.x);
		expect(at.llm_1.y).toBeGreaterThan(at.agent_1.y);
	});

	it('drops the preset size React Flow would mistake for a measurement, and sizes a group from its file', () => {
		const components = [
			{ id: 'group_1', provider: 'group', config: {}, ui: { nodeType: 'group', position: { x: 0, y: 0 }, measured: { width: 420, height: 220 } } },
			{ id: 'n1', provider: 'webhook', config: {}, ui: { position: { x: 500, y: 0 }, measured: { width: 150, height: 36 } } },
		];
		const model = buildCanvasModel(result(summaryFor(components as never), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		const [group, node] = model.nodes as unknown as Array<Record<string, unknown>>;
		expect(group).toMatchObject({ width: 420, height: 220 });
		expect(group.measured).toBeUndefined();
		expect(node.measured).toBeUndefined();
		expect(node.width).toBeUndefined();
	});

	it('leaves out a note with no text, which would only show an edit prompt', () => {
		const components = [...COMPONENTS, { id: 'note_1', provider: 'annotation', config: {}, ui: { nodeType: 'annotation', position: { x: 0, y: 400 } } }, { id: 'note_2', provider: 'annotation', config: { content: 'Keep me' }, ui: { nodeType: 'annotation', position: { x: 300, y: 400 } } }];
		const model = buildCanvasModel(result(summaryFor(components as never), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.nodes.map((n) => n.id)).toEqual(['webhook_1', 'agent_1', 'llm_1', 'note_2']);
	});

	it('draws from the summary when the host dropped _meta', () => {
		const model = buildCanvasModel(result(summaryFor(COMPONENTS)));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.summaryOnly).toBe(true);
		expect(model.nodes.map((n) => n.id)).toEqual(['webhook_1', 'agent_1', 'llm_1']);
		expect(model.edges.map((e) => e.id).sort()).toEqual(['agent_1::llm_1::llm', 'webhook_1::agent_1::questions']);
		// No catalog: every provider gets a made-up entry with handles for its edges.
		expect(model.services.agent).toMatchObject({ title: 'agent', icon: UNKNOWN_ICON, lanes: { questions: [] }, invoke: { llm: {} } });
		expect(model.services.webhook).toMatchObject({ lanes: { _extra: ['questions'] } });
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

	it('draws each node once when a damaged file puts nodes inside themselves', () => {
		const components = [
			{ id: 'a', provider: 'webhook', config: {}, ui: { parentId: 'a' } },
			{ id: 'b', provider: 'webhook', config: {}, ui: { parentId: 'c', position: { x: 0, y: 0 } } },
			{ id: 'c', provider: 'webhook', config: {}, ui: { parentId: 'b', position: { x: 300, y: 0 } } },
		];
		const model = buildCanvasModel(result(summaryFor(components as never), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		// The link that closes each loop is dropped; the rest still puts a parent first.
		expect(model.nodes.map((n) => [n.id, n.parentId])).toEqual([
			['a', undefined],
			['c', undefined],
			['b', 'c'],
		]);

		// Without saved positions the widget lays the nodes out itself.
		const bare = buildCanvasModel(result(summaryFor([components[0]] as never), { [CANVAS_META_KEY]: { pipeline: { components: [components[0]] }, services: SERVICES } }));
		if (bare.kind !== 'graph') throw new Error(bare.kind);
		expect(bare.nodes.map((n) => n.id)).toEqual(['a']);
	});

	it('reports an empty pipeline', () => {
		const empty = summaryFor([], { nodes: [], connections: [], node_count: 0 });
		expect(buildCanvasModel(result(empty, { [CANVAS_META_KEY]: { pipeline: { components: [] } } })).kind).toBe('empty');
		expect(buildCanvasModel(result(empty)).kind).toBe('empty');
	});

	it('tells the person what went wrong, not the model', () => {
		const base = { ok: false, path: '@/Team/=team_A/.projects/sub/x.pipe', workspace: '@/Team/=team_A/.projects' };
		const cases: Array<[Record<string, unknown>, { message: string; hint?: string }]> = [
			[
				{ error_type: 'NotFound', message: 'No pipeline file at ...', hint: 'Call store_list with path ...' },
				{ message: 'There is no pipeline at sub/x.pipe.', hint: 'Ask to see your saved pipelines.' },
			],
			[
				{ error_type: 'AccessDenied', path: '@/Team/=team_B/.projects/y.pipe' },
				{ message: "You don't have access to y.pipe.", hint: 'Ask to see the pipelines you can open.' },
			],
			[
				{ error_type: 'PipelineTooLarge', size: 2_200_033 },
				{ message: 'sub/x.pipe is too large to show here (2.1 MB). The limit is 2 MB.', hint: 'Open it in the builder instead.' },
			],
			[{ error_type: 'InvalidPipeline' }, { message: "sub/x.pipe isn't a pipeline file, or it is damaged.", hint: 'Open it in the builder to check it.' }],
			[
				{ error_type: 'InvalidPath', path: '' },
				{ message: 'Only pipeline files (.pipe or .pipe.json) in your workspace can be shown.', hint: 'Ask to see your saved pipelines.' },
			],
			[{ error_type: 'Timeout', message: 'view_pipeline timed out waiting for the engine at @/Team/=team_A/.projects' }, { message: 'view_pipeline timed out waiting for the engine at .projects' }],
		];
		for (const [fields, expected] of cases) {
			const model = buildCanvasModel(result({ ...base, ...fields } as never));
			expect(model).toEqual({ kind: 'error', ...expected });
			// Nothing addressed to the model, and no team id, reaches the person.
			expect(JSON.stringify(model)).not.toMatch(/store_list|team_A|team_B/);
		}
	});

	it('marks providers this engine does not have, and draws a connection the catalog does not declare', () => {
		const components = [...COMPONENTS, { id: 'mem_1', provider: 'memory_internal', config: {}, control: [{ classType: 'memory', from: 'agent_1' }], ui: { position: { x: 600, y: 200 } } }];
		const model = buildCanvasModel(result(summaryFor(components as never), { [CANVAS_META_KEY]: { pipeline: { components }, services: SERVICES } }));
		if (model.kind !== 'graph') throw new Error(model.kind);

		expect(model.missingProviders).toEqual(['memory_internal']);
		expect((model.nodes.find((n) => n.id === 'mem_1') as unknown as { className?: string }).className).toBe('rr-node-missing');
		expect((model.nodes.find((n) => n.id === 'agent_1') as unknown as { className?: string }).className).toBeUndefined();
		// The agent declares only an llm channel; the file also invokes its memory.
		expect(model.services.agent).toMatchObject({ title: 'Agent', invoke: { llm: {}, memory: {} } });
		expect(model.edges.map((e) => e.sourceHandle)).toContain('invoke-source.memory');
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

describe('formatBytes', () => {
	it('reads as a person would', () => {
		expect(formatBytes(2_200_033)).toBe('2.1 MB');
		expect(formatBytes(2_097_152)).toBe('2 MB');
		expect(formatBytes(640_000)).toBe('625 KB');
		expect(formatBytes(12)).toBe('12 bytes');
	});
});

describe('displayPath', () => {
	it('shows the file as the builder lists it: relative to the workspace', () => {
		expect(displayPath('@/Team/=team_A/.projects/sub/invoices.pipe', '@/Team/=team_A/.projects')).toBe('sub/invoices.pipe');
		expect(displayPath('.projects/invoices.pipe', '.projects')).toBe('invoices.pipe');
		// Another team's file, opened by its full path.
		expect(displayPath('@/Team/=team_B/.projects/shared.pipe', '@/Team/=team_A/.projects')).toBe('shared.pipe');
		expect(displayPath('odd/path.pipe', '.projects')).toBe('odd/path.pipe');
		expect(displayPath(undefined, '.projects')).toBe('');
	});
});
