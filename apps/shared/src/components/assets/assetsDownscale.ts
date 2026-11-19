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
// ASSETS DOWNSCALE — the browser half of the raster fit (canvas, bitmaps)
// =============================================================================

/**
 * Scales the raster images the {@link AssetsPane} writes to fit the
 * 1024 x 800 box. This module needs a browser (`createImageBitmap`, a
 * canvas), so only the pane imports it; the pure math ({@link fitWithin})
 * and the path helpers stay in `assetsModel`, which the VS Code extension
 * host compiles too.
 */

import { extensionOf, fitWithin } from './assetsModel';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The JPEG and WebP re-encode quality. */
const RASTER_QUALITY = 0.85;

/** The raster types the pane re-encodes; SVG (no pixels) and GIF (animation) pass through. */
const DOWNSCALED_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
};

// =============================================================================
// DOWNSCALE
// =============================================================================

/**
 * Scales a raster image to fit the asset box in the browser (a canvas in
 * the webview and the page alike) and re-encodes it in its own format: PNG
 * stays PNG, JPEG and WebP at {@link RASTER_QUALITY}. An image that already
 * fits, an SVG, a GIF, a non-image, and any decode or encode failure all
 * answer the original bytes.
 *
 * @param name - The file name (its extension picks the format).
 * @param bytes - The image bytes.
 * @returns The bytes to write.
 */
export async function downscaleImage(name: string, bytes: Uint8Array): Promise<Uint8Array> {
	const type = DOWNSCALED_TYPES[extensionOf(name)];
	if (!type || typeof createImageBitmap !== 'function') return bytes;
	try {
		// Step 1: decode and measure (a fresh copy: a Blob part must sit on a plain ArrayBuffer)
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
		try {
			const fit = fitWithin(bitmap.width, bitmap.height);
			if (!fit.scaled) return bytes;
			// Step 2: draw at the fitted size and re-encode in the same format
			const blob = await encodeBitmap(bitmap, fit.width, fit.height, type);
			return blob ? new Uint8Array(await blob.arrayBuffer()) : bytes;
		} finally {
			bitmap.close();
		}
	} catch {
		return bytes;
	}
}

/** Draws a bitmap onto a canvas of the given size and encodes it. */
async function encodeBitmap(bitmap: ImageBitmap, width: number, height: number, type: string): Promise<Blob | null> {
	const quality = type === 'image/png' ? undefined : RASTER_QUALITY;
	if (typeof OffscreenCanvas === 'function') {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.drawImage(bitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type, quality });
	}
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	context.drawImage(bitmap, 0, 0, width, height);
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}
