// =============================================================================
// IMAGE VIEWER — displays images from a blob URL
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { viewerStyles } from './styles';

const styles = {
	image: {
		maxWidth: '100%',
		maxHeight: '100%',
		objectFit: 'contain',
		borderRadius: 4,
	} as CSSProperties,
};

interface Props {
	/** Blob URL pointing to the image data. */
	content: string;
	uri: string;
}

export const ImageViewer: React.FC<Props> = ({ content, uri }) => {
	if (!content) return <div style={viewerStyles.message}>Loading image...</div>;
	return (
		<div style={viewerStyles.mediaContainer}>
			<img src={content} alt={uri} style={styles.image} />
		</div>
	);
};
