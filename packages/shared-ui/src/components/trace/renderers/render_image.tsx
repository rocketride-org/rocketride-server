// =============================================================================
// Trace Renderer: Image Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface ImageStreamData {
	action: number;
	bufferSize?: number;
	mimeType?: string;
}

interface ImageMetaData {
	format?: string;
	width?: number;
	height?: number;
	file_size?: number;
}

type ImageData = ImageStreamData | ImageMetaData;

export function isImage(data: unknown): data is ImageData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	if (typeof d.action === 'number') return true;
	if (typeof d.format === 'string' || typeof d.width === 'number') return true;
	return false;
}

// =============================================================================
// SUMMARY
// =============================================================================

const IMAGE_ACTIONS: Record<number, string> = { 0: 'Begin', 1: 'Write', 2: 'End' };

export function summaryImage(data: ImageData): string {
	if ('action' in data && typeof data.action === 'number') {
		const label = IMAGE_ACTIONS[data.action] ?? `Action ${data.action}`;
		if (data.action === 1 && data.bufferSize != null && data.bufferSize > 0) return `${label} ${(data.bufferSize / 1024).toFixed(0)} KB`;
		return label;
	}
	const meta = data as ImageMetaData;
	if (meta.format && meta.width && meta.height) return `${meta.format} ${meta.width}\u00D7${meta.height}`;
	if (meta.format) return meta.format;
	return '';
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderImage(data: ImageData): ReactElement {
	if ('action' in data && typeof data.action === 'number') {
		const d = data as ImageStreamData;
		const actionName = IMAGE_ACTIONS[d.action] ?? `Action ${d.action}`;
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

	const d = data as ImageMetaData;
	return (
		<div>
			{d.format && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Format</span>
					<span style={RS.kvVal}>{d.format}</span>
				</div>
			)}
			{d.width != null && d.height != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Size</span>
					<span style={RS.kvVal}>
						{d.width} {'\u00D7'} {d.height}
					</span>
				</div>
			)}
			{d.file_size != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>File Size</span>
					<span style={RS.kvVal}>{(d.file_size / 1e6).toFixed(1)} MB</span>
				</div>
			)}
		</div>
	);
}
