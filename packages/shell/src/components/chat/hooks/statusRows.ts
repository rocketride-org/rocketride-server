// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Status rows: the live "thinking" lines of the thread. The built-in chat path and
 * an injected `request` transport both build them here, so the shape the
 * "Thinking…" fold looks for (`sseType`) stays in one place.
 */

import type { ChatMessage, ChatStatusSink } from '../types';

/**
 * Builds one status row.
 */
export function statusRow(id: number, type: string, text: string, timestamp: string): ChatMessage {
	return { id, text, sender: 'status', sseType: type, timestamp };
}

/**
 * Makes the sink an injected `request` transport reports progress through.
 * Each call appends its row at once, so rows land in order while the request
 * is still pending.
 */
export function makeStatusSink(append: (row: ChatMessage) => void, nextId: () => number, timestamp: () => string): ChatStatusSink {
	return (type, text) => append(statusRow(nextId(), type, text, timestamp()));
}
