// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useTraceState
 *
 * Processes an array of TraceEvent objects into a flat list of TraceRow
 * objects suitable for rendering in the trace viewer. Maintains internal
 * bookkeeping (document map, slot bindings, pending call stacks) via refs
 * so that re-renders only occur when the final row list changes.
 *
 * Processing runs in a useEffect to avoid mutating refs during render
 * (which breaks React 18 Strict Mode double-invocation).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
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
	// Incremental processing — runs as an effect, not during render
	// =========================================================================

	useEffect(() => {
		const start = processedCountRef.current;
		const end = traceEvents.length;

		// Handle reset: if events array shrank (host cleared), reset all state
		if (end < start) {
			documentsRef.current.clear();
			docOrderRef.current = [];
			slotBindingsRef.current.clear();
			pendingStacksRef.current.clear();
			rowCounterRef.current = 0;
			nextDocIdRef.current = 0;
			processedCountRef.current = 0;
			setRows([]);
			return;
		}

		if (start >= end) return; // nothing new

		for (let i = start; i < end; i++) {
			const event = traceEvents[i];
			const { pipelineId, op, pipes, trace, source: eventSource } = event;
			const lane = trace.lane || op;

			switch (op) {
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
						source: eventSource,
					};

					doc.rows.push(row);
					stack?.push(row);
					break;
				}

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
	}, [traceEvents, flush]);

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
