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
 * Flow theme — thin bridge to the shared theme system.
 *
 * Instead of hardcoded color values or direct VS Code CSS var reads,
 * this delegates to `getMuiTheme()` which reads --rr-* tokens from the
 * DOM. Those tokens are set by `applyTheme()` (web app) or by
 * `rocketride-vscode.css` (VS Code extension).
 */

import { getMuiTheme } from '../../themes/getMuiTheme';

// Re-export for convenience
export { buildMuiTheme } from '../../themes/buildMuiTheme';

// =============================================================================
// Font exports (used by other components)
// =============================================================================

/**
 * System fallback font stack used when primary web fonts are unavailable.
 * Provides cross-platform coverage for macOS, Windows, and Linux.
 */
export const fallbackFonts = ['-apple-system', '"Segoe UI"', '"Helvetica Neue"', 'Arial', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"'];

/** CSS `font-family` string for the Roboto typeface with system fallbacks. */
export const roboto = ['Roboto', ...fallbackFonts].join(',');
/** CSS `font-family` string for Roboto Condensed with system fallbacks. */
export const robotoCondensed = ['Roboto Condensed', 'Roboto', ...fallbackFonts].join(',');
/** CSS `font-family` string for the Ubuntu Mono monospace typeface with system fallbacks. */
export const mono = ['Ubuntu Mono', ...fallbackFonts].join(',');

/** Primary brand color (RocketRide orange). */
export const brandOrange = '#F7901F';
/** Light grey used for subtle backgrounds and borders. */
export const lightGrey = '#E6E6E6';
/** Dark grey used for muted text and secondary icons. */
export const darkGrey = '#838383';
/** Off-black used as the secondary palette main color. */
export const offBlack = '#666666';

// =============================================================================
// Theme access
// =============================================================================

/**
 * Get the current MUI theme by reading --rr-* CSS vars from the DOM.
 * Works in both web app (vars set by applyTheme) and VS Code (vars set by rocketride-vscode.css).
 */
export { getMuiTheme };

export default getMuiTheme;
