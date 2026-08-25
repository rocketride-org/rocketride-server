/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it } from 'vitest';

import { parseListPayload } from './adapter';

const CONTEXT = { projectId: 'p1', source: 's1' };

describe('parseListPayload', () => {
	it('maps closed and open summaries to request summaries (seconds → ms)', () => {
		const payload = {
			ok: true,
			context: CONTEXT,
			traces: [{ beginSeq: 10, doc: 'a.pdf', beginTime: 100.5, elapsed: 2.25, calls: 7, open: false }],
			open: [{ beginSeq: 20, doc: 'b.pdf', beginTime: 200, calls: 1, open: true }],
		};
		const { context, summaries } = parseListPayload(payload);
		expect(context).toEqual(CONTEXT);
		// Sorted by beginSeq ascending (chronological, like the in-app list).
		expect(summaries.map((s) => s.beginSeq)).toEqual([10, 20]);
		expect(summaries[0]).toEqual({
			docId: 10,
			beginSeq: 10,
			objectName: 'a.pdf',
			hasError: false,
			inFlight: false,
			totalElapsed: 2250,
			beginTimestamp: 100500,
			totalCalls: 7,
		});
		expect(summaries[1].inFlight).toBe(true);
		expect(summaries[1].totalElapsed).toBeNull();
	});

	it('throws when the context block is missing', () => {
		expect(() => parseListPayload({ ok: true, traces: [], open: [] })).toThrow(/context/);
	});

	it('passes the empty-run note through', () => {
		const { summaries, note } = parseListPayload({ ok: true, context: CONTEXT, traces: [], open: [], note: 'no traces recorded' });
		expect(summaries).toEqual([]);
		expect(note).toBe('no traces recorded');
	});

	it('assigns distinct docIds to rows missing beginSeq instead of colliding on -1', () => {
		const payload = {
			ok: true,
			context: CONTEXT,
			traces: [{ doc: 'a.pdf' }, { doc: 'b.pdf' }],
			open: [{ doc: 'c.pdf' }],
		};
		const { summaries } = parseListPayload(payload);
		expect(summaries.every((s) => s.beginSeq === null)).toBe(true);
		const docIds = summaries.map((s) => s.docId);
		expect(new Set(docIds).size).toBe(docIds.length);
		expect(docIds.every((id) => id < 0)).toBe(true);
	});
});
