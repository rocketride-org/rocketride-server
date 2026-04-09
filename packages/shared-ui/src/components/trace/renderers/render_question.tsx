// =============================================================================
// Trace Renderer: Question Lane
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface QuestionData {
	questions: {
		type?: string;
		questions?: Array<{ text?: string; embedding_model?: string }>;
		history?: Array<{ role: string; content: string }>;
		instructions?: Array<{ subtitle: string; instructions: string }>;
		examples?: Array<{ given: string; result: string }>;
		goals?: string[];
		context?: string[];
		documents?: unknown[];
		role?: string;
		expectJson?: boolean;
		filter?: Record<string, unknown>;
	};
}

export function isQuestion(data: unknown): data is QuestionData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	if (!d.questions || typeof d.questions !== 'object') return false;
	return true;
}

// =============================================================================
// SUMMARY
// =============================================================================

export function summaryQuestion(data: QuestionData): string {
	const qs = data.questions.questions;
	if (Array.isArray(qs) && qs.length > 0 && qs[0].text) return qs[0].text;
	return '';
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderQuestion(data: QuestionData): ReactElement {
	const q = data.questions;
	const questions = q.questions || [];
	const history = q.history || [];
	const instructions = q.instructions || [];
	const examples = q.examples || [];
	const goals = q.goals || [];
	const context = q.context || [];
	const documents = q.documents || [];

	return (
		<div>
			{questions.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Question{questions.length > 1 ? 's' : ''}</div>
					<div style={RS.sectionContent}>
						{questions.map((qt, i) =>
							qt.text ? (
								<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-purple)' }}>
									{qt.text}
								</div>
							) : null
						)}
					</div>
				</div>
			)}
			{history.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>History ({history.length})</div>
					<div style={RS.sectionContent}>
						{history.map((h, i) => (
							<div key={i} style={RS.historyItem}>
								<span style={RS.historyRole}>
									{h.role === 'user' ? '\u{1F464}' : '\u{1F916}'} {h.role}:
								</span>
								{h.content.length > 120 ? h.content.slice(0, 120) + '\u2026' : h.content}
							</div>
						))}
					</div>
				</div>
			)}
			{instructions.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Instructions ({instructions.length})</div>
					<div style={RS.sectionContent}>
						{instructions.map((inst, i) => (
							<div key={i} style={{ fontSize: 11, padding: '1px 0' }}>
								<span style={{ fontWeight: 600 }}>{inst.subtitle}:</span> {inst.instructions.length > 100 ? inst.instructions.slice(0, 100) + '\u2026' : inst.instructions}
							</div>
						))}
					</div>
				</div>
			)}
			{examples.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Examples ({examples.length})</div>
					<div style={RS.sectionContent}>
						{examples.map((ex, i) => (
							<div key={i} style={{ fontSize: 11, padding: '1px 0' }}>
								<span style={{ color: 'var(--rr-text-secondary)' }}>Given:</span> {ex.given} <span style={{ color: 'var(--rr-text-secondary)', margin: '0 4px' }}>{'\u2192'}</span> {ex.result.length > 60 ? ex.result.slice(0, 60) + '\u2026' : ex.result}
							</div>
						))}
					</div>
				</div>
			)}
			{goals.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Goals ({goals.length})</div>
					<div style={RS.sectionContent}>
						{goals.map((g, i) => (
							<div key={i} style={{ fontSize: 11, padding: '1px 0' }}>
								{g}
							</div>
						))}
					</div>
				</div>
			)}
			{context.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Context ({context.length})</div>
					<div style={RS.sectionContent}>
						{context.map((c, i) => (
							<div key={i} style={{ fontSize: 11, padding: '1px 0' }}>
								{c.length > 100 ? c.slice(0, 100) + '\u2026' : c}
							</div>
						))}
					</div>
				</div>
			)}
			{documents.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Documents ({documents.length})</div>
				</div>
			)}
			<div style={RS.section}>
				{q.type && (
					<div style={RS.kvRow}>
						<span style={RS.kvKey}>Type</span>
						<span style={RS.kvVal}>{q.type}</span>
					</div>
				)}
				{q.role && (
					<div style={RS.kvRow}>
						<span style={RS.kvKey}>Role</span>
						<span style={RS.kvVal}>{q.role}</span>
					</div>
				)}
				{q.expectJson && (
					<div style={RS.kvRow}>
						<span style={RS.kvKey}>Format</span>
						<span style={RS.kvVal}>JSON expected</span>
					</div>
				)}
			</div>
		</div>
	);
}
