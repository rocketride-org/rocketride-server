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
// MONACO VIEWER — syntax-highlighted code editor for text & code files
// =============================================================================

/**
 * The Explorer's code viewer, on the SHARED Monaco module: the editor and
 * its workers are chunks of this remote's own bundle (no CDN loader), the
 * rr token theme and language detection come from the same module every
 * other Monaco surface uses.
 */

import React, { useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Documents } from 'shell';
import { MonacoEditor, detectLanguage } from 'shared/modules/monaco';

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const containerStyle: CSSProperties = {
	flex: 1,
	minHeight: 0,
	display: 'flex',
	overflow: 'hidden',
};

interface Props {
	docs: Documents;
	uri: string;
	content: string;
	readOnly?: boolean;
}

export const MonacoViewer: React.FC<Props> = ({ docs, uri, content, readOnly }) => {
	const language = useMemo(() => detectLanguage(uri), [uri]);

	const handleChange = useCallback(
		(value: string) => {
			docs.updateContent(uri, value);
		},
		[docs, uri],
	);

	return (
		<div style={containerStyle}>
			<MonacoEditor value={content} language={language} onChange={handleChange} options={{ readOnly }} />
		</div>
	);
};
