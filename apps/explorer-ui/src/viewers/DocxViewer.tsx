// =============================================================================
// DOCX VIEWER — renders Word documents using docx-preview
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { renderAsync } from 'docx-preview';
import { viewerStyles } from './styles';

const styles = {
	container: {
		flex: 1,
		overflow: 'auto',
		backgroundColor: '#fff',
	} as CSSProperties,
};

interface Props {
	/** Blob URL pointing to the .docx data. */
	content: string;
}

export const DocxViewer: React.FC<Props> = ({ content }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
		if (containerRef.current) containerRef.current.innerHTML = '';
		if (!containerRef.current || !content) return;
		let cancelled = false;

		(async () => {
			try {
				const response = await fetch(content);
				const data = await response.arrayBuffer();
				if (cancelled || !containerRef.current) return;
				containerRef.current.innerHTML = '';
				await renderAsync(data, containerRef.current, undefined, {
					inWrapper: true,
					ignoreWidth: false,
					ignoreHeight: true,
				});
			} catch {
				if (!cancelled) setError('Failed to render document.');
			}
		})();

		return () => { cancelled = true; };
	}, [content]);

	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!content) return <div style={viewerStyles.message}>Loading document...</div>;
	return <div ref={containerRef} style={styles.container} />;
};
