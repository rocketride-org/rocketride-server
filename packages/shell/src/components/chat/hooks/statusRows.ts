// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Status rows — the live "thinking" lines of the thread.
 *
 * A status row is a message with `sender: 'status'`. The built-in chat path
 * appends one per server-sent event; an injected `request` transport appends
 * them through the sink the hook hands it. Both build the row here so the
 * shape the thread's "Thinking…" fold looks for (`sseType`) stays in one place.
 */

import type { ChatMessage, ChatStatusSink } from '../types';

/**
 * Builds one status row.
 *
 * @param id - The row's unique id.
 * @param type - The event type, stored as `sseType` (`thinking` rows fold into the Thinking group).
 * @param text - The row's text.
 * @param timestamp - The formatted time string.
 * @returns The status message.
 */
export function statusRow(id: number, type: string, text: string, timestamp: string): ChatMessage {
	return { id, text, sender: 'status', sseType: type, timestamp };
}

/**
 * Makes the sink an injected `request` transport reports progress through.
 * Each call appends its row at once, so rows land in order while the request
 * is still pending.
 *
 * @param append - Appends one row to the thread.
 * @param nextId - Mints a fresh row id.
 * @param timestamp - Returns the current formatted time string.
 * @returns The status sink.
 */
export function makeStatusSink(append: (row: ChatMessage) => void, nextId: () => number, timestamp: () => string): ChatStatusSink {
	return (type, text) => append(statusRow(nextId(), type, text, timestamp()));
}
