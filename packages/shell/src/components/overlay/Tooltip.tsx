// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tooltip — a short text hint for a single element, shown on hover (after a
 * delay) and on keyboard focus (immediately), hidden on leave, blur and
 * Escape. The hint is linked to the element with `aria-describedby`, so
 * screen readers announce it as the element's description.
 *
 * The child must accept a ref (a DOM element, or a component that forwards
 * its ref) because the tooltip measures it for placement. Keep content to a
 * short phrase: tooltips are not interactive and never hold links or buttons
 * (use a Popover for that). An icon-only button still needs its own
 * `aria-label`; the tooltip only adds a description.
 *
 * Built on `.rr-tooltip` from components.css.
 */

import React, { cloneElement, ReactElement, ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPortalContainer, useAnchoredPosition } from './overlayHooks';
import type { OverlayPlacement } from './placement';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Tooltip} component. */
export interface ITooltipProps {
	/** The hint text. Short; no interactive content. */
	content: ReactNode;
	/** The single element the hint describes. Must accept a ref. */
	children: ReactElement;
	/** Placement relative to the element. Defaults to `'top'`. */
	placement?: OverlayPlacement;
	/** Hover delay before showing, in ms. Defaults to 400. */
	delay?: number;
	/** Suppress the tooltip (renders the child untouched). */
	disabled?: boolean;
}

/** The handlers and ref a tooltip attaches to its child. */
type TooltipChildProps = {
	ref?: React.Ref<HTMLElement>;
	onMouseEnter?: (event: React.MouseEvent<HTMLElement>) => void;
	onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
	onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
	onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
	'aria-describedby'?: string;
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Writes an element into a caller's ref, whichever form it takes.
 *
 * @param ref - A callback ref, an object ref, or nothing.
 * @param element - The element to store.
 */
function assignRef(ref: React.Ref<HTMLElement> | undefined, element: HTMLElement | null): void {
	if (!ref) return;
	if (typeof ref === 'function') {
		ref(element);
		return;
	}
	(ref as React.MutableRefObject<HTMLElement | null>).current = element;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the child with tooltip behavior attached.
 *
 * @param props - {@link ITooltipProps}.
 * @returns The child, plus the portaled hint while visible.
 */
export function Tooltip({ content, children, placement = 'top', delay = 400, disabled }: ITooltipProps): ReactElement {
	const [isVisible, setIsVisible] = useState(false);
	const anchorRef = useRef<HTMLElement | null>(null);
	const tipRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tipId = useId();
	const position = useAnchoredPosition(anchorRef, tipRef, isVisible, { placement, offset: 6 });

	/** Cancels a pending delayed show. */
	function clearTimer(): void {
		if (!timerRef.current) return;
		clearTimeout(timerRef.current);
		timerRef.current = null;
	}

	/** Shows after the hover delay. */
	function showLater(): void {
		clearTimer();
		timerRef.current = setTimeout(() => setIsVisible(true), delay);
	}

	/** Hides immediately. */
	function hide(): void {
		clearTimer();
		setIsVisible(false);
	}

	// Escape dismisses a visible tooltip without moving focus (WCAG 1.4.13).
	useEffect(() => {
		if (!isVisible) return undefined;
		/** Hide on Escape. */
		function handleKeyDown(event: KeyboardEvent): void {
			if (event.key === 'Escape') setIsVisible(false);
		}
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isVisible]);

	useEffect(() => clearTimer, []);

	if (disabled || content === null || content === undefined || content === '') return children;

	const childProps = children.props as TooltipChildProps;
	const childRef = (children as unknown as { ref?: React.Ref<HTMLElement> }).ref;

	let describedBy = childProps['aria-describedby'];
	if (isVisible && describedBy) {
		describedBy = `${describedBy} ${tipId}`;
	} else if (isVisible) {
		describedBy = tipId;
	}

	const trigger = cloneElement(children as ReactElement<TooltipChildProps>, {
		ref: (element: HTMLElement | null) => {
			anchorRef.current = element;
			assignRef(childRef, element);
		},
		'aria-describedby': describedBy,
		onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
			childProps.onMouseEnter?.(event);
			showLater();
		},
		onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
			childProps.onMouseLeave?.(event);
			hide();
		},
		onFocus: (event: React.FocusEvent<HTMLElement>) => {
			childProps.onFocus?.(event);
			// Keyboard focus shows at once; a mouse click focusing the element
			// is already covered by the hover delay.
			if (event.target.matches(':focus-visible')) {
				clearTimer();
				setIsVisible(true);
			}
		},
		onBlur: (event: React.FocusEvent<HTMLElement>) => {
			childProps.onBlur?.(event);
			hide();
		},
	});

	const container = getPortalContainer();

	return (
		<>
			{trigger}
			{isVisible &&
				container &&
				createPortal(
					<div ref={tipRef} id={tipId} role="tooltip" className="rr-tooltip" style={position.style}>
						{content}
					</div>,
					container
				)}
		</>
	);
}
