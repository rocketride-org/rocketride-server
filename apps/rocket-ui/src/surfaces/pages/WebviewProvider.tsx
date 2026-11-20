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
// WEBVIEW PAGE — renders an external URL in an iframe tab
// =============================================================================
//
// Opened as a static document with URI format `webview:<url>`.
// The display label is stored in the Editor, not encoded in the URI.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { getIsolation } from 'shell';
import { resolveWebviewUrl } from './webviewUrl';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	iframe: {
		flex: 1,
		width: '100%',
		border: 'none',
	} as CSSProperties,
};

// =============================================================================
// CONSTANTS
// =============================================================================

/** URI prefix that identifies webview documents. */
export const WEBVIEW_PREFIX = 'webview:';

// =============================================================================
// PROPS
// =============================================================================

interface IWebviewProviderProps {
	/** The document URI (format: `webview:<url>`). */
	uri: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders an external URL inside an iframe as a document tab.
 *
 * @param props - Webview page configuration.
 */
const WebviewProvider: React.FC<IWebviewProviderProps> = ({ uri }) => {
	// Extract URL by stripping the "webview:" prefix
	const url = uri.slice(WEBVIEW_PREFIX.length);

	// Same-authority pages (anything on the shell origin but the engine's chat
	// and dropper pages) and non-web schemes are never framed (#1022).
	// Nor any isolated app's origin (E7, #1022): a webview frame is not the app frame.
	// The iframe is given the canonical URL that was checked, never the raw text.
	const framed = url ? resolveWebviewUrl(url, window.location.origin, window.location.href, getIsolation()?.originTemplate) : null;
	if (!framed) {
		return <div>Invalid webview URI: {uri}</div>;
	}

	return (
		<iframe
			src={framed}
			style={styles.iframe}
			title={framed}
			// Least-privilege embedding: no top-navigation hijack, and no
			// clipboard read for arbitrary origins (write-only clipboard).
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
			allow="clipboard-write"
		/>
	);
};

export default WebviewProvider;
