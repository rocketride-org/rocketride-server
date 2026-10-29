// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Placement math for anchored overlays (Popover, Menu, Select, Combobox,
 * Tooltip). Pure functions over rectangles so the behavior is unit-testable
 * without a DOM: place the floating box on the requested side of the anchor,
 * flip to the opposite side when it would overflow the viewport, then shift
 * it along the cross axis so it stays fully on screen.
 */

// =============================================================================
// TYPES
// =============================================================================

/** Which side of the anchor the floating box sits on. */
export type OverlaySide = 'top' | 'bottom' | 'left' | 'right';

/** How the floating box aligns along the anchor's edge. */
export type OverlayAlign = 'start' | 'center' | 'end';

/** A side plus an optional alignment, e.g. `'bottom-start'`. */
export type OverlayPlacement = OverlaySide | `${OverlaySide}-${OverlayAlign}`;

/** A viewport-relative rectangle (the subset of DOMRect the math needs). */
export interface IRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** A width/height pair. */
export interface ISize {
	width: number;
	height: number;
}

/** The computed fixed-position coordinates and the side actually used. */
export interface IComputedPosition {
	top: number;
	left: number;
	side: OverlaySide;
}

/** Options for {@link computePosition}. */
export interface IComputePositionOptions {
	/** Requested placement. Defaults to `'bottom-start'`. */
	placement?: OverlayPlacement;
	/** Gap between anchor and floating box, in px. Defaults to 4. */
	offset?: number;
	/** Minimum distance kept from every viewport edge, in px. Defaults to 8. */
	padding?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const OPPOSITE_SIDE: Record<OverlaySide, OverlaySide> = {
	top: 'bottom',
	bottom: 'top',
	left: 'right',
	right: 'left',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Splits a placement string into its side and alignment.
 *
 * @param placement - e.g. `'bottom-start'` or `'top'`.
 * @returns The side and the alignment (`'center'` when none is given).
 */
export function parsePlacement(placement: OverlayPlacement): { side: OverlaySide; align: OverlayAlign } {
	const [side, align] = placement.split('-') as [OverlaySide, OverlayAlign | undefined];
	if (!align) return { side, align: 'center' };
	return { side, align };
}

/**
 * Clamps a value into `[min, max]`. When the range is inverted (the box is
 * larger than the viewport) the minimum wins, so the box's start edge stays
 * visible.
 *
 * @param value - The value to clamp.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/**
 * Main-axis coordinate for a side: the top (for top/bottom) or left (for
 * left/right) of the floating box.
 */
function mainAxisPosition(side: OverlaySide, anchor: IRect, floating: ISize, offset: number): number {
	if (side === 'bottom') return anchor.top + anchor.height + offset;
	if (side === 'top') return anchor.top - floating.height - offset;
	if (side === 'right') return anchor.left + anchor.width + offset;
	return anchor.left - floating.width - offset;
}

/**
 * Cross-axis coordinate for an alignment: the left (for top/bottom) or top
 * (for left/right) of the floating box.
 */
function crossAxisPosition(side: OverlaySide, align: OverlayAlign, anchor: IRect, floating: ISize): number {
	const isVertical = side === 'top' || side === 'bottom';
	const anchorStart = isVertical ? anchor.left : anchor.top;
	const anchorLength = isVertical ? anchor.width : anchor.height;
	const floatingLength = isVertical ? floating.width : floating.height;

	if (align === 'start') return anchorStart;
	if (align === 'end') return anchorStart + anchorLength - floatingLength;
	return anchorStart + (anchorLength - floatingLength) / 2;
}

/** Whether a box placed on `side` at `position` fits inside the viewport. */
function fitsOnSide(side: OverlaySide, position: number, floating: ISize, viewport: ISize, padding: number): boolean {
	if (side === 'bottom') return position + floating.height <= viewport.height - padding;
	if (side === 'top') return position >= padding;
	if (side === 'right') return position + floating.width <= viewport.width - padding;
	return position >= padding;
}

// =============================================================================
// API
// =============================================================================

/**
 * Computes fixed-position coordinates for a floating box anchored to a rect.
 *
 * The requested side is used when the box fits there. Otherwise the opposite
 * side is used when it fits; when neither fits, the side with more room wins.
 * The cross axis is then clamped so the box never leaves the viewport.
 *
 * @param anchor - The anchor's viewport rect (getBoundingClientRect()).
 * @param floating - The floating box's measured size.
 * @param viewport - The viewport size (window.innerWidth/innerHeight).
 * @param options - Placement, offset and edge padding.
 * @returns The top/left to apply with `position: fixed`, and the final side.
 */
export function computePosition(anchor: IRect, floating: ISize, viewport: ISize, options: IComputePositionOptions = {}): IComputedPosition {
	const { placement = 'bottom-start', offset = 4, padding = 8 } = options;
	const { side: requestedSide, align } = parsePlacement(placement);

	let side = requestedSide;
	let main = mainAxisPosition(side, anchor, floating, offset);

	if (!fitsOnSide(side, main, floating, viewport, padding)) {
		const flipped = OPPOSITE_SIDE[side];
		const flippedMain = mainAxisPosition(flipped, anchor, floating, offset);
		const isFlipBetter = fitsOnSide(flipped, flippedMain, floating, viewport, padding) || roomOnSide(flipped, anchor, viewport) > roomOnSide(side, anchor, viewport);
		if (isFlipBetter) {
			side = flipped;
			main = flippedMain;
		}
	}

	const cross = crossAxisPosition(side, align, anchor, floating);
	const isVertical = side === 'top' || side === 'bottom';

	if (isVertical) {
		return {
			side,
			top: clamp(main, padding, viewport.height - floating.height - padding),
			left: clamp(cross, padding, viewport.width - floating.width - padding),
		};
	}

	return {
		side,
		top: clamp(cross, padding, viewport.height - floating.height - padding),
		left: clamp(main, padding, viewport.width - floating.width - padding),
	};
}

/**
 * Free space between the anchor and the viewport edge on one side.
 *
 * @param side - The side to measure.
 * @param anchor - The anchor's viewport rect.
 * @param viewport - The viewport size.
 * @returns Room in px (may be negative when the anchor is off screen).
 */
export function roomOnSide(side: OverlaySide, anchor: IRect, viewport: ISize): number {
	if (side === 'bottom') return viewport.height - (anchor.top + anchor.height);
	if (side === 'top') return anchor.top;
	if (side === 'right') return viewport.width - (anchor.left + anchor.width);
	return anchor.left;
}
