// =============================================================================
// Trace Renderer: Text Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface TextData {
	text: string;
	length?: number;
}

export function isText(data: unknown): data is TextData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return typeof d.text === 'string';
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryText(data: TextData): string {
	return data.text;
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderText(data: TextData): ReactElement {
	return (
		<div>
			<div style={RS.section}>
				<div style={RS.label}>Text</div>
				<div style={RS.sectionContent}>
					<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-yellow)' }}>{data.text}</div>
					<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>
						{(data.length ?? data.text.length).toLocaleString()} chars
						{' \u00B7 '}~{data.text.split(/\s+/).length} words
					</div>
				</div>
			</div>
		</div>
	);
}
