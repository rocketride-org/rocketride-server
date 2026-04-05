// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * useTraceState
 *
 * Processes an array of TraceEvent objects into a flat list of TraceRow
 * objects suitable for rendering in the trace viewer. Maintains internal
 * bookkeeping (document map, slot bindings, pending call stacks) via refs
 * so that re-renders only occur when the final row list changes.
 *
 * The hook is designed to work incrementally: on each render it processes
 * only the new events appended since the last pass. If the host resets
 * the events array (length shrinks), all internal state is cleared.
 */

import { useState, useRef, useCallback } from 'react';
import type { TraceEvent, TraceRow } from '../types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of documents to retain before evicting old completed ones */
const MAX_DOCS = 64;

// =============================================================================
// Internal Types
// =============================================================================

interface TraceDocument {
	objectName: string;
	completed: boolean;
	rows: TraceRow[];
}

// =============================================================================
// Hook
// =============================================================================

export function useTraceState(traceEvents: TraceEvent[]): {
	rows: TraceRow[];
	clearTrace: () => void;
} {
	const [rows, setRows] = useState<TraceRow[]>([]);

	// =========================================================================
	// Internal refs -- mutable bookkeeping that does not trigger re-renders
	// =========================================================================

	/** Map of docId -> document containing its rows */
	const documentsRef = useRef<Map<number, TraceDocument>>(new Map());

	/** Insertion-ordered list of docIds for iteration / eviction */
	const docOrderRef = useRef<number[]>([]);

	/** Maps pipeline slot (pipelineId) to the active docId */
	const slotBindingsRef = useRef<Map<number, number>>(new Map());

	/** Per-pipeline pending call stack used to pair enter/leave events */
	const pendingStacksRef = useRef<Map<number, TraceRow[]>>(new Map());

	/** Monotonically increasing row ID counter */
	const rowCounterRef = useRef<number>(0);

	/** Monotonically increasing document ID counter */
	const nextDocIdRef = useRef<number>(0);

	/** Number of events already processed from the traceEvents array */
	const processedCountRef = useRef<number>(0);

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Build a flat TraceRow[] from all documents (newest first) and push
	 * it into React state.
	 */
	const flush = useCallback(() => {
		const flatRows: TraceRow[] = [];
		// Iterate in reverse so newest documents appear first
		const order = docOrderRef.current;
		for (let i = order.length - 1; i >= 0; i--) {
			const doc = documentsRef.current.get(order[i]);
			if (!doc) continue;
			for (const row of doc.rows) {
				flatRows.push(row.completed === doc.completed ? row : { ...row, completed: doc.completed });
			}
		}
		setRows(flatRows);
	}, []);

	/**
	 * Evict the oldest completed documents when the total exceeds MAX_DOCS.
	 */
	const evict = () => {
		while (docOrderRef.current.length > MAX_DOCS) {
			const oldId = docOrderRef.current[0];
			const oldDoc = documentsRef.current.get(oldId);
			if (oldDoc && !oldDoc.completed) break; // never evict in-flight docs
			docOrderRef.current.shift();
			documentsRef.current.delete(oldId);
		}
	};

	// =========================================================================
	// Reset detection
	// =========================================================================

	if (traceEvents.length < processedCountRef.current) {
		// Host cleared the events array -- reset all internal state
		documentsRef.current.clear();
		docOrderRef.current = [];
		slotBindingsRef.current.clear();
		pendingStacksRef.current.clear();
		rowCounterRef.current = 0;
		nextDocIdRef.current = 0;
		processedCountRef.current = 0;
		// rows will be flushed below (no new events, but flush clears)
	}

	// =========================================================================
	// Incremental processing
	// =========================================================================

	const start = processedCountRef.current;
	const end = traceEvents.length;

	if (start < end) {
		for (let i = start; i < end; i++) {
			const event = traceEvents[i];
			const { pipelineId, op, pipes, trace } = event;
			const lane = trace.lane || op;

			switch (op) {
				// -----------------------------------------------------------------
				// begin: allocate a new document and bind the pipeline slot
				// -----------------------------------------------------------------
				case 'begin': {
					const docId = nextDocIdRef.current++;
					const objectName = pipes[0] || '';
					documentsRef.current.set(docId, {
						objectName,
						completed: false,
						rows: [],
					});
					docOrderRef.current.push(docId);
					slotBindingsRef.current.set(pipelineId, docId);
					pendingStacksRef.current.set(pipelineId, []);
					evict();
					break;
				}

				// -----------------------------------------------------------------
				// enter: create a new TraceRow and push it onto the pending stack
				// -----------------------------------------------------------------
				case 'enter': {
					const docId = slotBindingsRef.current.get(pipelineId);
					if (docId == null) break;
					const doc = documentsRef.current.get(docId);
					if (!doc) break;

					const stack = pendingStacksRef.current.get(pipelineId);
					const filterName = pipes[pipes.length - 1] || '';
					const depth = Math.max(0, pipes.length - 2);

					const row: TraceRow = {
						id: rowCounterRef.current++,
						docId,
						completed: false,
						lane,
						filterName,
						depth,
						entryData: trace.data,
						timestamp: Date.now(),
						objectName: doc.objectName,
					};

					doc.rows.push(row);
					stack?.push(row);
					break;
				}

				// -----------------------------------------------------------------
				// leave: pop the pending stack and enrich the row with exit data
				// -----------------------------------------------------------------
				case 'leave': {
					const docId = slotBindingsRef.current.get(pipelineId);
					if (docId == null) break;
					const doc = documentsRef.current.get(docId);
					if (!doc) break;

					const pending = pendingStacksRef.current.get(pipelineId)?.pop();
					if (pending) {
						const idx = doc.rows.findIndex((r) => r.id === pending.id);
						if (idx !== -1) {
							doc.rows[idx] = {
								...doc.rows[idx],
								exitData: trace.data,
								result: trace.result,
								error: trace.error,
								endTimestamp: Date.now(),
							};
						}
					}
					break;
				}

				// -----------------------------------------------------------------
				// end: mark the document completed and unbind the slot
				// -----------------------------------------------------------------
				case 'end': {
					const docId = slotBindingsRef.current.get(pipelineId);
					if (docId != null) {
						const doc = documentsRef.current.get(docId);
						if (doc) doc.completed = true;
					}
					slotBindingsRef.current.delete(pipelineId);
					pendingStacksRef.current.delete(pipelineId);
					evict();
					break;
				}
			}
		}

		processedCountRef.current = end;
		flush();
	} else if (start > end) {
		// Already handled by reset detection above; just flush the empty state
		flush();
	}

	// =========================================================================
	// clearTrace — callable by the host to manually reset
	// =========================================================================

	const clearTrace = useCallback(() => {
		documentsRef.current.clear();
		docOrderRef.current = [];
		slotBindingsRef.current.clear();
		pendingStacksRef.current.clear();
		rowCounterRef.current = 0;
		nextDocIdRef.current = 0;
		processedCountRef.current = 0;
		setRows([]);
	}, []);

	return { rows, clearTrace };
}
