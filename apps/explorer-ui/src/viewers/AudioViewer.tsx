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
// AUDIO VIEWER — streams audio via a presigned URL from fsGetUrl
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RocketRideClient } from 'rocketride';
import { viewerStyles } from './styles';

const styles = {
	container: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 24,
		padding: 32,
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,
	label: {
		fontSize: 16,
		fontWeight: 500,
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	audio: {
		width: '100%',
		maxWidth: 500,
		outline: 'none',
	} as CSSProperties,
};

interface Props {
	client: RocketRideClient;
	uri: string;
}

export const AudioViewer: React.FC<Props> = ({ client, uri }) => {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileName = uri.includes('/') ? uri.substring(uri.lastIndexOf('/') + 1) : uri;

	useEffect(() => {
		setUrl(null);
		setError(null);
		let cancelled = false;
		client.fsGetUrl(uri)
			.then((u) => { if (!cancelled) setUrl(u); })
			.catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; };
	}, [client, uri]);

	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!url) return <div style={viewerStyles.message}>Loading audio...</div>;
	return (
		<div style={styles.container}>
			<span style={styles.label}>{fileName}</span>
			<audio src={url} controls style={styles.audio} />
		</div>
	);
};
