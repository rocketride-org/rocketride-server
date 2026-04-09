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

/**
 * Returns a short summary string for trace data, dispatched by lane.
 */
export function summaryTraceData(data: unknown, lane: string): string {
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
		default:
			return '';
	}
}

/**
 * Renders trace data using a lane-specific typed renderer.
 * Returns null if lane is unknown or data doesn't match expected shape.
 */
export function renderTraceData(data: unknown, lane: string): ReactElement | null {
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
		default:
			return null;
	}
}
