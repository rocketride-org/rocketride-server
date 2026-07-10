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
}

export const PdfViewer: React.FC<Props> = ({ content, uri }) => {
	if (!content) return <div style={viewerStyles.message}>Loading PDF...</div>;
	return <iframe src={content} style={styles.frame} title={uri} />;
};
