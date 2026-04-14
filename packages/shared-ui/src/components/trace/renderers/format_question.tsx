// =============================================================================
// Shared question rendering — used by render_question and render_invoke (LLM Ask)
// =============================================================================

import React, { ReactElement } from 'react';
import { RS } from './styles';
import { CollapsibleSection } from './utils';

export interface QuestionFields {
	type?: string;
	role?: string;
	expectJson?: boolean;
	questions?: Array<{ text?: string; embedding_model?: string }>;
	goals?: string[];
	instructions?: Array<{ subtitle?: string; instructions?: string }>;
	context?: string[];
	history?: Array<{ role?: string; content?: string }>;
	examples?: Array<{ given?: string; result?: string }>;
	documents?: unknown[];
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s;
}

/** Short summary string for the collapsed row — first question text or role. */
export function summaryQuestionFields(q: QuestionFields | null | undefined): string {
	if (!q) return '';
	if (Array.isArray(q.questions) && q.questions.length > 0 && q.questions[0]?.text) {
		return truncate(q.questions[0].text, 60);
	}
	if (q.role) return truncate(q.role, 60);
	return '';
}

/** Render a Question payload using the shared format. */
export function renderQuestionFields(q: QuestionFields | null | undefined): ReactElement | null {
	if (!q) return null;

	return (
		<div>
			{q.expectJson && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Format</span>
					<span style={RS.kvVal}>JSON expected</span>
				</div>
			)}

			{q.role && (
				<div style={{ ...RS.kvRow, marginBottom: 6 }}>
					<span style={RS.kvKey}>Role</span>
					<span style={RS.kvVal}>{q.role}</span>
				</div>
			)}

			{Array.isArray(q.goals) && q.goals.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Goal{q.goals.length > 1 ? 's' : ''}</div>
					<div style={RS.sectionContent}>
						{q.goals.map((g, i) => (
							<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-blue)' }}>
								{g}
							</div>
						))}
					</div>
				</div>
			)}

			{Array.isArray(q.questions) && q.questions.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Question{q.questions.length > 1 ? 's' : ''}</div>
					<div style={RS.sectionContent}>
						{q.questions.map((qt, i) =>
							qt?.text ? (
								<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-purple)' }}>
									{qt.text}
								</div>
							) : null
						)}
					</div>
				</div>
			)}

			{Array.isArray(q.instructions) && q.instructions.length > 0 && (
				<CollapsibleSection label={`Instructions (${q.instructions.length})`}>
					{q.instructions.map((inst, i) => (
						<div key={i} style={{ marginBottom: 6, marginTop: i > 0 ? 8 : 0 }}>
							{inst?.subtitle != null && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--rr-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{String(inst.subtitle)}</div>}
							{inst?.instructions != null && <div style={{ ...RS.textBlock, fontSize: 11, maxHeight: 100, marginLeft: 10, borderLeft: '3px solid var(--rr-chart-yellow)' }}>{String(inst.instructions).trim()}</div>}
						</div>
					))}
				</CollapsibleSection>
			)}

			{Array.isArray(q.context) && q.context.length > 0 && (
				<CollapsibleSection label={`Context (${q.context.length})`}>
					{q.context.map((ctx, i) => (
						<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)', maxHeight: 150 }}>
							{String(ctx)}
						</div>
					))}
				</CollapsibleSection>
			)}

			{Array.isArray(q.history) && q.history.length > 0 && (
				<CollapsibleSection label={`History (${q.history.length})`}>
					{q.history.map((h, i) => (
						<div key={i} style={RS.kvRow}>
							<span style={{ ...RS.kvKey, fontWeight: 600 }}>{String(h?.role || 'message')}</span>
							<span style={RS.kvVal}>{truncate(String(h?.content || ''), 200)}</span>
						</div>
					))}
				</CollapsibleSection>
			)}

			{Array.isArray(q.examples) && q.examples.length > 0 && (
				<CollapsibleSection label={`Examples (${q.examples.length})`}>
					{q.examples.map((ex, i) => (
						<div key={i} style={{ fontSize: 11, padding: '2px 0' }}>
							<span style={{ color: 'var(--rr-text-secondary)' }}>Given:</span> {ex?.given}
							<span style={{ color: 'var(--rr-text-secondary)', margin: '0 4px' }}>{'\u2192'}</span>
							{truncate(String(ex?.result || ''), 80)}
						</div>
					))}
				</CollapsibleSection>
			)}

			{Array.isArray(q.documents) && q.documents.length > 0 && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Documents</span>
					<span style={RS.kvVal}>{q.documents.length}</span>
				</div>
			)}
		</div>
	);
}
