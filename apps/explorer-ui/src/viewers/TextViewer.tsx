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
// TEXT VIEWER — editable textarea for plain text files
// =============================================================================

import React, { useCallback } from 'react';
import type { CSSProperties } from 'react';
import type { Documents } from 'shell';

const styles = {
	textarea: {
		flex: 1,
		width: '100%',
		resize: 'none',
		border: 'none',
		outline: 'none',
		padding: '12px 16px',
		fontSize: 13,
		lineHeight: '20px',
		fontFamily: 'var(--rr-font-mono, "Cascadia Code", Consolas, "Courier New", monospace)',
		backgroundColor: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		tabSize: 4,
		whiteSpace: 'pre',
		overflowWrap: 'normal',
		overflowX: 'auto',
		overflowY: 'auto',
		boxSizing: 'border-box',
	} as CSSProperties,
};

interface Props {
	docs: Documents;
	uri: string;
	content: string;
}

export const TextViewer: React.FC<Props> = ({ docs, uri, content }) => {
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			docs.updateContent(uri, e.target.value);
		},
		[docs, uri],
	);

	return (
		<textarea
			style={styles.textarea}
			value={content}
			onChange={handleChange}
			spellCheck={false}
			wrap="off"
		/>
	);
};
