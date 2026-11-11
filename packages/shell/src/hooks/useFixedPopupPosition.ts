// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useFixedPopupPosition — computes a fixed-position anchor point for a popup
 * relative to a trigger element.
 *
 * Two modes:
 *
 *  - LEGACY (no `options.popupRef`): one trigger measurement on open —
 *    'below' yields the point under the trigger's bottom-left corner,
 *    'above' yields its top-left corner (the caller translates itself).
 *    Existing callers keep exactly this behavior.
 *  - MEASURED (`options.popupRef` set): the popup element itself is measured,
 *    so the returned coordinates are FINAL — no caller transform. The popup
 *    flips to the other side when the preferred side lacks room, clamps into
 *    the viewport, aligns per `options.align`, and re-measures on scroll and
 *    resize while open. Render the popup even while this returns null
 *    (position it fixed and visibility:hidden) so there is a box to measure;
 *    the measurement runs pre-paint, so the hidden frame never flashes.
 */

import { useCallback, useLayoutEffect, useState } from 'react';

/** Options enabling the measured (clamp/flip) mode. */
export interface FixedPopupOptions {
	/** The popup element to measure — presence switches on the measured mode. */
	popupRef?: React.RefObject<HTMLElement | null>;
	/** Horizontal alignment against the trigger: left edges ('start', default) or right edges ('end'). */
	align?: 'start' | 'end';
	/** Gap between trigger and popup in px (default 4). */
	gap?: number;
	/** Minimum clearance from the viewport edges in px (default 8). */
	margin?: number;
	/** Also report the trigger's width (for popups that match it). */
	matchWidth?: boolean;
}

export function useFixedPopupPosition(triggerRef: React.RefObject<HTMLElement | null>, isOpen: boolean, placement: 'below' | 'above' = 'below', options?: FixedPopupOptions): { top: number; left: number; width?: number } | null {
	const [pos, setPos] = useState<{ top: number; left: number; width?: number } | null>(null);
	const { popupRef, align = 'start', gap = 4, margin = 8, matchWidth = false } = options ?? {};

	const measure = useCallback(() => {
		const trigger = triggerRef.current;
		if (!trigger) {
			setPos(null);
			return;
		}
		const rect = trigger.getBoundingClientRect();

		// step: legacy mode — the original single anchor point, verbatim
		const popup = popupRef?.current;
		if (!popup) {
			setPos({ top: placement === 'below' ? rect.bottom + 4 : rect.top, left: rect.left });
			return;
		}

		// step: measured mode — place the real popup box, flip when the
		// preferred side lacks room AND the other side has it, then clamp
		const { width, height } = popup.getBoundingClientRect();
		let top = placement === 'below' ? rect.bottom + gap : rect.top - gap - height;
		if (placement === 'below' && top + height > window.innerHeight - margin && rect.top - gap - height >= margin) {
			top = rect.top - gap - height;
		} else if (placement === 'above' && top < margin && rect.bottom + gap + height <= window.innerHeight - margin) {
			top = rect.bottom + gap;
		}
		top = Math.min(Math.max(top, margin), Math.max(window.innerHeight - height - margin, margin));
		let left = align === 'end' ? rect.right - width : rect.left;
		left = Math.min(Math.max(left, margin), Math.max(window.innerWidth - width - margin, margin));
		setPos(matchWidth ? { top, left, width: rect.width } : { top, left });
	}, [triggerRef, popupRef, placement, align, gap, margin, matchWidth]);

	useLayoutEffect(() => {
		if (!isOpen) {
			setPos(null);
			return;
		}
		measure();
		if (!popupRef) return;
		// step: keep the popup glued to its anchor while open — capture-phase
		// scroll sees every scrollable ancestor, not just the window
		window.addEventListener('scroll', measure, true);
		window.addEventListener('resize', measure);
		return () => {
			window.removeEventListener('scroll', measure, true);
			window.removeEventListener('resize', measure);
		};
	}, [isOpen, measure, popupRef]);

	return pos;
}
