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
// PDF VIEWER — displays PDFs in an iframe from a blob URL
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { viewerStyles } from './styles';

const styles = {
	frame: {
		flex: 1,
		width: '100%',
		border: 'none',
	} as CSSProperties,
};

interface Props {
	/** Blob URL pointing to the PDF data. */
	content: string;
	uri: string;
	/** Failure message when the blob could not be loaded (empty content otherwise). */
	error?: string;
}

export const PdfViewer: React.FC<Props> = ({ content, uri, error }) => {
	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!content) return <div style={viewerStyles.message}>Loading PDF...</div>;
	return <iframe src={content} style={styles.frame} title={uri} />;
};
