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
// SUNBURST CHART — SnakeViz-style radial partition visualisation
// =============================================================================
//
// Arc width = cumulative time (matching snakeviz).
// Color = D3 ordinal scale by function name (consistent per function).
// Hover = magenta highlight + all same-name arcs highlighted.
// Click arc = re-root to that function.  Click center = zoom out one level.
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

/** Minimum arc angle (radians) for a node to be rendered. */
const MIN_ARC_ANGLE = 0.005;

/** Magenta highlight colour for hovered arcs. */
const HOVER_COLOR = '#ff00ff';

/**
 * D3 category20c palette — the same 20-colour ordinal scale that snakeviz uses.
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
	/** Outer container — centers the SVG using flexbox. */
	container: {
		...commonStyles.columnFill,
		overflow: 'auto',
		background: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,

	/** SVG wrapper — constrains the SVG size. */
	svgWrapper: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 10,
		width: '100%',
		height: '100%',
	} as CSSProperties,

	/** Tooltip overlay. */
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
// PROPS
// =============================================================================

interface SunburstChartProps {
	/** Root node to visualise (the current viz root, not necessarily the tree root). */
	root: ProfileTreeNode | null;
	/** Total cumulative time of the full profile (for percentage display). */
	totalTime: number;
	/** Maximum depth rings to render. */
	maxDepth: number;
	/** Cutoff fraction — prune children with cumtime < cutoff * parent.cumtime. */
	cutoff: number;
	/** Callback when user clicks an arc to re-root the visualisation. */
	onRootChange: OnRootChange;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Apply cutoff pruning to a tree node.
 * Returns a new node with children filtered by the cutoff threshold.
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
 * Returns a new tree with children beyond maxDepth removed.
 */
function limitDepth(node: ProfileTreeNode, maxDepth: number, depth: number = 0): ProfileTreeNode {
	if (depth >= maxDepth) return { ...node, children: [] };
	return {
		...node,
		children: node.children.map((c) => limitDepth(c, maxDepth, depth + 1)),
	};
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * SnakeViz-style radial sunburst chart.
 *
 * - Arc width proportional to cumulative time (not self-time)
 * - D3 ordinal colour scale by function name (consistent per function)
 * - Hover highlights all same-name arcs in magenta
 * - Click arc = re-root, click center = zoom out one level
 */
/** Fixed internal coordinate size for the SVG viewBox. */
const SVG_SIZE = 600;
const SVG_RADIUS = SVG_SIZE / 2;

const SunburstChart: React.FC<SunburstChartProps> = ({
	root: vizRoot,
	totalTime,
	maxDepth,
	cutoff,
	onRootChange,
}) => {
	const svgRef = useRef<SVGSVGElement>(null);
	const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

	// =========================================================================
	// D3 RENDER
	// =========================================================================

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg || !vizRoot) return;

		// Apply client-side depth limiting and cutoff pruning
		const processedRoot = pruneTree(limitDepth(vizRoot, maxDepth), cutoff);

		// Resolve theme colours
		const cs = getComputedStyle(svg);
		const textPrimary = cs.getPropertyValue('--rr-text-primary').trim() || '#1a1a1a';
		const textSecondary = cs.getPropertyValue('--rr-text-secondary').trim() || '#666';
		const bgPaper = cs.getPropertyValue('--rr-bg-paper').trim() || '#ffffff';

		// D3 ordinal colour scale by function name (snakeviz: category20c)
		const color = d3.scaleOrdinal(CATEGORY20C);

		// Build hierarchy — partition value = cumtime (snakeviz behaviour)
		const root = d3.hierarchy(processedRoot, (d) => d.children)
			.sum((d) => {
				// Use cumtime for partition sizing (snakeviz style)
				if (!d.children || d.children.length === 0) return Math.max(d.cumtime, 0.000001);
				// For parent nodes: cumtime minus children to avoid double-counting
				const childCum = d.children.reduce((s, c) => s + c.cumtime, 0);
				return Math.max(d.cumtime - childCum, 0.000001);
			})
			.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

		// Radial partition layout
		const partition = d3.partition<ProfileTreeNode>().size([2 * Math.PI, SVG_RADIUS]);
		partition(root);

		// Setup SVG — fixed viewBox, scales to fill container via CSS
		const svgSel = d3.select(svg)
			.attr('viewBox', `${-SVG_RADIUS} ${-SVG_RADIUS} ${SVG_SIZE} ${SVG_SIZE}`)
			.style('width', '100%')
			.style('height', '100%')
			.style('max-width', `${SVG_SIZE}px`)
			.style('max-height', `${SVG_SIZE}px`);
		svgSel.selectAll('*').remove();

		// Arc generator
		const arc = d3.arc<HierarchyRectangularNode<ProfileTreeNode>>()
			.startAngle((d) => d.x0)
			.endAngle((d) => d.x1)
			.innerRadius((d) => d.y0)
			.outerRadius((d) => d.y1 - 1)
			.padAngle(0.002)
			.padRadius(SVG_RADIUS / 2);

		// Filter visible nodes (depth > 0, min arc angle)
		const nodes = root.descendants()
			.filter((d) => d.depth > 0 && (d.x1 - d.x0) > MIN_ARC_ANGLE) as HierarchyRectangularNode<ProfileTreeNode>[];

		// Draw arcs
		const paths = svgSel.selectAll<SVGPathElement, HierarchyRectangularNode<ProfileTreeNode>>('path.arc')
			.data(nodes)
			.join('path')
			.attr('class', 'arc')
			.attr('d', arc)
			.attr('fill', (d) => color(d.data.name))
			.attr('opacity', 0.85)
			.attr('stroke', bgPaper)
			.attr('stroke-width', 0.5)
			.style('cursor', 'pointer');

		// Center label — current root name
		svgSel.append('text')
			.attr('text-anchor', 'middle')
			.attr('dy', '-0.3em')
			.attr('fill', textPrimary)
			.attr('font-size', 13)
			.attr('font-family', 'var(--rr-font-mono, monospace)')
			.text(vizRoot.name === '<root>' ? 'All' : vizRoot.name);

		// Center subtitle — cumtime
		svgSel.append('text')
			.attr('text-anchor', 'middle')
			.attr('dy', '1.2em')
			.attr('fill', textSecondary)
			.attr('font-size', 11)
			.attr('font-family', 'var(--rr-font-mono, monospace)')
			.text(`${vizRoot.cumtime.toFixed(3)}s`);

		// Click any arc to re-root the visualisation to that function
		// (no children guard — ProfilerView resolves the full subtree from the original tree)
		paths.on('click', (_event, d) => {
			onRootChange(d.data);
		});

		// =====================================================================
		// HOVER — Magenta highlight + same-function highlighting (snakeviz)
		// =====================================================================

		paths.on('mouseenter', (event, d) => {
			const hoveredName = d.data.name;

			// Highlight all arcs with the same function name
			paths.each(function (dd) {
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

		paths.on('mousemove', (event) => {
			setTooltip((prev) => prev ? { ...prev, x: event.clientX + 12, y: event.clientY + 12 } : null);
		});

		paths.on('mouseleave', () => {
			// Restore original colours
			paths.attr('fill', (d) => color(d.data.name)).attr('opacity', 0.85);
			setTooltip(null);
		});

	}, [vizRoot, maxDepth, cutoff, onRootChange, totalTime]);

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!vizRoot) {
		return <div style={commonStyles.empty}>No profiling data available. Start and stop a session to generate a sunburst chart.</div>;
	}

	return (
		<div style={styles.container}>
			<div style={styles.svgWrapper}>
				<svg ref={svgRef} />
			</div>
			{tooltip && (
				<div style={{ ...styles.tooltip, left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>
			)}
		</div>
	);
};

export default SunburstChart;
