// =============================================================================
// Trace Renderer: Answer Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface AnswerData {
	answers: {
		answer?: string;
		expectJson?: boolean;
		tokens?: Record<string, number | string>;
	};
}

export function isAnswer(data: unknown): data is AnswerData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	if (!d.answers || typeof d.answers !== 'object') return false;
	return true;
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryAnswer(data: AnswerData): string {
	return data.answers.answer || '';
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderAnswer(data: AnswerData): ReactElement {
	const a = data.answers;

	return (
		<div>
			{a.answer && (
				<div style={RS.section}>
					<div style={RS.label}>Answer</div>
					<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{a.answer}</div>
					<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>
						{a.answer.length.toLocaleString()} chars {'\u00B7'} ~{a.answer.split(/\s+/).length} words
					</div>
				</div>
			)}
			{a.tokens && (
				<div style={RS.section}>
					<div style={RS.label}>Tokens</div>
					<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
						{Object.entries(a.tokens).map(([k, v]) => (
							<div key={k} style={{ backgroundColor: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 4, padding: '4px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 55 }}>
								<span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: 'var(--rr-brand)' }}>{typeof v === 'number' ? v.toLocaleString() : v}</span>
								<span style={{ fontSize: 8, color: 'var(--rr-text-secondary)', textTransform: 'uppercase' }}>{k.replace(/_/g, ' ')}</span>
							</div>
						))}
					</div>
				</div>
			)}
			{a.expectJson && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Format</span>
					<span style={RS.kvVal}>JSON expected</span>
				</div>
			)}
		</div>
	);
}
