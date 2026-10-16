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
// useThemeMode — which of the design system's two themes is showing
// =============================================================================
//
// The design system switches on `html[data-theme="dark"]`. The shell applies a
// theme as inline CSS variables on <html> and does not set that attribute, but
// it does publish `--rr-palette-mode` (light | dark) with every theme. This
// reads it — and the attribute too, should a host set one — and re-reads on
// every change to <html>, the way the shell's own sidebar does. The app root
// carries the result as its own `data-theme`, which tokens.css also matches.
// =============================================================================

import { useEffect, useState } from 'react';

/** The design system's two themes. */
export type ThemeMode = 'light' | 'dark';

/** What <html> says right now. */
function readMode(): ThemeMode {
	if (typeof document === 'undefined') return 'light';
	const root = document.documentElement;
	if (root.getAttribute('data-theme') === 'dark') return 'dark';
	return getComputedStyle(root).getPropertyValue('--rr-palette-mode').trim() === 'dark' ? 'dark' : 'light';
}

/**
 * The current theme, kept in step with the shell.
 *
 * @returns `light` or `dark`.
 */
export function useThemeMode(): ThemeMode {
	const [mode, setMode] = useState<ThemeMode>(readMode);
	useEffect(() => {
		const observer = new MutationObserver(() => setMode(readMode()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
		return () => observer.disconnect();
	}, []);
	return mode;
}
