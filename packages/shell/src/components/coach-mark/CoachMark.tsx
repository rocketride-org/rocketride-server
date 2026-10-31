/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * CoachMark and AttentionRing — point at something elsewhere on the screen.
 *
 *   AttentionRing  a pulsing accent ring over an element, nothing else; it
 *                  never blocks clicks ("this is where to go next").
 *   CoachMark      a guided-tour step: the ring, a dimmed page around the
 *                  element, and a callout beside it with a title, a line of
 *                  help and the tour's controls.
 *
 * Both find their element by CSS selector and follow it as the page moves,
 * so the element can live in another component tree (the shell's sidebar, a
 * page that has not mounted yet). Until it exists nothing is drawn. Neither
 * steals focus or traps it: the person is meant to click the element
 * itself. While a modal dialog is open they only point inside it (a tour can
 * guide the person through the dialog), and step aside for anything behind
 * it, coming back when it closes. Escape closes a CoachMark. The pulse
 * holds still under `prefers-reduced-motion`.
 *
 * The callout is drawn in the sidebar's ink (inverted colours where a theme
 * has no ink) so it stands out on any page, even over a large lit-up area.
 *
 * Built on `.rr-attention-ring` and `.rr-coach-mark` from components.css;
 * portalled to the document body.
 */

import React, { ReactNode, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../button/Button';

/** Props for the {@link AttentionRing} component. */
export interface IAttentionRingProps {
	/** CSS selector of the element to ring; the first match is used. */
	target: string;
}

/** Props for the {@link CoachMark} component. */
export interface ICoachMarkProps {
	/** CSS selector of the element to point at; the first match is used. */
	target: string;
	/** What to do, in a few words ("Open Pipelines"). */
	title: string;
	/** One or two sentences of help. */
	children: ReactNode;
	/** Where the person is in the tour ("Step 1 of 3"). */
	progress?: string;
	/** Fired by the Skip button and by Escape. */
	onClose: () => void;
	/** Label of the close button. Defaults to `'Skip tour'`. */
	closeLabel?: string;
	/**
	 * Moves the tour on, for a step the person reads rather than acts on.
	 * Without it the tour moves on when the person uses the element itself.
	 */
	onNext?: () => void;
	/** Label of the next button. Defaults to `'Next'`. */
	nextLabel?: string;
}

/** The space kept between the element and its ring. */
const RING_GAP = 4;
/** The space between the ring and the callout. */
const CALLOUT_GAP = 12;
/** The callout's width, matching the `.rr-coach-mark__callout` rule. */
const CALLOUT_WIDTH = 300;
/** Room kept for the callout's height when placing it above or below. */
const CALLOUT_ROOM = 190;

/** Where an element sits in the viewport. */
type TargetRect = { top: number; left: number; width: number; height: number };

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a pulsing ring over the target element, or nothing until it exists.
 *
 * @param props - {@link IAttentionRingProps}.
 * @returns The ring, portalled to the body.
 */
export function AttentionRing({ target }: IAttentionRingProps): React.ReactElement | null {
	const rect = useTargetRect(target);
	if (!rect) return null;
	return createPortal(<div className="rr-attention-ring" style={ringStyle(rect)} aria-hidden="true" />, document.body);
}

/**
 * Renders one guided-tour step pointing at the target element.
 *
 * @param props - {@link ICoachMarkProps}.
 * @returns The coach mark, portalled to the body, or nothing until the target exists.
 */
export function CoachMark({ target, title, children, progress, onClose, closeLabel = 'Skip tour', onNext, nextLabel = 'Next' }: ICoachMarkProps): React.ReactElement | null {
	const rect = useTargetRect(target);
	const titleId = useId();
	const hasRect = rect !== null;

	// Bring the element into view once it appears, so a mark lower on a
	// scrolling page is never pointed at off-screen.
	useEffect(() => {
		if (!hasRect) return;
		document.querySelector(target)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [target, hasRect]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	if (!rect) return null;
	return createPortal(
		<div className="rr-coach-mark">
			<div className="rr-coach-mark__scrim" style={ringStyle(rect)} aria-hidden="true" />
			<div className="rr-attention-ring" style={ringStyle(rect)} aria-hidden="true" />
			<div className="rr-coach-mark__callout" style={calloutStyle(rect)} role="dialog" aria-labelledby={titleId}>
				{progress && <div className="rr-coach-mark__progress">{progress}</div>}
				<div id={titleId} className="rr-coach-mark__title">
					{title}
				</div>
				<div className="rr-coach-mark__body">{children}</div>
				<div className="rr-coach-mark__actions">
					<Button variant="ghost" small onClick={onClose}>
						{closeLabel}
					</Button>
					{onNext && (
						<Button variant="secondary" small onClick={onNext}>
							{nextLabel}
						</Button>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Follows an element's place in the viewport, frame by frame, so the ring
 * keeps up with scrolling, resizing and the element mounting late. Reads
 * null while a modal dialog is open and the element is not inside it.
 *
 * @param selector - CSS selector of the element.
 * @returns Its rect, or null while it is missing or hidden.
 */
export function useTargetRect(selector: string): TargetRect | null {
	const [rect, setRect] = useState<TargetRect | null>(null);

	useEffect(() => {
		let frame = 0;
		let last = '';
		const measure = (): void => {
			const next = readRect(selector);
			const key = next ? `${next.top}|${next.left}|${next.width}|${next.height}` : '';
			if (key !== last) {
				last = key;
				setRect(next);
			}
			frame = window.requestAnimationFrame(measure);
		};
		measure();
		return () => window.cancelAnimationFrame(frame);
	}, [selector]);

	return rect;
}

/**
 * Measures the first element matching a selector.
 *
 * @param selector - CSS selector of the element.
 * @returns Its rect, or null when there is no visible match, or a modal dialog is open and the match is behind it.
 */
function readRect(selector: string): TargetRect | null {
	const element = document.querySelector(selector);
	if (!element) return null;
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
	if (dialog && !dialog.contains(element)) return null;
	const box = element.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) return null;
	return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/**
 * The ring's box: the element's, grown by the gap on every side.
 *
 * @param rect - The element's rect.
 * @returns Fixed-position styles.
 */
function ringStyle(rect: TargetRect): React.CSSProperties {
	return {
		top: rect.top - RING_GAP,
		left: rect.left - RING_GAP,
		width: rect.width + RING_GAP * 2,
		height: rect.height + RING_GAP * 2,
	};
}

/**
 * Places the callout to the right of the element when it fits, else below
 * it, else above it, else over the element's lower edge; always inside the
 * viewport.
 *
 * @param rect - The element's rect.
 * @returns Fixed-position styles.
 */
function calloutStyle(rect: TargetRect): React.CSSProperties {
	const maxTop = window.innerHeight - CALLOUT_ROOM - CALLOUT_GAP;
	const right = rect.left + rect.width + RING_GAP + CALLOUT_GAP;
	if (right + CALLOUT_WIDTH + CALLOUT_GAP <= window.innerWidth) {
		return { top: clamp(rect.top - RING_GAP, CALLOUT_GAP, maxTop), left: right };
	}
	const left = clamp(rect.left, CALLOUT_GAP, window.innerWidth - CALLOUT_WIDTH - CALLOUT_GAP);
	const below = rect.top + rect.height + RING_GAP + CALLOUT_GAP;
	if (below <= maxTop) return { top: below, left };
	const above = rect.top - RING_GAP - CALLOUT_GAP - CALLOUT_ROOM;
	if (above >= CALLOUT_GAP) return { top: above, left };
	return { top: maxTop, left };
}

/**
 * Keeps a number within bounds.
 *
 * @param value - The number.
 * @param min - The lowest allowed.
 * @param max - The highest allowed; wins over `min` when they cross.
 * @returns The bounded number.
 */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
