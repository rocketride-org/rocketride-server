// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * SidebarViewStrip — the horizontal icon switcher for declared sidebar view
 * containers, plus the per-app workbench memory both frames share.
 *
 * ONE implementation, two hosts: the 'cursor' workbench variant renders it
 * across its panel top, and the compact drawer renders it under its header —
 * the SAME declared containers (`AppLayout sidebarViews`), the same icons and
 * badges, the same remembered selection. The drawer is a rendering switch on
 * the compact media query, never a different sidebar.
 *
 * The memory helpers live here (not in SidebarWorkbench) because the classic
 * Sidebar needs them too, and importing them from SidebarWorkbench would
 * cycle (SidebarWorkbench already imports AppSwitcherButton from Sidebar).
 */

import React, { useState, type CSSProperties } from 'react';
import { cardHeaderChrome } from '../card/Card';
import type { SidebarViewContainer } from '../../types/sidebarChrome';

// =============================================================================
// PER-APP MEMORY — shared by SidebarWorkbench and the compact drawer
// =============================================================================

/** Where the workbench's per-app state is kept. */
const MEMORY_KEY = 'rr.shell.workbench';

/** The remembered workbench shape for one app.
 *
 *  GEOMETRY ONLY — a first-paint hint, not a system of record. The toolbar
 *  ORDER is not here: it lives in the global workspace file as the one
 *  `devToolPins` list (workspace/devToolPins), so it follows the person
 *  across browsers instead of being per-browser state that silently
 *  disagrees with the file everything else reads. */
export interface WorkbenchMemory {
	/** Panel width in px. */
	width?: number;
	/** Whether the panel is open. */
	open?: boolean;
}

/**
 * Reads the app's remembered workbench state. Storage can throw (locked-down
 * profiles, private mode) and a sidebar is never worth failing a boot over,
 * so anything unreadable means "no memory".
 *
 * @param appId - The app whose state to read.
 * @returns The remembered shape, or an empty object.
 */
export function rememberedWorkbench(appId: string): WorkbenchMemory {
	if (!appId) return {};
	try {
		return JSON.parse(window.localStorage.getItem(`${MEMORY_KEY}:${appId}`) ?? '{}') as WorkbenchMemory;
	} catch {
		return {};
	}
}

/**
 * Merges a partial update into the app's remembered workbench state.
 *
 * @param appId - The app whose state to update.
 * @param patch - The fields that changed.
 */
export function rememberWorkbench(appId: string, patch: WorkbenchMemory): void {
	if (!appId) return;
	try {
		window.localStorage.setItem(`${MEMORY_KEY}:${appId}`, JSON.stringify({ ...rememberedWorkbench(appId), ...patch }));
	} catch {
		// The workbench still works; it just opens on defaults next visit.
	}
}

/**
 * Resolves the container a stored id names — falling to the declared default
 * (isDefault), then the first container, when the id names nothing (the app
 * may no longer declare it). Shared so the workbench and the drawer can never
 * resolve the same memory differently.
 *
 * @param views - The declared containers, rail order.
 * @param storedId - The remembered container id ('' when none).
 * @returns The container to show, or undefined when none are declared.
 */
export function resolveActiveView(views: SidebarViewContainer[], storedId: string): SidebarViewContainer | undefined {
	return views.find((v) => v.id === storedId) ?? views.find((v) => v.isDefault) ?? views[0];
}

// =============================================================================
// STYLES
// =============================================================================

/** Icon size inside a tab (the rail standard). */
const STRIP_ICON = 20;

const styles = {
	/** The container switcher — ICON tabs, not text (design decision
	    2026-10-13: uppercase labels crowded the narrow panel; titles live in
	    the hover hints and the viewTitle row). The band keeps the stock
	    TabControl chrome — card-header fill, bottom border, brand underline on
	    the active tab — so it still reads as a platform strip rather than a
	    one-off bar. */
	strip: {
		flex: 'none',
		display: 'flex',
		alignItems: 'stretch',
		gap: 2,
		padding: '6px 10px 0',
		borderBottom: '1px solid var(--rr-border)',
		background: cardHeaderChrome.header.background,
		// Air between the band and whatever follows (the view title / body) —
		// flush against the border the content read as part of the strip.
		marginBottom: 6,
	} as CSSProperties,
	tab: (active: boolean, hovered: boolean): CSSProperties => ({
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 36,
		height: 32,
		padding: 0,
		border: 'none',
		// The active marker is the strip's brand underline (the TabControl
		// treatment), not a filled square — this is a tab, not a rail button.
		borderBottom: `2px solid ${active ? 'var(--rr-brand)' : 'transparent'}`,
		// Square corners — the strip matches VS Code's flat tab chrome.
		borderRadius: 0,
		background: hovered && !active ? 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))' : 'transparent',
		cursor: 'pointer',
		color: active ? 'var(--rr-text-primary)' : 'var(--rr-text-secondary)',
		transition: 'background 100ms ease, color 100ms ease',
	}),
	/** Count/marker badge, top-right of a tab, clear of the underline. */
	badge: {
		position: 'absolute',
		right: 2,
		top: 2,
		minWidth: 14,
		height: 14,
		padding: '0 3px',
		borderRadius: 7,
		background: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 9,
		fontWeight: 700,
		lineHeight: '14px',
		textAlign: 'center',
	} as CSSProperties,
};

/** The active container's name over the body (the strip is icon-only, so it
    names nothing itself) — shared by the workbench panel and the drawer. */
export const viewTitleStyle: CSSProperties = {
	padding: '2px 14px 6px',
	fontSize: 11,
	fontWeight: 700,
	letterSpacing: '0.08em',
	textTransform: 'uppercase',
	color: 'var(--rr-text-secondary)',
	flexShrink: 0,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link SidebarViewStrip}. */
export interface ISidebarViewStripProps {
	/** The declared containers, already in rail order. */
	views: SidebarViewContainer[];
	/** Id of the active container. */
	activeId: string;
	/** Fired with a container id when the user selects it. */
	onSelect: (id: string) => void;
}

/**
 * The horizontal icon tab strip over declared view containers — one glyph per
 * container, the title as its hover hint.
 *
 * @param props - {@link ISidebarViewStripProps}.
 */
export const SidebarViewStrip: React.FC<ISidebarViewStripProps> = ({ views, activeId, onSelect }) => {
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	return (
		<div style={styles.strip} role="tablist" aria-label="Sidebar views">
			{views.map((v) => {
				const isActive = activeId === v.id;
				return (
					<button
						key={v.id}
						role="tab"
						aria-selected={isActive}
						title={v.title}
						aria-label={v.title}
						onClick={() => onSelect(v.id)}
						onMouseEnter={() => setHoveredId(v.id)}
						onMouseLeave={() => setHoveredId(null)}
						style={styles.tab(isActive, hoveredId === v.id)}
					>
						<span style={{ display: 'flex', width: STRIP_ICON, height: STRIP_ICON, alignItems: 'center', justifyContent: 'center' }}>{v.icon}</span>
						{v.badge != null && v.badge !== 0 && <span style={styles.badge}>{v.badge}</span>}
					</button>
				);
			})}
		</div>
	);
};
