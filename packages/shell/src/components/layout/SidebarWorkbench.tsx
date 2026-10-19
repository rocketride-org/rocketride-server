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
// SIDEBAR WORKBENCH — the 'vscode' and 'cursor' sidebar frames
// =============================================================================
//
// Renders an app's declared view containers as VS Code-style chrome:
//
//   'vscode'  a fixed activity rail (one icon per container, platform footer
//             at its foot) beside a resizable panel showing the active
//             container. Clicking the active icon toggles the panel; the
//             rail never disappears, so navigation and the account menu stay
//             reachable with the panel closed.
//   'cursor'  the same panel with the container switcher as a horizontal
//             ICON strip across the panel top (Cursor's layout — no vertical
//             rail; titles live in the hover hints and the title row below).
//             Closed, it leaves a slim reopen strip so the panel and the
//             account menu stay one click away.
//
// Containers that bring their own `content` are switched here through the
// stock TabPanel (all bodies stay mounted, so tree/scroll state survives
// switches). Containers without content share the app's single registered
// `sidebar` node, which learns the selection through SidebarActiveViewContext
// — one data owner behind N rail icons.
//
// Desktop only: below the compact breakpoint ShellLayout renders the classic
// Sidebar drawer for every mode, so this frame never meets the drawer rules.
//
// State (width, panel open, active view) is remembered PER APP in
// localStorage, read synchronously so the first frame is correct — the same
// reasoning as the classic sidebar's collapse memory. ShellLayout keys this
// component by app id, so the initializers re-run on every app switch.
// =============================================================================

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { BxDockLeft, BxDotsHorizontal } from '../BoxIcon';
import { ConnectionManager } from '../../connection/connection';
import { useWorkspace } from '../workspace/WorkspaceContext';
import type { ShellThemeConfig, ShellAccountConfig } from '../workspace/types';
import { SidebarFooter, SidebarFooterExtras, openPlatformDocs } from '../sidebar-footer/SidebarFooter';
import { useSidebarFooterMenu } from './useSidebarFooterMenu';
import { SidebarCollapsedProvider } from '../sidebar-menu/SidebarCollapsedContext';
import { SidebarActiveViewProvider } from '../sidebar-menu/SidebarActiveViewContext';
import type { SidebarActiveView } from '../sidebar-menu/SidebarActiveViewContext';
import { TabPanel } from '../tab-panel/TabPanel';
import type { ITabPanelPanel } from '../tab-panel/TabPanel';
import { useHostChromeState } from './HostChromeContext';
import { AppSwitcherButton } from './Sidebar';
import { SidebarViewStrip, rememberedWorkbench as remembered, rememberWorkbench as remember, resolveActiveView, viewTitleStyle } from './SidebarViewStrip';
import type { SidebarViewContainer } from '../../types/sidebarChrome';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Activity rail width ('vscode') / reopen strip width ('cursor', closed). */
const RAIL_WIDTH = 48;
/** Rail view button square. */
const RAIL_BTN = 40;
/** Rail icon size inside the button. */
const RAIL_ICON = 20;
/** Panel geometry — matches the classic sidebar so switching modes keeps
    familiar proportions. */
const PANEL_DEFAULT = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
/** Dragging the sash below this closes the panel (the rail remains). */
const SNAP_THRESHOLD = 100;
/** Keyboard resize step (arrow keys on the sash), in px — the DetailPanel
    standard. */
const KEY_RESIZE_STEP = 24;
/** Vertical gap between rail buttons (the rail's flex gap). */
const RAIL_GAP = 4;
/** Drag-and-drop MIME for rail view reordering. */
const RAIL_DND_MIME = 'application/rr-rail-view';

// Per-app memory (remembered/remember) is shared with the compact drawer —
// see SidebarViewStrip.tsx. Both frames read and write the same stored
// selection, so crossing the breakpoint keeps the view you were on.

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** The whole workbench row: rail + panel, one bordered unit. */
	frame: {
		display: 'flex',
		height: '100%',
		background: 'var(--rr-bg-paper)',
		borderRight: '1px solid var(--rr-border)',
		position: 'relative',
		flexShrink: 0,
	} as CSSProperties,
	rail: {
		width: RAIL_WIDTH,
		minWidth: RAIL_WIDTH,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		paddingTop: 8,
		gap: 4,
		borderRight: '1px solid var(--rr-border)',
		// The rail's polarity is the THEME's call: dark (VS Code-style
		// inverted chrome — the tokens' built-in fallbacks) unless the theme
		// declares otherwise (--rr-bg-rail + --rr-rail-mode; rocketride-light
		// runs a paper-colored rail). Icons adapt via useRailMode().
		background: 'var(--rr-bg-rail, #2c2c2c)',
		// REGION REMAP: everything rendered ON the rail (the footer's avatar
		// row included) must hover like a rail button, not like light-panel
		// chrome — a light --rr-bg-surface-alt reads as a white flash here.
		// The footer's menu popup PORTALS to the body, so menus keep the
		// panel palette; only in-rail hovers pick this up.
		['--rr-bg-surface-alt' as string]: 'var(--rr-bg-rail-hover, rgba(255, 255, 255, 0.12))',
	} as CSSProperties,
	railSpacer: { flex: 1 } as CSSProperties,
	/** The measured box the view buttons stack in — fills the rail down to
	    the footer; buttons past the fit collapse behind the more button. */
	railViews: {
		flex: 1,
		minHeight: 0,
		width: '100%',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: RAIL_GAP,
		overflow: 'hidden',
	} as CSSProperties,
	/** The overflow menu beside the rail — icon + title rows. */
	railMoreMenu: {
		position: 'fixed',
		zIndex: 1000,
		minWidth: 180,
		maxHeight: '60vh',
		overflowY: 'auto',
		padding: '4px 0',
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 12.5,
	} as CSSProperties,
	railMenuItem: (hovered: boolean, active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		width: '100%',
		padding: '6px 12px',
		border: 'none',
		background: hovered ? 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))' : 'transparent',
		color: 'var(--rr-text-primary)',
		fontWeight: active ? 600 : 400,
		cursor: 'pointer',
		textAlign: 'left',
		font: 'inherit',
	}),
	railButton: (active: boolean, hovered: boolean): CSSProperties => ({
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: RAIL_BTN,
		height: RAIL_BTN,
		padding: 0,
		border: 'none',
		borderRadius: 8,
		cursor: 'pointer',
		color: active ? 'var(--rr-fg-rail-active, #ffffff)' : 'var(--rr-fg-rail, rgba(255, 255, 255, 0.6))',
		// The active state is a TINT OF THE RAIL'S OWN GROUND (a notch
		// stronger than hover), not a brand accent — design decision
		// 2026-10-12: no colored bars on the rail; selection reads as a
		// pressed surface, the VS Code treatment.
		background: active
			? 'var(--rr-bg-rail-active, rgba(255, 255, 255, 0.18))'
			: hovered ? 'var(--rr-bg-rail-hover, rgba(255, 255, 255, 0.12))' : 'transparent',
		transition: 'background 100ms ease, color 100ms ease',
	}),
	railBadge: {
		position: 'absolute',
		right: 2,
		bottom: 2,
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
	panel: (width: number, resizing: boolean): CSSProperties => ({
		width,
		minWidth: width,
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		transition: resizing ? 'none' : 'width 150ms ease, min-width 150ms ease',
	}),
	header: {
		display: 'flex',
		alignItems: 'center',
		height: 52,
		padding: '8px 12px 0',
		flexShrink: 0,
		marginBottom: 4,
	} as CSSProperties,
	headerButton: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 28,
		height: 28,
		borderRadius: 6,
		border: 'none',
		cursor: 'pointer',
		background: 'transparent',
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
		transition: 'background 120ms ease',
	} as CSSProperties,
	/** The active container's name over the panel body (both variants — the
	    'cursor' strip is icon-only, so it names nothing either). Shared with
	    the compact drawer via SidebarViewStrip. */
	viewTitle: viewTitleStyle,
	body: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		overflowY: 'auto',
		minHeight: 0,
	} as CSSProperties,
	sash: {
		position: 'absolute',
		right: 0,
		top: 0,
		width: 6,
		height: '100%',
		cursor: 'col-resize',
		zIndex: 10,
		// The visible affordance is the inner bar; the hit area stays 6px.
		background: 'transparent',
		touchAction: 'none',
	} as CSSProperties,
	sashBar: {
		position: 'absolute',
		right: 0,
		top: 0,
		width: 2,
		height: '100%',
		background: 'var(--rr-brand)',
	} as CSSProperties,
	/** The 'cursor' variant's closed-state reopen strip. */
	reopenStrip: {
		width: RAIL_WIDTH,
		minWidth: RAIL_WIDTH,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		paddingTop: 8,
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Props for the SidebarWorkbench component — the classic SidebarProps plus
    the variant ShellLayout resolved from the app's declaration. */
export interface SidebarWorkbenchProps {
	/** Which workbench chrome to render. */
	variant: 'vscode' | 'cursor';
	/** Theme picker configuration (footer menu). */
	themeConfig: ShellThemeConfig;
	/** Account info and logout callback (footer menu). */
	account: ShellAccountConfig;
	/** When true, the app switcher submenu in the footer is hidden. */
	hideAppSwitcher?: boolean;
	/** Callback to open a shell overlay (account, settings, environment). */
	onOverlay: (overlay: 'account' | 'settings' | 'environment') => void;
	/** Server-probed edition flag — gates SaaS-only footer items. */
	isSaas?: boolean;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The vscode/cursor sidebar frame. See the file header for the two variants
 * and the shared-content contract.
 *
 * @param props - See {@link SidebarWorkbenchProps}.
 */
const SidebarWorkbench: React.FC<SidebarWorkbenchProps> = ({ variant, themeConfig: _themeConfig, account, hideAppSwitcher, onOverlay, isSaas }) => {
	const { activeAppId, loadedApps } = useWorkspace();
	const { sidebarContent, sidebarViews } = useHostChromeState();

	// --- Declared containers, rail order ----------------------------------------
	// Cheap enough to compute per render (a copy + sort of a handful of
	// declarations). This frame exists ONLY for declared containers: a classic
	// `sidebar={content}` declaration never reaches it (ShellLayout routes it
	// to the classic column), so there is no legacy projection here. Containers
	// WITHOUT their own content still share the registered `sidebar` node —
	// that is the one-data-owner path, not a legacy shim.
	const declaredViews: SidebarViewContainer[] = (sidebarViews ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

	// --- Rail order: user-dragged, remembered per app -----------------------------
	// Ids the memory names render first in that order; anything it doesn't
	// name keeps its declared position after them (new containers appear at
	// the end rather than scrambling the user's arrangement).
	const [railOrder, setRailOrder] = useState<string[]>(() => remembered(activeAppId).railOrder ?? []);
	const views: SidebarViewContainer[] = useMemo(() => {
		if (railOrder.length === 0) return declaredViews;
		const rank = new Map(railOrder.map((id, i) => [id, i]));
		const named = declaredViews.filter((v) => rank.has(v.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
		return [...named, ...declaredViews.filter((v) => !rank.has(v.id))];
		// eslint-disable-next-line react-hooks/exhaustive-deps -- declaredViews is rebuilt per render; its CONTENT only changes with sidebarViews
	}, [sidebarViews, railOrder]);

	// --- Rail drag-reorder ---------------------------------------------------------
	const [dragViewId, setDragViewId] = useState<string | null>(null);
	/** Insertion hint while dragging: drop before/after this button. */
	const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);

	/** Applies a drop: rebuild the FULL ordered id list and remember it. */
	const handleRailDrop = useCallback((targetId: string, after: boolean) => {
		setDropHint(null);
		const dragged = dragViewId;
		setDragViewId(null);
		if (!dragged || dragged === targetId) return;
		const ids = views.map((v) => v.id).filter((id) => id !== dragged);
		const at = ids.indexOf(targetId);
		if (at < 0) return;
		ids.splice(at + (after ? 1 : 0), 0, dragged);
		setRailOrder(ids);
		remember(activeAppId, { railOrder: ids });
	}, [dragViewId, views, activeAppId]);

	// --- Rail overflow ----------------------------------------------------------------
	// The view buttons stack in a measured box (railViews) that ends where the
	// footer begins; buttons past the fit collapse behind a "more" button whose
	// menu lists the hidden containers — the TabControl overflow treatment,
	// vertical.
	const viewsBoxRef = useRef<HTMLDivElement | null>(null);
	const [railSlots, setRailSlots] = useState(Number.MAX_SAFE_INTEGER);
	useLayoutEffect(() => {
		const el = viewsBoxRef.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver((entries) => {
			const h = entries[0]?.contentRect.height ?? 0;
			if (h > 0) setRailSlots(Math.max(1, Math.floor((h + RAIL_GAP) / (RAIL_BTN + RAIL_GAP))));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [variant]);
	const railOverflowing = views.length > railSlots;
	// One slot is spent on the more button itself when overflowing.
	const visibleViews = railOverflowing ? views.slice(0, Math.max(0, railSlots - 1)) : views;
	const hiddenViews = railOverflowing ? views.slice(Math.max(0, railSlots - 1)) : [];

	// The overflow menu (portal beside the rail).
	const [moreOpen, setMoreOpen] = useState(false);
	const [menuHoverId, setMenuHoverId] = useState<string | null>(null);
	const moreBtnRef = useRef<HTMLButtonElement | null>(null);

	// --- Panel state: width, open, active view -----------------------------------
	// Initializers read the per-app memory synchronously (ShellLayout keys this
	// component by app id, so they re-run on every app switch). The app's own
	// `sidebar: 'collapsed'` manifest preference maps to "panel closed" and is
	// honored only when the user has no stored answer for this app yet.
	const [width, setWidth] = useState(() => {
		const w = remembered(activeAppId).width;
		return typeof w === 'number' ? Math.min(Math.max(w, MIN_WIDTH), MAX_WIDTH) : PANEL_DEFAULT;
	});
	const [open, setOpen] = useState(() => {
		const stored = remembered(activeAppId).open;
		if (typeof stored === 'boolean') return stored;
		return loadedApps[activeAppId]?.sidebar !== 'collapsed';
	});
	const [activeViewId, setActiveViewId] = useState(() => remembered(activeAppId).view ?? '');
	const [isResizing, setIsResizing] = useState(false);
	const [sashHover, setSashHover] = useState(false);
	const [hoveredRailId, setHoveredRailId] = useState<string | null>(null);
	// The 'cursor' reopen button: app icon at rest, expand glyph on hover/focus
	// (the classic collapsed-header treatment).
	const [reopenHover, setReopenHover] = useState(false);
	// Stale-hover guard: opening unmounts the reopen button BEFORE its
	// mouseleave can fire (and a sash snap-collapse can likewise strand the
	// flag), so without this reset the next collapsed strip would open on the
	// expand glyph instead of the app icon.
	useLayoutEffect(() => {
		setReopenHover(false);
	}, [open]);

	// A stored id may name a container the app no longer declares — resolve to
	// the declared default (isDefault), then the first container, rather than
	// rendering an empty panel. Shared resolver: the drawer answers identically.
	const activeView = resolveActiveView(views, activeViewId);

	// --- Open/close, with the classic events mapped on ---------------------------

	/** Close the panel (the rail stays), announcing like the classic collapse. */
	const closePanel = useCallback(() => {
		ConnectionManager.getInstance().emit('shell:sidebarCollapsing', {});
		setOpen(false);
		remember(activeAppId, { open: false });
	}, [activeAppId]);

	/** Open the panel. */
	const openPanel = useCallback(() => {
		setOpen(true);
		remember(activeAppId, { open: true });
	}, [activeAppId]);

	/**
	 * Activate a container. The VS Code gesture: an inactive icon switches the
	 * panel to it (opening the panel if needed); the ACTIVE icon toggles the
	 * panel.
	 */
	const activate = useCallback((id: string) => {
		// An id the rail never declared must not become — or PERSIST as — the
		// active view: resolveActiveView would silently fall back to the
		// default tab while the bad id kept re-asserting from storage.
		if (!views.some((v) => v.id === id)) return;
		if (open && activeView?.id === id) {
			closePanel();
			return;
		}
		setActiveViewId(id);
		remember(activeAppId, { view: id });
		if (!open) openPanel();
	}, [open, activeView?.id, activeAppId, closePanel, openPanel, views]);

	// The classic event keeps working in workbench modes: "collapsed" means
	// "panel closed". A LAYOUT effect for the same replay reasons as the
	// classic sidebar (apps emit from their own layout effects on mount).
	useLayoutEffect(() => (
		ConnectionManager.getInstance().on(
			'shell:setSidebarCollapsed',
			({ collapsed: next }: { collapsed: boolean }) => {
				setOpen(!next);
				remember(activeAppId, { open: !next });
			},
		)
	), [activeAppId]);

	// --- The selection handle shared content reads --------------------------------
	const activeViewHandle = useMemo<SidebarActiveView>(() => ({
		activeViewId: activeView?.id ?? '',
		setActiveView: (id: string) => activate(id),
	}), [activeView?.id, activate]);

	// --- Footer menu (same platform items as the classic frame) -------------------
	const { footerMenuItems, homeAppId } = useSidebarFooterMenu({ account, hideAppSwitcher, onOverlay, isSaas });

	// --- Sash: pointer drag + keyboard + double-click reset ------------------------

	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

	/** Begin a drag: capture the pointer and record the starting geometry. */
	const handleSashDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		dragRef.current = { startX: e.clientX, startWidth: width };
		setIsResizing(true);
	}, [width]);

	/** Drag: clamp into [MIN, MAX]; below the snap threshold, close the panel. */
	const handleSashMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!dragRef.current) return;
		const next = dragRef.current.startWidth + (e.clientX - dragRef.current.startX);
		if (next < SNAP_THRESHOLD) {
			if (open) closePanel();
			return;
		}
		if (!open) setOpen(true);
		setWidth(Math.min(Math.max(next, MIN_WIDTH), MAX_WIDTH));
	}, [open, closePanel]);

	/** End a drag: release bookkeeping and persist the settled width. */
	const handleSashUp = useCallback(() => {
		if (!dragRef.current) return;
		dragRef.current = null;
		setIsResizing(false);
		setWidth((settled) => {
			remember(activeAppId, { width: settled, open: true });
			return settled;
		});
	}, [activeAppId]);

	/** Reset to the default width (double-click / Home). */
	const resetWidth = useCallback(() => {
		setWidth(PANEL_DEFAULT);
		remember(activeAppId, { width: PANEL_DEFAULT });
	}, [activeAppId]);

	/** Keyboard resize on the focused sash: arrows step, Home resets. */
	const handleSashKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			setWidth((cur) => {
				const next = Math.min(Math.max(cur + (e.key === 'ArrowRight' ? KEY_RESIZE_STEP : -KEY_RESIZE_STEP), MIN_WIDTH), MAX_WIDTH);
				remember(activeAppId, { width: next });
				return next;
			});
		} else if (e.key === 'Home') {
			e.preventDefault();
			resetWidth();
		}
	}, [activeAppId, resetWidth]);

	// --- Self-hide ------------------------------------------------------------------
	// Content-less only. The frame renders REGARDLESS of auth state (design
	// decision 2026-10-12): the rail and panel are the app's chrome, not a
	// session privilege — the footer shows its anonymous form signed out.
	if (views.length === 0) return null;

	// --- Panel body ------------------------------------------------------------------
	// Containers with their own content switch through the stock TabPanel (all
	// bodies stay mounted); containers without content share the registered
	// `sidebar` node, which reads the active-view context. Both live under the
	// same providers so a mixed declaration behaves.
	const ownContentPanels: Record<string, ITabPanelPanel> = {};
	for (const v of views) {
		if (v.content != null) ownContentPanels[v.id] = { content: v.content };
	}
	const ownIds = Object.keys(ownContentPanels);
	const activeHasOwn = activeView?.content != null;
	// BOTH branches stay mounted, display-toggled: swapping them would
	// remount the shared data owner (re-subscribing monitors, re-scanning)
	// and drop own-content tree/scroll state on every rail switch. The
	// stock TabPanel already keeps its own panels mounted the same way.
	const panelBody = (
		<SidebarActiveViewProvider value={activeViewHandle}>
			{/* The workbench panel never iconifies, so shared content always sees
			    "expanded" — collapse gates inside it stay open. */}
			<SidebarCollapsedProvider value={false}>
				<div style={{ display: activeHasOwn ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
					{sidebarContent}
				</div>
				{ownIds.length > 0 && (
					<div style={{ display: activeHasOwn ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
						<TabPanel activeId={activeHasOwn ? activeView!.id : ownIds[0]} panels={ownContentPanels} />
					</div>
				)}
			</SidebarCollapsedProvider>
		</SidebarActiveViewProvider>
	);

	// --- Render ---------------------------------------------------------------------

	// The sash is shared by both variants; it hangs on the frame's right edge.
	const sash = open && (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize sidebar"
			aria-valuenow={width}
			aria-valuemin={MIN_WIDTH}
			aria-valuemax={MAX_WIDTH}
			tabIndex={0}
			style={styles.sash}
			onPointerDown={handleSashDown}
			onPointerMove={handleSashMove}
			onPointerUp={handleSashUp}
			onPointerCancel={handleSashUp}
			onMouseEnter={() => setSashHover(true)}
			onMouseLeave={() => setSashHover(false)}
			onDoubleClick={resetWidth}
			onKeyDown={handleSashKey}
		>
			{(sashHover || isResizing) && <div style={styles.sashBar} />}
		</div>
	);

	// Panel header: the classic brand lockup (go-home button) + panel close.
	const header = (
		<div style={styles.header}>
			<button
				title="Go to home"
				aria-label="Go to home"
				onClick={() => ConnectionManager.getInstance().emit('shell:switchApp', { appId: homeAppId })}
				onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
				onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
				style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', padding: '2px 4px', borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left', transition: 'background 120ms ease' }}
			>
				<AppSwitcherButton collapsed={false} />
			</button>
			{/* 'vscode' has NO close button here: clicking the active rail icon
			    toggles the panel (the VS Code gesture), so a second control for
			    the same verb is noise. 'cursor' has no rail — the header button
			    is its only close affordance. */}
			{variant === 'cursor' && (
				<button
					title="Close sidebar"
					aria-label="Close sidebar"
					onClick={closePanel}
					onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rr-bg-list-hover, var(--rr-bg-surface-alt))'; }}
					onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
					style={styles.headerButton}
				>
					<BxDockLeft size={18} />
				</button>
			)}
		</div>
	);

	if (variant === 'vscode') {
		return (
			<div id="rr-shell-sidebar" style={styles.frame}>
				{/* ================================================================
				    ACTIVITY RAIL — one icon per container; footer at the foot
				    ================================================================ */}
				<div style={styles.rail} role="tablist" aria-orientation="vertical" aria-label="Sidebar views">
					<div ref={viewsBoxRef} style={styles.railViews}>
						{visibleViews.map((v) => {
							const isActive = open && activeView?.id === v.id;
							const hint = dropHint?.id === v.id ? dropHint : null;
							return (
								<button
									key={v.id}
									role="tab"
									aria-selected={isActive}
									title={v.title}
									aria-label={v.title}
									draggable
									onClick={() => activate(v.id)}
									onMouseEnter={() => setHoveredRailId(v.id)}
									onMouseLeave={() => setHoveredRailId(null)}
									onDragStart={(e) => {
										e.dataTransfer.setData(RAIL_DND_MIME, v.id);
										e.dataTransfer.effectAllowed = 'move';
										setDragViewId(v.id);
									}}
									onDragEnd={() => { setDragViewId(null); setDropHint(null); }}
									onDragOver={(e) => {
										if (!e.dataTransfer.types.includes(RAIL_DND_MIME)) return;
										e.preventDefault();
										e.dataTransfer.dropEffect = 'move';
										const rect = e.currentTarget.getBoundingClientRect();
										setDropHint({ id: v.id, after: e.clientY > rect.top + rect.height / 2 });
									}}
									onDragLeave={() => setDropHint((cur) => (cur?.id === v.id ? null : cur))}
									onDrop={(e) => {
										if (!e.dataTransfer.types.includes(RAIL_DND_MIME)) return;
										e.preventDefault();
										const rect = e.currentTarget.getBoundingClientRect();
										handleRailDrop(v.id, e.clientY > rect.top + rect.height / 2);
									}}
									style={{
										...styles.railButton(isActive, hoveredRailId === v.id),
										...(dragViewId === v.id ? { opacity: 0.4 } : null),
										// Insertion hint: a brand edge on the drop side.
										...(hint ? { boxShadow: `inset 0 ${hint.after ? -2 : 2}px 0 var(--rr-brand)` } : null),
									}}
								>
									<span style={{ display: 'flex', width: RAIL_ICON, height: RAIL_ICON, alignItems: 'center', justifyContent: 'center' }}>{v.icon}</span>
									{v.badge != null && v.badge !== 0 && <span style={styles.railBadge}>{v.badge}</span>}
								</button>
							);
						})}
						{hiddenViews.length > 0 && (
							<button
								ref={moreBtnRef}
								title="More views"
								aria-label="More views"
								aria-haspopup="menu"
								aria-expanded={moreOpen}
								onClick={() => setMoreOpen((o) => !o)}
								onBlur={() => setTimeout(() => setMoreOpen(false), 150)}
								onMouseEnter={() => setHoveredRailId('rr-rail-more')}
								onMouseLeave={() => setHoveredRailId(null)}
								// The hidden ACTIVE container surfaces as a lit more
								// button — the selection stays visible when its icon
								// does not fit.
								style={styles.railButton(open && hiddenViews.some((v) => v.id === activeView?.id), hoveredRailId === 'rr-rail-more')}
							>
								<BxDotsHorizontal size={RAIL_ICON} />
								{moreOpen && moreBtnRef.current && createPortal(
									(() => {
										const rect = moreBtnRef.current.getBoundingClientRect();
										return (
											<div role="menu" style={{ ...styles.railMoreMenu, left: rect.right + 6, top: Math.min(rect.top, window.innerHeight - 320) }}>
												{hiddenViews.map((v) => (
													<button
														key={v.id}
														role="menuitem"
														style={styles.railMenuItem(menuHoverId === v.id, open && activeView?.id === v.id)}
														onMouseEnter={() => setMenuHoverId(v.id)}
														onMouseLeave={() => setMenuHoverId(null)}
														onMouseDown={(e) => { e.preventDefault(); activate(v.id); setMoreOpen(false); }}
													>
														<span style={{ display: 'flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{v.icon}</span>
														<span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.title}</span>
														{v.badge != null && v.badge !== 0 && <span style={{ ...styles.railBadge, position: 'static' }}>{v.badge}</span>}
													</button>
												))}
											</div>
										);
									})(),
									document.body,
								)}
							</button>
						)}
					</div>
					{/* The platform footer rides the rail so the account menu stays
					    reachable with the panel closed. The Documentation icon joins
					    it ONLY while the panel is closed — open, the panel's own
					    foot carries the labelled row (and the ticker). */}
					{/* Rendered signed out too — the footer has an anonymous form. */}
					<SidebarFooter
						collapsed
						userName={account.userName}
						userEmail={account.userEmail}
						menuItems={footerMenuItems}
						onOpenDocs={open ? undefined : openPlatformDocs}
					/>
				</div>

				{/* ================================================================
				    PANEL — header, active container title, body, platform foot
				    ================================================================ */}
				{open && (
					<div style={styles.panel(width, isResizing)}>
						{header}
						{/* A single declared view would just repeat the header's app
						    name — the title row earns its space only when there is
						    a choice of views. */}
						{activeView && views.length > 1 && <div style={styles.viewTitle}>{activeView.title}</div>}
						<div style={styles.body}>{panelBody}</div>
						{/* The platform's channel at the panel's foot: announcements
						    ticker + Documentation row. The account row stays on the
						    rail — this is everything else the classic footer held. */}
						<SidebarFooterExtras padded onOpenDocs={openPlatformDocs} />
					</div>
				)}
				{sash}
			</div>
		);
	}

	// --- 'cursor' variant: tab strip over the panel, slim reopen strip closed ---
	if (!open) {
		return (
			<div id="rr-shell-sidebar" style={{ ...styles.frame }}>
				<div style={styles.reopenStrip}>
					{/* The classic collapsed-header gesture: the APP'S icon at rest,
					    swapping to the expand glyph on hover/focus (same 40×40 box,
					    so no layout shift). Always mounted — and focus-reveals the
					    icon — so keyboard and touch users can expand without
					    hovering. */}
					<button
						title="Expand sidebar"
						aria-label="Expand sidebar"
						onClick={openPanel}
						onMouseEnter={() => setReopenHover(true)}
						onMouseLeave={() => setReopenHover(false)}
						onFocus={() => setReopenHover(true)}
						onBlur={() => setReopenHover(false)}
						style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: RAIL_BTN, height: RAIL_BTN, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--rr-text-secondary)', flexShrink: 0, padding: 0 }}
					>
						{reopenHover ? <BxDockLeft size={20} /> : <AppSwitcherButton collapsed />}
					</button>
					<div style={styles.railSpacer} />
					<SidebarFooter
						collapsed
						userName={account.userName}
						userEmail={account.userEmail}
						menuItems={footerMenuItems}
						onOpenDocs={openPlatformDocs}
					/>
				</div>
			</div>
		);
	}

	return (
		<div id="rr-shell-sidebar" style={styles.frame}>
			<div style={styles.panel(width, isResizing)}>
				{header}
				{/* The container switcher as a horizontal ICON strip — one glyph
				    per container, the title as its hover hint; the active view's
				    name renders in the title row below, same as 'vscode'. The
				    SAME component the compact drawer renders — one switcher,
				    two frames. */}
				<SidebarViewStrip views={views} activeId={activeView?.id ?? ''} onSelect={activate} />
				{activeView && views.length > 1 && <div style={styles.viewTitle}>{activeView.title}</div>}
				<div style={styles.body}>{panelBody}</div>
				{/* Footer inside the panel — the cursor variant has no rail, so
				    the full footer (ticker + docs + account row) lives here. */}
				<SidebarFooter
					collapsed={false}
					userName={account.userName}
					userEmail={account.userEmail}
					menuItems={footerMenuItems}
					onOpenDocs={openPlatformDocs}
				/>
			</div>
			{sash}
		</div>
	);
};

export default SidebarWorkbench;
