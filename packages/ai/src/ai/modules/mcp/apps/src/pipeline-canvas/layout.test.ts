/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it } from 'vitest';

import { BAND_GAP, LAYER_GAP, NODE_GAP, layoutLayers, layoutPipeline, type LayoutSize } from './layout';

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
		const positions = layoutLayers(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }], fixed);

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
		const positions = layoutLayers(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'c', target: 'd' }], sizeOf);

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
		const positions = layoutLayers(['a'], [{ source: 'a', target: 'ghost' }, { source: 'a', target: 'a' }], fixed);

		expect(positions).toEqual({ a: { x: 0, y: 0 } });
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

	it('keeps two agents\' rows apart', () => {
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
		const positions = layoutPipeline(['x', 'y'], [{ source: 'x', target: 'y', control: true }, { source: 'y', target: 'x', control: true }], fixed);

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

	it('puts bands one under the other with the band gap', () => {
		const ids = chain(6);
		const positions = layoutPipeline(ids, links(ids), fixed, { width: 300, height: 2000 });
		const rows = [...new Set(Object.values(positions).map((p) => p.y))].sort((a, b) => a - b);

		expect(rows.length).toBeGreaterThan(1);
		expect(rows[1] - rows[0]).toBe(SIZE.height + BAND_GAP);
	});

	it('keeps an agent\'s row under its own band', () => {
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
		const positions = layoutPipeline(ids, edges, fixed, { width: 360, height: 900 });

		expect(positions.llm.x).toBe(positions.agent.x);
		expect(positions.llm.y).toBe(positions.agent.y + SIZE.height + LAYER_GAP);
		expect(overlaps(positions, fixed)).toBe(false);
	});
});
