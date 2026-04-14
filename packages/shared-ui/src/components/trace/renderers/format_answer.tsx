// =============================================================================
// Shared answer rendering — used by render_answer and render_invoke (LLM Ask output)
// =============================================================================

import React, { ReactElement } from 'react';
import { RS } from './styles';
import { JsonTree } from '../JsonTree';

export interface AnswerFields {
	answer?: string | Record<string, unknown> | unknown[];
	expectJson?: boolean;
	tokens?: Record<string, number | string>;
}

/** Short summary string for the collapsed row — first line of the answer. */
export function summaryAnswerFields(a: AnswerFields | null | undefined): string {
	if (!a?.answer) return '';
	const s = typeof a.answer === 'string' ? a.answer : JSON.stringify(a.answer);
	return s.length > 60 ? s.slice(0, 60) + '\u2026' : s;
}

/** Render an Answer payload using the shared format. */
export function renderAnswerFields(a: AnswerFields | null | undefined): ReactElement | null {
	if (!a) return null;

	const answer = a.answer;
	const isStringAnswer = typeof answer === 'string';

	// If flagged as JSON string, try to parse for the tree view
	let parsedJson: unknown = null;
	if (isStringAnswer && a.expectJson) {
		try {
			parsedJson = JSON.parse(answer as string);
		} catch {
			/* render as plain text */
		}
	} else if (!isStringAnswer && answer != null) {
		parsedJson = answer;
	}
	const isJson = parsedJson !== null;

	return (
		<div>
			{answer != null && (
				<div style={RS.section}>
					<div style={RS.label}>Answer{isJson ? ' (JSON)' : ''}</div>
					<div style={RS.sectionContent}>
						{isJson ? (
							<JsonTree data={parsedJson} defaultExpanded={1} />
						) : (
							<>
								<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{answer as string}</div>
								<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>
									{(answer as string).length.toLocaleString()} chars {'\u00B7'} ~{(answer as string).split(/\s+/).length} words
								</div>
							</>
						)}
					</div>
				</div>
			)}

			{a.tokens && Object.keys(a.tokens).length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Tokens</div>
					<div style={RS.sectionContent}>
						<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
							{Object.entries(a.tokens).map(([k, v]) => (
								<div key={k} style={{ backgroundColor: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 4, padding: '4px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 55 }}>
									<span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: 'var(--rr-brand)' }}>{typeof v === 'number' ? v.toLocaleString() : v}</span>
									<span style={{ fontSize: 8, color: 'var(--rr-text-secondary)', textTransform: 'uppercase' }}>{k.replace(/_/g, ' ')}</span>
								</div>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
