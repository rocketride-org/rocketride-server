/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it } from 'vitest';

import { LAYER_GAP, NODE_GAP, layoutLayers, type LayoutSize } from './layout';

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
