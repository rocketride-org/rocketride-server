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
 *   PageViewControl/SidebarMenu (count badges reuse the shared {@link ViewMenuBadge}),
 * - a scrollable body composed from Section / LabelValue / Chip / StatusBadge /
 *   MiniContainer / Button.
 *
 * Accessibility: the panel is a modal dialog (`role="dialog"`, `aria-modal`,
 * `aria-label` = title). Opening moves focus to the close button; closing returns
 * focus to whatever was focused before, and Escape closes the drawer.
 */

import React, { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { ViewMenuEntry } from '../../types/viewMenu';
import { ViewMenuBadge } from '../page-view-control/ViewMenuBadge';
import { CLOSE_GLYPH, trapFocus, acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer } from '../modal/Modal';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width when the caller does not override `width`. */
const DEFAULT_WIDTH = 560;

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
	/** Tray height in px (side 'bottom' only). Default {@link DEFAULT_HEIGHT}. */
	height?: number;
	/**
	 * Fixed action row pinned below the scrolling body (record-panel verbs:
	 * Save / Cancel / destructive actions). Rendered with a top divider;
	 * omitted = no footer row (pure inspect panels).
	 */
	footer?: ReactNode;
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
	 * lifetime.
	 */
	resizable?: boolean;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Full-area dim backdrop; sits above content but below shell modals (2000).
	// Contained mode swaps `fixed` for `absolute` so the backdrop (and the
	// drawer inside it) fill the nearest positioned ancestor — the surface
	// that owns the record — instead of the viewport.
	overlay: (contained: boolean): CSSProperties => ({
		position: contained ? 'absolute' : 'fixed',
		inset: 0,
		zIndex: 1500,
		background: 'color-mix(in srgb, var(--rr-text-primary) 30%, transparent)',
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
		...(bottom
			? { left: 0, right: 0, bottom: 0, height: size }
			: { top: 0, right: 0, bottom: 0, width: size }),
		background: 'var(--rr-bg-default)',
		boxShadow: bottom
			? '0 -10px 30px color-mix(in srgb, var(--rr-text-primary) 20%, transparent)'
			: '-10px 0 30px color-mix(in srgb, var(--rr-text-primary) 20%, transparent)',
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

	// Scrollable body; the header and tabs stay fixed above it.
	body: {
		flex: 1,
		overflowY: 'auto',
		padding: '6px 20px 20px',
	} as CSSProperties,

	// Resize handle: a slim grab strip over the panel's growing edge — the
	// LEFT edge of a right drawer, the TOP edge of a bottom tray. The tint
	// appears on hover / during drag (the canvas splitters' sash token, so
	// the affordance matches the rest of the platform).
	resizeHandle: (active: boolean, bottom: boolean): CSSProperties => ({
		position: 'absolute',
		...(bottom
			? { top: 0, left: 0, right: 0, height: 6, cursor: 'row-resize' }
			: { left: 0, top: 0, bottom: 0, width: 6, cursor: 'col-resize' }),
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
export function DetailPanel({
	open,
	onClose,
	avatar,
	title,
	subtitle,
	tabs,
	activeTab,
	onTabSelect,
	children,
	side = 'right',
	width = DEFAULT_WIDTH,
	height = DEFAULT_HEIGHT,
	footer,
	contained,
	resizable = true,
}: IDetailPanelProps): React.ReactElement | null {
	// Orientation flag: a bottom tray resizes along Y instead of X; every
	// other behavior (layering, focus, containment) is orientation-agnostic.
	const bottom = side === 'bottom';
	// The caller's default size along the slide axis (width or height).
	const defaultSize = bottom ? height : width;
	// The axis floor: form-safe width for a drawer, content-safe height for a tray.
	const minSize = bottom ? MIN_HEIGHT : MIN_WIDTH;
	// Drives the slide-in: false on mount (off-screen), flipped true next frame.
	const [entered, setEntered] = useState(false);
	// The drawer box — Tab focus is trapped inside it while open.
	const panelRef = useRef<HTMLDivElement>(null);
	// The overlay box — its size IS the owning surface, the resize clamp's
	// reference (dialog in contained mode, viewport otherwise).
	const overlayRef = useRef<HTMLDivElement>(null);
	// User-dragged size along the slide axis; null = the caller's default.
	// Lives only while open (the closed panel unmounts), so every open starts
	// at the default.
	const [dragSize, setDragSize] = useState<number | null>(null);
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
	const clampSize = (candidate: number): number => {
		const host = bottom
			? (overlayRef.current?.clientHeight ?? window.innerHeight)
			: (overlayRef.current?.clientWidth ?? window.innerWidth);
		const max = Math.max(minSize, Math.min(host * MAX_HOST_FRACTION, host - CONTEXT_SLIVER));
		return Math.min(Math.max(candidate, minSize), max);
	};

	/** Begin a drag: capture the pointer and record the starting geometry. */
	const handleResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		dragRef.current = { start: bottom ? e.clientY : e.clientX, startSize: dragSize ?? defaultSize };
		setResizeActive(true);
	};

	/** Drag: the panel is edge-anchored, so moving TOWARD the opposite edge
	    (left for a right drawer, up for a bottom tray) grows the size. */
	const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
		if (!dragRef.current) return;
		const position = bottom ? e.clientY : e.clientX;
		setDragSize(clampSize(dragRef.current.startSize + (dragRef.current.start - position)));
	};

	/** End a drag: release bookkeeping (pointer capture releases natively). */
	const handleResizeUp = (): void => {
		dragRef.current = null;
		setResizeActive(false);
	};

	/** Keyboard resize on the focused handle: arrows along the slide axis
	    step the size (toward the opposite edge grows), Home resets. */
	const handleResizeKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		const current = dragSize ?? defaultSize;
		const grow = bottom ? 'ArrowUp' : 'ArrowLeft';
		const shrink = bottom ? 'ArrowDown' : 'ArrowRight';
		if (e.key === grow) {
			e.preventDefault();
			setDragSize(clampSize(current + KEY_RESIZE_STEP));
		} else if (e.key === shrink) {
			e.preventDefault();
			setDragSize(clampSize(current - KEY_RESIZE_STEP));
		} else if (e.key === 'Home') {
			e.preventDefault();
			setDragSize(null);
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

	// While open: lock page scroll, animate in, move focus in, and wire Escape.
	// Cleanup reverses every side effect and restores the prior focus.
	useEffect(() => {
		if (!open) {
			return;
		}
		// Remember what to restore focus to when the drawer closes.
		previouslyFocusedRef.current = document.activeElement;
		// Join the SHARED overlay stack (same registry Modal uses): locks page
		// scroll, and lets a Modal stacked over this drawer become the topmost
		// layer so keyboard handling never double-fires across layers.
		const layer = acquireOverlayLayer();
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
		// Escape closes the drawer; Tab is trapped inside it — aria-modal alone
		// does not stop keyboard focus from wandering into the page behind.
		const onKeyDown = (event: KeyboardEvent): void => {
			// Only the topmost overlay reacts: with a dialog open over this
			// drawer, Escape must close the dialog alone, and only ONE focus
			// trap may steer document.activeElement.
			if (!isTopOverlayLayer(layer)) return;
			if (event.key === 'Escape') {
				onCloseRef.current();
			} else if (event.key === 'Tab' && panelRef.current) {
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

	// Closed drawers render nothing at all.
	if (!open) {
		return null;
	}

	return (
		/* Dismissal is deliberate-only per the 2026-07-08 design decision: the
		   close glyph or Escape — clicking the dim backdrop must NOT close. */
		<div ref={overlayRef} style={styles.overlay(contained === true)}>
			<div ref={panelRef} style={styles.panel(dragSize ?? defaultSize, entered, bottom)} role="dialog" aria-modal="true" aria-label={title}>
				{/* Growing-edge resize handle (drag, arrow keys, Home = reset,
				    double-click = reset). A separator's aria-orientation names
				    the SEPARATOR's own axis: vertical for a drawer's left edge,
				    horizontal for a tray's top edge. */}
				{resizable && (
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
						onDoubleClick={() => setDragSize(null)}
						onKeyDown={handleResizeKey}
					/>
				)}
				{/* Fixed EntityHeader: avatar slot + name/secondary + close glyph. */}
				<div style={styles.header}>
					{avatar != null && <div style={styles.avatar}>{avatar}</div>}
					<div style={styles.who}>
						<div style={styles.title}>{title}</div>
						{subtitle != null && <div style={styles.subtitle}>{subtitle}</div>}
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						style={styles.close}
						onClick={onClose}
						aria-label="Close"
					>
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

				{/* Independently scrolling body composed of stock detail vocabulary. */}
				<div style={styles.body}>{children}</div>

				{/* Fixed record-action footer (Save / Cancel / destructive verbs). */}
				{footer != null && <div style={styles.footer}>{footer}</div>}
			</div>
		</div>
	);
}
