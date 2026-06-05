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
// SUNBURST CHART — Radial partition visualisation with d3
// =============================================================================

import React, { useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import * as d3 from 'd3';
import type { HierarchyRectangularNode } from 'd3';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, ProfileTreeResponse, OnNodeSelect } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum visible depth rings. */
const MAX_DEPTH = 10;

/** Minimum arc angle (radians) for a node to be rendered. */
const MIN_ARC_ANGLE = 0.005;

// =============================================================================
// COLOUR PALETTE (same as FlameGraph)
// =============================================================================

/** CSS variable names for chart colours. */
const PALETTE_VARS = [
	'--rr-chart-blue', '--rr-chart-purple', '--rr-chart-green',
	'--rr-chart-yellow', '--rr-chart-orange', '--rr-chart-red',
];

/** Fallback hex values. */
const PALETTE_FALLBACK = ['#4263eb', '#7048e8', '#2b8a3e', '#e67700', '#e67a2e', '#c92a2a'];

/** Resolve palette from CSS custom properties on a DOM element. */
function resolvePalette(el: Element): string[] {
	const cs = getComputedStyle(el);
	return PALETTE_VARS.map((v, i) => cs.getPropertyValue(v).trim() || PALETTE_FALLBACK[i]);
}

/** Simple string hash for distributing colours. */
function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/** Map a node to a resolved colour string. */
function nodeColour(palette: string[], name: string, tottime: number, cumtime: number): string {
	const base = hashStr(name) % palette.length;
	const ratio = cumtime > 0 ? tottime / cumtime : 0;
	const shift = Math.floor(ratio * 2);
	const idx = Math.min(base + shift, palette.length - 1);
	return palette[idx];
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Outer container. */
	container: {
		...commonStyles.columnFill,
		alignItems: 'center',
		overflow: 'auto',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,

	/** SVG wrapper. */
	svgWrapper: {
		display: 'flex',
		justifyContent: 'center',
		padding: 20,
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
	/** Structured call tree from the server. */
	treeData: ProfileTreeResponse | null;
	/** Currently selected node for cross-highlighting. */
	selectedNode: ProfileTreeNode | null;
	/** Callback when a node is selected. */
	onNodeSelect: OnNodeSelect;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Radial sunburst chart visualisation.
 *
 * Renders a radial partition layout using d3.partition + d3.arc.
 * Click to zoom into a subtree; click centre to zoom back out.
 *
 * @param props.treeData     - Tree data from the server.
 * @param props.selectedNode - Currently highlighted node (cross-vis).
 * @param props.onNodeSelect - Callback for node selection.
 */
const SunburstChart: React.FC<SunburstChartProps> = ({ treeData, selectedNode, onNodeSelect }) => {
	const svgRef = useRef<SVGSVGElement>(null);
	const [zoomNode, setZoomNode] = useState<ProfileTreeNode | null>(null);
	const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

	// Current root for rendering
	const currentRoot = zoomNode || treeData?.tree || null;

	// Chart dimensions
	const size = 600;
	const radius = size / 2;

	// =========================================================================
	// D3 RENDER
	// =========================================================================

	useEffect(() => {
		const svg = svgRef.current;
		if (!svg || !currentRoot) return;

		// Resolve theme colours (d3 .attr() can't use CSS var() references)
		const cs = getComputedStyle(svg);
		const palette = resolvePalette(svg);
		const textPrimary = cs.getPropertyValue('--rr-text-primary').trim() || '#1a1a1a';
		const textSecondary = cs.getPropertyValue('--rr-text-secondary').trim() || '#666';
		const brandColor = cs.getPropertyValue('--rr-brand').trim() || '#f7901f';
		const bgPaper = cs.getPropertyValue('--rr-bg-paper').trim() || '#ffffff';

		// Build hierarchy with self-time partitioning
		const root = d3.hierarchy(currentRoot, (d) => d.children)
			.sum((d) => {
				if (!d.children || d.children.length === 0) return Math.max(d.cumtime, 0.000001);
				const childCum = d.children.reduce((s, c) => s + c.cumtime, 0);
				return Math.max(d.cumtime - childCum, 0);
			})
			.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

		// Radial partition layout
		const partition = d3.partition<ProfileTreeNode>().size([2 * Math.PI, radius]);
		partition(root);

		// Setup SVG
		const svgSel = d3.select(svg)
			.attr('width', size)
			.attr('height', size)
			.attr('viewBox', `${-radius} ${-radius} ${size} ${size}`);
		svgSel.selectAll('*').remove();

		// Arc generator
		const arc = d3.arc<HierarchyRectangularNode<ProfileTreeNode>>()
			.startAngle((d) => d.x0)
			.endAngle((d) => d.x1)
			.innerRadius((d) => d.y0)
			.outerRadius((d) => d.y1 - 1)
			.padAngle(0.002)
			.padRadius(radius / 2);

		// Filter visible nodes
		const nodes = root.descendants()
			.filter((d) => d.depth > 0 && d.depth <= MAX_DEPTH && (d.x1 - d.x0) > MIN_ARC_ANGLE) as HierarchyRectangularNode<ProfileTreeNode>[];

		// Draw arcs
		const paths = svgSel.selectAll<SVGPathElement, HierarchyRectangularNode<ProfileTreeNode>>('path')
			.data(nodes)
			.join('path')
			.attr('d', arc)
			.attr('fill', (d) => nodeColour(palette, d.data.name, d.data.tottime, d.data.cumtime))
			.attr('opacity', 0.85)
			.attr('stroke', (d) => {
				if (selectedNode && d.data.name === selectedNode.name
					&& d.data.file === selectedNode.file
					&& d.data.line === selectedNode.line) {
					return brandColor;
				}
				return bgPaper;
			})
			.attr('stroke-width', (d) => {
				if (selectedNode && d.data.name === selectedNode.name
					&& d.data.file === selectedNode.file
					&& d.data.line === selectedNode.line) return 2;
				return 0.5;
			})
			.style('cursor', 'pointer');

		// Centre label — current root name
		svgSel.append('text')
			.attr('text-anchor', 'middle')
			.attr('dy', '-0.3em')
			.attr('fill', textPrimary)
			.attr('font-size', 13)
			.attr('font-family', 'var(--rr-font-mono, monospace)')
			.text(currentRoot.name === '<root>' ? 'All' : currentRoot.name);

		// Centre subtitle — cumtime
		svgSel.append('text')
			.attr('text-anchor', 'middle')
			.attr('dy', '1.2em')
			.attr('fill', textSecondary)
			.attr('font-size', 11)
			.attr('font-family', 'var(--rr-font-mono, monospace)')
			.text(`${currentRoot.cumtime.toFixed(3)}s`);

		// Click centre circle to zoom out
		const innerRadius = (root.children?.[0] as HierarchyRectangularNode<ProfileTreeNode>)?.y0 || 40;
		svgSel.append('circle')
			.attr('r', innerRadius)
			.attr('fill', 'transparent')
			.style('cursor', zoomNode ? 'pointer' : 'default')
			.on('click', () => {
				if (zoomNode) {
					setZoomNode(null);
					onNodeSelect(null);
				}
			});

		// Click arc to zoom
		paths.on('click', (_event, d) => {
			if (d.children && d.children.length > 0) {
				setZoomNode(d.data);
				onNodeSelect(d.data);
			}
		});

		// Tooltip
		paths.on('mouseenter', (event, d) => {
			const lines = [
				d.data.name,
				`${d.data.file}:${d.data.line}`,
				`Calls: ${d.data.ncalls}`,
				`Total: ${d.data.tottime.toFixed(4)}s`,
				`Cumulative: ${d.data.cumtime.toFixed(4)}s`,
			];
			setTooltip({ x: event.clientX + 12, y: event.clientY + 12, text: lines.join('\n') });
		});
		paths.on('mousemove', (event) => {
			setTooltip((prev) => prev ? { ...prev, x: event.clientX + 12, y: event.clientY + 12 } : null);
		});
		paths.on('mouseleave', () => setTooltip(null));

	}, [currentRoot, selectedNode, zoomNode, onNodeSelect, radius, size]);

	// Reset zoom when tree data changes
	useEffect(() => { setZoomNode(null); }, [treeData]);

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!treeData?.tree) {
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
