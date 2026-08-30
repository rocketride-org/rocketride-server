// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Modal — the platform's stock dialog: a centered box over a dimmed backdrop.
 *
 * One component for every modal dialog so they never drift apart again. It owns
 * the backdrop, the box, the header (title + optional close), an optional body
 * padding, and an optional footer action row — all from `commonStyles.modal*`.
 *
 * Dismissal policy (design-owner decision 2026-07-08, refined):
 *  - The backdrop is INERT: clicking outside the box never closes it.
 *  - Escape closes it (unless `closeOnEscape={false}`).
 *  - The top-right ✕ appears ONLY when the dialog has no other explicit dismiss
 *    control. The default is therefore "show ✕ only when there is no footer"
 *    (a footer almost always carries a Cancel/Close/Done button). A dialog that
 *    auto-dismisses on a timer, or whose footer already closes it, passes
 *    `showClose={false}`; a footerless dialog gets the ✕ automatically so it is
 *    never left un-closable.
 *
 * Accessibility, matching {@link DetailPanel}: while open the dialog locks page
 * scroll, moves focus into the box (unless a child already claimed it, e.g. a
 * ConfirmDialog focusing its confirm button), traps Tab within the box, and
 * restores the previously-focused element on close. Escape acts only on the
 * TOPMOST open dialog, so a stacked dialog dismisses one layer at a time.
 *
 * The single canonical close glyph ({@link CLOSE_GLYPH}) is used everywhere, so
 * the old `×` / `✕` / `&times;` drift disappears.
 */

import React, { CSSProperties, ReactNode, useEffect, useId, useRef } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The one canonical close glyph (U+2715 MULTIPLICATION X) used by every dialog. */
export const CLOSE_GLYPH = '✕';

/** Selector matching the tabbable elements inside a dialog (for focus + trap). */
export const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently-open overlay layers (identity tokens), topmost last.
 * Shared by every keyboard-owning overlay — Modal AND DetailPanel — via the
 * acquire/release/isTop helpers below: Escape and the Tab focus-trap act only
 * on the top layer, so stacked overlays (a dialog over a dialog, or a dialog
 * over a DetailPanel drawer) dismiss one at a time instead of all at once,
 * and two focus traps never fight over document.activeElement.
 */
interface OverlayLayer {
	/** Whether this layer wants document.body scroll locked while open. */
	lock: boolean;
}

const openLayers: OverlayLayer[] = [];

/**
 * The page's body overflow value from BEFORE the first layer opened, captured
 * once and restored when the LAST layer closes. It is the "unlocked" target
 * {@link syncBodyOverflow} falls back to, so scroll state is always derived
 * from the layers still open rather than saved/restored per layer (which would
 * let an out-of-order close mis-set scroll behind a still-open overlay).
 */
let originalBodyOverflow: string | null = null;

/**
 * Reconcile document.body scroll with the current stack: locked while ANY open
 * layer requests a lock, otherwise the captured pre-lock value. Run on every
 * acquire and release so closing a locking modal that sits above a modeless
 * drawer leaves the page scrollable, and closing a modeless drawer under a
 * modal leaves it locked — the body always matches what REMAINS open.
 */
function syncBodyOverflow(): void {
	if (openLayers.some((layer) => layer.lock)) {
		document.body.style.overflow = 'hidden';
	} else if (originalBodyOverflow !== null) {
		document.body.style.overflow = originalBodyOverflow;
	}
}

/**
 * Joins the shared overlay stack as the new topmost layer and (by default) locks
 * page scroll — the pre-lock overflow is captured by the first layer only, so a
 * later out-of-order close never re-enables scroll behind a still-open layer.
 *
 * `lockScroll: false` joins the stack (so Escape / focus-trap top-gating still
 * work) WITHOUT locking scroll — for a MODELESS overlay (e.g. a DetailPanel
 * palette floating over an interactive canvas) whose host surface must stay
 * scrollable/pannable behind it. The pre-lock overflow is still captured on the
 * first layer so the eventual restore is correct regardless of open order.
 *
 * @param lockScroll - Whether to lock `document.body` scroll while open (default true).
 * @returns The layer's identity token, for {@link isTopOverlayLayer} and
 *   {@link releaseOverlayLayer}.
 */
export function acquireOverlayLayer(lockScroll = true): object {
	if (openLayers.length === 0) originalBodyOverflow = document.body.style.overflow;
	const layer: OverlayLayer = { lock: lockScroll };
	openLayers.push(layer);
	syncBodyOverflow();
	return layer;
}

/**
 * Whether `layer` is currently the topmost open overlay — the only layer that
 * may react to Escape / Tab.
 *
 * @param layer - The token returned by {@link acquireOverlayLayer}.
 * @returns True while the layer is top-of-stack.
 */
export function isTopOverlayLayer(layer: object): boolean {
	return openLayers[openLayers.length - 1] === layer;
}

/**
 * Removes a layer from the stack (indexOf, not pop, so out-of-order unmounts
 * are safe) and restores page scroll when the LAST layer is gone.
 *
 * @param layer - The token returned by {@link acquireOverlayLayer}.
 */
export function releaseOverlayLayer(layer: object): void {
	const i = openLayers.indexOf(layer as OverlayLayer);
	if (i >= 0) openLayers.splice(i, 1);
	if (openLayers.length === 0) {
		// Last layer gone: restore the captured pre-lock overflow and reset.
		if (originalBodyOverflow !== null) {
			document.body.style.overflow = originalBodyOverflow;
			originalBodyOverflow = null;
		}
	} else {
		// Layers remain: match the body to whatever they still require — a
		// modeless drawer left open after a locking modal closes must NOT keep
		// the page scroll-locked.
		syncBodyOverflow();
	}
}

// =============================================================================
// FOCUS TRAP
// =============================================================================

/**
 * Keeps Tab / Shift+Tab focus cycling within `container` instead of escaping to
 * the page behind the dialog.
 *
 * @param e - The Tab keydown event.
 * @param container - The dialog box to trap focus inside.
 */
export function trapFocus(e: KeyboardEvent, container: HTMLElement): void {
	// All tabbable elements currently inside the dialog, in DOM order.
	const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
	if (focusables.length === 0) {
		// Nothing tabbable: keep focus on the dialog box itself.
		e.preventDefault();
		container.focus();
		return;
	}
	const first = focusables[0];
	const last = focusables[focusables.length - 1];
	const active = document.activeElement;
	// Shift+Tab off the first (or from outside the set) wraps to the last;
	// Tab off the last wraps back to the first.
	if (e.shiftKey && (active === first || !container.contains(active))) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Modal} component. */
export interface IModalProps {
	/** Header title — a plain string or a custom node. */
	title: ReactNode;
	/** Fired when the dialog is dismissed (✕ or Escape). */
	onClose: () => void;
	/** Body content. */
	children: ReactNode;
	/** Optional footer action row (Cancel / primary button, etc.). */
	footer?: ReactNode;
	/**
	 * Whether to render the top-right ✕. Defaults to "only when there is no
	 * footer" — a footer's Cancel/Close is the dismiss control, so a corner ✕
	 * would be redundant. Pass `false` for auto-dismissing dialogs; pass `true`
	 * to force the ✕ on a footered dialog that has no cancel affordance.
	 */
	showClose?: boolean;
	/** Whether Escape closes the dialog. Default true. */
	closeOnEscape?: boolean;
	/** Box width in px. Default 440 (commonStyles.modalDialog). */
	width?: number;
	/** Drop the body padding (for content that fills the box, e.g. a DataGrid). */
	noBodyPadding?: boolean;
	/** Accessible label when `title` is not a plain string. */
	ariaLabel?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Borderless glyph close button, right-aligned in the header row. Matches the
	// account Modal idiom; the header's flex pushes it to the trailing edge.
	close: {
		marginLeft: 'auto',
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		padding: 0,
		fontSize: 17,
		lineHeight: 1,
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a dialog box over a dimmed, inert backdrop.
 *
 * @param props - {@link IModalProps}.
 * @returns The modal element.
 */
export function Modal({ title, onClose, children, footer, showClose, closeOnEscape = true, width, noBodyPadding, ariaLabel }: IModalProps): React.ReactElement {
	// Resolve the ✕: explicit prop wins; otherwise show it only when there is no
	// footer (a footer carries the dismiss control, making a corner ✕ redundant).
	const resolvedShowClose = showClose ?? footer == null;

	// Stable id linking the rendered title to the dialog's accessible name when
	// `title` is a React node and no explicit ariaLabel was given — otherwise the
	// dialog would end up unnamed for assistive tech.
	const titleId = useId();
	const labelledByTitle = ariaLabel == null && title != null && typeof title !== 'string';

	// Ref to the dialog box, for focus placement and the Tab focus trap.
	const dialogRef = useRef<HTMLDivElement>(null);
	// Latest onClose / closeOnEscape kept in refs so the open effect runs ONCE:
	// depending on them would re-run it and re-steal focus on every parent render.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const closeOnEscapeRef = useRef(closeOnEscape);
	closeOnEscapeRef.current = closeOnEscape;

	// While open (Modal is mounted only while open): push onto the layer stack,
	// lock page scroll, move focus in, and wire Escape + Tab. Cleanup reverses
	// every side effect and restores the prior focus.
	useEffect(() => {
		// 1. Join the shared overlay stack (locks page scroll on first layer).
		const layer = acquireOverlayLayer();
		// 2. Remember what to restore focus to when the dialog closes.
		const previouslyFocused = document.activeElement;
		// 4. Move focus into the dialog unless a child already claimed it (e.g. a
		//    ConfirmDialog focusing its confirm button in its own, later, effect).
		const dialog = dialogRef.current;
		if (dialog && !dialog.contains(document.activeElement)) {
			const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
			(firstFocusable ?? dialog).focus();
		}
		/** Escape (close) + Tab (focus trap), for the TOPMOST layer only. */
		const onKeyDown = (e: KeyboardEvent): void => {
			// Only the top-of-stack overlay reacts, so a stacked dialog doesn't
			// collapse every layer on a single keypress.
			if (!isTopOverlayLayer(layer)) return;
			if (e.key === 'Escape' && closeOnEscapeRef.current) {
				e.preventDefault();
				e.stopPropagation();
				onCloseRef.current();
			} else if (e.key === 'Tab' && dialog) {
				trapFocus(e, dialog);
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('keydown', onKeyDown);
			// Leave the stack (restores page scroll when the last layer closes).
			releaseOverlayLayer(layer);
			if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
		};
		// Mount-once: the refs above carry the latest onClose / closeOnEscape.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		// Backdrop is inert: no onClick — clicking outside must NOT close (policy).
		<div style={commonStyles.modalOverlay}>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={typeof title === 'string' ? title : ariaLabel}
				aria-labelledby={labelledByTitle ? titleId : undefined}
				// tabIndex -1 lets the box itself hold focus when it has no tabbable child.
				tabIndex={-1}
				style={width != null ? { ...commonStyles.modalDialog, width } : commonStyles.modalDialog}
			>
				{/* Header: title on the left, optional ✕ pushed to the trailing edge.
				    display:contents keeps the id-carrying wrapper out of the flex layout. */}
				<div style={commonStyles.modalHeader}>
					<span id={labelledByTitle ? titleId : undefined} style={{ display: 'contents' }}>
						{title}
					</span>
					{resolvedShowClose && (
						<button type="button" style={styles.close} onClick={onClose} aria-label="Close">
							{CLOSE_GLYPH}
						</button>
					)}
				</div>
				{/* Body. */}
				<div style={noBodyPadding ? undefined : commonStyles.modalBody}>{children}</div>
				{/* Optional footer action row. */}
				{footer != null && <div style={commonStyles.modalFooter}>{footer}</div>}
			</div>
		</div>
	);
}
