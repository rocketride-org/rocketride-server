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

	it('keeps the token counts of a single object as bookkeeping, not as a lane', () => {
		const tokens = { input: 107, output: 13, cache_read: 50, cache_creation: 20 };
		const data = {
			objectsRequested: 1,
			objectsCompleted: 1,
			resultTypes: { answers: 'answers' },
			objects: {
				body: { status: 'OK', answers: ['hello'], result_types: { answers: 'answers' }, tokens },
			},
		};
		const out = normalizeRunResult(data);
		expect(out.answers).toEqual(['hello']);
		expect(out.tokens).toBeUndefined();
		expect(out._rocketride.tokens).toEqual(tokens);
	});

	it('adds no token counts when the object reports none', () => {
		const data = { objects: { body: { status: 'OK', answers: ['hello'] } } };
		expect('tokens' in normalizeRunResult(data)._rocketride).toBe(false);
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
