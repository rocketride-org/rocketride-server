// =============================================================================
// Trace Renderer: Answer Lane
// =============================================================================

import { ReactElement } from 'react';
import { renderAnswerFields, summaryAnswerFields, AnswerFields } from './format_answer';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface AnswerData {
	answers: AnswerFields;
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
	return summaryAnswerFields(data.answers);
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderAnswer(data: AnswerData): ReactElement | null {
	return renderAnswerFields(data.answers);
}
