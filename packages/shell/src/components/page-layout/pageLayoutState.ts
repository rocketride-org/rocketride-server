// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pure rules behind PageLayout's sidebars, kept apart from React so they are
 * unit-testable: when a page counts as narrow, and what each sidebar's open
 * state becomes when the page crosses that line.
 */

// =============================================================================
// TYPES
// =============================================================================

/** How a sidebar renders: an in-flow column or an overlay drawer. */
export type SidebarMode = 'column' | 'drawer';

/** Per-side open state. */
export interface ISidebarOpenState {
	left: boolean;
	right: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default container width (px) below which sidebars become drawers. */
export const DEFAULT_COLLAPSE_BELOW = 900;

/** Default sidebar width (px). */
export const DEFAULT_SIDEBAR_WIDTH = 280;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The sidebar mode for a measured container width. An unmeasured container
 * (0, e.g. before layout or on the server) counts as wide, so the first paint
 * never flashes drawers.
 *
 * @param width - The page container's width in px.
 * @param collapseBelow - The breakpoint in px.
 * @returns The mode.
 */
export function getSidebarMode(width: number, collapseBelow: number): SidebarMode {
	if (width <= 0) return 'column';
	if (width < collapseBelow) return 'drawer';
	return 'column';
}

/**
 * The open state after the page changes mode. Drawers always start closed
 * (an overlay must never open on its own); returning to columns restores each
 * side's default.
 *
 * @param mode - The new mode.
 * @param defaults - Each side's default open state in column mode.
 * @returns The open state to apply.
 */
export function openStateForMode(mode: SidebarMode, defaults: ISidebarOpenState): ISidebarOpenState {
	if (mode === 'drawer') return { left: false, right: false };
	return { left: defaults.left, right: defaults.right };
}

/**
 * Opening one drawer closes the other, so two overlays never stack on a
 * narrow page. Columns are independent.
 *
 * @param current - The current open state.
 * @param side - The side being changed.
 * @param isOpen - Its new state.
 * @param mode - The current mode.
 * @returns The next open state.
 */
export function setSideOpen(current: ISidebarOpenState, side: 'left' | 'right', isOpen: boolean, mode: SidebarMode): ISidebarOpenState {
	const next = { ...current, [side]: isOpen };
	if (mode === 'drawer' && isOpen) {
		if (side === 'left') next.right = false;
		if (side === 'right') next.left = false;
	}
	return next;
}
