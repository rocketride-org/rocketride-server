// =============================================================================
// MIT License
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
// MAP - INTERACTION (pure: pointer gestures, wheel zoom, keys, tweening, frame stats)
// =============================================================================
//
// The canvas component feeds raw pointer, wheel and key events through these
// and acts on what comes out, so the rules are tested without a browser:
//
//   - a press that moves less than CLICK_SLOP_PX is a click (pick a point);
//     beyond that it pans; in lasso mode it draws the lasso path instead;
//   - the wheel zooms about the pointer by a bounded factor per event;
//   - arrow keys, Enter, Escape, L, +/- and 0 drive the map, but never while
//     Ctrl, Cmd or Alt is held (those belong to the shell and the browser);
//   - a new layout tweens from the old positions (skipped under reduced motion);
//   - frame times are kept in a ring buffer for the 95th percentile the
//     performance lane reads.
// =============================================================================

/** Movement (pixels) below which a press is a click. */
export const CLICK_SLOP_PX = 4;

/** What a gesture produced. */
export type GestureEvent = { type: 'click'; x: number; y: number } | { type: 'pan'; dx: number; dy: number } | { type: 'pan-end' } | { type: 'lasso'; path: number[] };

/** A pointer gesture in progress. */
export interface IGesture {
	down(x: number, y: number, lasso: boolean): void;
	move(x: number, y: number): GestureEvent[];
	up(x: number, y: number): GestureEvent[];
	cancel(): void;
	/** The lasso path drawn so far (x,y interleaved). */
	path(): number[];
	readonly active: boolean;
}

/**
 * Create the gesture tracker of one canvas.
 *
 * @returns The tracker.
 */
export function createGesture(): IGesture {
	let active = false;
	let lasso = false;
	let panning = false;
	let moved = false;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastY = 0;
	let path: number[] = [];

	const reset = (): void => {
		active = false;
		panning = false;
		moved = false;
		path = [];
	};

	return {
		get active() {
			return active;
		},
		down(x: number, y: number, lassoMode: boolean): void {
			active = true;
			lasso = lassoMode;
			panning = false;
			moved = false;
			startX = lastX = x;
			startY = lastY = y;
			path = lassoMode ? [x, y] : [];
		},
		move(x: number, y: number): GestureEvent[] {
			if (!active) return [];
			if (Math.hypot(x - startX, y - startY) > CLICK_SLOP_PX) moved = true;
			if (lasso) {
				path.push(x, y);
				return [];
			}
			if (!panning) {
				if (!moved) return [];
				panning = true;
			}
			const event: GestureEvent = { type: 'pan', dx: x - lastX, dy: y - lastY };
			lastX = x;
			lastY = y;
			return [event];
		},
		up(x: number, y: number): GestureEvent[] {
			if (!active) return [];
			if (Math.hypot(x - startX, y - startY) > CLICK_SLOP_PX) moved = true;
			let out: GestureEvent[];
			if (panning) out = [{ type: 'pan-end' }];
			else if (lasso && moved) {
				path.push(x, y);
				out = [{ type: 'lasso', path: path.slice() }];
			} else out = [{ type: 'click', x, y }];
			reset();
			return out;
		},
		cancel: reset,
		path(): number[] {
			return path.slice();
		},
	};
}

/**
 * The zoom factor of one wheel event.
 *
 * @param deltaY - WheelEvent.deltaY.
 * @param deltaMode - WheelEvent.deltaMode (0 pixels, 1 lines, 2 pages).
 * @returns A factor between 0.25 and 4 (>1 zooms in).
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.min(4, Math.max(0.25, Math.exp(-pixels * 0.002)));
}

/** Map actions a key can trigger. */
export type KeyAction = 'left' | 'right' | 'up' | 'down' | 'inspect' | 'clear' | 'lasso' | 'zoom-in' | 'zoom-out' | 'fit';

/**
 * The map action of a key, if any.
 *
 * @param key - KeyboardEvent.key.
 * @param mods - The modifier state.
 * @returns The action, or null (also whenever Ctrl, Cmd or Alt is held).
 */
export function keyAction(key: string, mods: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): KeyAction | null {
	if (mods.ctrlKey || mods.metaKey || mods.altKey) return null;
	switch (key) {
		case 'ArrowLeft':
			return 'left';
		case 'ArrowRight':
			return 'right';
		case 'ArrowUp':
			return 'up';
		case 'ArrowDown':
			return 'down';
		case 'Enter':
			return 'inspect';
		case 'Escape':
			return 'clear';
		case 'l':
		case 'L':
			return 'lasso';
		case '+':
		case '=':
			return 'zoom-in';
		case '-':
		case '_':
			return 'zoom-out';
		case '0':
			return 'fit';
		default:
			return null;
	}
}

/**
 * Smooth start and end.
 *
 * @param t - 0..1.
 * @returns Eased 0..1.
 */
export function easeInOut(t: number): number {
	const x = Math.max(0, Math.min(1, t));
	return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/**
 * Positions part-way from one layout to the next.
 *
 * @param from - Old positions.
 * @param to - New positions.
 * @param t - Progress 0..1 (eased here).
 * @returns The blend (a copy of `to` when the shapes differ).
 */
export function tweenPositions(from: Float32Array, to: Float32Array, t: number): Float32Array {
	if (from.length !== to.length) return Float32Array.from(to);
	const e = easeInOut(t);
	const out = new Float32Array(to.length);
	for (let i = 0; i < to.length; i += 1) out[i] = (from[i] as number) + ((to[i] as number) - (from[i] as number)) * e;
	return out;
}

/** Recent frame times. */
export interface IFrameStats {
	record(ms: number): void;
	/** The 95th percentile, or null before any frame. */
	p95(): number | null;
	count(): number;
	reset(): void;
}

/**
 * Keep the last `capacity` frame times.
 *
 * @param capacity - Frames kept.
 * @returns The recorder.
 */
export function createFrameStats(capacity = 240): IFrameStats {
	const ring = new Float64Array(capacity);
	let size = 0;
	let at = 0;
	return {
		record(ms: number): void {
			ring[at] = ms;
			at = (at + 1) % capacity;
			size = Math.min(capacity, size + 1);
		},
		p95(): number | null {
			if (size === 0) return null;
			const sorted = Array.from(ring.subarray(0, size)).sort((a, b) => a - b);
			return sorted[Math.min(size - 1, Math.floor(0.95 * size))] as number;
		},
		count: () => size,
		reset(): void {
			size = 0;
			at = 0;
		},
	};
}
