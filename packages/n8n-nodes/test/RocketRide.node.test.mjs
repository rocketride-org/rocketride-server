import { describe, it, expect } from 'vitest';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

/** Build a fake IExecuteFunctions context that records the HTTP request options. */
function makeContext({ params, credentials, httpMock, continueOnFail = false, items = [{ json: {} }] }) {
	const calls = [];
	return {
		calls,
		getInputData: () => items,
		getCredentials: async () => credentials,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'RocketRide' }),
		continueOnFail: () => continueOnFail,
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

describe('RocketRide.execute — pipeline address', () => {
	const ok = () => ({ status: 'OK', data: { ok: true } });

	it('POSTs to {baseUrl}/webhook/{address} when the address is set', async () => {
		const ctx = makeContext({
			params: { operation: 'run', payloadMode: 'text', text: 'x', address: ' acme.docBrain.webhook_1 ' },
			credentials: { baseUrl: 'http://localhost:5567/', apiKey: 'rr_x', ignoreSslIssues: false },
			httpMock: ok,
		});
		await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls[0].url).toBe('http://localhost:5567/webhook/acme.docBrain.webhook_1');
	});

	it('accepts the two-segment address (the pipeline default source)', async () => {
		const ctx = makeContext({
			params: { operation: 'chat', question: 'q', address: 'acme.docBrain' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'rr_x', ignoreSslIssues: false },
			httpMock: ok,
		});
		await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls[0].url).toBe('http://localhost:5567/webhook/acme.docBrain');
	});

	it('refuses a value that is not an address before sending anything', async () => {
		const ctx = makeContext({
			params: { operation: 'run', payloadMode: 'text', text: 'x', address: 'acme/docBrain' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'rr_x', ignoreSslIssues: false },
			httpMock: ok,
			continueOnFail: true,
		});
		const result = await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls).toHaveLength(0);
		expect(result[0][0].json.error).toContain('is not a pipeline address');
	});
});

describe('RocketRide.execute — Run Pipeline', () => {
	it('POSTs text/plain to {baseUrl}/webhook and returns the unwrapped data', async () => {
		const ctx = makeContext({
			params: { operation: 'run', payloadMode: 'text', text: 'hello rocketride' },
			credentials: { baseUrl: 'http://localhost:5567/', apiKey: 'rr_x', ignoreSslIssues: false },
			httpMock: () => ({
				status: 'OK',
				data: { objectsRequested: 1, objectsCompleted: 1, resultTypes: {}, objects: { body: { status: 'OK', text: 'HELLO' } } },
			}),
		});

		const result = await RocketRide.prototype.execute.call(ctx);
		const opts = ctx.calls[0];

		expect(opts.method).toBe('POST');
		expect(opts.url).toBe('http://localhost:5567/webhook');
		expect(opts.headers['Content-Type']).toBe('text/plain');
		expect(opts.body).toBe('hello rocketride');
		expect(opts.skipSslCertificateValidation).toBe(false);
		expect(result[0][0].json.text).toBe('HELLO');
		expect(result[0][0].json._rocketride.object).toBe('body');
	});

	it('sends structured text + documents as JSON, coercing metadata', async () => {
		const ctx = makeContext({
			params: {
				operation: 'run',
				payloadMode: 'structured',
				text: 'question',
				'documents.document': [{ content: 'doc one', metadata: '{"src":"a.txt"}' }],
			},
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'rr_test', ignoreSslIssues: false },
			httpMock: () => ({ status: 'OK', data: { ok: true } }),
		});

		await RocketRide.prototype.execute.call(ctx);
		const opts = ctx.calls[0];

		expect(opts.headers['Content-Type']).toBe('application/json');
		const sent = JSON.parse(opts.body);
		expect(sent.text).toBe('question');
		expect(sent.documents[0].content).toBe('doc one');
		expect(sent.documents[0].metadata.src).toBe('a.txt');
	});

	it('forwards the SSL toggle from credentials', async () => {
		const ctx = makeContext({
			params: { operation: 'run', payloadMode: 'text', text: 'x' },
			credentials: { baseUrl: 'https://rr.example.com', apiKey: 'rr_test', ignoreSslIssues: true },
			httpMock: () => ({ status: 'OK', data: {} }),
		});
		await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls[0].skipSslCertificateValidation).toBe(true);
	});

	it('captures errors as item output when continueOnFail is enabled', async () => {
		const ctx = makeContext({
			params: { operation: 'run', payloadMode: 'text', text: 'x' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'rr_test', ignoreSslIssues: false },
			httpMock: () => {
				throw new Error('boom');
			},
			continueOnFail: true,
		});
		const result = await RocketRide.prototype.execute.call(ctx);
		expect(result[0][0].json.error).toBe('boom');
	});
});
