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
