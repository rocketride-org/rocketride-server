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
// SIDEBAR TONE — the ink sidebar an app can ask for through its branding
//
// The ink sidebar is the paper sidebar with its surface tokens re-pointed at
// the theme's `--rr-sidebar-ink-*` tokens, set on the sidebar frame. Every
// component inside — the header, the app's menus, the footer — already reads
// those surface tokens, so they all turn ink together and none of them has to
// know about tones.
// =============================================================================

import type { CSSProperties } from 'react';

/** The token whose presence says the active theme defines an ink sidebar. */
export const INK_PROBE_TOKEN = '--rr-sidebar-ink-bg';

/** The surface tokens the ink sidebar re-points, and what each points at. */
const INK_OVERRIDES: Record<string, string> = {
	'--rr-bg-paper': 'var(--rr-sidebar-ink-bg)',
	'--rr-text-primary': 'var(--rr-sidebar-ink-fg)',
	'--rr-text-secondary': 'var(--rr-sidebar-ink-fg-muted)',
	'--rr-bg-list-hover': 'var(--rr-sidebar-ink-hover)',
	'--rr-bg-surface-alt': 'var(--rr-sidebar-ink-hover)',
	'--rr-bg-list-active': 'var(--rr-sidebar-ink-active-bg)',
	'--rr-fg-list-active': 'var(--rr-sidebar-ink-active-fg)',
	'--rr-border': 'var(--rr-sidebar-ink-border)',
	'--rr-palette-mode': 'dark',
};

/**
 * Whether the sidebar should draw in ink.
 *
 * Only when the app asked for it AND the theme can draw it: a theme without
 * the ink tokens would otherwise re-point every surface token at nothing and
 * leave the sidebar unreadable.
 *
 * @param tone - The tone the active app's branding asks for.
 * @param hasInkTokens - Whether the active theme defines the ink tokens.
 * @returns True when the sidebar draws in ink.
 */
export function isInkSidebar(tone: string | undefined, hasInkTokens: boolean): boolean {
	if (tone !== 'ink') {
		return false;
	}
	return hasInkTokens;
}

/**
 * The style that turns the sidebar frame ink.
 *
 * @param isInk - Whether the sidebar draws in ink.
 * @returns The token overrides for the frame, or an empty style for paper.
 */
export function getSidebarToneStyle(isInk: boolean): CSSProperties {
	if (!isInk) {
		return {};
	}
	const style: Record<string, string> = { colorScheme: 'dark' };
	for (const [token, value] of Object.entries(INK_OVERRIDES)) {
		style[token] = value;
	}
	return style as CSSProperties;
}
