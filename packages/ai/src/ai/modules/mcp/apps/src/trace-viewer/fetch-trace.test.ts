/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it, vi } from 'vitest';

import { makeFetchTrace } from './fetch-trace';

const CONTEXT = { projectId: 'p1', source: 's1', teamId: 't1' };
const EVENTS = [{ event: 'apaevt_flow', body: { eventTime: 1, logSeq: 2 } }];

function textResult(payload: unknown): unknown {
	return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

describe('makeFetchTrace', () => {
	it('calls log_trace with the keying context and beginSeq', async () => {
		const call = vi.fn().mockResolvedValue(textResult({ ok: true, beginSeq: 7, events: EVENTS }));
		const fetchTrace = makeFetchTrace(call, CONTEXT);
		await expect(fetchTrace(7)).resolves.toEqual({ events: EVENTS });
		expect(call).toHaveBeenCalledWith({
			name: 'log_trace',
			arguments: { projectId: 'p1', source: 's1', teamId: 't1', beginSeq: 7 },
		});
	});

	it('omits teamId when the context has none', async () => {
		const call = vi.fn().mockResolvedValue(textResult({ ok: true, beginSeq: 7, events: [] }));
		await makeFetchTrace(call, { projectId: 'p1', source: 's1' })(7);
		expect(call).toHaveBeenCalledWith({ name: 'log_trace', arguments: { projectId: 'p1', source: 's1', beginSeq: 7 } });
	});

	it('serves a prefetched trace without a bridge call', async () => {
		const call = vi.fn();
		const fetchTrace = makeFetchTrace(call, CONTEXT, { beginSeq: 7, events: EVENTS });
		await expect(fetchTrace(7)).resolves.toEqual({ events: EVENTS });
		expect(call).not.toHaveBeenCalled();
	});

	it('surfaces retention errors with friendly copy', async () => {
		const call = vi.fn().mockResolvedValue(textResult({ ok: false, error_type: 'TraceExpired', message: 'below horizon' }));
		await expect(makeFetchTrace(call, CONTEXT)(7)).rejects.toThrow(/retention window/);
	});
});
