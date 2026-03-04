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
 * VSCode integration utilities
 */

/**
 * Checks if the code is running within a VSCode webview environment.
 * This is detected by checking for VSCode-specific CSS variables.
 *
 * @returns {boolean} True if running in VSCode, false otherwise
 */
export const isInVSCode = (): boolean => {
	// Guard against SSR where document is unavailable
	if (typeof document === 'undefined') return false;

	// VSCode webviews inject CSS custom properties; if --vscode-font-family is set, we're in VSCode
	const vscodeFontFamily = getComputedStyle(document.body)
		.getPropertyValue('--vscode-font-family')
		.trim();

	return !!vscodeFontFamily;
};

/**
 * Gets a VSCode CSS variable value with a fallback.
 *
 * @param {string} varName - The CSS variable name (e.g., '--vscode-editor-background')
 * @param {string} fallback - The fallback value if variable is not found
 * @returns {string} The CSS variable value or fallback
 */
export const getVSCodeColor = (varName: string, fallback: string): string => {
	// Guard against SSR where document is unavailable
	if (typeof document === 'undefined') return fallback;

	// Read the CSS custom property from the body element where VSCode injects theme colors
	const value = getComputedStyle(document.body).getPropertyValue(varName).trim();

	// Return the resolved value, or fall back if the variable is empty/unset
	return value || fallback;
};
