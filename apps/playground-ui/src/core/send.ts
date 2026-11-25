// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Sending to an agent: every request is one pipe, opened on the
 * connection's source address. A question is written once, the way
 * `client.chat()` builds it; a file is streamed in chunks, the way
 * `client.sendFiles()` does, so its upload progress can be shown. The pipe's
 * SSE `message` events are the thinking rows.
 */

import { Question, QuestionType } from 'rocketride';
import type { RocketRideClient } from 'shell';
import type { ResultBody, TypedLane } from './model';
import { TYPED_MIME } from './sources';

// =============================================================================
// TYPES
// =============================================================================

/** One earlier turn, for a question's history. */
export interface HistoryTurn {
	role: 'user' | 'assistant';
	content: string;
}

/** What a request reports while it runs. */
export interface SendCallbacks {
	/** A thinking message from the pipe. */
	onThinking?: (text: string) => void;
	/** Bytes written so far (files only). */
	onProgress?: (sent: number) => void;
	/** The pipe is open (files only: the upload starts). */
	onOpened?: () => void;
}

/** A failed request, as the Playground shows it. */
export interface SendFailure {
	message: string;
	code?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** How many earlier turns ride a question (the shell chat widget's number). */
export const HISTORY_TURNS = 6;

/** How many files upload at once (`client.sendFiles()`'s default). */
export const FILE_CONCURRENCY = 5;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The SSE handler a pipe takes: each `message` becomes a thinking row.
 *
 * @param onThinking - Receives each message.
 * @returns The handler.
 */
function sseHandler(onThinking?: (text: string) => void): (type: string, data: Record<string, unknown>) => Promise<void> {
	return async (_type, data) => {
		const text = typeof data?.message === 'string' ? data.message.trim() : '';
		if (text) onThinking?.(text);
	};
}

/**
 * A thrown error as the Playground shows it: its message and, for a typed
 * SDK exception, the server's code.
 *
 * @param err - Anything thrown.
 * @returns The failure.
 */
export function failureOf(err: unknown): SendFailure {
	const code = typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code as string) : undefined;
	const message = err instanceof Error ? err.message : String(err);
	return { message, ...(code ? { code } : {}) };
}

/**
 * Closes a pipe that is still open after a failure, ignoring a second failure.
 *
 * @param pipe - The pipe.
 */
async function closeQuietly(pipe: { isOpened: boolean; close: () => Promise<unknown> }): Promise<void> {
	if (!pipe.isOpened) return;
	try {
		await pipe.close();
	} catch {
		// the first failure is the one reported
	}
}

// =============================================================================
// QUESTIONS
// =============================================================================

/**
 * Sends typed input on the source's typed lane: a question with its
 * history, plain text, or JSON as typed.
 *
 * @param client - The realm's client.
 * @param address - The source's address.
 * @param lane - The typed lane the source takes.
 * @param text - What the caller typed.
 * @param history - Earlier turns, oldest first (questions only).
 * @param params - Settings values by public name, when any were changed.
 * @param callbacks - Thinking rows.
 * @returns The close body.
 */
export async function sendTyped(client: RocketRideClient, address: string, lane: TypedLane, text: string, history: HistoryTurn[], params: Record<string, unknown> | undefined, callbacks: SendCallbacks): Promise<ResultBody> {
	// step: the bytes for the lane
	let bytes: Uint8Array;
	if (lane === 'questions') {
		const question = new Question({ type: QuestionType.PROMPT, expectJson: false });
		question.addQuestion(text);
		for (const turn of history.slice(-HISTORY_TURNS)) question.addHistory(turn);
		question.checkTurn();
		bytes = new TextEncoder().encode(JSON.stringify(question.toDict()));
	} else {
		bytes = new TextEncoder().encode(text);
	}

	// step: one pipe, written once
	const pipe = await client.pipe(address, { name: 'Question', size: bytes.length || 1 }, TYPED_MIME[lane], undefined, sseHandler(callbacks.onThinking), undefined, params);
	try {
		await pipe.open();
		await pipe.write(bytes);
		return ((await pipe.close()) ?? {}) as ResultBody;
	} finally {
		await closeQuietly(pipe);
	}
}

// =============================================================================
// FILES
// =============================================================================

/**
 * Sends one file, streamed in chunks.
 *
 * @param client - The realm's client.
 * @param address - The source's address.
 * @param file - The file.
 * @param params - Settings values by public name, when any were changed.
 * @param callbacks - Opened, progress and thinking.
 * @returns The close body.
 */
export async function sendFile(client: RocketRideClient, address: string, file: File, params: Record<string, unknown> | undefined, callbacks: SendCallbacks): Promise<ResultBody> {
	const mime = file.type || 'application/octet-stream';
	const pipe = await client.pipe(address, { name: file.name, size: file.size || 1 }, mime, undefined, sseHandler(callbacks.onThinking), undefined, params);
	try {
		await pipe.open();
		callbacks.onOpened?.();

		// step: the file's bytes, chunk by chunk, with the running total
		const reader = file.stream().getReader();
		let sent = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await pipe.write(value);
				sent += value.length;
				callbacks.onProgress?.(sent);
			}
		} finally {
			reader.releaseLock();
		}
		return ((await pipe.close()) ?? {}) as ResultBody;
	} finally {
		await closeQuietly(pipe);
	}
}

/**
 * Runs `task` over every item with at most `limit` in flight, in order of
 * starting. Each task settles on its own; nothing here rejects.
 *
 * @param items - The work.
 * @param limit - The most in flight at once.
 * @param task - One item's work.
 */
export async function runLimited<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			await task(items[index], index).catch(() => undefined);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
