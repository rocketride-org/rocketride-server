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

import React, { CSSProperties, ReactNode, useEffect, useRef } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The one canonical close glyph (U+2715 MULTIPLICATION X) used by every dialog. */
export const CLOSE_GLYPH = '✕';

/** Selector matching the tabbable elements inside a dialog (for focus + trap). */
const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Stack of currently-open Modal layers (identity tokens), topmost last. Escape
 * and the Tab focus-trap act only on the top layer, so stacked dialogs (or a
 * dialog over a DetailPanel) dismiss one at a time rather than all at once.
 */
const openLayers: object[] = [];

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
function trapFocus(e: KeyboardEvent, container: HTMLElement): void {
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
	/** Drop the body padding (for content that fills the box, e.g. a DataTable). */
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
export function Modal({
	title,
	onClose,
	children,
	footer,
	showClose,
	closeOnEscape = true,
	width,
	noBodyPadding,
	ariaLabel,
}: IModalProps): React.ReactElement {
	// Resolve the ✕: explicit prop wins; otherwise show it only when there is no
	// footer (a footer carries the dismiss control, making a corner ✕ redundant).
	const resolvedShowClose = showClose ?? footer == null;

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
		// 1. Identity token marking this dialog's spot in the layer stack.
		const layer = {};
		openLayers.push(layer);
		// 2. Remember what to restore focus to when the dialog closes.
		const previouslyFocused = document.activeElement;
		// 3. Lock page scroll behind the dialog. Save/restore the exact prior
		//    value so nesting (dialog over a DetailPanel) unwinds correctly.
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		// 4. Move focus into the dialog unless a child already claimed it (e.g. a
		//    ConfirmDialog focusing its confirm button in its own, later, effect).
		const dialog = dialogRef.current;
		if (dialog && !dialog.contains(document.activeElement)) {
			const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
			(firstFocusable ?? dialog).focus();
		}
		/** Escape (close) + Tab (focus trap), for the TOPMOST layer only. */
		const onKeyDown = (e: KeyboardEvent): void => {
			// Only the top-of-stack dialog reacts, so a stacked dialog doesn't
			// collapse every layer on a single keypress.
			if (openLayers[openLayers.length - 1] !== layer) return;
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
			// Pop this layer (indexOf, not pop, so out-of-order unmounts are safe).
			const i = openLayers.indexOf(layer);
			if (i >= 0) openLayers.splice(i, 1);
			// Restore page scroll and the previously-focused element.
			document.body.style.overflow = previousOverflow;
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
				// tabIndex -1 lets the box itself hold focus when it has no tabbable child.
				tabIndex={-1}
				style={width != null ? { ...commonStyles.modalDialog, width } : commonStyles.modalDialog}
			>
				{/* Header: title on the left, optional ✕ pushed to the trailing edge. */}
				<div style={commonStyles.modalHeader}>
					{title}
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
