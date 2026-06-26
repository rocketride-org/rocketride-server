// =============================================================================
// JSON VIEWER — syntax-highlighted JSON via MarkdownRenderer
// =============================================================================

import React from 'react';
import { MarkdownRenderer } from 'shared';
import { viewerStyles } from './styles';

interface Props {
	content: string;
}

export const JsonViewer: React.FC<Props> = ({ content }) => {
	let pretty: string;
	try {
		pretty = JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		pretty = content;
	}

	return (
		<div style={viewerStyles.prose}>
			<MarkdownRenderer content={'```json\n' + pretty + '\n```'} />
		</div>
	);
};
