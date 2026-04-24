// =============================================================================
// Trace Renderer: Video Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface VideoData {
	action: number;
	bufferSize?: number;
	mimeType?: string;
}

const ACTION_NAMES: Record<number, string> = {
	0: 'Begin',
	1: 'Write',
	2: 'End',
};

export function isVideo(data: unknown): data is VideoData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return typeof d.action === 'number';
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryVideo(data: VideoData): string {
	const label = ACTION_NAMES[data.action] ?? `Action ${data.action}`;
	if (data.action === 1 && data.bufferSize != null && data.bufferSize > 0) return `${label} ${(data.bufferSize / 1024).toFixed(0)} KB`;
	return label;
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderVideo(data: VideoData): ReactElement {
	const actionName = ACTION_NAMES[data.action] ?? `Action ${data.action}`;

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Action</span>
				<span style={RS.kvVal}>{actionName}</span>
			</div>
			{data.mimeType && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Type</span>
					<span style={RS.kvMono}>{data.mimeType}</span>
				</div>
			)}
			{data.bufferSize != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Buffer</span>
					<span style={RS.kvMono}>{data.bufferSize === 0 ? '0 bytes' : `${(data.bufferSize / 1024).toFixed(0)} KB`}</span>
				</div>
			)}
		</div>
	);
}
