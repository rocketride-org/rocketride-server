// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DetailPanel — the slide-over drawer for entity details.
 *
 * The standard way to show an entity's details (connection, user, model, job):
 * a panel that slides in over a dimmed client area, replacing detail modals.
 * Centered modals (`commonStyles.modalDialog`) remain only for confirmations
 * and short forms.
 *
 * Orientation: `side: 'right'` (the default — full-height drawer from the
 * right edge) is THE record-panel standard; vertical record content (forms,
 * LabelValue stacks) fits a tall narrow surface. `side: 'bottom'` slides a
 * full-width tray up from the bottom edge — for WIDE, ambient content
 * (consoles, logs, traces, wide tables) that reads better short-and-wide,
 * mirroring the record/console split familiar from Stripe's dashboard.
 *
 * Anatomy (matches the style-guide 6.2 / mockup):
 * - a fixed EntityHeader (42px avatar/icon slot + title + secondary line + close),
 * - an optional underline tab strip taking the same {@link ViewMenuEntry} shape as
 *   TabControl/SidebarMenu (count badges reuse the shared {@link ViewMenuBadge}),
 * - a scrollable body composed from Section / LabelValue / Chip / StatusBadge /
 *   MiniContainer / Button.
 *
 * Accessibility: the panel is a modal dialog (`role="dialog"`, `aria-modal`,
 * `aria-label` = title). Opening moves focus to the close button; closing returns
 * focus to whatever was focused before, and Escape closes the drawer.
 */

import React, { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { ViewMenuEntry } from '../../types/viewMenu';
import { ViewMenuBadge } from '../tab-control/ViewMenuBadge';
import { CLOSE_GLYPH, trapFocus, acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { BxChevronLeft } from '../BoxIcon';
import { usePrefs } from '../../contexts/PrefsContext';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width when the caller does not override `width`. */
const DEFAULT_WIDTH = 560;

/** Stacked-panel sliver: each covered panel stays this much wider (px). */
const STACK_OFFSET = 40;

/** Narrowest usable drawer — forms and footer verbs break below this. */
const MIN_WIDTH = 380;

/** Default bottom-tray height when the caller does not override `height`. */
const DEFAULT_HEIGHT = 420;

/** Shortest usable bottom tray — header + a few content rows break below. */
const MIN_HEIGHT = 240;

/** Context sliver: dimmed host pixels that must stay visible beside the drawer. */
const CONTEXT_SLIVER = 120;

/** Widest drawer as a fraction of the owning surface. */
const MAX_HOST_FRACTION = 0.85;

/** Keyboard resize step (arrow keys on the handle), in px. */
const KEY_RESIZE_STEP = 24;

// =============================================================================
// PANEL STACK REGISTRY
// =============================================================================
// Open panels register here in push order (bottom -> top), scoped so viewport
// drawers and `contained` drawers (the Account dialog) form INDEPENDENT
// stacks. The registry drives the interaction standard's stack rules
// (2026-07-18): depth-aware width (the TOP panel's width W; every covered
// panel renders W + 40px per level, keeping a constant sliver), the header
// back arrow, inert covered layers, X-closes-the-whole-stack with ONE
// aggregate dirty confirm, and the sliver click that peels the top panel.

/** One open panel's registry entry (callbacks read refs — always live). */
interface IStackEntry {
	/** True when the panel's form mode holds unsaved changes. */
	isDirty: () => boolean;
	/** Raw close (the consumer's onClose) — no guards. */
	close: () => void;
	/** Guarded self-close: discard confirm when dirty, then close. */
	requestPeel: () => void;
	/** Current rendered size along the slide axis (seeds a push). */
	getSize: () => number;
	/** Entity title (labels the back arrow of the panel above). */
	getTitle: () => string;
}

/** Push-ordered open panels per scope. */
const stackScopes: Record<string, IStackEntry[]> = { viewport: [], contained: [] };

/** The stacked TOP panel's width per scope; null while not stacked. */
const stackSharedSize: Record<string, number | null> = { viewport: null, contained: null };

/** Subscribers re-rendered on every stack mutation. */
const stackListeners = new Set<() => void>();

/** Notify every open panel that the stack changed shape. */
function notifyStack(): void {
	stackListeners.forEach((listener) => listener());
}

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DetailPanel} component. */
export interface IDetailPanelProps {
	/** Whether the drawer is open. When false the component renders nothing. */
	open: boolean;
	/** Fired when the user dismisses the drawer (close glyph or Escape). */
	onClose: () => void;
	/** 42px round avatar/icon slot rendered at the start of the EntityHeader. */
	avatar?: ReactNode;
	/** Entity title — 17px/700. */
	title: string;
	/** Secondary line under the title — 12.5px, secondary colour. */
	subtitle?: string;
	/** Optional tab strip. Same entry shape as the ViewMenu renderers. */
	tabs?: ViewMenuEntry[];
	/** Id of the active tab (drawn with the brand underline). */
	activeTab?: string;
	/** Fired with a tab id when the user selects a tab. */
	onTabSelect?: (id: string) => void;
	/** Body content — composed from Section / LabelValue / Chip / StatusBadge /
	    MiniContainer / Button. Scrolls independently of the header and tabs. */
	children: ReactNode;
	/**
	 * Which edge the panel slides from. `'right'` (default) is the record-panel
	 * standard: a full-height drawer for vertical record content. `'bottom'`
	 * is a full-width tray for wide, ambient content (consoles, logs, wide
	 * tables). All layering, focus, containment, and footer behavior is
	 * identical between the two.
	 */
	side?: 'right' | 'bottom';
	/** Drawer width in px (side 'right' only). Default {@link DEFAULT_WIDTH}. */
	width?: number;
	/**
	 * Override the resize FLOOR (side 'right' only). The default floor is
	 * {@link MIN_WIDTH} (380 — form-safe for record panels). A non-record drawer
	 * whose content reads fine narrow (a node/catalog palette) can lower it so
	 * the user can drag it slim. Ignored for `side: 'bottom'`.
	 */
	minWidth?: number;
	/** Tray height in px (side 'bottom' only). Default {@link DEFAULT_HEIGHT}. */
	height?: number;
	/**
	 * Fixed action row pinned below the scrolling body (record-panel verbs:
	 * Save / Cancel / destructive actions). Rendered with a top divider;
	 * omitted = no footer row (pure inspect panels).
	 */
	footer?: ReactNode;
	/**
	 * Body hosts a full VIEW (its own TabControl strip, gutters, and inner
	 * scroll regions): the body becomes a definite, non-scrolling flex box
	 * with no padding — the hosted View owns all scrolling. Without this, a
	 * height-100% View collapses inside the default scrolling body and
	 * scrollbars double up. Ignored when `tabs` are used (bodyTabs already
	 * stops outer scrolling).
	 */
	flushBody?: boolean;
	/**
	 * Anchor the drawer to the nearest POSITIONED ANCESTOR instead of the
	 * viewport. A slide-out anchors to the surface that OWNS the record:
	 * grids on app pages open viewport drawers;
	 * grids inside a dialog (the Account overlay) open drawers clipped to the
	 * dialog's own edge — a window-edge drawer over a modal reads as an
	 * unrelated second window and fights the backdrop stacking. The host
	 * surface must be `position: relative` with `overflow: hidden`.
	 */
	contained?: boolean;
	/**
	 * Growing-edge drag resizing (ON by default; pass false to opt out) —
	 * the left edge of a right drawer, the top edge of a bottom tray. The
	 * size clamps between the axis floor ({@link MIN_WIDTH} / {@link MIN_HEIGHT})
	 * and the OWNING SURFACE's size minus a visible sliver of dimmed context
	 * (capped at 85%), so the panel can neither collapse below a usable
	 * content size nor fully occlude the page behind it — the dimmed edge is
	 * what communicates "overlay, not navigation". Double-click the handle to
	 * restore the default size; the dragged size lasts for the panel's open
	 * lifetime. In a STACK, only the top panel's handle is live and dragging
	 * it resizes the whole stack (covered panels follow at +40px per level).
	 */
	resizable?: boolean;
	/**
	 * The panel's form mode (Edit/Create) holds unsaved changes. Arms the
	 * DISCARD GUARD (interaction standard 2026-07-18): Escape, the back
	 * arrow, the sliver click, and the header X all raise the stock
	 * "Discard changes?" ConfirmDialog instead of exiting silently. The
	 * consumer's footer Cancel should route through the same guard by
	 * checking its own dirty state before calling {@link onExitMode}.
	 */
	dirty?: boolean;
	/**
	 * True while the panel is in a FORM mode (Edit or Create). Escape then
	 * peels the innermost STATE layer — it acts as Cancel (guarded by
	 * `dirty`) and calls {@link onExitMode} instead of closing the panel.
	 */
	editing?: boolean;
	/**
	 * Leave the form mode back to Inspect (Escape's Cancel path and the
	 * confirmed discard). Create-mode panels typically close instead —
	 * point this at the same handler that closes the create panel.
	 */
	onExitMode?: () => void;
	/**
	 * An async record action is in flight (saving/creating). The panel is
	 * undismissable while true: X, Escape, back, and the sliver click all
	 * no-op — the consumer's footer verbs disable themselves.
	 */
	busy?: boolean;
	/**
	 * MODELESS drawer (default false = modal). A modeless drawer drops the dim
	 * backdrop and lets pointer / drag events pass THROUGH the overlay to the
	 * surface behind it, so that surface stays fully interactive while the panel
	 * is open — the canvas palettes (Add Node) that must keep drag-to-add onto
	 * the graph working. It also skips the page-scroll lock and the Tab focus
	 * trap, and reports `aria-modal="false"`. Dismissal is still deliberate-only
	 * (close glyph / Escape); only the drawer box itself captures pointer events.
	 * Everything else (slide-in, resize, footer, header) is identical to a modal
	 * drawer. Not for records — a record editor is modal; reserve this for
	 * non-modal tool/palette drawers over a live surface.
	 */
	modeless?: boolean;
	/**
	 * Opt-in width persistence. Set a STABLE key (one per panel role, not per
	 * record — e.g. `panelDetailUserWidth`) and the drawer RESTORES its saved
	 * size on open (clamped to the current usable band) and SAVES the new size on
	 * every resize-end (drag, keyboard step, reset). Omit it and the drawer is
	 * session-local — it opens at `width`/`height` every time (the default).
	 * Persistence applies to a LONE panel only: a stack's shared width stays
	 * session-local by the interaction standard.
	 *
	 * The value is read/written through the ambient {@link usePrefs} accessor —
	 * the app's WORKSPACE preferences — so the width rides the workspace file and
	 * syncs per-user, never browser `localStorage`. If no {@link PrefsProvider} is
	 * mounted above the panel, persistence simply no-ops (the drawer stays
	 * session-local); nothing crashes.
	 */
	persistKey?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Full-area dim backdrop; sits above content but below shell modals (2000).
	// Contained mode swaps `fixed` for `absolute` so the backdrop (and the
	// drawer inside it) fill the nearest positioned ancestor — the surface
	// that owns the record — instead of the viewport. Modeless mode drops the
	// dim and sets pointerEvents:none so the surface behind stays interactive
	// (drag / click pass THROUGH to it); the drawer box re-enables its own
	// pointer events via styles.panel.
	overlay: (contained: boolean, modeless: boolean): CSSProperties => ({
		position: contained ? 'absolute' : 'fixed',
		inset: 0,
		zIndex: 1500,
		background: modeless ? 'transparent' : 'color-mix(in srgb, var(--rr-text-primary) 30%, transparent)',
		pointerEvents: modeless ? 'none' : 'auto',
		// Clip the drawer while it sits at translateX(100%): a transformed
		// element EXTENDS ancestor scroll regions, and anything that then
		// scrolls an ancestor toward it (native autoFocus was the culprit)
		// visibly drags the page sideways ("the page flies in" bug).
		overflow: 'hidden',
	}),

	// The drawer itself, pinned to its edge. `entered` drives the slide-in:
	// right = full-height drawer entering along X; bottom = full-width tray
	// entering along Y. Shadow always falls toward the dimmed host content.
	panel: (size: number, entered: boolean, bottom: boolean): CSSProperties => ({
		position: 'absolute',
		...(bottom ? { left: 0, right: 0, bottom: 0, height: size } : { top: 0, right: 0, bottom: 0, width: size }),
		background: 'var(--rr-bg-default)',
		boxShadow: bottom ? '0 -10px 30px color-mix(in srgb, var(--rr-text-primary) 20%, transparent)' : '-10px 0 30px color-mix(in srgb, var(--rr-text-primary) 20%, transparent)',
		// The drawer box always captures pointer events, so a MODELESS overlay
		// (pointerEvents:none) still lets the drawer itself be interactive while
		// the surface behind it stays live.
		pointerEvents: 'auto',
		display: 'flex',
		flexDirection: 'column',
		// Slide-in: off-screen to flush over a 200ms ease-out transition.
		transform: entered ? 'translate(0, 0)' : bottom ? 'translateY(100%)' : 'translateX(100%)',
		transition: 'transform 200ms ease-out',
	}),

	// Fixed EntityHeader row: avatar + name/secondary + close.
	header: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		gap: 13,
		padding: '18px 20px 12px',
	} as CSSProperties,

	// 42px round slot centring the caller's avatar/icon node.
	avatar: {
		flexShrink: 0,
		width: 42,
		height: 42,
		borderRadius: '50%',
		overflow: 'hidden',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,

	// Stacked title + secondary line.
	who: {
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	title: {
		fontSize: 17,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	subtitle: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Close affordance — a real button (focus target) styled as the bare glyph.
	close: {
		marginLeft: 'auto',
		flexShrink: 0,
		background: 'none',
		border: 'none',
		padding: 0,
		fontFamily: 'inherit',
		fontSize: 18,
		lineHeight: 1,
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
	} as CSSProperties,

	// Underline tab strip (only rendered when `tabs` are provided).
	tabs: {
		flex: 'none',
		display: 'flex',
		gap: 24,
		padding: '0 20px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	// A single tab; the active treatment (brand colour + underline) is layered on.
	tab: (active: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 7,
		padding: '8px 2px 10px',
		fontSize: 13.5,
		fontWeight: 600,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-secondary)',
		borderBottom: `2px solid ${active ? 'var(--rr-brand)' : 'transparent'}`,
		cursor: 'pointer',
	}),

	// Back affordance on stacked panels (depth >= 1): a bare chevron glyph
	// LEFT of the avatar, the close glyph's quiet treatment.
	back: {
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		background: 'none',
		border: 'none',
		padding: 2,
		marginLeft: -6,
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
	} as CSSProperties,

	// Scrollable body; the header and tabs stay fixed above it.
	body: {
		flex: 1,
		overflowY: 'auto',
		padding: '6px 20px 20px',
	} as CSSProperties,

	// Tabbed body (interaction standard 2026-07-18): the OUTER region stops
	// scrolling — each tab panel owns its own overflow (PanelTabBody for
	// Section stacks; grids/viewers own theirs).
	bodyTabs: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		padding: '6px 20px 20px',
	} as CSSProperties,

	// Flush body (View-hosting drawers): a full *View* mounted as the body —
	// with its own TabControl strip, gutters, and inner scroll regions —
	// needs a definite flex box and NO padding or outer scrolling, or its
	// height-100% chain breaks and scrollbars double up.
	bodyFlush: {
		flex: 1,
		minHeight: 0,
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		padding: 0,
	} as CSSProperties,

	// Covered-layer catcher: sits over a panel that is NOT the stack top —
	// an extra dim that makes depth readable, swallows every interaction
	// (the covered panel is inert), and turns the exposed sliver into the
	// "go back" click target (it peels the TOP panel).
	coveredCatcher: {
		position: 'absolute',
		inset: 0,
		zIndex: 2,
		background: 'color-mix(in srgb, var(--rr-text-primary) 18%, transparent)',
		cursor: 'pointer',
	} as CSSProperties,

	// Resize handle: a slim grab strip over the panel's growing edge — the
	// LEFT edge of a right drawer, the TOP edge of a bottom tray. The tint
	// appears on hover / during drag (the canvas splitters' sash token, so
	// the affordance matches the rest of the platform).
	resizeHandle: (active: boolean, bottom: boolean): CSSProperties => ({
		position: 'absolute',
		...(bottom ? { top: 0, left: 0, right: 0, height: 6, cursor: 'row-resize' } : { left: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize' }),
		zIndex: 1,
		background: active ? 'var(--rr-sash-hover)' : 'transparent',
		touchAction: 'none',
	}),

	// Fixed footer action row (record-panel verbs), divided from the body.
	// Buttons right-aligned like Modal footers; destructive verbs sit at the
	// LEFT edge by convention (callers use marginRight:'auto' on that button).
	footer: {
		flex: 'none',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: 8,
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the right slide-over detail drawer.
 *
 * @param props - {@link IDetailPanelProps}.
 * @returns The drawer element, or `null` when closed.
 */
export function DetailPanel({ open, onClose, avatar, title, subtitle, tabs, activeTab, onTabSelect, children, side = 'right', width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, footer, flushBody, contained, resizable = true, dirty, editing, onExitMode, busy, modeless, minWidth, persistKey }: IDetailPanelProps): React.ReactElement | null {
	// The ambient workspace-prefs accessor (no-op when no PrefsProvider is
	// mounted) — the single store DetailPanel persists its width through.
	const prefs = usePrefs();
	// Orientation flag: a bottom tray resizes along Y instead of X; every
	// other behavior (layering, focus, containment) is orientation-agnostic.
	const bottom = side === 'bottom';
	// The caller's default size along the slide axis (width or height).
	const defaultSize = bottom ? height : width;
	// The axis floor: content-safe height for a tray; for a drawer the record-safe
	// MIN_WIDTH unless the caller lowered it (a slim non-record palette).
	const minSize = bottom ? MIN_HEIGHT : (minWidth ?? MIN_WIDTH);
	// Drives the slide-in: false on mount (off-screen), flipped true next frame.
	const [entered, setEntered] = useState(false);
	// The drawer box — Tab focus is trapped inside it while open.
	const panelRef = useRef<HTMLDivElement>(null);
	// The overlay box — its size IS the owning surface, the resize clamp's
	// reference (dialog in contained mode, viewport otherwise).
	const overlayRef = useRef<HTMLDivElement>(null);
	// User-dragged size along the slide axis; null = the caller's default. Lives
	// only while open (the closed panel unmounts). Seeded from the caller's
	// persisted width when keyed (see persistKey/persistence), so a keyed panel
	// reopens at its last size; otherwise every open starts at the default. A
	// restored value is re-clamped to the current band by the open effect below.
	const [dragSize, setDragSize] = useState<number | null>(() => {
		if (persistKey) {
			const stored = prefs.getPref(persistKey);
			if (typeof stored === 'number' && stored > 0) return stored;
		}
		return null;
	});
	// Resize interaction state: hover / drag tint + in-flight drag bookkeeping.
	const [resizeActive, setResizeActive] = useState(false);
	const dragRef = useRef<{ start: number; startSize: number } | null>(null);

	/**
	 * Clamp a candidate size to the usable band: never below the axis floor,
	 * never large enough to hide the owning surface's context sliver.
	 *
	 * @param candidate - Proposed size in px along the slide axis.
	 * @returns The clamped size.
	 */
	/** Event-time stack lookup: the scope's entries and whether THIS panel is
	    the top of a live (2+ panel) right-drawer stack. */
	const stackStateNow = (): { entries: IStackEntry[]; stackedTop: boolean } => {
		const entries = stackScopes[contained ? 'contained' : 'viewport'];
		const stackedTop = !bottom && entries.length > 1 && entryRef.current === entries[entries.length - 1];
		return { entries, stackedTop };
	};

	const clampSize = (candidate: number): number => {
		const host = bottom ? (overlayRef.current?.clientHeight ?? window.innerHeight) : (overlayRef.current?.clientWidth ?? window.innerWidth);
		// In a stack the clamp binds the ROOT (deepest, widest) panel: the top
		// may grow only until root = top + 40/level still fits the host band.
		const { entries, stackedTop } = stackStateNow();
		const allowance = stackedTop ? STACK_OFFSET * (entries.length - 1) : 0;
		const max = Math.max(minSize, Math.min(host * MAX_HOST_FRACTION, host - CONTEXT_SLIVER) - allowance);
		return Math.min(Math.max(candidate, minSize), max);
	};

	/** Route a resize: a stacked TOP drag drives the shared stack width (the
	    whole stack reshapes, slivers constant); a lone panel keeps its own. */
	const applySize = (next: number): void => {
		const { stackedTop } = stackStateNow();
		if (stackedTop) {
			stackSharedSize[contained ? 'contained' : 'viewport'] = next;
			notifyStack();
		} else {
			setDragSize(next);
		}
	};

	/** Begin a drag: capture the pointer and record the starting geometry. */
	const handleResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		dragRef.current = { start: bottom ? e.clientY : e.clientX, startSize: sizeRef.current };
		setResizeActive(true);
	};

	/** Drag: the panel is edge-anchored, so moving TOWARD the opposite edge
	    (left for a right drawer, up for a bottom tray) grows the size. */
	const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		if (!dragRef.current) return;
		const position = bottom ? e.clientY : e.clientX;
		applySize(clampSize(dragRef.current.startSize + (dragRef.current.start - position)));
	};

	/**
	 * Persist the current LONE-panel size through the ambient prefs accessor.
	 * No-op without a persistKey, and skipped while stacked — a stack's shared
	 * width is session-local by the interaction standard.
	 *
	 * @param size - Size (px along the slide axis) to save.
	 */
	const persistSize = (size: number): void => {
		if (!persistKey) return;
		// Registered panels include THIS one, so "lone" means exactly one entry.
		if (stackScopes[contained ? 'contained' : 'viewport'].length > 1) return;
		prefs.setPref(persistKey, size);
	};

	/** End a drag: release bookkeeping (pointer capture releases natively) and
	    persist the settled size for keyed panels. */
	const handleResizeUp = (): void => {
		dragRef.current = null;
		setResizeActive(false);
		persistSize(sizeRef.current);
	};

	/** Reset to the default size: a stacked top resets so the ROOT lands on
	    the default; a lone panel simply drops its dragged size. */
	const resetSize = (): void => {
		const { entries, stackedTop } = stackStateNow();
		if (stackedTop) {
			stackSharedSize[contained ? 'contained' : 'viewport'] = Math.max(minSize, defaultSize - STACK_OFFSET * (entries.length - 1));
			notifyStack();
		} else {
			setDragSize(null);
			// A keyed lone panel remembers the reset — reopen at the default, not
			// the last dragged size.
			persistSize(defaultSize);
		}
	};

	/** Keyboard resize on the focused handle: arrows along the slide axis
	    step the size (toward the opposite edge grows), Home resets. Each step is
	    a settled size, so keyed panels persist it. */
	const handleResizeKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		const current = sizeRef.current;
		const grow = bottom ? 'ArrowUp' : 'ArrowLeft';
		const shrink = bottom ? 'ArrowDown' : 'ArrowRight';
		if (e.key === grow) {
			e.preventDefault();
			const next = clampSize(current + KEY_RESIZE_STEP);
			applySize(next);
			persistSize(next);
		} else if (e.key === shrink) {
			e.preventDefault();
			const next = clampSize(current - KEY_RESIZE_STEP);
			applySize(next);
			persistSize(next);
		} else if (e.key === 'Home') {
			e.preventDefault();
			resetSize();
		}
	};
	// Focus target on open; also the button the close glyph fires.
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	// Element focused before opening, restored on close.
	const previouslyFocusedRef = useRef<Element | null>(null);
	// Latest onClose kept in a ref so the open effect need not depend on it
	// (which would re-run — and re-steal focus — on every parent render).
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// ── Interaction-standard state (2026-07-18) ────────────────────────────
	// Live mirrors for the registry entry and keyboard handlers — all of them
	// must read the CURRENT values without re-registering.
	const dirtyRef = useRef(dirty === true);
	dirtyRef.current = dirty === true;
	const editingRef = useRef(editing === true);
	editingRef.current = editing === true;
	const busyRef = useRef(busy === true);
	busyRef.current = busy === true;
	// Modeless is stable for a panel's open lifetime, but the open effect reads
	// it through a ref so it never lands in that effect's dependency list (which
	// would re-run it and re-steal focus on a parent render).
	const modelessRef = useRef(modeless === true);
	modelessRef.current = modeless === true;
	const onExitModeRef = useRef(onExitMode);
	onExitModeRef.current = onExitMode;
	const titleRef = useRef(title);
	titleRef.current = title;
	// Which exit path is waiting on the "Discard changes?" confirm.
	const [discardPending, setDiscardPending] = useState<'exit-mode' | 'close' | 'close-all' | null>(null);
	// This panel's registry entry while open, and the rendered-size mirror
	// that seeds a push (the child starts at OUR size minus the sliver).
	const entryRef = useRef<IStackEntry | null>(null);
	const sizeRef = useRef(defaultSize);
	// Bumped by the registry so every panel re-derives its stack geometry.
	const [, setStackTick] = useState(0);
	// Registry scope: viewport drawers and contained drawers stack separately.
	const stackScope = contained ? 'contained' : 'viewport';

	/** Guarded self-close — the back arrow, sliver click, and Escape-in-Inspect. */
	const requestPeel = (): void => {
		if (busyRef.current) return;
		if (dirtyRef.current) setDiscardPending('close');
		else onCloseRef.current();
	};
	// Ref so the registry entry (a stable closure) always calls the live one.
	const requestPeelRef = useRef(requestPeel);
	requestPeelRef.current = requestPeel;

	/** Unwind every layer top -> bottom. Focus restores chain to the root's
	    opener: each restore targets a detached node once its panel unmounts,
	    which no-ops, so the earliest (root) restore wins. */
	const closeAllInScope = (): void => {
		[...stackScopes[stackScope]].reverse().forEach((e) => e.close());
	};

	/** The header X — closes the ENTIRE stack (interaction standard): one
	    aggregate discard confirm when ANY layer holds unsaved changes. */
	const requestCloseAll = (): void => {
		if (busyRef.current) return;
		if (stackScopes[stackScope].some((e) => e.isDirty())) setDiscardPending('close-all');
		else closeAllInScope();
	};

	/** Escape — peels the innermost STATE layer: an open confirm handles its
	    own Escape (it is the top overlay layer); a form mode acts as Cancel
	    (dirty-guarded) via onExitMode; Inspect mode peels the panel. */
	const handleEscape = (): void => {
		if (busyRef.current) return;
		if (editingRef.current) {
			if (dirtyRef.current) setDiscardPending('exit-mode');
			else if (onExitModeRef.current) onExitModeRef.current();
			else onCloseRef.current();
		} else {
			requestPeel();
		}
	};
	const handleEscapeRef = useRef(handleEscape);
	handleEscapeRef.current = handleEscape;

	// Entering a FORM mode after open re-runs the late first-field focus: the
	// data-rr-autofocus marker mounts WITH the mode's inputs, so the open
	// effect's one-shot timer never sees it on an inspect-first panel. A
	// short delay lets the mode's inputs commit to the DOM first.
	useEffect(() => {
		if (!open || editing !== true) return undefined;
		const timer = window.setTimeout(() => {
			const field = panelRef.current?.querySelector<HTMLElement>('[data-rr-autofocus]');
			field?.focus({ preventScroll: true });
		}, 30);
		return () => clearTimeout(timer);
	}, [open, editing]);

	// Stack registration: push on open, pop on close. Pushing over an existing
	// panel seeds the shared TOP width from the covered panel's rendered size
	// minus the sliver, so the covered panel does not move at push time.
	useEffect(() => {
		if (!open) return undefined;
		const entries = stackScopes[stackScope];
		if (!bottom && entries.length > 0) {
			const below = entries[entries.length - 1];
			stackSharedSize[stackScope] = Math.max(minSize, below.getSize() - STACK_OFFSET);
		}
		const entry: IStackEntry = {
			isDirty: () => dirtyRef.current,
			close: () => onCloseRef.current(),
			requestPeel: () => requestPeelRef.current(),
			getSize: () => sizeRef.current,
			getTitle: () => titleRef.current,
		};
		entryRef.current = entry;
		entries.push(entry);
		const listener = (): void => setStackTick((t) => t + 1);
		stackListeners.add(listener);
		notifyStack();
		return () => {
			const at = entries.indexOf(entry);
			if (at >= 0) entries.splice(at, 1);
			entryRef.current = null;
			// The shared width dissolves when fewer than two panels remain —
			// a lone panel returns to its own dragged/default size.
			if (entries.length < 2) stackSharedSize[stackScope] = null;
			stackListeners.delete(listener);
			notifyStack();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, stackScope, bottom]);

	// While open: lock page scroll, animate in, move focus in, and wire Escape.
	// Cleanup reverses every side effect and restores the prior focus.
	useEffect(() => {
		if (!open) {
			return;
		}
		// Remember what to restore focus to when the drawer closes.
		previouslyFocusedRef.current = document.activeElement;
		// Join the SHARED overlay stack (same registry Modal uses): a modal drawer
		// locks page scroll; a modeless drawer joins WITHOUT locking so the surface
		// behind stays scrollable/pannable. Either way it participates in the stack
		// so a Modal stacked over this drawer becomes the topmost layer and keyboard
		// handling never double-fires across layers.
		const layer = acquireOverlayLayer(!modelessRef.current);
		// Trigger the slide-in on the next frame so the transition actually runs.
		const enterRaf = requestAnimationFrame(() => setEntered(true));
		// Move focus into the panel (the close button). preventScroll: focus()
		// otherwise scrolls the focused element into view in every scrollable
		// ancestor — the drawer is position:fixed so this is belt-and-braces
		// here, but it keeps both focus sites symmetric (see the restore below).
		const focusRaf = requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
		// Late first-field focus: panels mark their opening input with
		// data-rr-autofocus INSTEAD of native autoFocus. Native autoFocus
		// fires at MOUNT — while the drawer is still translated off-screen —
		// and focuses WITHOUT preventScroll, so the browser scrolls ancestors
		// toward the off-screen input and drags the page sideways. Focusing
		// after the 200ms slide, with preventScroll, keeps the layout still.
		const fieldTimer = window.setTimeout(() => {
			const field = panelRef.current?.querySelector<HTMLElement>('[data-rr-autofocus]');
			field?.focus({ preventScroll: true });
		}, 220);
		// Escape peels the innermost STATE layer (form mode acts as Cancel,
		// Inspect peels the panel — see handleEscape); Tab is trapped inside
		// the drawer — aria-modal alone does not stop keyboard focus from
		// wandering into the page behind.
		const onKeyDown = (event: KeyboardEvent): void => {
			// Only the topmost overlay reacts: with a dialog open over this
			// drawer, Escape must close the dialog alone, and only ONE focus
			// trap may steer document.activeElement.
			if (!isTopOverlayLayer(layer)) return;
			if (event.key === 'Escape') {
				handleEscapeRef.current();
			} else if (event.key === 'Tab' && panelRef.current && !modelessRef.current) {
				// A modeless drawer never traps Tab — focus may leave for the live
				// surface behind it (that is what "modeless" means).
				trapFocus(event, panelRef.current);
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => {
			cancelAnimationFrame(enterRaf);
			cancelAnimationFrame(focusRaf);
			clearTimeout(fieldTimer);
			document.removeEventListener('keydown', onKeyDown);
			// Leave the stack (restores page scroll when the last layer closes).
			releaseOverlayLayer(layer);
			// Reset so a subsequent open animates from off-screen again.
			setEntered(false);
			// Return focus to whatever held it before the drawer opened.
			// preventScroll is REQUIRED here: opening from a DataGrid row click
			// leaves Tabulator's `.tabulator-tableholder` (which carries
			// tabindex="0") as the previously-focused element, and a plain
			// focus() scrolls that tall rows region into view in every
			// scrollable ancestor — jumping the page on close.
			const previous = previouslyFocusedRef.current;
			if (previous instanceof HTMLElement) {
				previous.focus({ preventScroll: true });
			}
		};
	}, [open]);

	// A restored width (from persistence) may exceed the current usable band if
	// the owning surface shrank between sessions. Clamp it once on open, after
	// layout — overlayRef and the stack registry are live by the time an effect
	// runs, so clampSize resolves against the real host size.
	useEffect(() => {
		if (!open) return;
		setDragSize((prev) => (prev == null ? null : clampSize(prev)));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Closed drawers render nothing at all.
	if (!open) {
		return null;
	}

	// ── Stack geometry (derived from the registry every render) ────────────
	// Push order is bottom -> top; this panel's index locates it. While a
	// right-drawer stack is live, every size derives from the shared TOP
	// width: covered panels render +40px per level (constant slivers, root
	// widest). A lone panel keeps its own dragged/default size.
	const entries = stackScopes[stackScope];
	const stackIndex = entryRef.current ? entries.indexOf(entryRef.current) : -1;
	const stacked = !bottom && entries.length > 1 && stackIndex >= 0;
	const depthFromTop = stacked ? entries.length - 1 - stackIndex : 0;
	const isTop = !stacked || depthFromTop === 0;
	const hasBelow = stackIndex > 0;
	const parentTitle = hasBelow ? entries[stackIndex - 1].getTitle() : null;
	const renderSize = stacked ? (stackSharedSize[stackScope] ?? Math.max(minSize, defaultSize - STACK_OFFSET)) + STACK_OFFSET * depthFromTop : (dragSize ?? defaultSize);
	// Mirror for the registry (push seeding) and the resize handlers.
	sizeRef.current = renderSize;

	return (
		/* Dismissal is deliberate-only per the 2026-07-08 design decision: the
		   close glyph, back arrow, sliver, or Escape — clicking the dim
		   backdrop must NOT close. */
		<div ref={overlayRef} style={styles.overlay(contained === true, modeless === true)}>
			<div ref={panelRef} style={styles.panel(renderSize, entered, bottom)} role="dialog" aria-modal={modeless ? undefined : 'true'} aria-label={title}>
				{/* Growing-edge resize handle (drag, arrow keys, Home = reset,
				    double-click = reset). Only the stack TOP's handle is live —
				    a covered panel's handle would fight the sliver's peel
				    click. A separator's aria-orientation names the SEPARATOR's
				    own axis: vertical for a drawer's left edge, horizontal for
				    a tray's top edge. */}
				{resizable && isTop && (
					<div
						role="separator"
						aria-orientation={bottom ? 'horizontal' : 'vertical'}
						aria-label="Resize panel"
						tabIndex={0}
						style={styles.resizeHandle(resizeActive, bottom)}
						onPointerDown={handleResizeDown}
						onPointerMove={handleResizeMove}
						onPointerUp={handleResizeUp}
						onPointerCancel={handleResizeUp}
						onMouseEnter={() => setResizeActive(true)}
						onMouseLeave={() => {
							if (!dragRef.current) setResizeActive(false);
						}}
						onDoubleClick={resetSize}
						onKeyDown={handleResizeKey}
					/>
				)}
				{/* Fixed EntityHeader: back arrow (stacked panels), avatar slot,
				    name/secondary, close glyph. The header is STACK machinery:
				    back peels one level, X exits the whole stack. */}
				<div style={styles.header}>
					{hasBelow && (
						<button type="button" style={styles.back} onClick={requestPeel} aria-label={`Back to ${parentTitle}`} title={`Back to ${parentTitle}`}>
							<BxChevronLeft size={20} />
						</button>
					)}
					{avatar != null && <div style={styles.avatar}>{avatar}</div>}
					<div style={styles.who}>
						<div style={styles.title}>{title}</div>
						{subtitle != null && <div style={styles.subtitle}>{subtitle}</div>}
					</div>
					<button ref={closeButtonRef} type="button" style={styles.close} onClick={requestCloseAll} aria-label="Close">
						{CLOSE_GLYPH}
					</button>
				</div>

				{/* Optional underline tab strip; count badges reuse ViewMenuBadge. */}
				{tabs != null && tabs.length > 0 && (
					<div style={styles.tabs} role="tablist">
						{tabs.map((entry) => {
							// The active tab carries the brand colour + underline.
							const isActive = entry.id === activeTab;
							return (
								<div
									key={entry.id}
									role="tab"
									aria-selected={isActive}
									tabIndex={0}
									style={styles.tab(isActive)}
									onClick={() => onTabSelect?.(entry.id)}
									onKeyDown={(e) => {
										// Enter / Space activate the tab, matching native button semantics.
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											onTabSelect?.(entry.id);
										}
									}}
								>
									{entry.label}
									{/* Count badge when the entry declares a count. */}
									{entry.count != null && <ViewMenuBadge count={entry.count} severity={entry.severity} />}
								</div>
							);
						})}
					</div>
				)}

				{/* Body: independently scrolling for plain panels; with TABS the
				    outer region stops scrolling and each tab panel owns its own
				    overflow (PanelTabBody / grids), per the 2026-07-18 standard. */}
				<div style={tabs != null && tabs.length > 0 ? styles.bodyTabs : flushBody ? styles.bodyFlush : styles.body}>{children}</div>

				{/* Fixed footer — RECORD machinery only (record-level verbs left,
				    mode machinery right); navigation lives in the header. */}
				{footer != null && <div style={styles.footer}>{footer}</div>}

				{/* Covered layer: an extra dim that makes stack depth readable,
				    swallows every interaction, and turns the exposed sliver into
				    the "go back" target — clicking it peels the TOP panel. */}
				{!isTop && (
					<div
						style={styles.coveredCatcher}
						aria-hidden="true"
						onClick={() => {
							const top = stackScopes[stackScope][stackScopes[stackScope].length - 1];
							top?.requestPeel();
						}}
					/>
				)}
			</div>

			{/* The discard guard (stock ConfirmDialog, stacked above every
			    panel): raised by Escape / back / sliver / X on a dirty form.
			    Which exit resumes on confirm depends on the pending path. */}
			{discardPending != null && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						const pending = discardPending;
						setDiscardPending(null);
						if (pending === 'exit-mode') onExitModeRef.current?.();
						else if (pending === 'close') onCloseRef.current();
						else closeAllInScope();
					}}
					onCancel={() => setDiscardPending(null)}
				/>
			)}
		</div>
	);
}
