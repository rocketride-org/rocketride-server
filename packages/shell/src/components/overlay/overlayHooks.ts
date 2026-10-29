// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Hooks shared by every anchored overlay (Popover, Menu, Select, Combobox,
 * Tooltip): where to portal, where to sit, how to join the overlay stack,
 * and how to be dismissed.
 *
 * Overlays join the SAME layer stack Modal and DetailPanel use
 * (acquireOverlayLayer), without locking scroll. That keeps Escape
 * one-layer-at-a-time: a Select open inside a Modal closes on Escape and the
 * Modal stays, because the Modal is no longer the top layer.
 */

import React, { CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acquireOverlayLayer, isTopOverlayLayer, releaseOverlayLayer } from '../modal/Modal';
import { computePosition, IComputePositionOptions, OverlaySide } from './placement';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Id of the portal container bootstrap.tsx creates before React renders. */
const POPUP_PORTAL_ID = 'rr-popup-portal';

/** How long typed characters accumulate into one typeahead query. */
const TYPEAHEAD_RESET_MS = 500;

// =============================================================================
// PORTAL
// =============================================================================

/**
 * The element overlays portal into: the shell's popup portal when present
 * (inside the shell), otherwise document.body (webviews, tests, other hosts).
 *
 * @returns The container, or null outside the DOM.
 */
export function getPortalContainer(): HTMLElement | null {
	if (typeof document === 'undefined') return null;
	return document.getElementById(POPUP_PORTAL_ID) ?? document.body;
}

// =============================================================================
// POSITIONING
// =============================================================================

/** Result of {@link useAnchoredPosition}. */
export interface IAnchoredPosition {
	/** Fixed-position style for the floating element. Transparent until measured. */
	style: CSSProperties;
	/** The side actually used after flipping. */
	side: OverlaySide;
	/** False during the first, hidden measuring frame. */
	isPositioned: boolean;
}

/**
 * Keeps a floating element positioned against an anchor while open:
 * measures after layout, then re-measures on window resize, on any scroll
 * (capture phase, so scrolling containers count) and when either element
 * resizes.
 *
 * @param anchorRef - The element the overlay is attached to.
 * @param floatingRef - The overlay element itself.
 * @param isOpen - Whether the overlay is mounted and visible.
 * @param options - Placement, offset, padding, and `matchWidth` to make the
 *   overlay at least as wide as the anchor (Select, Combobox).
 * @returns The style to spread on the floating element and the final side.
 */
export function useAnchoredPosition(anchorRef: React.RefObject<HTMLElement | null>, floatingRef: React.RefObject<HTMLElement | null>, isOpen: boolean, options: IComputePositionOptions & { matchWidth?: boolean } = {}): IAnchoredPosition {
	const { placement, offset, padding, matchWidth } = options;
	const [position, setPosition] = useState<{ top: number; left: number; side: OverlaySide; minWidth?: number } | null>(null);

	const update = useCallback(() => {
		const anchor = anchorRef.current;
		const floating = floatingRef.current;
		if (!anchor || !floating) return;

		const anchorRect = anchor.getBoundingClientRect();
		const viewport = { width: window.innerWidth, height: window.innerHeight };
		let floatingSize = { width: floating.offsetWidth, height: floating.offsetHeight };
		let minWidth: number | undefined;
		if (matchWidth) {
			minWidth = anchorRect.width;
			floatingSize = { width: Math.max(floatingSize.width, anchorRect.width), height: floatingSize.height };
		}

		const next = computePosition(anchorRect, floatingSize, viewport, { placement, offset, padding });
		setPosition({ top: next.top, left: next.left, side: next.side, minWidth });
	}, [anchorRef, floatingRef, placement, offset, padding, matchWidth]);

	useLayoutEffect(() => {
		if (!isOpen) {
			setPosition(null);
			return undefined;
		}
		update();

		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);

		let observer: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined') {
			observer = new ResizeObserver(update);
			if (anchorRef.current) observer.observe(anchorRef.current);
			if (floatingRef.current) observer.observe(floatingRef.current);
		}

		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
			if (observer) observer.disconnect();
		};
	}, [isOpen, update, anchorRef, floatingRef]);

	if (!position) {
		// Measuring frame: transparent and inert, but NOT visibility:hidden, so
		// focus can already move into the panel (a hidden element cannot take
		// focus, which made initial focus racy).
		return { side: 'bottom', isPositioned: false, style: { position: 'fixed', top: 0, left: 0, opacity: 0, pointerEvents: 'none' } };
	}

	return {
		side: position.side,
		isPositioned: true,
		style: { position: 'fixed', top: position.top, left: position.left, minWidth: position.minWidth },
	};
}

// =============================================================================
// LAYER + DISMISS
// =============================================================================

/** Options for {@link useOverlayDismiss}. */
export interface IOverlayDismissOptions {
	/** Whether the overlay is open. Nothing is registered while closed. */
	isOpen: boolean;
	/** Elements that count as "inside": the overlay and its anchor. */
	insideRefs: React.RefObject<HTMLElement | null>[];
	/** Called when the overlay should close. */
	onDismiss: () => void;
	/** Close on Escape (top layer only). Defaults to true. */
	isEscapeEnabled?: boolean;
	/** Close on a pointer press outside every inside ref. Defaults to true. */
	isOutsidePressEnabled?: boolean;
}

/**
 * Joins the shared overlay stack while open and dismisses on Escape (only
 * when this overlay is the top layer) or on a press outside the overlay and
 * its anchor. Scroll is never locked: anchored overlays are modeless.
 *
 * @param options - {@link IOverlayDismissOptions}.
 */
export function useOverlayDismiss({ isOpen, insideRefs, onDismiss, isEscapeEnabled = true, isOutsidePressEnabled = true }: IOverlayDismissOptions): void {
	// Latest callback/refs without re-subscribing every render.
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	const insideRefsRef = useRef(insideRefs);
	insideRefsRef.current = insideRefs;

	useEffect(() => {
		if (!isOpen) return undefined;
		const layer = acquireOverlayLayer(false);

		/** Escape closes the top layer only, so stacked overlays peel one at a time. */
		function handleKeyDown(event: KeyboardEvent): void {
			if (!isEscapeEnabled) return;
			if (event.key !== 'Escape') return;
			if (!isTopOverlayLayer(layer)) return;
			event.stopPropagation();
			onDismissRef.current();
		}

		/** A press outside the overlay and its anchor closes it. */
		function handlePointerDown(event: PointerEvent): void {
			if (!isOutsidePressEnabled) return;
			if (!isTopOverlayLayer(layer)) return;
			const target = event.target as Node | null;
			const isInside = insideRefsRef.current.some((ref) => {
				return Boolean(ref.current && target && ref.current.contains(target));
			});
			if (isInside) return;
			onDismissRef.current();
		}

		document.addEventListener('keydown', handleKeyDown);
		document.addEventListener('pointerdown', handlePointerDown, true);
		return () => {
			document.removeEventListener('keydown', handleKeyDown);
			document.removeEventListener('pointerdown', handlePointerDown, true);
			releaseOverlayLayer(layer);
		};
	}, [isOpen, isEscapeEnabled, isOutsidePressEnabled]);
}

// =============================================================================
// TYPEAHEAD
// =============================================================================

/**
 * Accumulates typed characters into a typeahead query that resets after a
 * short pause, like native selects.
 *
 * @returns A function taking the latest typed character and returning the
 *   current query.
 */
export function useTypeahead(): (char: string) => string {
	const bufferRef = useRef('');
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	return useCallback((char: string) => {
		bufferRef.current += char;
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => {
			bufferRef.current = '';
		}, TYPEAHEAD_RESET_MS);
		return bufferRef.current;
	}, []);
}

/**
 * Whether a keydown is a printable character that should drive typeahead
 * (no modifier other than Shift, a single character, not Space).
 *
 * @param event - The keyboard event.
 * @returns True for typeahead characters.
 */
export function isTypeaheadKey(event: React.KeyboardEvent | KeyboardEvent): boolean {
	if (event.ctrlKey || event.metaKey || event.altKey) return false;
	if (event.key.length !== 1) return false;
	return event.key !== ' ';
}
