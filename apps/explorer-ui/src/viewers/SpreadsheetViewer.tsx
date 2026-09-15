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
// SPREADSHEET VIEWER — renders Excel/CSV files using SheetJS
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import * as XLSX from 'xlsx';
import DOMPurify from 'dompurify';
import { viewerStyles } from './styles';

const styles = {
	container: {
		flex: 1,
		overflow: 'auto',
		padding: 16,
		backgroundColor: 'var(--rr-bg-paper)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 13,
	} as CSSProperties,
};

interface Props {
	/** Blob URL pointing to the spreadsheet data. */
	content: string;
	/** Upstream failure message when the blob could not be loaded (empty content otherwise). */
	loadError?: string;
}

export const SpreadsheetViewer: React.FC<Props> = ({ content, loadError }) => {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setHtml(null);
		setError(null);
		if (!content) return;
		let cancelled = false;

		(async () => {
			try {
				const response = await fetch(content);
				const data = await response.arrayBuffer();
				if (cancelled) return;
				const workbook = XLSX.read(data, { type: 'array' });
				const sheet = workbook.Sheets[workbook.SheetNames[0]];
				if (!sheet) { setError('No sheets found.'); return; }
				// `sanitizeLinks` strips unsafe `javascript:` URLs from workbook data (CVE-2026-44549);
				// it is a valid runtime option but absent from the bundled xlsx type defs, hence the cast.
				const htmlOpts = { id: 'rr-sheet', sanitizeLinks: true } as XLSX.Sheet2HTMLOpts;
				const rawHtml = XLSX.utils.sheet_to_html(sheet, htmlOpts);
				setHtml(DOMPurify.sanitize(rawHtml));
			} catch {
				if (!cancelled) setError('Failed to render spreadsheet.');
			}
		})();

		return () => { cancelled = true; };
	}, [content]);

	// Upstream load failure wins over any local render error and over "Loading...".
	if (loadError) return <div style={viewerStyles.message}>{loadError}</div>;
	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!html) return <div style={viewerStyles.message}>Loading spreadsheet...</div>;
	return <div style={styles.container} dangerouslySetInnerHTML={{ __html: html }} />;
};
