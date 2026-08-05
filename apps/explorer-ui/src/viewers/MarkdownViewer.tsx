// =============================================================================
// MARKDOWN VIEWER — rendered markdown via shared MarkdownRenderer
// =============================================================================

import React from 'react';
import { MarkdownRenderer } from 'shared';
import { viewerStyles } from './styles';

interface Props {
	content: string;
}

export const MarkdownViewer: React.FC<Props> = ({ content }) => (
	<div style={viewerStyles.prose}>
		<MarkdownRenderer content={content} />
	</div>
);
