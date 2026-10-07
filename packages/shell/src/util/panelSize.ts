// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PANEL SIZE — the usable band a drawer or tray may occupy
// =============================================================================
//
// THE ARITHMETIC, WITHOUT THE DOM. `DetailPanel` decides a size in six places —
// a drag, a keyboard step, a reset (stacked and lone), the stack-join seed and
// the open correction — and each one previously had to remember the rule on its
// own. Two of them did not: a reset while stacked wrote 600 where the band
// allowed 380, and a first open rendered the caller's raw default however narrow
// the host was. Both shipped a panel whose own resize handle was off-screen.
//
// Keeping the arithmetic here does two things: the component has one clamp to
// route every write through, and the rule is a plain function of numbers, so it
// can be tested without a browser (see panelSize.test.ts).

/** The measurements that decide how wide (or tall) a panel may be. */
export interface SizeBand {
	/** The owning surface's size along the slide axis, in px. */
	hostSize: number;
	/** The axis floor — forms and footer verbs break below this. */
	minSize: number;
	/** Widest the panel may be as a fraction of the host. */
	maxFraction: number;
	/** Host pixels that must stay visible beside the panel. */
	contextSliver: number;
	/**
	 * Room reserved for the panels this one covers, in px.
	 *
	 * In a stack the band binds the ROOT (deepest, widest) panel: the top may
	 * grow only until root = top + one sliver per level still fits. Zero for a
	 * lone panel.
	 */
	stackAllowance?: number;
}

/**
 * The largest size the band allows.
 *
 * The floor WINS over the band: a host too narrow for `minSize` still gets
 * `minSize`, because a panel below its floor is unusable in a different way,
 * and a caller that expects to be opened on a phone should lower the floor.
 *
 * @param band - The measurements.
 * @returns The maximum size in px.
 */
export function maxSize(band: SizeBand): number {
	const usable = Math.min(band.hostSize * band.maxFraction, band.hostSize - band.contextSliver);
	return Math.max(band.minSize, usable - (band.stackAllowance ?? 0));
}

/**
 * A candidate size, brought inside the band.
 *
 * @param candidate - The size somebody asked for: a caller's default, a restored
 *   preference, a drag position or a keyboard step.
 * @param band - The measurements.
 * @returns The size to actually render.
 * @example
 * resolveSize(640, { hostSize: 390, minSize: 380, maxFraction: 0.85, contextSliver: 120 });
 * // => 380 — the phone case: 640 would put the resize handle off-screen.
 */
export function resolveSize(candidate: number, band: SizeBand): number {
	return Math.min(Math.max(candidate, band.minSize), maxSize(band));
}

/**
 * The shared TOP width that puts the stack's ROOT panel at `defaultSize`.
 *
 * Covered panels render one sliver wider per level, so the top has to start
 * that much narrower for the root — the widest, and the one against the host
 * edge — to land where the caller asked. Still a candidate: pass it through
 * {@link resolveSize} before writing it.
 *
 * @param defaultSize - The caller's default size for the root panel.
 * @param minSize - The axis floor.
 * @param offset - Sliver width per level, in px.
 * @param levels - Panels in the stack.
 * @returns The top panel's size in px.
 */
export function stackedTopSize(defaultSize: number, minSize: number, offset: number, levels: number): number {
	return Math.max(minSize, defaultSize - offset * Math.max(0, levels - 1));
}
