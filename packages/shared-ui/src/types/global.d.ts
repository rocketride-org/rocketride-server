// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Ambient module declarations for third-party libraries and asset imports.
 * These declarations allow TypeScript to understand non-TS imports (images, SVGs, etc.)
 * and untyped npm packages used throughout the shared-ui package.
 */

/** Ambient declaration for the `d3` data visualization library. */
declare module 'd3';

/** Allows importing `.svg` files as string URLs (handled by the bundler). */
declare module '*.svg' {
	const content: string;
	export default content;
}

/** Allows importing `.png` files as string URLs (handled by the bundler). */
declare module '*.png' {
	const content: string;
	export default content;
}

/** Allows importing `.jpg` files as string URLs (handled by the bundler). */
declare module '*.jpg' {
	const content: string;
	export default content;
}

/** Allows importing `.jpeg` files as string URLs (handled by the bundler). */
declare module '*.jpeg' {
	const content: string;
	export default content;
}

/** Allows importing `.gif` files as string URLs (handled by the bundler). */
declare module '*.gif' {
	const content: string;
	export default content;
}

/** Allows importing assets from the shared assets directory as unknown values. */
declare module 'shared/assets/*' {
	const content: unknown;
	export default content;
}
