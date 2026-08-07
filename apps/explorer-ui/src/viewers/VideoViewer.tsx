// =============================================================================
// VIDEO VIEWER — streams video via a presigned URL from fsGetUrl
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RocketRideClient } from 'rocketride';
import { viewerStyles } from './styles';

const styles = {
	video: {
		maxWidth: '100%',
		maxHeight: '100%',
		borderRadius: 4,
		outline: 'none',
	} as CSSProperties,
};

interface Props {
	client: RocketRideClient;
	uri: string;
}

export const VideoViewer: React.FC<Props> = ({ client, uri }) => {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

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
	if (!url) return <div style={viewerStyles.message}>Loading video...</div>;
	return (
		<div style={viewerStyles.mediaContainer}>
			<video src={url} controls style={styles.video} />
		</div>
	);
};
