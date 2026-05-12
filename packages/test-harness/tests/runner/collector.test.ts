import { describe, expect, it } from 'vitest';

import { TraceCollector } from '../../src/runner/collector';
import type { ApaevtFlowEvent } from '../../src/runner/schema';

function flowEvent(op: 'begin' | 'enter' | 'leave' | 'end', pipes: string[]): ApaevtFlowEvent {
	return {
		event: 'apaevt_flow',
		body: {
			id: 0,
			op,
			pipes,
			project_id: 'test',
			source: 'src',
		},
	};
}

describe('TraceCollector', () => {
	it('routes apaevt_flow into runtime_events and tracks leaf nodes', async () => {
		const collector = new TraceCollector({ token: 'tk', timeoutMs: 1000 });

		await collector.onEvent(flowEvent('begin', ['src']));
		await collector.onEvent(flowEvent('enter', ['src', 'parse_1']));
		await collector.onEvent(flowEvent('enter', ['src', 'parse_1', 'response_1']));
		await collector.onEvent(flowEvent('end', ['src', 'parse_1', 'response_1']));

		const result = await collector.waitForTerminal();
		expect(result.timedOut).toBe(false);
		expect(result.runtime_events).toHaveLength(4);
		expect(result.exercised_nodes.sort()).toEqual(['parse_1', 'response_1', 'src']);
		expect(result.terminalEvent?.body.op).toBe('end');
	});

	it('routes apaevt_sse into sse_events', async () => {
		const collector = new TraceCollector({ token: 'tk', timeoutMs: 100 });

		await collector.onEvent({
			event: 'apaevt_sse',
			body: { pipe_id: 1, type: 'message', data: { text: 'hello' } },
		});
		await collector.onEvent(flowEvent('end', ['src']));

		const result = await collector.waitForTerminal();
		expect(result.sse_events).toHaveLength(1);
		expect(result.runtime_events).toHaveLength(1);
		expect(result.other_events).toHaveLength(0);
	});

	it('routes unknown event types into other_events', async () => {
		const collector = new TraceCollector({ token: 'tk', timeoutMs: 100 });

		await collector.onEvent({
			event: 'apaevt_status_message',
			body: { message: 'hi' },
		});
		await collector.onEvent(flowEvent('end', ['src']));

		const result = await collector.waitForTerminal();
		expect(result.other_events).toHaveLength(1);
		expect(result.sse_events).toHaveLength(0);
	});

	it('times out when no apaevt_flow op:end arrives', async () => {
		const collector = new TraceCollector({ token: 'tk', timeoutMs: 50 });

		const promise = collector.waitForTerminal();
		await collector.onEvent(flowEvent('begin', ['src']));
		const result = await promise;

		expect(result.timedOut).toBe(true);
		expect(result.terminalEvent).toBeUndefined();
	});

	it('ignores non-event-shaped messages defensively', async () => {
		const collector = new TraceCollector({ token: 'tk', timeoutMs: 50 });

		await collector.onEvent(undefined);
		await collector.onEvent({ random: 'object' });
		await collector.onEvent(flowEvent('end', ['src']));

		const result = await collector.waitForTerminal();
		expect(result.runtime_events).toHaveLength(1);
		expect(result.other_events).toHaveLength(0);
	});
});
