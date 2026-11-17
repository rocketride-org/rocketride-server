// =============================================================================
// CONSENT BANNER PLACEMENT - where the banner may sit without covering the
// page's core graphics or primary actions. Pure geometry: the banner measures
// the obstacles (elements marked data-rr-keep-clear) and its own height, this
// file decides. Unit-tested under node:test (test/unit/placement.test.ts).
//
// Desktop and tablet: a compact toast in a bottom corner, bottom-left first,
// then bottom-right, each narrowed to the free gutter beside what it would
// cover; a toast narrowed below COMPACT_BELOW carries the short phone copy.
// Phones: a slim bar at the bottom, raised just above an obstacle it would
// cover. When no clear spot exists yet (on a laptop the hero terminal
// fills the bottom of the first screen), the banner waits until the visitor
// scrolls one free. Once shown, nextPlacement decides how it follows the page.
// =============================================================================

/** A box in viewport pixels (getBoundingClientRect's edges). */
export type Rect = { left: number; top: number; right: number; bottom: number };
/** The viewport's size in CSS pixels. */
export type View = { width: number; height: number };

/** Toast inset from the viewport edges. */
export const MARGIN = 16;
/** Phone bar inset. */
export const PHONE_MARGIN = 12;
/** Toast width: preferred maximum. */
export const TOAST_MAX = 380;
/** Toast width: the narrowest a corner gutter may make it; a narrower gutter leaves that corner unused. */
export const TOAST_MIN = 260;
/** Clearance kept around every obstacle. */
export const GAP = 8;
/** The phone bar never rises above this share of the screen height: it waits instead. */
export const BAR_MAX_TOP_SHARE = 0.45;
/** A toast narrower than this carries the short phone copy instead of the heading and body. */
export const COMPACT_BELOW = 320;

/** Which banner a viewport gets: the slim bar across the bottom on phones, a corner toast on tablets and desktops. */
export type Variant = 'phone' | 'toast';
/** The bottom corner a toast sits in. */
export type Side = 'left' | 'right';

/**
 * Phones get the slim bar: narrow viewports, and short ones (a phone held sideways).
 *
 * @param view The viewport.
 * @returns 'phone' below 600 px wide or 500 px tall, else 'toast'.
 */
export function variantFor(view: View): Variant {
	if (view.width < 600 || view.height < 500) {
		return 'phone';
	}
	return 'toast';
}

/**
 * Whether a banner of this variant and width carries the short phone copy: the phone bar and narrow toasts do.
 *
 * @param variant The banner's variant.
 * @param width   The banner's width (px).
 * @returns True for the phone bar and for a toast narrower than COMPACT_BELOW.
 */
export function compactCopy(variant: Variant, width: number): boolean {
	return variant === 'phone' || width < COMPACT_BELOW;
}

/**
 * Whether two rects overlap once `b` is grown by `gap` on every side.
 *
 * @param a   The banner's rect.
 * @param b   An obstacle's rect.
 * @param gap Clearance kept around `b` (px); 0 tests plain overlap.
 * @returns True when they overlap, edges within the gap included.
 */
export function intersects(a: Rect, b: Rect, gap = 0): boolean {
	return a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

/**
 * The part of each rect that is on screen.
 *
 * @param view  The viewport.
 * @param rects Rects in viewport coordinates.
 * @returns Each rect clipped to the viewport; rects entirely off screen are dropped.
 */
export function onScreen(view: View, rects: Rect[]): Rect[] {
	const out: Rect[] = [];
	for (const r of rects) {
		const c = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(view.width, r.right), bottom: Math.min(view.height, r.bottom) };
		if (c.right > c.left && c.bottom > c.top) {
			out.push(c);
		}
	}
	return out;
}

/**
 * The rect a toast covers in a bottom corner, MARGIN from the edges.
 *
 * @param view   The viewport.
 * @param side   The corner: bottom-left or bottom-right.
 * @param width  The toast's width (px).
 * @param height The toast's height at that width (px).
 * @returns The toast's rect in viewport coordinates.
 */
export function toastRect(view: View, side: Side, width: number, height: number): Rect {
	const top = view.height - MARGIN - height;
	const bottom = view.height - MARGIN;
	if (side === 'left') {
		return { left: MARGIN, top, right: MARGIN + width, bottom };
	}
	return { left: view.width - MARGIN - width, top, right: view.width - MARGIN, bottom };
}

/** Where the banner sits once placed: a toast in a corner at a width, or the phone bar at a distance from the bottom. */
export type Placement = { variant: 'toast'; side: Side; width: number } | { variant: 'phone'; bottom: number };

/** The banner's fixed-position offsets (px). */
export type Position = { left?: number; right?: number; bottom: number; width?: number };

/**
 * The banner's fixed position for a placement. While it is still measured (null) it sits where it
 * would first appear: the phone bar across the bottom, a toast in the bottom-left corner. The phone
 * bar keeps its bottom inset; it rises above an obstacle by a transform, which is not a layout shift.
 *
 * @param placement The placement, or null while the banner is measured or waits for a clear spot.
 * @param isPhone   Whether the phone variant applies to the current viewport.
 * @returns The fixed-position offsets.
 */
export function positionFor(placement: Placement | null, isPhone: boolean): Position {
	if (placement === null) {
		if (isPhone) {
			return { left: PHONE_MARGIN, right: PHONE_MARGIN, bottom: PHONE_MARGIN };
		}
		return { left: MARGIN, bottom: MARGIN };
	}
	if (placement.variant === 'phone') {
		return { left: PHONE_MARGIN, right: PHONE_MARGIN, bottom: PHONE_MARGIN };
	}
	return { [placement.side]: MARGIN, bottom: MARGIN, width: placement.width };
}

/**
 * The banner's data-rr-placement value.
 *
 * @param placement The placement, or null while the banner is measured or waits.
 * @returns 'measuring' until placed, then 'bar', 'left' or 'right'.
 */
export function placementLabel(placement: Placement | null): 'measuring' | 'bar' | Side {
	if (placement === null) {
		return 'measuring';
	}
	if (placement.variant === 'phone') {
		return 'bar';
	}
	return placement.side;
}

/**
 * Whether two placements put the banner in the same spot, compared field by field.
 *
 * @param a One placement, or null (not placed).
 * @param b The other, or null.
 * @returns True when both are null, or both are the same variant in the same spot.
 */
export function samePlacement(a: Placement | null, b: Placement | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	if (a.variant === 'phone' && b.variant === 'phone') {
		return a.bottom === b.bottom;
	}
	if (a.variant === 'toast' && b.variant === 'toast') {
		return a.side === b.side && a.width === b.width;
	}
	return false;
}

/** A toast's corner and width, as placeToast chooses them. */
export type ToastPlacement = { side: Side; width: number };

/**
 * Bottom-left first, then bottom-right, at the preferred width; a corner that covers an obstacle is
 * narrowed to the gutter beside it (never below TOAST_MIN) and measured again, since a narrower toast
 * is taller.
 *
 * @param view      The viewport.
 * @param obstacles What the toast may not cover, on screen.
 * @param heightAt  The toast's height at a width, with the copy that width carries (px).
 * @param sides     The corners to try, in order.
 * @returns The first clear corner and its width, or null when no corner is clear.
 */
export function placeToast(view: View, obstacles: Rect[], heightAt: (width: number) => number, sides: Side[] = ['left', 'right']): ToastPlacement | null {
	const preferred = Math.max(0, Math.min(TOAST_MAX, view.width - 2 * MARGIN));
	const narrowest = Math.min(TOAST_MIN, preferred);
	for (const side of sides) {
		let width = preferred;
		for (let tries = 0; tries < 4 && width >= narrowest; tries++) {
			const rect = toastRect(view, side, width, heightAt(width));
			const hits = obstacles.filter((o) => {
				return intersects(rect, o, GAP);
			});
			if (hits.length === 0) {
				return { side, width };
			}
			const room = roomBeside(view, side, hits);
			if (room >= width) {
				break; // the obstacle is above the toast, not beside it: narrowing cannot help
			}
			width = Math.floor(room);
		}
	}
	return null;
}

/**
 * The width a toast in this corner has before the nearest obstacle it covers.
 *
 * @param view The viewport.
 * @param side The toast's corner.
 * @param hits The obstacles the toast covers.
 * @returns The free width (px), the gap and margin taken off.
 */
function roomBeside(view: View, side: Side, hits: Rect[]): number {
	if (side === 'left') {
		const nearest = Math.min(...hits.map((o) => {
			return o.left;
		}));
		return nearest - GAP - MARGIN;
	}
	const nearest = Math.max(...hits.map((o) => {
		return o.right;
	}));
	return view.width - MARGIN - nearest - GAP;
}

/** The phone bar's distance from the bottom, as placeBar chooses it. */
export type BarPlacement = { bottom: number };

/**
 * The phone bar at the bottom; raised just above an obstacle it would cover (the footer's Privacy
 * settings link, a primary action).
 *
 * @param view      The viewport.
 * @param obstacles What the bar may not cover, on screen.
 * @param height    The bar's height (px).
 * @returns The bar's distance from the bottom, or null when it would have to rise above BAR_MAX_TOP_SHARE of the screen.
 */
export function placeBar(view: View, obstacles: Rect[], height: number): BarPlacement | null {
	let bottom = PHONE_MARGIN;
	for (let tries = 0; tries < 4; tries++) {
		const rect = { left: PHONE_MARGIN, right: view.width - PHONE_MARGIN, top: view.height - bottom - height, bottom: view.height - bottom };
		if (rect.top < view.height * BAR_MAX_TOP_SHARE) {
			return null;
		}
		const hits = obstacles.filter((o) => {
			return intersects(rect, o, GAP);
		});
		if (hits.length === 0) {
			return { bottom };
		}
		const highest = Math.min(...hits.map((o) => {
			return o.top;
		}));
		bottom = Math.ceil(view.height - highest + GAP);
	}
	return null;
}

/**
 * What the banner may not cover, on screen: every marked element, and among them the ones marked
 * "always" (kept clear also once the banner is shown, while the page scrolls).
 */
export type Obstacles = { all: Rect[]; always: Rect[] };

/** What nextPlacement decides from: the placement on screen, the viewport, the obstacles and the banner's size. */
export type PlacementInput = {
	/** The placement on screen now, or null while the banner is measured or waits for a clear spot. */
	current: Placement | null;
	/** Whether `current` was placed for this viewport size: a new size means a new first placement. */
	isSameView: boolean;
	/** The viewport. */
	view: View;
	/** What the banner may not cover. */
	obstacles: Obstacles;
	/** The banner's height as it is rendered now (px). */
	height: number;
	/** The toast's height at a width, with the copy that width carries (px). */
	heightAt: (width: number) => number;
};

/** A new placement, null to hide the banner (it waits or steps aside), or 'keep' to leave it as it is. */
export type PlacementDecision = Placement | null | 'keep';

/**
 * Where the banner goes, on its first placement and on every scroll or resize after it.
 *
 * - The phone bar on screen rises above an obstacle marked "always" and settles back once it has
 *   passed; it never vanishes.
 * - A toast on screen keeps its corner and width (no layout shift while the page scrolls) until
 *   something it must not cover comes under it; then it takes the other corner at the same width if
 *   that is clear, else it is placed again from scratch (it may narrow), else it steps aside (null)
 *   until a corner is clear again.
 * - With nothing placed for this viewport (the first placement, or the window changed size), it is
 *   placed against every obstacle. With no clear spot it waits (null); a placement from before the
 *   resize stays where it is ('keep').
 *
 * @param input The placement on screen, the viewport, the obstacles and the banner's height.
 * @returns The new placement, null to hide the banner, or 'keep'.
 */
export function nextPlacement(input: PlacementInput): PlacementDecision {
	const { current } = input;
	const variant = variantFor(input.view);
	if (current !== null && input.isSameView && current.variant === variant) {
		if (current.variant === 'phone') {
			return barOnScreen(input);
		}
		return toastOnScreen(current, input);
	}
	const first = firstPlacement(variant, input);
	if (first === null && current !== null) {
		return 'keep';
	}
	return first;
}

/**
 * The phone bar on screen, against the obstacles marked "always" only.
 *
 * @param input The viewport, the obstacles and the bar's height.
 * @returns The bar raised or settled back, or 'keep' where it cannot move (it never vanishes).
 */
function barOnScreen(input: PlacementInput): PlacementDecision {
	const bar = placeBar(input.view, input.obstacles.always, input.height);
	if (bar === null) {
		return 'keep';
	}
	return { variant: 'phone', bottom: bar.bottom };
}

/**
 * A toast on screen, against every obstacle.
 *
 * @param shown The toast's placement.
 * @param input The viewport, the obstacles and the toast's measurements.
 * @returns 'keep' while its corner is clear; else the other corner, a fresh placement, or null (it steps aside).
 */
function toastOnScreen(shown: { variant: 'toast'; side: Side; width: number }, input: PlacementInput): PlacementDecision {
	const { view, obstacles, height } = input;
	if (!coversAny(toastRect(view, shown.side, shown.width, height), obstacles.all)) {
		return 'keep';
	}
	const other = otherSide(shown.side);
	if (!coversAny(toastRect(view, other, shown.width, height), obstacles.all)) {
		return { variant: 'toast', side: other, width: shown.width };
	}
	return freshToast(input);
}

/**
 * The first placement for a viewport, against every obstacle.
 *
 * @param variant The viewport's variant.
 * @param input   The viewport, the obstacles and the banner's measurements.
 * @returns The bar or the toast, or null when there is no clear spot yet.
 */
function firstPlacement(variant: Variant, input: PlacementInput): Placement | null {
	if (variant === 'toast') {
		return freshToast(input);
	}
	const bar = placeBar(input.view, input.obstacles.all, input.height);
	if (bar === null) {
		return null;
	}
	return { variant: 'phone', bottom: bar.bottom };
}

/**
 * A toast placed from scratch against every obstacle, in either corner, narrowed if that is what fits.
 *
 * @param input The viewport, the obstacles and the toast's height at each width.
 * @returns The toast's placement, or null when no corner is clear.
 */
function freshToast(input: PlacementInput): Placement | null {
	const toast = placeToast(input.view, input.obstacles.all, input.heightAt);
	if (toast === null) {
		return null;
	}
	return { variant: 'toast', side: toast.side, width: toast.width };
}

/**
 * Whether a rect covers any obstacle, the clearance included.
 *
 * @param rect      The banner's rect.
 * @param obstacles What it may not cover.
 * @returns True when it covers at least one.
 */
function coversAny(rect: Rect, obstacles: Rect[]): boolean {
	return obstacles.some((o) => {
		return intersects(rect, o, GAP);
	});
}

/**
 * The other bottom corner.
 *
 * @param side A corner.
 * @returns The opposite one.
 */
function otherSide(side: Side): Side {
	if (side === 'left') {
		return 'right';
	}
	return 'left';
}
