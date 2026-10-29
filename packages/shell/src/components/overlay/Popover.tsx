// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Popover — a floating panel anchored to an element: filter panels, pickers,
 * "more" panels, anything richer than a Menu.
 *
 * Controlled: the caller owns `open` and closes it from `onClose`, which
 * fires on Escape (top layer only), on a press outside the panel and its
 * anchor, and never on its own otherwise. The panel portals into the shell's
 * popup layer, flips to the other side of the anchor when it would leave the
 * viewport, and moves focus into itself on open and back to the anchor on
 * close.
 *
 * Built on the `.rr-popover` surface from themes/components.css.
 */

import React, { CSSProperties, ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getPortalContainer, useAnchoredPosition, useOverlayDismiss } from './overlayHooks';
import type { OverlayPlacement } from './placement';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Popover} component. */
export interface IPopoverProps {
	/** Whether the popover is open. */
	open: boolean;
	/** The element the popover is attached to (usually the trigger button). */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** Called when the popover asks to close (Escape, outside press). */
	onClose: () => void;
	/** Panel content. */
	children: ReactNode;
	/** Where to place it relative to the anchor. Defaults to `'bottom-start'`. */
	placement?: OverlayPlacement;
	/** Gap between anchor and panel, in px. Defaults to 4. */
	offset?: number;
	/** Make the panel at least as wide as the anchor. */
	matchWidth?: boolean;
	/** Accessible name when the panel has no visible heading. */
	ariaLabel?: string;
	/** Id of an element that names the panel (e.g. a Field label). */
	ariaLabelledBy?: string;
	/** ARIA role of the panel. Defaults to `'dialog'`. */
	role?: string;
	/** Move focus into the panel on open. Defaults to true. */
	autoFocus?: boolean;
	/** Return focus to the anchor on close. Defaults to true. */
	restoreFocus?: boolean;
	/** Close when pressing outside. Defaults to true. */
	closeOnOutsidePress?: boolean;
	/** Extra class names for the panel (e.g. `rr-menu`). */
	className?: string;
	/** Extra inline styles for the panel (width, max-height, padding). */
	style?: CSSProperties;
	/** Element id for the panel, for `aria-controls` on the trigger. */
	id?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders an anchored, portaled floating panel.
 *
 * @param props - {@link IPopoverProps}.
 * @returns The portaled panel while open, otherwise nothing.
 */
export function Popover({ open, anchorRef, onClose, children, placement = 'bottom-start', offset, matchWidth, ariaLabel, ariaLabelledBy, role = 'dialog', autoFocus = true, restoreFocus = true, closeOnOutsidePress = true, className, style, id }: IPopoverProps): React.ReactElement | null {
	const panelRef = useRef<HTMLDivElement>(null);
	const position = useAnchoredPosition(anchorRef, panelRef, open, { placement, offset, matchWidth });

	useOverlayDismiss({
		isOpen: open,
		insideRefs: [panelRef, anchorRef],
		onDismiss: onClose,
		isOutsidePressEnabled: closeOnOutsidePress,
	});

	// Focus moves in once the panel is placed: it renders hidden for one
	// frame while it is measured, and a hidden element cannot take focus.
	useEffect(() => {
		if (!open || !autoFocus || !position.isPositioned) return;
		const panel = panelRef.current;
		if (panel && !panel.contains(document.activeElement)) {
			panel.focus({ preventScroll: true });
		}
	}, [open, autoFocus, position.isPositioned]);

	// Focus returns to the anchor on close.
	useEffect(() => {
		if (!open) return undefined;
		const anchor = anchorRef.current;
		const panel = panelRef.current;
		return () => {
			if (!restoreFocus || !anchor) return;
			// Only reclaim focus if it was inside the panel (or lost to body);
			// a click that moved focus elsewhere keeps it there.
			const active = document.activeElement;
			if (!active || active === document.body || panel?.contains(active)) {
				anchor.focus({ preventScroll: true });
			}
		};
	}, [open, restoreFocus, anchorRef]);

	const container = getPortalContainer();
	if (!open || !container) return null;

	let panelClassName = 'rr-popover';
	if (className) panelClassName = `rr-popover ${className}`;

	return createPortal(
		<div ref={panelRef} id={id} role={role} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} tabIndex={-1} data-side={position.side} className={panelClassName} style={{ ...position.style, ...style, outline: 'none' }}>
			{children}
		</div>,
		container
	);
}
