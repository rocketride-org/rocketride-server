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
// =============================================================================

import { projectToScreen } from './camera';
import { FLAG, sizeCanvas } from './renderer.webgl';
import type { IPointData, IPointRenderer, IRenderFrame } from './renderer.webgl';

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
	let outline = 'rgb(0, 0, 0)';
	let groups = new Map<string, number[]>();
	let widthCss = 1;
	let heightCss = 1;
	let dpr = 1;
	let xy = new Float32Array(0);
	let lastFrame: IRenderFrame | null = null;

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
		setPoints(next: IPointData, outlineRgb: [number, number, number]): void {
			data = next;
			outline = `rgb(${Math.round(outlineRgb[0] * 255)}, ${Math.round(outlineRgb[1] * 255)}, ${Math.round(outlineRgb[2] * 255)})`;
			groups = new Map();
			for (let i = 0; i < next.count; i += 1) {
				if ((next.flags[i] as number) & FLAG.hidden) continue;
				const key = `rgb(${next.rgba[4 * i]}, ${next.rgba[4 * i + 1]}, ${next.rgba[4 * i + 2]})`;
				const list = groups.get(key);
				if (list) list.push(i);
				else groups.set(key, [i]);
			}
			xy = new Float32Array(next.count * 2);
		},
		render(frame: IRenderFrame): void {
			lastFrame = frame;
			const ratio = frame.dpr || dpr;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			if (data === null || data.count === 0) return;
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
			projectToScreen(data.positions, 3, frame.matrix, { width: widthCss, height: heightCss }, xy);
			const flags = data.flags;
			const radius = (i: number): number => (frame.pointSizePx * (((flags[i] as number) & FLAG.emphasised) !== 0 ? 1.6 : 1)) / 2;
			const ok = (i: number): boolean => Number.isFinite(xy[2 * i] as number) && Number.isFinite(xy[2 * i + 1] as number);
			for (const [colour, indices] of groups) {
				let filled = false;
				let hollow = false;
				ctx.beginPath();
				for (const i of indices) {
					if (!ok(i) || ((flags[i] as number) & FLAG.hollow) !== 0) continue;
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
				for (const i of indices) {
					if (!ok(i) || ((flags[i] as number) & FLAG.hollow) === 0) continue;
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
			for (const indices of groups.values()) {
				for (const i of indices) {
					const f = flags[i] as number;
					if (!ok(i) || (f & FLAG.hollow) !== 0 || (f & (FLAG.outlined | FLAG.emphasised)) === 0) continue;
					const r = radius(i);
					ctx.moveTo((xy[2 * i] as number) + r, xy[2 * i + 1] as number);
					ctx.arc(xy[2 * i] as number, xy[2 * i + 1] as number, r, 0, 2 * Math.PI);
					outlined = true;
				}
			}
			if (outlined) {
				ctx.strokeStyle = outline;
				ctx.lineWidth = 1;
				ctx.stroke();
			}
		},
		snapshot(target: CanvasRenderingContext2D): boolean {
			if (lastFrame === null) return false;
			this.render(lastFrame);
			target.drawImage(canvas, 0, 0);
			return true;
		},
		destroy(): void {
			data = null;
			groups = new Map();
			lastFrame = null;
		},
	};
}
