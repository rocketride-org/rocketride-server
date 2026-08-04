// =============================================================================
// Trace Renderer: Question Lane
// =============================================================================

import { ReactElement } from 'react';
import { renderQuestionFields, summaryQuestionFields, QuestionFields } from './format_question';

// =============================================================================
// TYPE GUARD
// =============================================================================

interface QuestionData {
	questions: QuestionFields;
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
	return summaryQuestionFields(data.questions);
}

// =============================================================================
// RENDERER
// =============================================================================

export function renderQuestion(data: QuestionData): ReactElement | null {
	return renderQuestionFields(data.questions);
}
