// =============================================================================
// Trace Renderer: Documents Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface DocumentEntry {
	page_content?: string;
	metadata?: Record<string, unknown>;
	embedding_model?: string;
	score?: number;
	tokens?: number;
}

interface DocumentData {
	documents: DocumentEntry | DocumentEntry[];
	count?: number;
}

export function isDocument(data: unknown): data is DocumentData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return d.documents != null && typeof d.documents === 'object';
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryDocument(data: DocumentData): string {
	const docs = Array.isArray(data.documents) ? data.documents : [data.documents];
	if (docs.length === 0) return '';
	const first = docs[0];
	const label = first.page_content || (first.metadata?.parent ? String(first.metadata.parent) : '');
	if (docs.length === 1) return label;
	return `${docs.length} documents`;
}

// =============================================================================
// RENDERER
// =============================================================================

function renderSingleDoc(doc: DocumentEntry, index: number, total: number): ReactElement {
	const content = doc.page_content;
	const metadata = doc.metadata;
	const embeddingModel = doc.embedding_model;
	const score = doc.score;
	const tokens = doc.tokens;

	return (
		<div key={index} style={total > 1 ? { marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--rr-border)' } : undefined}>
			{total > 1 && (
				<div style={{ fontSize: 9, fontWeight: 700, color: 'var(--rr-text-disabled)', textTransform: 'uppercase', marginBottom: 4 }}>
					Document {index + 1} of {total}
				</div>
			)}
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
			{metadata &&
				(() => {
					const m = metadata as Record<string, string | number | boolean | undefined>;
					return (
						<div style={RS.section}>
							<div style={RS.label}>Metadata</div>
							{m.parent && (
								<div style={RS.kvRow}>
									<span style={RS.kvKey}>Source</span>
									<span style={RS.kvVal}>{String(m.parent)}</span>
								</div>
							)}
							{m.objectId && (
								<div style={RS.kvRow}>
									<span style={RS.kvKey}>Object ID</span>
									<span style={RS.kvMono}>{String(m.objectId)}</span>
								</div>
							)}
							{m.chunkId != null && (
								<div style={RS.kvRow}>
									<span style={RS.kvKey}>Chunk</span>
									<span style={RS.kvVal}>{String(m.chunkId)}</span>
								</div>
							)}
							{m.nodeId && (
								<div style={RS.kvRow}>
									<span style={RS.kvKey}>Node</span>
									<span style={RS.kvMono}>{String(m.nodeId)}</span>
								</div>
							)}
							{m.isTable && (
								<div style={RS.kvRow}>
									<span style={RS.kvKey}>Type</span>
									<span style={RS.kvVal}>Table data</span>
								</div>
							)}
						</div>
					);
				})()}
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

export function renderDocument(data: DocumentData): ReactElement {
	const docs = Array.isArray(data.documents) ? data.documents : [data.documents];

	return (
		<div>
			{data.count != null && (
				<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginBottom: 6 }}>
					{data.count} document{data.count !== 1 ? 's' : ''}
				</div>
			)}
			{docs.map((doc, i) => renderSingleDoc(doc, i, docs.length))}
		</div>
	);
}
