import { describe, it, expect } from 'vitest';
import { isLocalHostUrl, isConnectionError, reachabilityMessage } from '../nodes/RocketRide/helpers.ts';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

describe('reachability helpers', () => {
	it('detects local hosts', () => {
		expect(isLocalHostUrl('http://localhost:5567')).toBe(true);
		expect(isLocalHostUrl('http://127.0.0.1:5567')).toBe(true);
		expect(isLocalHostUrl('https://rr.example.com')).toBe(false);
		expect(isLocalHostUrl('not a url')).toBe(false);
	});

	it('classifies connection errors vs HTTP errors', () => {
		expect(isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:5567'))).toBe(true);
		expect(isConnectionError({ cause: { code: 'ENOTFOUND' }, message: 'fetch failed' })).toBe(true);
		expect(isConnectionError(new Error('Request failed with status code 400'))).toBe(false);
	});

	it('gives 127.0.0.1 + Docker hints for localhost, generic guidance for remote', () => {
		const local = reachabilityMessage('http://localhost:5567', 'ECONNREFUSED');
		expect(local).toMatch(/127\.0\.0\.1/);
		expect(local).toMatch(/host\.docker\.internal/);
		expect(reachabilityMessage('https://rr.example.com', 'ECONNREFUSED')).not.toMatch(/host\.docker\.internal/);
	});
});

function makeCtx({ params, credentials, httpMock, continueOnFail = false }) {
	return {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => credentials,
		getNodeParameter: (name, _i, fb) => (name in params ? params[name] : fb),
		getNode: () => ({ name: 'RocketRide' }),
		continueOnFail: () => continueOnFail,
		helpers: { httpRequestWithAuthentication: { call: async () => httpMock() } },
	};
}

describe('RocketRide.execute — reachability', () => {
	it('surfaces the Docker hint for a local connection failure', async () => {
		const ctx = makeCtx({
			params: { operation: 'run', payloadMode: 'text', text: 'x' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			httpMock: () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:5567');
			},
			continueOnFail: true,
		});
		const out = await RocketRide.prototype.execute.call(ctx);
		expect(out[0][0].json.error).toMatch(/host\.docker\.internal/);
	});
});
