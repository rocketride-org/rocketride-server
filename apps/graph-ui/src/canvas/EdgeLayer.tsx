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
// CANVAS - EDGE LAYER (every relationship in ONE svg, behind the nodes)
// =============================================================================
//
// React Flow draws each edge as an element of its own: its own `<svg>`, its own wrapper,
// its own subscription to the store, re-evaluated on every store change (every pan step,
// every drag step), plus a compositing layer per edge. At 600 relationships that is the
// dominant cost of dragging a node and of a first paint (measured in a real shell: the
// browser spent more time assembling the layers than running any script).
//
// This layer draws all relationships into a single `<svg>` inside React Flow's viewport (so
// it pans and zooms with the nodes, with no work of its own while it does), behind the
// nodes. Each relationship is a small memoised component that receives only the numbers
// it draws from: it re-renders when one of ITS two ends moves, and not otherwise.
//
// Edges have no pointer behaviour and are not focusable: the keyboard and screen-reader
// path through the graph is the node-to-neighbour roving focus, and the Table lists every
// relationship. Each relationship is still exposed to assistive technology as an image
// named "TYPE from A to B", and shows its type as a tooltip whether or not its label is
// drawn.
// =============================================================================

import React, { memo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { edgeShape } from '../graph/geometry';
import type { IEdgeSlot, Point } from '../graph/geometry';
import type { GraphId } from '../graph/types';
import { NODE_DIAMETER } from './GraphNodeView';
import { ACCENT_TOKEN, EDGE_TOKEN } from './tokens';

/** One relationship as the layer draws it. */
export interface IEdgeDraw {
	id: string;
	source: GraphId;
	target: GraphId;
	/** Accessible name: `TYPE from A to B`. */
	ariaLabel: string;
	slot: IEdgeSlot;
	type: string;
	/** Draw in the brand colour (an end is selected, or it is on a found path). */
	highlighted: boolean;
	/** Draw dashed: the database answered with a different relationship under this id, or a write ran since. */
	stale: boolean;
}

/** What one relationship component takes: numbers and flat values, so memoisation is by value. */
interface IEdgeProps {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	slot: IEdgeSlot;
	type: string;
	ariaLabel: string;
	highlighted: boolean;
	stale: boolean;
}

/**
 * One relationship.
 *
 * @param props - Its two end centres and what it shows.
 * @returns The `<g>`.
 */
function EdgeShapeImpl({ ax, ay, bx, by, slot, type, ariaLabel, highlighted, stale }: IEdgeProps): React.ReactElement {
	const shape = edgeShape({ x: ax, y: ay }, { x: bx, y: by }, slot, NODE_DIAMETER / 2, NODE_DIAMETER / 2);
	const stroke = highlighted ? `var(${ACCENT_TOKEN})` : `var(${EDGE_TOKEN})`;
	return (
		<g className="graph-ui-edge" role="img" aria-label={ariaLabel} opacity={stale ? 0.55 : undefined}>
			<title>{type}</title>
			<path d={shape.path} fill="none" stroke={stroke} strokeWidth={highlighted ? 2 : 1.4} strokeDasharray={stale ? '5 4' : undefined} />
			<polygon points={shape.arrow} fill={stroke} />
			<text className="graph-ui-edge-label" x={shape.label.x} y={shape.label.y} transform={`rotate(${shape.labelAngle} ${shape.label.x} ${shape.label.y})`} textAnchor="middle" dominantBaseline="central">
				{type}
			</text>
		</g>
	);
}

/** The memoised relationship. Its slot is compared by value, so a rebuilt list with nothing changed redoes nothing. */
const EdgeShape = memo(EdgeShapeImpl, (a, b) => a.ax === b.ax && a.ay === b.ay && a.bx === b.bx && a.by === b.by && a.type === b.type && a.ariaLabel === b.ariaLabel && a.highlighted === b.highlighted && a.stale === b.stale && a.slot.index === b.slot.index && a.slot.count === b.slot.count && a.slot.reversed === b.slot.reversed && a.slot.loop === b.slot.loop);

/** Props. */
export interface IEdgeLayerProps {
	edges: readonly IEdgeDraw[];
	/** The centre of every drawn node, as it is on screen right now (a drag included). */
	centers: ReadonlyMap<GraphId, Point>;
}

/**
 * Every relationship, in one svg behind the nodes.
 *
 * @param props - See {@link IEdgeLayerProps}.
 * @returns The layer, rendered into React Flow's viewport.
 */
export function EdgeLayer({ edges, centers }: IEdgeLayerProps): React.ReactElement {
	return (
		<ViewportPortal>
			<svg className="graph-ui-edge-layer" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
				{edges.map((edge) => {
					const a = centers.get(edge.source);
					const b = centers.get(edge.target);
					if (!a || !b) return null;
					return <EdgeShape key={edge.id} ax={a.x} ay={a.y} bx={b.x} by={b.y} slot={edge.slot} type={edge.type} ariaLabel={edge.ariaLabel} highlighted={edge.highlighted} stale={edge.stale} />;
				})}
			</svg>
		</ViewportPortal>
	);
}
