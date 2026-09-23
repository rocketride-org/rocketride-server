// =============================================================================
// Trace Renderer: Final-result media entry (shared by image/audio/video lanes)
// =============================================================================
//
// The response node emits one entry per media lane on END, uniformly shaped:
//   {mime_type, <lane>, metadata?}   base64 payload (develop + descriptor PR)
//   {mime_type, path}                spool path, bytes on disk (streaming PR)
// where <lane> is 'image' | 'audio' | 'video'. This module recognises that shape
// and renders a real <img>/<audio>/<video> from a data URL (base64 case) or a
// compact path row (path case) — instead of dumping the base64 into a JsonTree.

import { ReactElement } from 'react';
import { RS } from './styles';

export type MediaLane = 'image' | 'audio' | 'video';

export interface MediaResultData {
	mime_type: string;
	image?: string;
	audio?: string;
	video?: string;
	/** Spool path when bytes live on disk instead of inline base64. */
	path?: string;
	/** Descriptor-derived provenance detail; a small nested dict, never the payload. */
	metadata?: Record<string, unknown>;
}

/**
 * True when `data` is a final-result media entry for `lane`:
 * `{mime_type, <lane>|path, metadata?}`.
 *
 * Distinct from the AVI stream-trace shape (`{action, ...}`) and the metadata
 * shape (`{format, ...}`): those carry no `mime_type` + payload/path pair, so the
 * live-trace guards keep working unchanged.
 */
export function isMediaResult(data: unknown, lane: MediaLane): data is MediaResultData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	if (typeof d.mime_type !== 'string') return false;
	return typeof d[lane] === 'string' || typeof d.path === 'string';
}

/** A handful of human-useful scalar fields from the provenance metadata, capped. */
function metadataRows(metadata: Record<string, unknown>): ReactElement[] {
	const rows: ReactElement[] = [];
	for (const key of ['name', 'source_mime', 'width', 'height', 'size'] as const) {
		const value = metadata[key];
		if (value == null) continue;
		const text = typeof value === 'string' ? (value.length > 200 ? value.slice(0, 200) + '…' : value) : String(value);
		rows.push(
			<div style={RS.kvRow} key={key}>
				<span style={RS.kvKey}>{key === 'source_mime' ? 'Source' : key[0].toUpperCase() + key.slice(1)}</span>
				<span style={RS.kvVal}>{text}</span>
			</div>
		);
	}
	return rows;
}

/** Render the media element (base64 → data URL) or, for the path shape, a path row. */
function renderElement(lane: MediaLane, data: MediaResultData): ReactElement {
	const payload = data[lane];
	if (typeof payload === 'string') {
		const src = `data:${data.mime_type};base64,${payload}`;
		if (lane === 'image') return <img style={RS.media} src={src} alt="" />;
		if (lane === 'audio') return <audio style={RS.media} src={src} controls />;
		return <video style={RS.media} src={src} controls />;
	}
	// Path shape: bytes are on disk (server-side); the webview can't stream them here.
	return (
		<div style={RS.kvRow}>
			<span style={RS.kvKey}>Path</span>
			<span style={RS.kvMono}>{data.path}</span>
		</div>
	);
}

/** Render a final-result media entry: a player (or path) plus provenance rows. */
export function renderMediaResult(lane: MediaLane, data: MediaResultData): ReactElement {
	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvMono}>{data.mime_type}</span>
			</div>
			{data.metadata && metadataRows(data.metadata)}
			{renderElement(lane, data)}
		</div>
	);
}
