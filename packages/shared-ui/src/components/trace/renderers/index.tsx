// =============================================================================
// Trace Data Renderer — dispatches by lane, validates with type guards
// =============================================================================

import { ReactElement } from 'react';
import { isQuestion, renderQuestion, summaryQuestion } from './render_question';
import { isAnswer, renderAnswer, summaryAnswer } from './render_answer';
import { isDocument, renderDocument, summaryDocument } from './render_document';
import { isText, renderText, summaryText } from './render_text';
import { isVideo, renderVideo, summaryVideo } from './render_video';
import { isAudio, renderAudio, summaryAudio } from './render_audio';
import { isImage, renderImage, summaryImage } from './render_image';
import { isTable, renderTable, summaryTable } from './render_table';
import { isInvoke, renderInvokeInput, renderInvokeOutput, summaryInvokeInput, summaryInvokeOutput } from './render_invoke';
import { DiffView, diffObjects, summaryDiff } from './utils';

// =============================================================================
// INPUT SUMMARY — short string for collapsed row display
// =============================================================================

export function summaryTraceInput(data: unknown, lane: string): string {
	if (!data || typeof data !== 'object') return '';
	const l = lane.toLowerCase();

	switch (l) {
		case 'questions':
			return isQuestion(data) ? summaryQuestion(data) : '';
		case 'answers':
			return isAnswer(data) ? summaryAnswer(data) : '';
		case 'documents':
			return isDocument(data) ? summaryDocument(data) : '';
		case 'text':
			return isText(data) ? summaryText(data) : '';
		case 'video':
			return isVideo(data) ? summaryVideo(data) : '';
		case 'audio':
			return isAudio(data) ? summaryAudio(data) : '';
		case 'image':
			return isImage(data) ? summaryImage(data) : '';
		case 'table':
			return isTable(data) ? summaryTable(data) : '';
		case 'invoke':
			return isInvoke(data) ? summaryInvokeInput(data) : '';
		default:
			return '';
	}
}

// =============================================================================
// OUTPUT SUMMARY — short string for collapsed output row
// =============================================================================

export function summaryTraceOutput(data: unknown, lane: string, inputData?: unknown): string {
	if (!data || typeof data !== 'object') return '';
	const l = lane.toLowerCase();

	// Invoke has type-specific output summaries
	if (l === 'invoke' && isInvoke(data)) {
		return summaryInvokeOutput(data, inputData);
	}

	// Default: diff summary
	const { entries, total } = diffObjects(inputData, data);
	return summaryDiff(entries, total);
}

// =============================================================================
// INPUT RENDERER — typed renderer per lane
// =============================================================================

export function renderTraceInput(data: unknown, lane: string): ReactElement | null {
	if (!data || typeof data !== 'object') return null;
	const l = lane.toLowerCase();

	switch (l) {
		case 'questions':
			return isQuestion(data) ? renderQuestion(data) : null;
		case 'answers':
			return isAnswer(data) ? renderAnswer(data) : null;
		case 'documents':
			return isDocument(data) ? renderDocument(data) : null;
		case 'text':
			return isText(data) ? renderText(data) : null;
		case 'video':
			return isVideo(data) ? renderVideo(data) : null;
		case 'audio':
			return isAudio(data) ? renderAudio(data) : null;
		case 'image':
			return isImage(data) ? renderImage(data) : null;
		case 'table':
			return isTable(data) ? renderTable(data) : null;
		case 'invoke':
			return isInvoke(data) ? renderInvokeInput(data) : null;
		default:
			return null;
	}
}

// =============================================================================
// OUTPUT RENDERER — diff view by default, invoke overrides
// =============================================================================

export function renderTraceOutput(data: unknown, lane: string, inputData?: unknown): ReactElement | null {
	if (!data || typeof data !== 'object') return null;
	const l = lane.toLowerCase();

	// Invoke has type-specific output renderers
	if (l === 'invoke' && isInvoke(data)) {
		return renderInvokeOutput(data, inputData);
	}

	// Default: DiffView comparing input to output
	return DiffView({ before: inputData, after: data });
}

// =============================================================================
// BACKWARD COMPAT ALIASES
// =============================================================================

/** Alias for renderTraceInput — used by hasTreeView check. */
export const renderTraceData = renderTraceInput;

/** Alias for summaryTraceInput — used by collapsed row summary. */
export const summaryTraceData = summaryTraceInput;
