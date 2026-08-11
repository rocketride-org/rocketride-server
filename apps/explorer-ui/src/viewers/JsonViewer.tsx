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
// JSON VIEWER — interactive collapsible tree via the shared JsonTree
// =============================================================================

import React from 'react';
import { JsonTree } from 'shared/components/json-tree';
import { viewerStyles } from './styles';

interface Props {
	content: string;
}

/** Depth the JSON tree auto-expands to on open. */
const EXPAND_DEPTH = 2;

export const JsonViewer: React.FC<Props> = ({ content }) => {
	// Parse the file text; only valid JSON gets the interactive tree.
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		// Invalid JSON: show the raw text in a plain <pre> so the user can still
		// read the payload (and spot the syntax error) instead of an empty tree.
		return (
			<div style={viewerStyles.prose}>
				<pre>{content}</pre>
			</div>
		);
	}

	// The shared JsonTree is the platform's one JSON presentation layer — a
	// collapsible inspector, distinct from the Monaco code view this file's
	// category also offers.
	return (
		<div style={viewerStyles.prose}>
			<JsonTree data={parsed} defaultExpanded={EXPAND_DEPTH} />
		</div>
	);
};
