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
// HTML PAGE PROVIDER — the framework's generic "open an HTML page" surface
// =============================================================================
//
// ONE document view for every static content page: a complete standalone
// HTML document rendered through a script-less sandboxed srcdoc iframe so
// its styles can't leak into the shell. The framework never knows what a
// page is about; content ships with whoever asks.
//
// Two URI forms route here:
//   html:<key>     — generic: the html rides as the document's content.
//   intro:<mode>   — compatibility alias: resolved from the builtin tools'
//                    intro catalog (reload-safe without persisted content).
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { INTRO_PAGES } from 'shared/tools/introCatalog';
import type { IntroMode } from 'shared/tools/introCatalog';

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

/**
 * Renders one static HTML content page in a sandboxed iframe (pages are
 * pure HTML+CSS; the sandbox grants nothing).
 *
 * @param props.uri - The document URI ('html:<key>' or 'intro:<mode>').
 * @param props.content - The document's content payload (the html for
 *                        'html:' documents; unused for intro aliases).
 */
const HtmlPageProvider: React.FC<{ uri: string; content?: unknown }> = ({ uri, content }) => {
	let html: string | undefined;
	let title = uri;
	if (uri.startsWith('intro:')) {
		const page = INTRO_PAGES[uri.slice('intro:'.length) as IntroMode];
		html = page?.html;
		title = page?.title ?? uri;
	} else if (typeof content === 'string') {
		html = content;
	}
	if (!html) return <div style={styles.invalid}>No content for page: {uri}</div>;
	return <iframe srcDoc={html} title={title} style={styles.iframe} sandbox="" />;
};

export default HtmlPageProvider;
