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
