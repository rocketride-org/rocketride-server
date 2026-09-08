// =============================================================================
// Shared answer rendering — used by render_answer and render_invoke (LLM Ask output)
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';
import { JsonTree } from '../../json-tree';

/** One model call's token cost; the turn total carries a breakdown of these. */
export interface TokenCall {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
	model?: string;
}

/** Per-turn token usage: scalar totals plus a per-call breakdown for many-call turns. */
export interface TokenUsage {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
	model?: string;
	calls?: number;
	breakdown?: TokenCall[];
}

export interface AnswerFields {
	answer?: string | Record<string, unknown> | unknown[];
	expectJson?: boolean;
	tokens?: TokenUsage;
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

	// Only the scalar totals render here. Each model call carries its own usage on
	// its own invoke row, so repeating the whole breakdown under the answer is noise
	// (an 11-call agent run listed 11 blocks). `breakdown` is dropped, not rendered.
	const tokenScalars = a.tokens ? Object.entries(a.tokens).filter(([k]) => k !== 'breakdown') : [];

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

			{tokenScalars.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Tokens</div>
					<div style={RS.sectionContent}>
						<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
							{tokenScalars.map(([k, v]) => (
								<div key={k} style={{ backgroundColor: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)', borderRadius: 4, padding: '4px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 55 }}>
									<span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: 'var(--rr-brand)' }}>{typeof v === 'number' ? v.toLocaleString() : String(v)}</span>
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
