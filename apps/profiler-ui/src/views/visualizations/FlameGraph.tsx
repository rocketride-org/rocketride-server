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
// FLAME GRAPH — Interactive icicle chart with d3.partition
// =============================================================================

import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import * as d3 from 'd3';
import type { HierarchyRectangularNode } from 'd3';
import { commonStyles } from 'shared/themes/styles';
import type { ProfileTreeNode, ProfileTreeResponse, BreadcrumbEntry, OnNodeSelect } from './types';

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

// =============================================================================
// COLOUR PALETTE
// =============================================================================

/**
 * CSS variable names for the chart colour palette.
 * Resolved at render time via getComputedStyle because d3 `.attr('fill')`
 * uses setAttribute which cannot resolve CSS `var()` references.
 */
const PALETTE_VARS = [
	'--rr-chart-blue',
	'--rr-chart-purple',
	'--rr-chart-green',
	'--rr-chart-yellow',
	'--rr-chart-orange',
	'--rr-chart-red',
];

/** Fallback hex values if CSS variables cannot be resolved. */
const PALETTE_FALLBACK = ['#4263eb', '#7048e8', '#2b8a3e', '#e67700', '#e67a2e', '#c92a2a'];

/**
 * Resolve the chart palette from CSS custom properties on a DOM element.
 *
 * @param el - DOM element to read computed styles from.
 * @returns Array of resolved hex colour strings.
 */
function resolvePalette(el: Element): string[] {
	const cs = getComputedStyle(el);
	return PALETTE_VARS.map((v, i) => cs.getPropertyValue(v).trim() || PALETTE_FALLBACK[i]);
}

/**
 * Simple string hash for distributing colours across function names.
 *
 * @param s - String to hash.
 * @returns Positive integer hash.
 */
function hashStr(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/**
 * Map a node to a resolved colour string.
 *
 * @param palette - Resolved colour array from resolvePalette().
 * @param name    - Function name (for hash distribution).
 * @param tottime - Self-time.
 * @param cumtime - Cumulative time.
 * @returns Resolved hex colour string.
 */
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
	/** Outer container fills available space. */
	container: {
		...commonStyles.columnFill,
		overflow: 'hidden',
	} as CSSProperties,

	/** Toolbar row with search and breadcrumbs. */
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '6px 8px',
		borderBottom: '1px solid var(--rr-border)',
		flexWrap: 'wrap',
	} as CSSProperties,

	/** Search input. */
	searchInput: {
		...commonStyles.inputField,
		width: 220,
		padding: '4px 8px',
		fontSize: 12,
	} as CSSProperties,

	/** Breadcrumb trail container. */
	breadcrumbs: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
	} as CSSProperties,

	/** Clickable breadcrumb link. */
	breadcrumbLink: {
		color: 'var(--rr-text-link)',
		cursor: 'pointer',
		textDecoration: 'none',
		whiteSpace: 'nowrap',
		background: 'none',
		border: 'none',
		padding: 0,
		fontFamily: 'inherit',
		fontSize: 12,
	} as CSSProperties,

	/** Breadcrumb separator. */
	breadcrumbSep: {
		color: 'var(--rr-text-disabled)',
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
// PROPS
// =============================================================================

interface FlameGraphProps {
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
 * Interactive icicle / flame graph visualisation.
 *
 * Renders a top-down icicle chart using d3.hierarchy + d3.partition in SVG.
 * Click any block to zoom into that subtree; breadcrumbs at top for
 * navigating back. Hover shows a tooltip with function details. Search
 * input highlights matching nodes and dims the rest.
 *
 * @param props.treeData     - Tree data from the server.
 * @param props.selectedNode - Currently highlighted node (cross-vis).
 * @param props.onNodeSelect - Callback for node selection.
 */
const FlameGraph: React.FC<FlameGraphProps> = ({ treeData, selectedNode, onNodeSelect }) => {
	const svgRef = useRef<SVGSVGElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(800);
	const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([]);
	const [search, setSearch] = useState('');
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
		if (!svg || !treeData?.tree) return;

		// Determine the zoom root
		const zoomRoot = breadcrumbs.length > 0
			? breadcrumbs[breadcrumbs.length - 1].node
			: treeData.tree;

		// Build d3 hierarchy — use self-time for partition widths
		const root = d3.hierarchy(zoomRoot, (d) => d.children)
			.sum((d) => {
				if (!d.children || d.children.length === 0) return Math.max(d.cumtime, 0.000001);
				const childCum = d.children.reduce((s, c) => s + c.cumtime, 0);
				return Math.max(d.cumtime - childCum, 0);
			})
			.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

		// Resolve theme colours from CSS custom properties (d3 .attr() can't use var())
		const palette = resolvePalette(svg);

		// Compute partition layout
		const maxDepth = Math.min(root.height + 1, MAX_VISIBLE_DEPTH);
		const height = maxDepth * ROW_HEIGHT;
		const partition = d3.partition<ProfileTreeNode>()
			.size([width, height])
			.padding(1);
		partition(root);

		// Setup SVG
		d3.select(svg).attr('width', width).attr('height', height);
		d3.select(svg).selectAll('*').remove();

		// Flatten visible nodes
		const nodes = root.descendants() as HierarchyRectangularNode<ProfileTreeNode>[];
		const searchLower = search.toLowerCase().trim();

		// Resolve theme colours from CSS custom properties
		const computedStyle = getComputedStyle(svg);
		const brandColor = computedStyle.getPropertyValue('--rr-brand').trim() || '#f7901f';

		// Create node groups
		const g = d3.select(svg)
			.selectAll<SVGGElement, HierarchyRectangularNode<ProfileTreeNode>>('g.node')
			.data(nodes.filter((d) => (d.x1 - d.x0) >= MIN_RENDER_WIDTH))
			.join('g')
			.attr('class', 'node')
			.attr('transform', (d) => `translate(${d.x0},${d.y0})`);

		// Rectangles
		g.append('rect')
			.attr('width', (d) => Math.max(0, d.x1 - d.x0))
			.attr('height', (d) => Math.max(0, d.y1 - d.y0 - 1))
			.attr('rx', 2)
			.attr('fill', (d) => nodeColour(palette, d.data.name, d.data.tottime, d.data.cumtime))
			.attr('opacity', (d) => {
				if (!searchLower) return 0.85;
				const matches = d.data.name.toLowerCase().includes(searchLower)
					|| d.data.file.toLowerCase().includes(searchLower);
				return matches ? 1 : 0.2;
			})
			.attr('stroke', (d) => {
				if (selectedNode && d.data.name === selectedNode.name
					&& d.data.file === selectedNode.file
					&& d.data.line === selectedNode.line) {
					return brandColor;
				}
				return 'none';
			})
			.attr('stroke-width', 2)
			.style('cursor', 'pointer');

		// Labels — use theme text colour for readability
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
		// INTERACTION
		// =====================================================================

		// Click to zoom
		g.on('click', (_event, d) => {
			if (d.depth === 0) return;
			const ancestors: BreadcrumbEntry[] = [];
			let current: HierarchyRectangularNode<ProfileTreeNode> | null = d;
			while (current && current.depth > 0) {
				ancestors.unshift({ label: current.data.name, node: current.data });
				current = current.parent;
			}
			setBreadcrumbs([...breadcrumbs, ...ancestors]);
			onNodeSelect(d.data);
		});

		// Tooltip
		g.on('mouseenter', (event, d) => {
			const lines = [
				d.data.name,
				`${d.data.file}:${d.data.line}`,
				`Calls: ${d.data.ncalls}`,
				`Total: ${d.data.tottime.toFixed(4)}s`,
				`Cumulative: ${d.data.cumtime.toFixed(4)}s`,
			];
			setTooltip({ x: event.clientX + 12, y: event.clientY + 12, text: lines.join('\n') });
		});
		g.on('mousemove', (event) => {
			setTooltip((prev) => prev ? { ...prev, x: event.clientX + 12, y: event.clientY + 12 } : null);
		});
		g.on('mouseleave', () => setTooltip(null));

	}, [treeData, width, breadcrumbs, search, selectedNode, onNodeSelect]);

	// =========================================================================
	// BREADCRUMB NAVIGATION
	// =========================================================================

	const handleBreadcrumbClick = useCallback((index: number) => {
		if (index < 0) {
			setBreadcrumbs([]);
			onNodeSelect(null);
		} else {
			setBreadcrumbs((prev) => prev.slice(0, index + 1));
			onNodeSelect(null);
		}
	}, [onNodeSelect]);

	// =========================================================================
	// RENDER
	// =========================================================================

	if (!treeData?.tree) {
		return <div style={commonStyles.empty}>No profiling data available. Start and stop a session to generate a flame graph.</div>;
	}

	return (
		<div style={styles.container}>
			{/* Toolbar */}
			<div style={styles.toolbar}>
				<input
					type="text"
					placeholder="Search functions..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					style={styles.searchInput}
				/>
				<div style={styles.breadcrumbs}>
					<button style={styles.breadcrumbLink} onClick={() => handleBreadcrumbClick(-1)}>root</button>
					{breadcrumbs.map((crumb, i) => (
						<React.Fragment key={i}>
							<span style={styles.breadcrumbSep}>&gt;</span>
							<button style={styles.breadcrumbLink} onClick={() => handleBreadcrumbClick(i)}>{crumb.label}</button>
						</React.Fragment>
					))}
				</div>
			</div>

			{/* SVG */}
			<div ref={containerRef} style={styles.svgContainer}>
				<svg ref={svgRef} />
			</div>

			{/* Tooltip */}
			{tooltip && (
				<div style={{ ...styles.tooltip, left: tooltip.x, top: tooltip.y }}>{tooltip.text}</div>
			)}
		</div>
	);
};

export default FlameGraph;
