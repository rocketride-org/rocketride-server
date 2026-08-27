/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React, { useEffect, useRef } from 'react';
import { openWhepStream } from 'rocketride';

interface WhepPlayerProps {
	/** WHEP url the engine announced for this live stream. */
	url: string;
	kind: 'audio' | 'video';
	className?: string;
	label?: string;
}

/** Plays a live WHEP stream: opens the RTCPeerConnection and attaches the MediaStream. */
export const WhepPlayer: React.FC<WhepPlayerProps> = ({ url, kind, className, label }) => {
	const elRef = useRef<HTMLMediaElement | null>(null);

	useEffect(() => {
		let closer: (() => void) | undefined;
		let cancelled = false;
		openWhepStream(url)
			.then(({ stream, close }) => {
				closer = close;
				if (cancelled) return close();
				if (elRef.current) elRef.current.srcObject = stream;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
			closer?.();
		};
	}, [url]);

	return kind === 'video' ? (
		<video ref={el => { elRef.current = el; }} autoPlay muted playsInline controls className={className} aria-label={label} />
	) : (
		<audio ref={el => { elRef.current = el; }} autoPlay muted playsInline controls className={className} aria-label={label} />
	);
};
