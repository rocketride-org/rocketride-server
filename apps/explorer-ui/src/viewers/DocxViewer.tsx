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
	/** Upstream failure message when the blob could not be loaded (empty content otherwise). */
	loadError?: string;
}

export const DocxViewer: React.FC<Props> = ({ content, loadError }) => {
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

	// Upstream load failure wins over any local render error and over "Loading...".
	if (loadError) return <div style={viewerStyles.message}>{loadError}</div>;
	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!content) return <div style={viewerStyles.message}>Loading document...</div>;
	return <div ref={containerRef} style={styles.container} />;
};
