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
// INTRO PROVIDER — an embedded "Introduction to ..." page as a document tab
// =============================================================================
//
// Opened as a static document with URI format `intro:<mode>` from the
// sidebar's Introduction rows. The page content ships INSIDE the bundle
// (shared/modules/intro) as a complete standalone HTML document — no serving,
// no external references — rendered through a script-less sandboxed srcdoc
// iframe so its own styles can't leak into the shell.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { INTRO_PAGES } from 'shared/modules/intro/introPages';
import type { IntroMode } from 'shared/modules/intro/introPages';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	iframe: {
		flex: 1,
		width: '100%',
		border: 'none',
		background: '#ffffff',
	},
	invalid: {
		padding: 24,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one embedded introduction page inside a sandboxed srcdoc iframe.
 * The pages are pure HTML+CSS (no scripts), so the sandbox grants nothing.
 *
 * @param props.mode - The sidebar mode whose introduction to show.
 */
const IntroProvider: React.FC<{ mode: string }> = ({ mode }) => {
	const page = INTRO_PAGES[mode as IntroMode];
	if (!page) return <div style={styles.invalid}>Unknown introduction page: {mode}</div>;
	return <iframe srcDoc={page.html} title={page.title} style={styles.iframe} sandbox="" />;
};

export default IntroProvider;
