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
// CANVAS — ER LAYOUT (elkjs layered auto-layout)
// =============================================================================
//
// Same engine and algorithm as the pipeline canvas's Tidy layout (elk
// 'layered', left-to-right), reduced to the flat ER case: no groups, node
// sizes derived from column counts.
// =============================================================================

import ELK from 'elkjs/lib/elk.bundled';
import type { Edge } from '@xyflow/react';
import type { ErNode } from './erModel';
import { NODE_WIDTH, nodeHeight } from './erModel';

// Single ELK instance — stateless between layout runs.
const elk = new ELK();

/**
 * Compute layered left-to-right positions for the diagram.
 *
 * @param nodes - The diagram nodes (positions ignored).
 * @param edges - The FK edges (drive the layering).
 * @returns The nodes with layouted positions.
 */
export async function layoutErNodes(nodes: ErNode[], edges: Edge[]): Promise<ErNode[]> {
	if (nodes.length === 0) return nodes;

	// Flat elk graph: one child per table, one edge per FK.
	const graph = {
		id: 'er-root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.spacing.nodeNode': '48',
			'elk.layered.spacing.nodeNodeBetweenLayers': '90',
			'elk.edgeRouting': 'ORTHOGONAL',
		},
		children: nodes.map((node) => ({
			id: node.id,
			width: NODE_WIDTH,
			height: nodeHeight(node.data.columns.length),
		})),
		edges: edges.map((edge) => ({
			id: edge.id,
			sources: [edge.source],
			targets: [edge.target],
		})),
	};

	let result;
	try {
		result = await elk.layout(graph);
	} catch (err) {
		// A layout rejection must not strand the diagram in its loading state —
		// fall back to the caller's positions and keep the canvas usable.
		console.log('[sql-ui] ER layout failed', err);
		return nodes;
	}

	// Map elk positions back onto the xyflow nodes.
	const positions = new Map((result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]));
	return nodes.map((node) => ({
		...node,
		position: positions.get(node.id) ?? node.position,
	}));
}
