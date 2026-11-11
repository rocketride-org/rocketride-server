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
// MONACO THEME — the --rr-* token bridge (one theme for every surface)
// =============================================================================

/**
 * Builds the platform's Monaco theme from the live --rr-* CSS variables
 * (moved out of explorer-ui's MonacoViewer so every Monaco surface shares
 * it), plus the hook that re-registers it when the app theme flips.
 */

import { useEffect, useState } from 'react';
import type { Monaco } from './loader';

/** The registered theme name every editor mounts with. */
export const THEME_NAME = 'rr-theme';

/** Read a CSS custom property from :root, returning the trimmed value or the fallback. */
function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Convert any CSS color to a Monaco-compatible hex string (#RRGGBB or #RRGGBBAA).
 * Monaco's defineTheme only accepts hex — rgba() / named colors are silently ignored.
 */
function toHex(color: string): string {
	// Already hex — pass through
	if (color.startsWith('#')) return color;

	// Use an off-screen canvas to resolve any CSS color to rgba
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return color;
	ctx.fillStyle = color;
	const resolved = ctx.fillStyle; // browser normalises to #rrggbb or rgba(...)

	if (resolved.startsWith('#')) return resolved;

	const match = resolved.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
	if (!match) return color;

	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	const a = match[4] !== undefined ? Math.round(Number(match[4]) * 255) : 255;

	const hex = '#' + [r, g, b, ...(a < 255 ? [a] : [])]
		.map(v => v.toString(16).padStart(2, '0'))
		.join('');
	return hex;
}

/**
 * Detect whether the app is currently in dark mode by checking the
 * `--rr-palette-mode` token (set by applyTheme / rocketride-default.css).
 */
function isDarkMode(): boolean {
	const mode = cssVar('--rr-palette-mode', 'light').replace(/['"]/g, '');
	return mode === 'dark';
}

/**
 * Build and register the platform Monaco theme from the live --rr-* CSS
 * variables. Call after Monaco has loaded (and again on theme flips).
 *
 * @param monaco - The Monaco API namespace.
 */
export function defineRrTheme(monaco: Monaco): void {
	const dark = isDarkMode();

	// Helper: read a CSS variable and guarantee Monaco-safe hex output
	const hex = (name: string, fallback: string) => toHex(cssVar(name, fallback));

	// Read the app's CSS variables with sensible fallbacks
	const bg        = hex('--rr-bg-paper',        dark ? '#252526' : '#ffffff');
	const fg        = hex('--rr-text-primary',     dark ? '#cccccc' : '#1a1a1a');
	const fgSec     = hex('--rr-text-secondary',   dark ? '#999999' : '#666666');
	const border    = hex('--rr-border',            dark ? '#444444' : '#dcdcdc');
	const selection = dark ? '#264f78' : '#add6ff';
	const lineHl    = dark ? '#ffffff0a' : '#0000000a';
	const inputBg   = hex('--rr-bg-input',         dark ? '#3c3c3c' : '#ffffff');
	const widgetBg  = hex('--rr-bg-widget',         dark ? '#252526' : '#f3f3f3');
	const listHover = toHex(cssVar('--rr-bg-list-hover', dark ? '#ffffff0a' : '#0000000a'));
	const listActive = hex('--rr-bg-list-active',   dark ? '#094771' : '#0e639c');
	const listActiveFg = hex('--rr-fg-list-active', '#ffffff');
	const accent    = hex('--rr-accent',            '#f7901f');
	const link      = hex('--rr-text-link',         dark ? '#3794ff' : '#1976d2');
	const scrollbar = toHex(cssVar('--rr-bg-scrollbar-thumb', '#79797966'));
	const focusBorder = hex('--rr-border-focus',    dark ? '#007fd4' : '#0078d4');

	monaco.editor.defineTheme(THEME_NAME, {
		base: dark ? 'vs-dark' : 'vs',
		inherit: true,
		rules: [],
		colors: {
			// Editor
			'editor.background': bg,
			'editor.foreground': fg,
			'editor.lineHighlightBackground': lineHl,
			'editor.selectionBackground': selection,
			'editor.inactiveSelectionBackground': dark ? '#3a3d4166' : '#e5ebf166',
			'editorCursor.foreground': accent,

			// Line numbers
			'editorLineNumber.foreground': fgSec,
			'editorLineNumber.activeForeground': fg,

			// Gutter / rulers
			'editorGutter.background': bg,
			'editorRuler.foreground': border,
			'editorIndentGuide.background': border,
			'editorIndentGuide.activeBackground': fgSec,

			// Widgets (find, hover, suggest)
			'editorWidget.background': widgetBg,
			'editorWidget.foreground': fg,
			'editorWidget.border': border,
			'editorHoverWidget.background': widgetBg,
			'editorHoverWidget.border': border,
			'editorSuggestWidget.background': widgetBg,
			'editorSuggestWidget.border': border,
			'editorSuggestWidget.foreground': fg,
			'editorSuggestWidget.selectedBackground': listActive,
			'editorSuggestWidget.highlightForeground': accent,

			// Input (find dialog)
			'input.background': inputBg,
			'input.foreground': fg,
			'input.border': border,
			'inputOption.activeBorder': accent,
			'focusBorder': focusBorder,

			// Lists (autocomplete, etc.)
			'list.hoverBackground': listHover,
			'list.activeSelectionBackground': listActive,
			'list.activeSelectionForeground': listActiveFg,
			'list.inactiveSelectionBackground': dark ? '#37373d' : '#e4e6f1',
			'list.highlightForeground': accent,

			// Scrollbar
			'scrollbarSlider.background': scrollbar,
			'scrollbarSlider.hoverBackground': dark ? '#79797999' : '#64646480',
			'scrollbarSlider.activeBackground': dark ? '#797979cc' : '#00000080',

			// Minimap (disabled but just in case)
			'minimap.background': bg,

			// Links
			'editorLink.activeForeground': link,

			// Bracket match
			'editorBracketMatch.background': dark ? '#0064001a' : '#0064001a',
			'editorBracketMatch.border': accent,
		},
	});
}

/** Monotonic theme-change counter shared by every hook instance. */
let themeVersion = 0;

/**
 * Re-render trigger for app theme flips: observes the <html> attributes the
 * theme toggle writes and bumps a counter. Consumers re-define + re-set the
 * Monaco theme on change.
 *
 * @returns The current theme version.
 */
export function useThemeVersion(): number {
	const [version, setVersion] = useState(themeVersion);

	useEffect(() => {
		// Watch for data-theme attribute changes on <html> (web app theme toggle)
		const observer = new MutationObserver(() => {
			themeVersion += 1;
			setVersion(themeVersion);
		});

		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'class', 'style'],
		});

		return () => observer.disconnect();
	}, []);

	return version;
}
