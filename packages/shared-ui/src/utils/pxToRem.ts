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
 * Converts a pixel value to rem units based on the current HTML root font size.
 * Reads the computed `font-size` of the `<html>` element at runtime, so the
 * conversion respects any user or system-level font size overrides.
 *
 * @param px - The pixel value to convert.
 * @returns The equivalent value in rem units (as a number, without the "rem" suffix).
 */
export default function pxToRem(px: number) {
	const html = document.querySelector('html') as HTMLElement;
	// Read the computed root font size at runtime so we respect user/system overrides
	const htmlFontSize = window.getComputedStyle(html, null).getPropertyValue('font-size');
	// Divide the pixel value by the root font size (e.g., 16px) to get rem units
	return px / parseInt(htmlFontSize, 10);
}

/**
 * Converts a pixel value to a rem string (e.g., `"1.5rem"`) for use in CSS-in-JS styles.
 * Delegates to {@link pxToRem} for the numeric conversion.
 *
 * @param px - The pixel value to convert.
 * @returns A string like `"1.5rem"`.
 */
export function pxToRemString(px: number) {
	return `${pxToRem(px)}rem`;
}
