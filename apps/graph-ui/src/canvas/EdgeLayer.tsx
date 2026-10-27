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
// Relationships can be clicked and right-clicked, but React Flow never sees them (it is
// given no edges), so its edge events cannot fire. Each relationship therefore carries
// its own HIT PATH: the same curve, invisible, the only part of the layer the pointer can
// hit (the visible line, arrow and label stay out of hit-testing). It is at least 12
// SCREEN pixels wide at any zoom: 12 canvas units from normal size up, and wider as the
// view zooms out (a stylesheet variable the canvas keeps in step with the zoom, see
// edgeHitWidth in stable.ts; the `strokeWidth` here is only the fallback). The hit paths
// exist only when the view handles a click or a menu. The handlers are the same two
// functions for every relationship, so a click changes nothing here.
//
// Edges are not focusable: the keyboard path to a relationship is R on a node (keynav.ts),
// which selects its relationships in turn, and the Table lists every relationship. Each
// relationship is still exposed to assistive technology as an image named "TYPE from A to
// B", and shows its type as a tooltip whether or not its label is drawn.
// =============================================================================

import React, { memo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { edgeShape } from '../graph/geometry';
import type { IEdgeSlot, Point } from '../graph/geometry';
import type { GraphId } from '../graph/types';
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
	/** The selected relationship: drawn in the accent, thicker still, with a halo. */
	selected: boolean;
	/** Draw dashed: the database answered with a different relationship under this id, or a write ran since. */
	stale: boolean;
	/** Drawn faint: not on the shown path, or between nodes a search left out. */
	dim: boolean;
	/** The relationship type's colour, or null for the ordinary line colour. */
	color: string | null;
	/** Radii of the start and end circles (a label's size). */
	sourceRadius: number;
	targetRadius: number;
}

/**
 * The stroke of a relationship. The accent marks a found path or a selected end, and the selected relationship
 * itself; each is ALSO thicker than an ordinary line, so the difference never rests on colour alone.
 *
 * @param edge - Whether it is highlighted or selected, and its type colour.
 * @returns The CSS colour and the line width.
 */
export function edgePaint(edge: Pick<IEdgeDraw, 'highlighted' | 'selected' | 'color'>): { stroke: string; width: number } {
	if (edge.selected) return { stroke: `var(${ACCENT_TOKEN})`, width: 3 };
	if (edge.highlighted) return { stroke: `var(${ACCENT_TOKEN})`, width: 2 };
	return { stroke: edge.color ?? `var(${EDGE_TOKEN})`, width: 1.4 };
}

/** What a click or a menu on a relationship calls (one function for every relationship). */
export type EdgePointerHandler = (id: GraphId, event: React.MouseEvent<SVGPathElement>) => void;

/** What one relationship component takes: numbers and flat values, so memoisation is by value. */
export interface IEdgeProps {
	id: string;
	ax: number;
	ay: number;
	bx: number;
	by: number;
	ar: number;
	br: number;
	slot: IEdgeSlot;
	type: string;
	ariaLabel: string;
	highlighted: boolean;
	selected: boolean;
	stale: boolean;
	dim: boolean;
	color: string | null;
	onClick?: EdgePointerHandler;
	onContextMenu?: EdgePointerHandler;
}

/** Opacity of a dimmed relationship, and of an out-of-date one. */
const DIM_OPACITY = 0.2;
const STALE_OPACITY = 0.55;

/**
 * One relationship. It uses no hooks, so a test can render it by calling it.
 *
 * @param props - Its two end centres and radii, and what it shows.
 * @returns The `<g>`.
 */
export function EdgeShapeImpl({ id, ax, ay, bx, by, ar, br, slot, type, ariaLabel, highlighted, selected, stale, dim, color, onClick, onContextMenu }: IEdgeProps): React.ReactElement {
	const shape = edgeShape({ x: ax, y: ay }, { x: bx, y: by }, slot, ar, br);
	const { stroke, width } = edgePaint({ highlighted, selected, color });
	const opacity = dim ? DIM_OPACITY : stale ? STALE_OPACITY : undefined;
	return (
		<g className="graph-ui-edge" role="img" aria-label={ariaLabel} opacity={opacity} data-selected={selected ? 'true' : undefined}>
			<title>{type}</title>
			{selected && <path d={shape.path} fill="none" stroke={stroke} strokeOpacity={0.25} strokeWidth={9} strokeLinecap="round" />}
			<path d={shape.path} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={stale ? '5 4' : undefined} />
			<polygon points={shape.arrow} fill={stroke} />
			<text className="graph-ui-edge-label" x={shape.label.x} y={shape.label.y} transform={`rotate(${shape.labelAngle} ${shape.label.x} ${shape.label.y})`} textAnchor="middle" dominantBaseline="central">
				{type}
			</text>
			{(onClick || onContextMenu) && <path className="graph-ui-edge-hit" d={shape.path} fill="none" stroke="transparent" strokeWidth={12} aria-hidden="true" onClick={onClick && ((event) => onClick(id, event))} onContextMenu={onContextMenu && ((event) => onContextMenu(id, event))} />}
		</g>
	);
}

/** The memoised relationship. Its slot is compared by value, so a rebuilt list with nothing changed redoes nothing. */
const EdgeShape = memo(
	EdgeShapeImpl,
	(a, b) =>
		a.id === b.id &&
		a.ax === b.ax &&
		a.ay === b.ay &&
		a.bx === b.bx &&
		a.by === b.by &&
		a.ar === b.ar &&
		a.br === b.br &&
		a.type === b.type &&
		a.ariaLabel === b.ariaLabel &&
		a.highlighted === b.highlighted &&
		a.selected === b.selected &&
		a.stale === b.stale &&
		a.dim === b.dim &&
		a.color === b.color &&
		a.onClick === b.onClick &&
		a.onContextMenu === b.onContextMenu &&
		a.slot.index === b.slot.index &&
		a.slot.count === b.slot.count &&
		a.slot.reversed === b.slot.reversed &&
		a.slot.loop === b.slot.loop
);

/** Props. */
export interface IEdgeLayerProps {
	edges: readonly IEdgeDraw[];
	/** The centre of every drawn node, as it is on screen right now (a drag included). */
	centers: ReadonlyMap<GraphId, Point>;
	/** A relationship was clicked; absent: relationships take no pointer events at all. */
	onEdgeClick?: EdgePointerHandler;
	/** A context menu was asked for on a relationship. */
	onEdgeContextMenu?: EdgePointerHandler;
}

/**
 * Every relationship, in one svg behind the nodes.
 *
 * @param props - See {@link IEdgeLayerProps}.
 * @returns The layer, rendered into React Flow's viewport.
 */
export function EdgeLayer({ edges, centers, onEdgeClick, onEdgeContextMenu }: IEdgeLayerProps): React.ReactElement {
	return (
		<ViewportPortal>
			<svg className="graph-ui-edge-layer" style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
				{edges.map((edge) => {
					const a = centers.get(edge.source);
					const b = centers.get(edge.target);
					if (!a || !b) return null;
					return (
						<EdgeShape
							key={edge.id}
							id={edge.id}
							ax={a.x}
							ay={a.y}
							bx={b.x}
							by={b.y}
							ar={edge.sourceRadius}
							br={edge.targetRadius}
							slot={edge.slot}
							type={edge.type}
							ariaLabel={edge.ariaLabel}
							highlighted={edge.highlighted}
							selected={edge.selected}
							stale={edge.stale}
							dim={edge.dim}
							color={edge.color}
							onClick={onEdgeClick}
							onContextMenu={onEdgeContextMenu}
						/>
					);
				})}
			</svg>
		</ViewportPortal>
	);
}
