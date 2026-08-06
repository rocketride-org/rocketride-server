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

	if (!url) {
		return <div>Invalid webview URI: {uri}</div>;
	}

	return <iframe src={url} style={styles.iframe} title={url} allow="clipboard-read; clipboard-write" />;
};

export default WebviewProvider;
