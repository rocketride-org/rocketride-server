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
// MAP - CANVAS2D POINT RENDERER (the fallback when WebGL1 is unavailable)
// =============================================================================
//
// Same interface and the same view matrix as the WebGL renderer: points are
// projected on the CPU and drawn as circles, batched by colour (one path and one
// fill per colour), then one stroke for every outlined or emphasised point and
// one per colour for hollow points. Slower than WebGL at thousands of points,
// but complete. `snapshot` draws the last frame again and copies it (the PNG).
//
// Dimmed points are drawn first, the rest over them, as the WebGL renderer
// does; their colours (fill, outline, hollow ring) are mixed toward the
// surface on the CPU, keeping DIM, and drawn opaque: the same pixels the
// shader makes (translucent circles would darken where they overlap).
// =============================================================================

import { projectToScreen } from './camera';
import { DIM, FLAG, dimFlags, sizeCanvas } from './renderer.webgl';
import type { IPointData, IPointRenderer, IRenderFrame } from './renderer.webgl';

/** 0-1 channels to an `rgb()` colour. */
const css = (rgb: readonly [number, number, number]): string => `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;

/**
 * A colour mixed toward the surface, keeping DIM of it.
 *
 * @param rgb - 0-255 channels.
 * @param surface - 0-1 channels.
 * @returns `rgb()`.
 */
function dimmedCss(rgb: readonly [number, number, number], surface: readonly [number, number, number]): string {
	return `rgb(${rgb.map((v, k) => Math.round((surface[k] as number) * 255 * (1 - DIM) + v * DIM)).join(', ')})`;
}

/**
 * Create the Canvas2D renderer.
 *
 * @param canvas - The canvas (exclusively this renderer's).
 * @returns The renderer, or null when the canvas has no 2D context.
 */
export function createCanvas2dRenderer(canvas: HTMLCanvasElement): IPointRenderer | null {
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	let data: IPointData | null = null;
	let outlineRgb: [number, number, number] = [0, 0, 0];
	let surface: [number, number, number] = [1, 1, 1];
	let mask: Uint8Array | null = null;
	let flags: Uint8Array = new Uint8Array(0);
	let dimmed = 0;
	// Points by colour: the key is the `rgb()` drawn, the channels are kept for the dimmed mix.
	let groups = new Map<string, { rgb: [number, number, number]; indices: number[] }>();
	let widthCss = 1;
	let heightCss = 1;
	let dpr = 1;
	let xy = new Float32Array(0);
	let lastFrame: IRenderFrame | null = null;

	/** Merge the dimmed bits into the points' flags. */
	const merge = (): void => {
		const merged = data === null ? { flags: new Uint8Array(0), dimmed: 0 } : dimFlags(data.flags, mask);
		flags = merged.flags;
		dimmed = merged.dimmed;
	};

	return {
		kind: 'canvas2d',
		lost: false,
		pointSizeRange: [1, 256],
		resize(w: number, h: number, ratio: number): void {
			widthCss = Math.max(1, w);
			heightCss = Math.max(1, h);
			dpr = ratio;
			sizeCanvas(canvas, w, h, ratio);
		},
		setPoints(next: IPointData, outline: [number, number, number]): void {
			data = next;
			outlineRgb = outline;
			groups = new Map();
			for (let i = 0; i < next.count; i += 1) {
				if ((next.flags[i] as number) & FLAG.hidden) continue;
				const rgb: [number, number, number] = [next.rgba[4 * i] as number, next.rgba[4 * i + 1] as number, next.rgba[4 * i + 2] as number];
				const key = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
				const group = groups.get(key);
				if (group) group.indices.push(i);
				else groups.set(key, { rgb, indices: [i] });
			}
			xy = new Float32Array(next.count * 2);
			merge();
		},
		setDimmed(next: Uint8Array | null, surfaceRgb: [number, number, number]): number {
			mask = next;
			surface = surfaceRgb;
			merge();
			return dimmed;
		},
		render(frame: IRenderFrame): void {
			lastFrame = frame;
			const ratio = frame.dpr || dpr;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			if (data === null || data.count === 0) return;
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
			projectToScreen(data.positions, 3, frame.matrix, { width: widthCss, height: heightCss }, xy);
			const radius = (i: number): number => (frame.pointSizePx * (((flags[i] as number) & FLAG.emphasised) !== 0 ? 1.6 : 1)) / 2;
			const ok = (i: number): boolean => Number.isFinite(xy[2 * i] as number) && Number.isFinite(xy[2 * i + 1] as number);
			/** One set of points: the dimmed ones (faded colours) or the lit ones. */
			const drawSet = (faded: boolean): void => {
				const inSet = (i: number): boolean => ok(i) && (((flags[i] as number) & FLAG.dimmed) !== 0) === faded;
				for (const [key, group] of groups) {
					const colour = faded ? dimmedCss(group.rgb, surface) : key;
					let filled = false;
					let hollow = false;
					ctx.beginPath();
					for (const i of group.indices) {
						if (!inSet(i) || ((flags[i] as number) & FLAG.hollow) !== 0) continue;
						const r = radius(i);
						ctx.moveTo((xy[2 * i] as number) + r, xy[2 * i + 1] as number);
						ctx.arc(xy[2 * i] as number, xy[2 * i + 1] as number, r, 0, 2 * Math.PI);
						filled = true;
					}
					if (filled) {
						ctx.fillStyle = colour;
						ctx.fill();
					}
					ctx.beginPath();
					for (const i of group.indices) {
						if (!inSet(i) || ((flags[i] as number) & FLAG.hollow) === 0) continue;
						const r = radius(i);
						ctx.moveTo((xy[2 * i] as number) + r, xy[2 * i + 1] as number);
						ctx.arc(xy[2 * i] as number, xy[2 * i + 1] as number, r, 0, 2 * Math.PI);
						hollow = true;
					}
					if (hollow) {
						ctx.strokeStyle = colour;
						ctx.lineWidth = 2;
						ctx.stroke();
					}
				}
				let outlined = false;
				ctx.beginPath();
				for (const group of groups.values()) {
					for (const i of group.indices) {
						const f = flags[i] as number;
						if (!inSet(i) || (f & FLAG.hollow) !== 0 || (f & (FLAG.outlined | FLAG.emphasised)) === 0) continue;
						const r = radius(i);
						ctx.moveTo((xy[2 * i] as number) + r, xy[2 * i + 1] as number);
						ctx.arc(xy[2 * i] as number, xy[2 * i + 1] as number, r, 0, 2 * Math.PI);
						outlined = true;
					}
				}
				if (outlined) {
					ctx.strokeStyle = faded ? dimmedCss([outlineRgb[0] * 255, outlineRgb[1] * 255, outlineRgb[2] * 255], surface) : css(outlineRgb);
					ctx.lineWidth = 1;
					ctx.stroke();
				}
			};
			// The faded points first, then the lit ones over them.
			if (dimmed > 0) drawSet(true);
			drawSet(false);
		},
		snapshot(target: CanvasRenderingContext2D): boolean {
			if (lastFrame === null) return false;
			this.render(lastFrame);
			target.drawImage(canvas, 0, 0);
			return true;
		},
		destroy(): void {
			data = null;
			mask = null;
			flags = new Uint8Array(0);
			dimmed = 0;
			groups = new Map();
			lastFrame = null;
		},
	};
}
