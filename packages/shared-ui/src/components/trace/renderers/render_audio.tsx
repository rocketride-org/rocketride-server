// =============================================================================
// Trace Renderer: Audio Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface AudioStreamData {
	action: number;
	bufferSize?: number;
	mimeType?: string;
}

interface AudioMetaData {
	format?: string;
	duration_seconds?: number;
	sample_rate?: number;
	channels?: number;
	file_size?: number;
}

type AudioData = AudioStreamData | AudioMetaData;

export function isAudio(data: unknown): data is AudioData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	// Stream format
	if (typeof d.action === 'number') return true;
	// Metadata format
	if (typeof d.format === 'string' || typeof d.duration_seconds === 'number') return true;
	return false;
}

// =============================================================================
// SUMMARY
// =============================================================================

const AUDIO_ACTIONS: Record<number, string> = { 0: 'Begin', 1: 'Write', 2: 'End' };

export function summaryAudio(data: AudioData): string {
	if ('action' in data && typeof data.action === 'number') {
		const label = AUDIO_ACTIONS[data.action] ?? `Action ${data.action}`;
		if (data.action === 1 && data.bufferSize != null && data.bufferSize > 0) return `${label} ${(data.bufferSize / 1024).toFixed(0)} KB`;
		return label;
	}
	const meta = data as AudioMetaData;
	if (meta.format && meta.duration_seconds != null) return `${meta.format} ${Math.floor(meta.duration_seconds / 60)}m ${Math.round(meta.duration_seconds % 60)}s`;
	if (meta.format) return meta.format;
	return '';
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderAudio(data: AudioData): ReactElement {
	if ('action' in data && typeof data.action === 'number') {
		const d = data as AudioStreamData;
		const actionName = AUDIO_ACTIONS[d.action] ?? `Action ${d.action}`;
		return (
			<div>
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Action</span>
					<span style={RS.kvVal}>{actionName}</span>
				</div>
				{d.mimeType && (
					<div style={RS.kvRow}>
						<span style={RS.kvKey}>Type</span>
						<span style={RS.kvMono}>{d.mimeType}</span>
					</div>
				)}
				{d.bufferSize != null && (
					<div style={RS.kvRow}>
						<span style={RS.kvKey}>Buffer</span>
						<span style={RS.kvMono}>{d.bufferSize === 0 ? '0 bytes' : `${(d.bufferSize / 1024).toFixed(0)} KB`}</span>
					</div>
				)}
			</div>
		);
	}

	const d = data as AudioMetaData;
	return (
		<div>
			{d.format && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Format</span>
					<span style={RS.kvVal}>{d.format}</span>
				</div>
			)}
			{d.duration_seconds != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Duration</span>
					<span style={RS.kvVal}>
						{Math.floor(d.duration_seconds / 60)}m {Math.round(d.duration_seconds % 60)}s
					</span>
				</div>
			)}
			{d.sample_rate != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Sample Rate</span>
					<span style={RS.kvVal}>{(d.sample_rate / 1000).toFixed(1)} kHz</span>
				</div>
			)}
			{d.channels != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Channels</span>
					<span style={RS.kvVal}>{d.channels === 2 ? 'Stereo' : d.channels === 1 ? 'Mono' : String(d.channels)}</span>
				</div>
			)}
			{d.file_size != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Size</span>
					<span style={RS.kvVal}>{(d.file_size / 1e6).toFixed(1)} MB</span>
				</div>
			)}
		</div>
	);
}
