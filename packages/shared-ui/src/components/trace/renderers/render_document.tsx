// =============================================================================
// Trace Renderer: Document Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface DocumentData {
	documents?: {
		page_content?: string;
		metadata?: Record<string, unknown>;
		embedding_model?: string;
		score?: number;
		tokens?: number;
	};
	page_content?: string;
	metadata?: Record<string, unknown>;
}

export function isDocument(data: unknown): data is DocumentData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	if (d.documents && typeof d.documents === 'object') return true;
	if (typeof d.page_content === 'string') return true;
	return false;
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryDocument(data: DocumentData): string {
	const doc = data.documents || data;
	if (doc.page_content) return doc.page_content;
	const meta = doc.metadata;
	if (meta?.parent) return String(meta.parent);
	return '';
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderDocument(data: DocumentData): ReactElement {
	const doc = data.documents || data;
	const content = doc.page_content;
	const metadata = doc.metadata;
	const embeddingModel = (doc as Record<string, unknown>).embedding_model as string | undefined;
	const score = (doc as Record<string, unknown>).score as number | undefined;
	const tokens = (doc as Record<string, unknown>).tokens as number | undefined;

	return (
		<div>
			{content && (
				<div style={RS.section}>
					<div style={RS.label}>Content</div>
					<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-purple)' }}>{content}</div>
					<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>
						{content.length.toLocaleString()} chars
						{tokens != null && (
							<span>
								{' '}
								{'\u00B7'} {tokens} tokens
							</span>
						)}
					</div>
				</div>
			)}
			{metadata && (
				<div style={RS.section}>
					<div style={RS.label}>Metadata</div>
					{metadata.parent && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Source</span>
							<span style={RS.kvVal}>{String(metadata.parent)}</span>
						</div>
					)}
					{metadata.objectId && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Object ID</span>
							<span style={RS.kvMono}>{String(metadata.objectId)}</span>
						</div>
					)}
					{metadata.chunkId != null && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Chunk</span>
							<span style={RS.kvVal}>{String(metadata.chunkId)}</span>
						</div>
					)}
					{metadata.nodeId && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Node</span>
							<span style={RS.kvMono}>{String(metadata.nodeId)}</span>
						</div>
					)}
					{metadata.isTable && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Type</span>
							<span style={RS.kvVal}>Table data</span>
						</div>
					)}
				</div>
			)}
			{embeddingModel && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Embedding</span>
					<span style={RS.kvVal}>{embeddingModel}</span>
				</div>
			)}
			{score != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Score</span>
					<span style={RS.kvMono}>{score.toFixed(4)}</span>
				</div>
			)}
		</div>
	);
}
