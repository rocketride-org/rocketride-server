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
// CANVAS - NODE (a coloured circle with its caption underneath)
// =============================================================================
//
// Memoised and module-level, as React Flow's performance guidance asks: the
// component identity never changes, and a node only re-renders when its own
// data does (selection, focus, caption, colour).
//
// The hidden, centred handles exist because React Flow 12.3 only draws an edge
// whose two nodes expose a handle. The edge component ignores the handle
// coordinates and computes its own path from the circle's boundary
// (graph/geometry.ts).
// =============================================================================

import React, { memo } from 'react';
import type { CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { NODE_RADIUS } from '../graph/geometry';

/** Diameter of a node circle, in canvas units. */
export const NODE_DIAMETER = NODE_RADIUS * 2;

/** What a node renders. */
export interface IGraphNodeData extends Record<string, unknown> {
	caption: string;
	/** A CSS colour (`var(--rr-chart-*)` or `hsl(...)`). */
	fill: string;
	/** Text colour readable on the fill. */
	textColor: string;
	/** First character of the primary label: a cue that does not rely on colour. */
	initial: string;
	selected: boolean;
	expanded: boolean;
	/** The database answered for this id with a different element (or a write ran): the copy is out of date. */
	stale: boolean;
}

/** The React Flow node type of a graph node. */
export type GraphFlowNode = Node<IGraphNodeData, 'graphNode'>;

/** Handles are invisible and sit on the circle's centre. */
const HIDDEN_HANDLE: CSSProperties = {
	left: '50%',
	top: '50%',
	right: 'auto',
	bottom: 'auto',
	transform: 'translate(-50%, -50%)',
	width: 1,
	height: 1,
	minWidth: 1,
	minHeight: 1,
	opacity: 0,
	border: 'none',
	background: 'transparent',
	pointerEvents: 'none',
};

const styles = {
	root: { position: 'relative', width: NODE_DIAMETER, height: NODE_DIAMETER } as CSSProperties,
	circle: (fill: string, color: string): CSSProperties => ({
		width: NODE_DIAMETER,
		height: NODE_DIAMETER,
		borderRadius: '50%',
		background: fill,
		color,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 16,
		fontWeight: 700,
		boxSizing: 'border-box',
		userSelect: 'none',
	}),
};

/**
 * One node of the graph canvas.
 *
 * @param props - React Flow node props carrying {@link IGraphNodeData}.
 * @returns The node.
 */
function GraphNodeViewImpl({ data }: NodeProps<GraphFlowNode>): React.ReactElement {
	return (
		<div className="graph-ui-node" data-selected={data.selected ? 'true' : 'false'} data-expanded={data.expanded ? 'true' : 'false'} data-stale={data.stale ? 'true' : 'false'} style={styles.root}>
			<div className="graph-ui-circle" style={styles.circle(data.fill, data.textColor)} aria-hidden="true">
				{data.initial}
			</div>
			<div className="graph-ui-caption" aria-hidden="true">
				{data.caption}
			</div>
			<Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} isConnectable={false} />
			<Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} isConnectable={false} />
		</div>
	);
}

/** The memoised node component handed to React Flow's `nodeTypes`. */
export const GraphNodeView = memo(GraphNodeViewImpl);
