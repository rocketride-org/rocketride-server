import { describe, it, expect } from 'vitest';
import { normalizeRunResult } from '../nodes/RocketRide/helpers.ts';

describe('normalizeRunResult', () => {
	it('lifts a single object\'s dynamic lanes to the top level (no hard-coded keys)', () => {
		const data = {
			objectsRequested: 1,
			objectsCompleted: 1,
			resultTypes: { chat_response: 'answers' },
			objects: {
				body: { status: 'OK', chat_response: ['hello'], result_types: { chat_response: 'answers' } },
			},
		};
		const out = normalizeRunResult(data);
		expect(out.chat_response).toEqual(['hello']);
		expect(out.status).toBeUndefined();
		expect(out.result_types).toBeUndefined();
		expect(out._rocketride.object).toBe('body');
		expect(out._rocketride.objectsCompleted).toBe(1);
		expect(out._rocketride.resultTypes).toEqual({ chat_response: 'answers' });
	});

	it('keeps the objects map for multi-object responses', () => {
		const data = {
			objectsRequested: 2,
			objectsCompleted: 2,
			resultTypes: {},
			objects: { a: { status: 'OK', text: 'x' }, b: { status: 'OK', text: 'y' } },
		};
		const out = normalizeRunResult(data);
		expect(out.objects.a.text).toBe('x');
		expect(out.objects.b.text).toBe('y');
		expect(out._rocketride.objectsRequested).toBe(2);
	});

	it('passes through non-RocketRide shapes unchanged', () => {
		expect(normalizeRunResult({ result: 'plain' })).toEqual({ result: 'plain' });
	});
});
