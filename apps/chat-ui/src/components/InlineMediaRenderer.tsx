/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useEffect, useRef, useState } from 'react';
import { openWhepStream } from 'rocketride';
import { getClient } from '../hooks/clientSingleton';

interface InlineMediaRendererProps {
	/** FileStore path; the bytes are pulled over rrext_media. */
	path?: string | undefined;
	/** Pre-resolved data URI (base64 fallback — nothing to pull). */
	directUrl?: string | undefined;
	/** Live WHEP url — a WebRTC stream, attached via srcObject. */
	whepUrl?: string | undefined;
	mime?: string | undefined;
	name?: string | undefined;
}

type Source = { kind: 'loading' } | { kind: 'url'; url: string } | { kind: 'error'; message: string };

const categoryOf = (mime?: string): 'audio' | 'video' | 'image' | undefined => {
	if (mime?.startsWith('audio/')) return 'audio';
	if (mime?.startsWith('video/')) return 'video';
	if (mime?.startsWith('image/')) return 'image';
	return undefined;
};

/** Plays media produced by a pipeline: a live WHEP stream, or the produced file. */
export const InlineMediaRenderer: React.FC<InlineMediaRendererProps> = ({ path, directUrl, whepUrl, mime, name }) => {
	const label = name ?? path?.split('/').pop() ?? 'media';
	const category = categoryOf(mime);
	const [source, setSource] = useState<Source>(directUrl ? { kind: 'url', url: directUrl } : { kind: 'loading' });

	// Live WHEP: open the WebRTC stream and attach it via srcObject.
	const mediaRef = useRef<HTMLMediaElement | null>(null);
	const [whepFailed, setWhepFailed] = useState(false);
	useEffect(() => {
		if (!whepUrl) return;
		let closer: (() => void) | undefined;
		let cancelled = false;
		setWhepFailed(false);
		openWhepStream(whepUrl)
			.then(({ stream, close }) => {
				closer = close;
				if (cancelled) return close();
				if (mediaRef.current) mediaRef.current.srcObject = stream;
			})
			.catch(async (e: unknown) => {
				if (cancelled) return;
				// The live push may have died; the artifact is spooled to the store too, so fall
				// back to the persisted file instead of leaving a dead/empty player.
				const client = getClient();
				if (path && client) {
					try {
						const url = await client.mediaPlaybackUrl(path, mime);
						if (!cancelled) {
							setSource({ kind: 'url', url });
							setWhepFailed(true);
							return;
						}
					} catch {
						/* fall through to the error below */
					}
				}
				if (!cancelled) {
					setSource({ kind: 'error', message: e instanceof Error ? e.message : 'Live stream unavailable.' });
					setWhepFailed(true);
				}
			});
		return () => {
			cancelled = true;
			closer?.();
		};
	}, [whepUrl]);

	useEffect(() => {
		if (whepUrl || directUrl || !path) return;
		const client = getClient();
		if (!client) {
			setSource({ kind: 'error', message: 'Not connected — cannot load media.' });
			return;
		}

		let cancelled = false;
		let objectUrl: string | undefined;
		const controller = new AbortController();

		client
			.mediaPlaybackUrl(path, mime, controller.signal)
			.then(url => {
				objectUrl = url;
				if (!cancelled) setSource({ kind: 'url', url });
			})
			.catch((e: unknown) => {
				if (!cancelled) setSource({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to load media.' });
			});

		return () => {
			cancelled = true;
			controller.abort();  // close the pull so the server-side media handle is released
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path, directUrl, whepUrl, mime]);

	if (whepUrl && !whepFailed) {
		return (
			<div className={`inline-media inline-media-${category ?? 'file'}`}>
				{category === 'video' && (
					<video ref={el => { mediaRef.current = el; }} className="inline-media-video" autoPlay muted playsInline controls />
				)}
				{category === 'audio' && (
					<audio ref={el => { mediaRef.current = el; }} className="inline-media-audio" autoPlay muted playsInline controls />
				)}
				<div className="inline-media-footer">
					<span className="inline-media-name">{label}</span>
				</div>
			</div>
		);
	}

	if (source.kind === 'loading') {
		return (
			<div className="inline-media inline-media-loading">
				<span className="inline-media-name">{label}</span>
				<span className="inline-media-spinner" />
			</div>
		);
	}

	if (source.kind === 'error') {
		return (
			<div className="inline-media inline-media-error">
				<span className="inline-media-name">{label}</span>
				<span className="inline-media-errortext">{source.message}</span>
			</div>
		);
	}

	return (
		<div className={`inline-media inline-media-${category ?? 'file'}`}>
			{category === 'video' && <video className="inline-media-video" src={source.url} controls preload="metadata" />}
			{category === 'audio' && <audio className="inline-media-audio" src={source.url} controls preload="metadata" />}
			{category === 'image' && <img className="inline-media-image" src={source.url} alt={label} />}
			<div className="inline-media-footer">
				<span className="inline-media-name">{label}</span>
			</div>
		</div>
	);
};
