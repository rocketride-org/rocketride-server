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
	// Try to pretty-print; only valid JSON goes through the fenced markdown path.
	let pretty: string | null = null;
	try {
		pretty = JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		pretty = null;
	}

	// Invalid JSON: render the raw content in a plain <pre> so any triple-backtick
	// fences in the payload can't terminate a markdown code block early.
	if (pretty === null) {
		return (
			<div style={viewerStyles.prose}>
				<pre>{content}</pre>
			</div>
		);
	}

	return (
		<div style={viewerStyles.prose}>
			<MarkdownRenderer content={'```json\n' + pretty + '\n```'} />
		</div>
	);
};
