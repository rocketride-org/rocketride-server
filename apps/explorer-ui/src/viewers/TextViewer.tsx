// =============================================================================
// TEXT VIEWER — editable textarea for plain text files
// =============================================================================

import React, { useCallback } from 'react';
import type { CSSProperties } from 'react';
import type { Documents } from 'shell-ui';

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
