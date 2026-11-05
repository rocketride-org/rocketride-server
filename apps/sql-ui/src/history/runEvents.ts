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
// HISTORY — RUN EVENTS (the query runner -> the history store)
// =============================================================================
//
// SQL Explorer's own run bus, made by the shared factory. The runner knows
// when a statement finished; the history store knows how to keep it. Neither
// needs to import the other, and the runner stays correct whether or not
// anything is listening — a run is never blocked by, or aware of, recording.
// =============================================================================

import { createRunEvents } from 'shared/explorer/history/runEvents';
import type { HistoryEntry } from './types';

/** SQL Explorer's run bus (its history store listens on it). */
export const sqlRunEvents = createRunEvents<'sql'>();

/**
 * Announce that one statement finished on one connection.
 *
 * Listener failures are swallowed: recording is a side channel and must never
 * surface as a query failure.
 *
 * @param endpointKey - The connection's stable endpoint key.
 * @param entry - The finished statement's record.
 */
export function emitRun(endpointKey: string, entry: HistoryEntry): void {
	sqlRunEvents.emitRun(endpointKey, entry);
}

/**
 * Subscribe to finished statements.
 *
 * @param callback - Called with the endpoint key and the entry.
 * @returns The unsubscribe function.
 */
export function subscribeRuns(callback: (endpointKey: string, entry: HistoryEntry) => void): () => void {
	return sqlRunEvents.subscribeRuns(callback as Parameters<typeof sqlRunEvents.subscribeRuns>[0]);
}
