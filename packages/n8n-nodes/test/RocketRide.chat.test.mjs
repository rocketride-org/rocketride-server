import { describe, it, expect } from 'vitest';
import { buildChatBody } from '../nodes/RocketRide/helpers.ts';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

describe('buildChatBody', () => {
	it('wraps a question in the RocketRide question envelope', () => {
		const { body, contentType } = buildChatBody({ question: 'What is this doc about?' });
		expect(contentType).toBe('application/rocketride-question');
		const q = JSON.parse(body);
		expect(q.type).toBe('question');
		expect(q.questions).toEqual([{ text: 'What is this doc about?' }]);
		expect(q.expectJson).toBe(false);
		expect(q.role).toBeUndefined();
	});

	it('sets expectJson and role when provided', () => {
		const q = JSON.parse(buildChatBody({ question: 'extract emails', expectJson: true, role: 'analyst' }).body);
		expect(q.expectJson).toBe(true);
		expect(q.role).toBe('analyst');
	});
});

function makeContext({ params, credentials, httpMock }) {
	const calls = [];
	return {
		calls,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => credentials,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'RocketRide' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: {
				call: async (_ctx, _credName, opts) => {
					calls.push(opts);
					return httpMock(opts);
				},
			},
		},
	};
}

describe('RocketRide.execute — Chat', () => {
	it('posts the question envelope with the chat content type', async () => {
		const ctx = makeContext({
			params: { operation: 'chat', question: 'hello?', expectJson: false, role: '' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			httpMock: () => ({ status: 'OK', data: { objects: { chat: { answers: ['hi'] } } } }),
		});

		await RocketRide.prototype.execute.call(ctx);
		const opts = ctx.calls[0];

		expect(opts.headers['Content-Type']).toBe('application/rocketride-question');
		expect(JSON.parse(opts.body).questions[0].text).toBe('hello?');
	});
});
