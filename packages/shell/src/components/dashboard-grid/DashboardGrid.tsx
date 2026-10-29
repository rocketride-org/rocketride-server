// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DashboardGrid — the layout of a dashboard view. Two modes:
 *
 *   12-column (default): wrap each widget in a DashboardGridItem with a
 *   `span` of 3, 4, 6, 8 or 12 columns. When the GRID is narrower than
 *   960px, spans under 6 widen to 6 (two per row); under 600px every item
 *   takes the full row.
 *
 *   Auto-fit (`minItemWidth`): as many equal columns as fit, each at least
 *   that wide, stretched so a short row still fills the width. Use it for a
 *   row of StatCards; no items needed.
 *
 * The breakpoints are CSS container queries on the grid itself, so the grid
 * behaves the same in a full page, a side panel or a webview, and never
 * disagrees with the shell's viewport breakpoint.
 *
 * Built on `.rr-dashboard-grid` from components.css.
 */

import React, { ReactNode } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Column spans a DashboardGridItem can take. */
export type DashboardSpan = 3 | 4 | 6 | 8 | 12;

/** Props for the {@link DashboardGrid} component. */
export interface IDashboardGridProps {
	/** DashboardGridItems, or any widgets in auto-fit mode. */
	children: ReactNode;
	/** Auto-fit mode: the narrowest a column may get (px). */
	minItemWidth?: number;
	/** Accessible name; makes the grid a labelled region. */
	label?: string;
}

/** Props for the {@link DashboardGridItem} component. */
export interface IDashboardGridItemProps {
	/** The widget. */
	children: ReactNode;
	/** Columns out of 12. Defaults to 12. */
	span?: DashboardSpan;
	/** Rows to span (a tall feed beside two charts). Defaults to 1. */
	rowSpan?: number;
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a responsive dashboard grid.
 *
 * @param props - {@link IDashboardGridProps}.
 * @returns The grid element.
 */
export function DashboardGrid({ children, minItemWidth, label }: IDashboardGridProps): React.ReactElement {
	let className = 'rr-dashboard-grid';
	let style: React.CSSProperties | undefined;
	if (minItemWidth) {
		className += ' rr-dashboard-grid--auto';
		style = { '--rr-dashboard-min': `${minItemWidth}px` } as React.CSSProperties;
	}

	let regionProps: { role?: 'region'; 'aria-label'?: string } = {};
	if (label) regionProps = { role: 'region', 'aria-label': label };

	return (
		<div className={className} style={style} {...regionProps}>
			{children}
		</div>
	);
}

/**
 * Renders one cell of a 12-column DashboardGrid.
 *
 * @param props - {@link IDashboardGridItemProps}.
 * @returns The cell element.
 */
export function DashboardGridItem({ children, span = 12, rowSpan = 1 }: IDashboardGridItemProps): React.ReactElement {
	let style: React.CSSProperties | undefined;
	if (rowSpan > 1) style = { gridRow: `span ${rowSpan}` };
	return (
		<div className={`rr-dashboard-grid__item rr-dashboard-grid__item--span-${span}`} style={style}>
			{children}
		</div>
	);
}
