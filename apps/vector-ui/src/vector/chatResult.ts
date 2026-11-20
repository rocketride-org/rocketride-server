// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// VECTOR-UI — CHAT RESULTS (answer text and the chunks it cites)
// =============================================================================
//
// What the Chat source answers for one question (`client.chat`): a record
// whose `result_types` names its fields by type. `answers` carries the LLM's
// text; `documents` (the pipeline's response_documents node) carries the
// chunks the store retrieved for the question. The console shows the text
// and cites exactly those chunks, in the order the store ranked them.
//
// Pure: no platform imports, no state. The answer text is returned as
// written; src/chat/Markdown.tsx renders it safely.
// =============================================================================

import type { IChatSource, VectorKey } from '../contract/types';
import { CONTROL_OBJECT_ID } from '../contract/types';

/** How long the console waits for an answer. */
export const CHAT_TIMEOUT_MS = 120_000;

/** Longest question the console sends. */
export const CHAT_MAX_CHARS = 4_000;

/** Most citations kept from one answer. */
export const CHAT_MAX_SOURCES = 100;

/** What the local stub LLM puts before every answer. */
export const STUB_PREFIX = '[STUB-LLM]';

/** Shown when the console stops waiting. */
export const CHAT_TIMEOUT_SENTENCE = 'Stopped waiting after 120 s. The pipeline may still be answering; there is no way to cancel it from here.';

/** One answer, parsed. */
export interface ParsedChatAnswer {
	/** The answer text (Markdown, untrusted), '' when there is none. */
	text: string;
	/** True when the answer comes from the local stub LLM. */
	stub: boolean;
	/** The cited chunks, ranked as the store returned them. */
	sources: IChatSource[];
	/** True when the answer carried a documents field at all (the pipeline returns its sources). */
	hasDocumentsLane: boolean;
	/** True when there is neither text nor a source. */
	empty: boolean;
}

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Field names whose declared result type is one of `types`, in declaration order.
 *
 * @param wire - The answer.
 * @param types - The result types.
 * @param fallback - The field read when result_types names none.
 * @returns Field names.
 */
function fieldsOfType(wire: Record<string, unknown>, types: readonly string[], fallback: string): string[] {
	const declared = isRecord(wire.result_types) ? wire.result_types : null;
	if (declared !== null) {
		const named = Object.keys(declared).filter((key) => typeof declared[key] === 'string' && types.includes(declared[key] as string));
		if (named.length > 0) return named;
	}
	return Object.prototype.hasOwnProperty.call(wire, fallback) ? [fallback] : [];
}

/**
 * The text of one answer value.
 *
 * @param value - A string, an object (JSON answer) or a list of either.
 * @returns The parts, empty ones dropped.
 */
function answerParts(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (typeof value === 'string') return value.trim() === '' ? [] : [value];
	if (Array.isArray(value)) return value.flatMap((item) => answerParts(item));
	if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
	try {
		return ['```json\n' + JSON.stringify(value, null, 2) + '\n```'];
	} catch {
		return [];
	}
}

/**
 * A chunk id from metadata (a non-negative integer, possibly sent as a string).
 *
 * @param value - The raw value.
 * @returns The id, or null.
 */
function chunkIdOf(value: unknown): number | null {
	const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Parse one answer of the Chat source.
 *
 * @param wire - What `ask` resolved with.
 * @returns The text and citations; never throws.
 */
export function parseChatResult(wire: unknown): ParsedChatAnswer {
	if (!isRecord(wire)) return { text: '', stub: false, sources: [], hasDocumentsLane: false, empty: true };

	let answerFields = fieldsOfType(wire, ['answers'], 'answers');
	if (answerFields.length === 0) answerFields = fieldsOfType(wire, ['text'], 'text');
	const text = answerFields.flatMap((field) => answerParts(wire[field])).join('\n\n');

	const documentFields = fieldsOfType(wire, ['documents'], 'documents');
	const sources: IChatSource[] = [];
	const seen = new Set<string>();
	for (const field of documentFields) {
		const list = wire[field];
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (sources.length >= CHAT_MAX_SOURCES) break;
			if (!isRecord(item)) continue;
			const metadata = isRecord(item.metadata) ? item.metadata : {};
			const objectId = typeof metadata.objectId === 'string' ? metadata.objectId : '';
			const chunkId = chunkIdOf(metadata.chunkId);
			if (objectId === '' || objectId === CONTROL_OBJECT_ID || chunkId === null) continue;
			const id = `${objectId}\u0000${chunkId}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const key: VectorKey = [objectId, chunkId];
			sources.push({
				rank: sources.length + 1,
				key,
				objectId,
				chunkId,
				path: typeof metadata.parent === 'string' ? metadata.parent : '',
				score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
				text: typeof item.page_content === 'string' ? item.page_content : '',
			});
		}
	}

	return {
		text,
		stub: text.trimStart().startsWith(STUB_PREFIX),
		sources,
		hasDocumentsLane: documentFields.length > 0,
		empty: text === '' && sources.length === 0,
	};
}

/**
 * The header line over an answer's sources ("3 sources · 0.58 top").
 *
 * @param sources - The citations.
 * @returns The count, the top score (or null) and the line.
 */
export function summariseSources(sources: readonly IChatSource[]): { count: number; top: number | null; line: string } {
	const count = sources.length;
	if (count === 0) return { count, top: null, line: 'No sources returned' };
	const scores = sources.map((source) => source.score).filter((score): score is number => score !== null);
	const top = scores.length > 0 ? Math.max(...scores) : null;
	const noun = count === 1 ? '1 source' : `${count.toLocaleString('en-US')} sources`;
	return { count, top, line: top === null ? noun : `${noun} · ${top.toFixed(2)} top` };
}

/**
 * Check a question before it is sent.
 *
 * @param raw - What the user typed.
 * @returns The trimmed question, or why it cannot be sent.
 */
export function validateQuestion(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
	const text = (raw ?? '').trim();
	if (text === '') return { ok: false, reason: 'Type a question first.' };
	if (text.length > CHAT_MAX_CHARS) {
		return { ok: false, reason: `Questions are limited to ${CHAT_MAX_CHARS.toLocaleString('en-US')} characters; this one has ${text.length.toLocaleString('en-US')}.` };
	}
	return { ok: true, text };
}

/** How a failed question reads. `stale` results are dropped silently. */
export interface ChatErrorSentence {
	kind: 'timeout' | 'stale' | 'unavailable' | 'error';
	message: string;
	detail?: string;
}

/**
 * The fields of an explorer error, read without importing the class (it may
 * come from another bundle).
 *
 * @param error - Anything thrown.
 * @returns kind, headline and detail when it looks like one.
 */
function explorerError(error: unknown): { kind: string; headline: string; detail?: string } | null {
	if (!isRecord(error) && !(error instanceof Error)) return null;
	const record = error as unknown as Record<string, unknown>;
	if (typeof record.kind !== 'string' || typeof record.headline !== 'string') return null;
	return { kind: record.kind, headline: record.headline, ...(typeof record.detail === 'string' ? { detail: record.detail } : {}) };
}

/**
 * Turn whatever `ask` rejected with into the sentence the chat shows.
 *
 * @param error - The rejection.
 * @returns The sentence.
 */
export function chatErrorSentence(error: unknown): ChatErrorSentence {
	const explorer = explorerError(error);
	if (explorer !== null) {
		if (explorer.kind === 'timeout') return { kind: 'timeout', message: CHAT_TIMEOUT_SENTENCE };
		if (explorer.kind === 'stale') return { kind: 'stale', message: explorer.headline };
		if (explorer.kind === 'unavailable') {
			return { kind: 'unavailable', message: 'This pipeline has no running Chat source.', detail: [explorer.headline, explorer.detail].filter(Boolean).join('\n') };
		}
		return { kind: 'error', message: `The question failed: ${explorer.headline}`, ...(explorer.detail !== undefined ? { detail: explorer.detail } : {}) };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { kind: 'error', message: `The question failed: ${message}` };
}
