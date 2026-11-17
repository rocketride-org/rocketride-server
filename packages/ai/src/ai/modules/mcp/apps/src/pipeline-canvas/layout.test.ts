/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it } from 'vitest';

import { BAND_GAP, LAYER_GAP, NODE_GAP, edgesThroughNodes, layoutLayers, layoutPipeline, type LayoutSize } from './layout';

const SIZE: LayoutSize = { width: 100, height: 40 };
const fixed = () => SIZE;

function overlaps(positions: Record<string, { x: number; y: number }>, sizeOf: (id: string) => LayoutSize): boolean {
	const ids = Object.keys(positions);
	return ids.some((a, i) =>
		ids.slice(i + 1).some((b) => {
			const pa = positions[a];
			const pb = positions[b];
			const sa = sizeOf(a);
			const sb = sizeOf(b);
			return pa.x < pb.x + sb.width && pb.x < pa.x + sa.width && pa.y < pb.y + sb.height && pb.y < pa.y + sa.height;
		})
	);
}

describe('layoutLayers', () => {
	it('places a chain left to right, one layer apart', () => {
		const positions = layoutLayers(
			['a', 'b', 'c'],
			[
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
			],
			fixed
		);

		expect(positions.a).toEqual({ x: 0, y: 0 });
		expect(positions.b).toEqual({ x: SIZE.width + LAYER_GAP, y: 0 });
		expect(positions.c).toEqual({ x: 2 * (SIZE.width + LAYER_GAP), y: 0 });
	});

	it('uses the longest path from a source for the layer', () => {
		// a -> b -> c, and a -> c directly: c still goes after b.
		const positions = layoutLayers(
			['a', 'b', 'c'],
			[
				{ source: 'a', target: 'c' },
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
			],
			fixed
		);

		expect(positions.c.x).toBeGreaterThan(positions.b.x);
	});

	it('stacks a layer with the node gap, centred on the tallest layer, in file order', () => {
		const positions = layoutLayers(
			['src', 'x', 'y', 'z'],
			[
				{ source: 'src', target: 'x' },
				{ source: 'src', target: 'y' },
				{ source: 'src', target: 'z' },
			],
			fixed
		);

		expect([positions.x.y, positions.y.y, positions.z.y]).toEqual([0, SIZE.height + NODE_GAP, 2 * (SIZE.height + NODE_GAP)]);
		const tallest = 3 * SIZE.height + 2 * NODE_GAP;
		expect(positions.src.y).toBe((tallest - SIZE.height) / 2);
	});

	it('never overlaps nodes of different sizes', () => {
		const sizes: Record<string, LayoutSize> = { a: { width: 220, height: 160 }, b: { width: 120, height: 40 }, c: { width: 180, height: 90 }, d: { width: 90, height: 300 } };
		const sizeOf = (id: string) => sizes[id];
		const positions = layoutLayers(
			['a', 'b', 'c', 'd'],
			[
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'c' },
				{ source: 'c', target: 'd' },
			],
			sizeOf
		);

		expect(overlaps(positions, sizeOf)).toBe(false);
	});

	it('finishes on a cycle and still places every node', () => {
		const positions = layoutLayers(
			['a', 'b', 'c'],
			[
				{ source: 'a', target: 'b' },
				{ source: 'b', target: 'c' },
				{ source: 'c', target: 'a' },
			],
			fixed
		);

		expect(Object.keys(positions).sort()).toEqual(['a', 'b', 'c']);
		expect(overlaps(positions, fixed)).toBe(false);
	});

	it('ignores edges to unknown nodes and self loops', () => {
		const positions = layoutLayers(
			['a'],
			[
				{ source: 'a', target: 'ghost' },
				{ source: 'a', target: 'a' },
			],
			fixed
		);

		expect(positions).toEqual({ a: { x: 0, y: 0 } });
	});

	it('orders a column by the rows of the nodes that feed it', () => {
		// b2 is fed by the top node, b1 by the bottom one: b2 goes on top.
		const positions = layoutLayers(
			['a1', 'a2', 'b1', 'b2'],
			[
				{ source: 'a1', target: 'b2' },
				{ source: 'a2', target: 'b1' },
			],
			fixed
		);

		expect(positions.b2.y).toBeLessThan(positions.b1.y);
	});

	it('places 200 disconnected nodes in one column without overlap', () => {
		const ids = Array.from({ length: 200 }, (_, i) => `n${i}`);
		const positions = layoutLayers(ids, [], fixed);

		expect(new Set(ids.map((id) => positions[id].x))).toEqual(new Set([0]));
		expect(overlaps(positions, fixed)).toBe(false);
	});
});

describe('layoutPipeline', () => {
	it('puts what an agent invokes in a row under the agent', () => {
		const positions = layoutPipeline(
			['chat', 'agent', 'llm', 'memory', 'tool', 'answers'],
			[
				{ source: 'chat', target: 'agent' },
				{ source: 'agent', target: 'answers' },
				{ source: 'agent', target: 'llm', control: true },
				{ source: 'agent', target: 'memory', control: true },
				{ source: 'agent', target: 'tool', control: true },
			],
			fixed
		);

		const rowY = positions.chat.y + SIZE.height + LAYER_GAP;
		expect([positions.llm, positions.memory, positions.tool]).toEqual([
			{ x: positions.agent.x, y: rowY },
			{ x: positions.agent.x + SIZE.width + NODE_GAP, y: rowY },
			{ x: positions.agent.x + 2 * (SIZE.width + NODE_GAP), y: rowY },
		]);
		expect(positions.answers.x).toBeGreaterThan(positions.agent.x);
		expect(overlaps(positions, fixed)).toBe(false);
	});

	it("keeps two agents' rows apart", () => {
		const ids = ['chat', 'a1', 'a2', 'l1', 't1', 'l2'];
		const positions = layoutPipeline(
			ids,
			[
				{ source: 'chat', target: 'a1' },
				{ source: 'chat', target: 'a2' },
				{ source: 'a1', target: 'l1', control: true },
				{ source: 'a1', target: 't1', control: true },
				{ source: 'a2', target: 'l2', control: true },
			],
			fixed
		);

		expect(overlaps(positions, fixed)).toBe(false);
	});

	it('follows an invoked node that invokes another back to the agent', () => {
		const positions = layoutPipeline(
			['agent', 'subagent', 'llm'],
			[
				{ source: 'agent', target: 'subagent', control: true },
				{ source: 'subagent', target: 'llm', control: true },
			],
			fixed
		);

		expect(positions.subagent.y).toBe(positions.llm.y);
		expect(positions.subagent.x).toBe(positions.agent.x);
		expect(overlaps(positions, fixed)).toBe(false);
	});

	it('treats a node with a data input as part of the data flow even when it is invoked', () => {
		const positions = layoutPipeline(
			['a', 'b'],
			[
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'b', control: true },
			],
			fixed
		);

		expect(positions.b).toEqual({ x: SIZE.width + LAYER_GAP, y: 0 });
	});

	it('keeps an invoked node that sends data in the data flow, after its invoker', () => {
		// The shape of a pipeline tool: the agent invokes it, and it feeds a sub-flow.
		const positions = layoutPipeline(
			['chat', 'agent', 'llm', 'pipe_tool', 'branch', 'answers'],
			[
				{ source: 'chat', target: 'agent' },
				{ source: 'agent', target: 'llm', control: true },
				{ source: 'agent', target: 'pipe_tool', control: true },
				{ source: 'pipe_tool', target: 'branch' },
				{ source: 'branch', target: 'answers' },
			],
			fixed
		);

		expect(positions.pipe_tool.x).toBeGreaterThan(positions.agent.x);
		expect(positions.branch.x).toBeGreaterThan(positions.pipe_tool.x);
		expect(positions.llm.x).toBe(positions.agent.x);
		expect(positions.llm.y).toBeGreaterThan(positions.agent.y);
		expect(overlaps(positions, fixed)).toBe(false);
	});

	it('lays out a graph of invoked nodes only', () => {
		const positions = layoutPipeline(
			['x', 'y'],
			[
				{ source: 'x', target: 'y', control: true },
				{ source: 'y', target: 'x', control: true },
			],
			fixed
		);

		expect(Object.keys(positions).sort()).toEqual(['x', 'y']);
		expect(overlaps(positions, fixed)).toBe(false);
	});
});

describe('layoutPipeline in a frame', () => {
	const chain = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
	const links = (ids: string[]) => ids.slice(1).map((id, i) => ({ source: ids[i], target: id }));
	const zoomIn = (positions: Record<string, { x: number; y: number }>, frame: LayoutSize) => {
		const w = Math.max(...Object.values(positions).map((p) => p.x)) + SIZE.width;
		const h = Math.max(...Object.values(positions).map((p) => p.y)) + SIZE.height;
		return Math.min(frame.width / w, frame.height / h);
	};

	it('wraps only when one band would be too small to read', () => {
		const ids = chain(5);
		// One band of 5 is 820 px wide: zoom 0.24 in 200 px, still readable with labels, so it stays one band.
		expect(new Set(Object.values(layoutPipeline(ids, links(ids), fixed, { width: 200, height: 560 })).map((p) => p.y)).size).toBe(1);
		// In 140 px it would be zoom 0.17, so it wraps.
		expect(new Set(Object.values(layoutPipeline(ids, links(ids), fixed, { width: 140, height: 560 })).map((p) => p.y)).size).toBeGreaterThan(1);
	});

	it('wraps a long flow into bands so it is drawn larger', () => {
		const ids = chain(12);
		const frame = { width: 360, height: 560 };
		const one = layoutPipeline(ids, links(ids), fixed);
		const wrapped = layoutPipeline(ids, links(ids), fixed, frame);

		expect(zoomIn(wrapped, frame)).toBeGreaterThan(zoomIn(one, frame) * 2);
		expect(new Set(Object.values(wrapped).map((p) => p.y)).size).toBeGreaterThan(1);
		expect(overlaps(wrapped, fixed)).toBe(false);
	});

	it('keeps a short flow in one band', () => {
		const ids = chain(3);
		const positions = layoutPipeline(ids, links(ids), fixed, { width: 740, height: 420 });

		expect(new Set(Object.values(positions).map((p) => p.y))).toEqual(new Set([0]));
	});

	it('makes even bands', () => {
		const ids = chain(8);
		const positions = layoutPipeline(ids, links(ids), fixed, { width: 250, height: 900 });
		const rows = new Map<number, number>();
		for (const p of Object.values(positions)) rows.set(p.y, (rows.get(p.y) ?? 0) + 1);

		expect([...rows.values()]).toEqual([4, 4]);
	});

	it('cuts a band where the fewest edges cross', () => {
		// a feeds b and c (one column), both feed d, then a chain: d e f g h.
		// A cut after a or after b/c would carry two connections; a cut later carries one.
		const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
		const edges = [
			{ source: 'a', target: 'b' },
			{ source: 'a', target: 'c' },
			{ source: 'b', target: 'd' },
			{ source: 'c', target: 'd' },
			{ source: 'd', target: 'e' },
			{ source: 'e', target: 'f' },
			{ source: 'f', target: 'g' },
			{ source: 'g', target: 'h' },
		];
		const positions = layoutPipeline(ids, edges, fixed, { width: 180, height: 2000 });
		const band = (id: string) => Object.values(positions).filter((p) => p.y < positions[id].y - SIZE.height - NODE_GAP).length > 0;
		const across = edges.filter((e) => positions[e.target].y > positions[e.source].y + SIZE.height + BAND_GAP / 2);

		expect(new Set(Object.values(positions).map((p) => p.y)).size).toBeGreaterThan(1);
		expect(band('a')).toBe(false);
		expect(across.length).toBe(1);
		expect(edgesThroughNodes(positions, edges, fixed)).toBe(0);
	});

	it('puts an invoked node that sends data below the others in its column', () => {
		const positions = layoutPipeline(
			['chat', 'agent', 'tool', 'answers', 'branch'],
			[
				{ source: 'chat', target: 'agent' },
				{ source: 'agent', target: 'tool', control: true },
				{ source: 'agent', target: 'answers' },
				{ source: 'tool', target: 'branch' },
			],
			fixed
		);

		expect(positions.tool.x).toBe(positions.answers.x);
		expect(positions.tool.y).toBeGreaterThan(positions.answers.y);
	});

	it('puts bands one under the other with the band gap', () => {
		const ids = chain(6);
		const positions = layoutPipeline(ids, links(ids), fixed, { width: 180, height: 2000 });
		const rows = [...new Set(Object.values(positions).map((p) => p.y))].sort((a, b) => a - b);

		expect(rows.length).toBeGreaterThan(1);
		expect(rows[1] - rows[0]).toBe(SIZE.height + BAND_GAP);
	});

	it("keeps an agent's row under its own band", () => {
		const ids = ['chat', 'agent', 'llm', 'a2', 'a3', 'a4', 'a5', 'a6'];
		const edges = [
			{ source: 'chat', target: 'agent' },
			{ source: 'agent', target: 'a2' },
			{ source: 'a2', target: 'a3' },
			{ source: 'a3', target: 'a4' },
			{ source: 'a4', target: 'a5' },
			{ source: 'a5', target: 'a6' },
			{ source: 'agent', target: 'llm', control: true },
		];
		const positions = layoutPipeline(ids, edges, fixed, { width: 160, height: 900 });

		expect(positions.llm.x).toBe(positions.agent.x);
		expect(positions.llm.y).toBe(positions.agent.y + SIZE.height + LAYER_GAP);
		expect(overlaps(positions, fixed)).toBe(false);
	});
});

describe('edges and nodes', () => {
	// The shape of tool-pipe-diamond: an agent with an LLM and memory it invokes,
	// a pipeline tool it invokes that feeds two branches, a join, an LLM and answers.
	const sizes: Record<string, LayoutSize> = {};
	const ids = ['chat', 'agent', 'llm', 'memory', 'tool', 'branch_a', 'branch_b', 'join', 'sub_llm', 'sub_answers', 'answers'];
	for (const id of ids) sizes[id] = { width: 180, height: id === 'tool' || id.startsWith('branch') || id === 'join' ? 150 : id === 'llm' || id === 'memory' ? 60 : 90 };
	const sizeOf = (id: string) => sizes[id];
	const edges = [
		{ source: 'chat', target: 'agent' },
		{ source: 'agent', target: 'llm', control: true },
		{ source: 'agent', target: 'memory', control: true },
		{ source: 'agent', target: 'tool', control: true },
		{ source: 'tool', target: 'branch_a' },
		{ source: 'tool', target: 'branch_b' },
		{ source: 'branch_a', target: 'join' },
		{ source: 'branch_b', target: 'join' },
		{ source: 'join', target: 'sub_llm' },
		{ source: 'sub_llm', target: 'sub_answers' },
		{ source: 'agent', target: 'answers' },
	];

	it('counts a connection drawn through another node', () => {
		const positions = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 400, y: 0 } };
		expect(edgesThroughNodes(positions, [{ source: 'a', target: 'c' }], fixed)).toBe(1);
		expect(edgesThroughNodes(positions, [{ source: 'a', target: 'b' }], fixed)).toBe(0);
	});

	it.each([
		[760, 560],
		[390, 420],
		[1100, 700],
	])('draws no connection behind a node in a %i x %i frame', (width, height) => {
		const positions = layoutPipeline(ids, edges, sizeOf, { width, height });

		expect(edgesThroughNodes(positions, edges, sizeOf)).toBe(0);
		expect(overlaps(positions, sizeOf)).toBe(false);
	});
});
