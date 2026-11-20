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
// GRAPH-UI - SCHEMA GRAPH (a static picture of the labels and how they connect)
// =============================================================================
//
// One circle per label, in the label's colour, on a ring, and one arrow per
// relationship pattern the schema saw. It is drawn from the model in
// graph/overview.ts: no layout engine, no canvas, no request. A pattern the node
// inferred rather than saw is dashed. The cards and the table beside it say the same
// things in text, so the picture is named for assistive technology but not walked.
// =============================================================================

import React, { useId } from 'react';
import type { IGraphEdgeShape, IGraphNodeShape, OverviewGraph } from '../graph/overview';

/** The longest caption drawn; the full text is in the circle's title. */
const CAPTION_CHARS = 24;

/**
 * Cut a caption to fit under its circle.
 *
 * @param text - The caption.
 * @returns The caption, or its start and an ellipsis.
 */
function fit(text: string): string {
	return text.length <= CAPTION_CHARS ? text : `${text.slice(0, CAPTION_CHARS - 1)}…`;
}

/** One arrow and its type name. */
const Edge: React.FC<{ edge: IGraphEdgeShape; arrow: string }> = ({ edge, arrow }) => (
	<g>
		<title>{`${edge.from} -[${edge.type}]-> ${edge.to}${edge.observed ? '' : ' (inferred, not seen in data)'}`}</title>
		<path d={edge.path} fill="none" stroke="var(--rr-text-secondary)" strokeWidth={1.4} strokeDasharray={edge.observed ? undefined : '4 3'} markerEnd={`url(#${arrow})`} />
		<text x={edge.labelX} y={edge.labelY} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="var(--rr-text-secondary)" stroke="var(--rr-bg-paper)" strokeWidth={3} paintOrder="stroke">
			{fit(edge.type)}
		</text>
	</g>
);

/** One label's circle and caption. */
const Node: React.FC<{ node: IGraphNodeShape }> = ({ node }) => (
	<g>
		<title>{node.caption}</title>
		<circle cx={node.x} cy={node.y} r={node.r} fill={node.fill} stroke="var(--rr-border)" strokeWidth={1} />
		<text x={node.x} y={node.y + node.r + 13} textAnchor="middle" fontSize={11} fill="var(--rr-text-primary)">
			{fit(node.caption)}
		</text>
	</g>
);

/** Props. */
export interface ISchemaGraphProps {
	graph: Extract<OverviewGraph, { kind: 'drawn' }>;
}

/**
 * The schema graph.
 *
 * @param props - See {@link ISchemaGraphProps}.
 * @returns The picture.
 */
export const SchemaGraph: React.FC<ISchemaGraphProps> = ({ graph }) => {
	// Several Overviews stay mounted in one realm (hidden documents): a fixed id would resolve to the first one, which can
	// sit in a hidden subtree, where browsers do not draw the markers it defines.
	const arrow = `schema-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
	return (
		<svg viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label={`Schema graph: ${graph.nodes.length} labels, ${graph.edges.length} observed patterns`} style={{ width: '100%', maxWidth: 680, height: 'auto', display: 'block' }}>
			<title>{`Schema graph: ${graph.nodes.length} labels, ${graph.edges.length} observed patterns`}</title>
			<defs>
				<marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
					<path d="M 0 0 L 10 5 L 0 10 z" fill="var(--rr-text-secondary)" />
				</marker>
			</defs>
			{graph.edges.map((edge) => (
				<Edge key={edge.id} edge={edge} arrow={arrow} />
			))}
			{graph.nodes.map((node) => (
				<Node key={node.label} node={node} />
			))}
		</svg>
	);
};

export default SchemaGraph;
