// =============================================================================
// SPREADSHEET VIEWER — renders Excel/CSV files using SheetJS
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import * as XLSX from 'xlsx';
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
}

export const SpreadsheetViewer: React.FC<Props> = ({ content }) => {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
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
				setHtml(XLSX.utils.sheet_to_html(sheet, { id: 'rr-sheet' }));
			} catch {
				if (!cancelled) setError('Failed to render spreadsheet.');
			}
		})();

		return () => { cancelled = true; };
	}, [content]);

	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!html) return <div style={viewerStyles.message}>Loading spreadsheet...</div>;
	return <div style={styles.container} dangerouslySetInnerHTML={{ __html: html }} />;
};
