// MIT License
//
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
// FLAME GRAPH (ICICLE) — SnakeViz-style rectangular partition visualisation
// =============================================================================
//
// SnakeViz icicle mode: top-down stacked rectangles.
// Width = cumulative time.  Color = D3 ordinal scale by function name.
// Hover = magenta highlight + all same-name rects highlighted.
// Click rect = re-root to that function.
// =============================================================================

import React, { useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import * as d3 from 'd3';
import type { HierarchyRectangularNode } from 'd3';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, OnRootChange } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Height of each row (one call depth level) in pixels. */
const ROW_HEIGHT = 22;

/** Maximum visible depth levels before scrolling. */
const MAX_VISIBLE_DEPTH = 25;

/** Minimum pixel width for a node to be rendered. */
const MIN_RENDER_WIDTH = 2;

/** Padding inside each rect for the label text. */
const TEXT_PADDING = 4;

/** Magenta highlight colour for hovered nodes (same as sunburst). */
const HOVER_COLOR = '#ff00ff';

/**
 * D3 category20c palette — same 20-colour ordinal scale as snakeviz.
 * Hardcoded to avoid dependency on d3-scale-chromatic type exports.
 */
const CATEGORY20C = [
	'#3182bd', '#6baed6', '#9ecae1', '#c6dbef',
	'#e6550d', '#fd8d3c', '#fdae6b', '#fdd0a2',
	'#31a354', '#74c476', '#a1d99b', '#c7e9c0',
	'#756bb1', '#9e9ac8', '#bcbddc', '#dadaeb',
	'#636363', '#969696', '#bdbdbd', '#d9d9d9',
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container fills available space. */
	container: {
		...commonStyles.columnFill,
		overflow: 'hidden',
	} as CSSProperties,

	/** Scrollable SVG container. */
	svgContainer: {
		flex: 1,
		overflow: 'auto',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,

	/** Tooltip that follows the mouse on hover. */
	tooltip: {
		position: 'fixed',
		pointerEvents: 'none',
		padding: '8px 12px',
		borderRadius: 6,
		background: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		lineHeight: 1.5,
		zIndex: 10000,
		maxWidth: 500,
		boxShadow: '0 4px 12px var(--rr-shadow-widget)',
		whiteSpace: 'pre-line',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Apply cutoff pruning to a tree node.
 * Children whose cumtime is less than cutoff * parent.cumtime are removed.
 */
function pruneTree(node: ProfileTreeNode, cutoff: number): ProfileTreeNode {
	if (cutoff <= 0 || !node.children.length) return node;
	const threshold = cutoff * node.cumtime;
	const prunedChildren = node.children
		.filter((c) => c.cumtime >= threshold)
		.map((c) => pruneTree(c, cutoff));
	return { ...node, children: prunedChildren };
}

/**
 * Limit tree depth to maxDepth levels.
 */
function limitDepth(node: ProfileTreeNode, maxDepth: number, depth: number = 0): ProfileTreeNode {
	if (depth >= maxDepth) return { ...node, children: [] };
	return {
		...node,
		children: node.children.map((c) => limitDepth(c, maxDepth, depth + 1)),
	};
}

// =============================================================================
// PROPS
// =============================================================================

interface FlameGraphProps {
	/** Root node to visualise (the current viz root). */
	root: ProfileTreeNode | null;
	/** Total cumulative time of the full profile (for percentage display). */
	totalTime: number;
	/** Maximum depth levels to render. */
	maxDepth: number;
	/** Cutoff fraction — prune children with cumtime < cutoff * parent.cumtime. */
	cutoff: number;
	/** Callback when user clicks a rect to re-root the visualisation. */
	onRootChange: OnRootChange;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SnakeViz-style icicle chart visualisation.
 *
 * Renders a top-down rectangular partition layout using d3.partition.
 * Width = cumulative time.  Same colour scheme and hover behaviour as
 * the sunburst chart.
 */
const FlameGraph: React.FC<FlameGraphProps> = ({
	root: vizRoot,
	totalTime,
	maxDepth: maxDepthProp,
	cutoff,
	onRootChange,
}) => {
	const svgRef = useRef<SVGSVGElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(800);
	const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

	// =========================================================================
	// RESPONSIVE WIDTH
	// =========================================================================

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) setWidth(entry.contentRect.width);
		});
		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	// =========================================================================
	// D3 RENDER
	// =========================================================================

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg || !vizRoot) return;

		// Apply client-side depth limiting and cutoff pruning
		const processedRoot = pruneTree(limitDepth(vizRoot, maxDepthProp), cutoff);

		// D3 ordinal colour scale by function name (matches sunburst)
		const color = d3.scaleOrdinal(CATEGORY20C);

		// Build d3 hierarchy — partition value = cumtime (snakeviz icicle mode)
		const root = d3.hierarchy(processedRoot, (d) => d.children)
			.sum((d) => {
				if (!d.children || d.children.length === 0) return Math.max(d.cumtime, 0.000001);
				const childCum = d.children.reduce((s, c) => s + c.cumtime, 0);
				return Math.max(d.cumtime - childCum, 0.000001);
			})
			.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

		// Compute partition layout
		const depthLimit = Math.min(root.height + 1, MAX_VISIBLE_DEPTH);
		const height = depthLimit * ROW_HEIGHT;
		const partition = d3.partition<ProfileTreeNode>()
			.size([width, height])
			.padding(1);
		partition(root);

		// Setup SVG
		d3.select(svg).attr('width', width).attr('height', height);
		d3.select(svg).selectAll('*').remove();

		// Flatten visible nodes
		const nodes = (root.descendants() as HierarchyRectangularNode<ProfileTreeNode>[])
			.filter((d) => (d.x1 - d.x0) >= MIN_RENDER_WIDTH);

		// Create node groups
		const g = d3.select(svg)
			.selectAll<SVGGElement, HierarchyRectangularNode<ProfileTreeNode>>('g.node')
			.data(nodes)
			.join('g')
			.attr('class', 'node')
			.attr('transform', (d) => `translate(${d.x0},${d.y0})`);

		// Rectangles
		const rects = g.append('rect')
			.attr('width', (d) => Math.max(0, d.x1 - d.x0))
			.attr('height', (d) => Math.max(0, d.y1 - d.y0 - 1))
			.attr('rx', 2)
			.attr('fill', (d) => color(d.data.name))
			.attr('opacity', 0.85)
			.attr('stroke', 'none')
			.style('cursor', 'pointer');

		// Labels
		g.append('text')
			.attr('x', TEXT_PADDING)
			.attr('y', ROW_HEIGHT / 2 + 1)
			.attr('dy', '0.35em')
			.attr('fill', '#fff')
			.attr('font-size', 11)
			.attr('font-family', 'var(--rr-font-mono, monospace)')
			.attr('pointer-events', 'none')
			.text((d) => {
				const nodeWidth = d.x1 - d.x0;
				if (nodeWidth < 40) return '';
				const label = d.data.name;
				const maxChars = Math.floor((nodeWidth - TEXT_PADDING * 2) / 7);
				return label.length > maxChars ? label.slice(0, maxChars - 1) + '\u2026' : label;
			});

		// =====================================================================
		// CLICK — Re-root to that function
		// =====================================================================

		// Click any block to re-root the visualisation to that function
		// (no children guard — ProfilerView resolves the full subtree from the original tree)
		g.on('click', (_event, d) => {
			if (d.depth === 0) return;
			onRootChange(d.data);
		});

		// =====================================================================
		// HOVER — Magenta highlight + same-function highlighting (snakeviz)
		// =====================================================================

		g.on('mouseenter', (event, d) => {
			const hoveredName = d.data.name;

			// Highlight all rects with the same function name
			rects.each(function (dd) {
				const el = d3.select(this);
				if (dd.data.name === hoveredName) {
					el.attr('fill', HOVER_COLOR).attr('opacity', 1);
				} else {
					el.attr('opacity', 0.4);
				}
			});

			// Tooltip with cumtime percentage
			const pct = totalTime > 0 ? (d.data.cumtime / totalTime * 100).toFixed(1) : '0.0';
			const lines = [
				d.data.name,
				`${d.data.cumtime.toFixed(4)}s (${pct}%)`,
				`${d.data.file}:${d.data.line}`,
			];
			setTooltip({ x: event.clientX + 12, y: event.clientY + 12, text: lines.join('\n') });
		});

		g.on('mousemove', (event) => {
			setTooltip((prev) => prev ? { ...prev, x: event.clientX + 12, y: event.clientY + 12 } : null);
		});

		g.on('mouseleave', () => {
			// Restore original colours
			rects.attr('fill', (d) => color(d.data.name)).attr('opacity', 0.85);
			setTooltip(null);
		});

	}, [vizRoot, width, maxDepthProp, cutoff, onRootChange, totalTime]);

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!vizRoot) {
		return <div style={commonStyles.empty}>No profiling data available. Start and stop a session to generate a flame graph.</div>;
	}

	return (
		<div style={styles.container}>
			<div ref={containerRef} style={styles.svgContainer}>
				<svg ref={svgRef} />
			</div>
			{tooltip && (
				<div style={{ ...styles.tooltip, left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>
			)}
		</div>
	);
};

export default FlameGraph;
