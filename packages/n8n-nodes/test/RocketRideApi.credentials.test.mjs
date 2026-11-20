import { describe, it, expect } from 'vitest';
import { RocketRideApi } from '../credentials/RocketRideApi.credentials.ts';

describe('RocketRideApi credential', () => {
	const cred = new RocketRideApi();

	it('has the expected identity', () => {
		expect(cred.name).toBe('rocketRideApi');
		expect(cred.displayName).toBe('RocketRide API');
	});

	it('sends the API key as a Bearer Authorization header', () => {
		expect(cred.authenticate.type).toBe('generic');
		const headers = cred.authenticate.properties.headers ?? {};
		expect(headers.Authorization).toBe('=Bearer {{$credentials.apiKey}}');
	});

	it('tests the Base URL and the key together against the authenticated GET /status route', () => {
		expect(cred.test.request.method).toBe('GET');
		expect(cred.test.request.url).toBe('/status');
		expect(cred.test.request.baseURL).toBe('={{$credentials.baseUrl}}');
	});

	it('forwards the Ignore SSL Issues toggle to the credential test request', () => {
		// Test and Run must make identical TLS decisions: a node run passes
		// skipSslCertificateValidation from the same toggle.
		expect(cred.test.request.skipSslCertificateValidation).toBe(
			'={{$credentials.ignoreSslIssues}}',
		);
	});

	it('describes the key as an rr_ account key, never a pipeline or task key', () => {
		const apiKey = cred.properties.find((p) => p.name === 'apiKey');
		expect(apiKey.description).toContain('rr_');
		expect(apiKey.description).not.toMatch(/(pk|tk)_/);
	});

	it('exposes baseUrl, a masked apiKey, and an SSL toggle', () => {
		const byName = Object.fromEntries(cred.properties.map((p) => [p.name, p]));
		expect(byName.baseUrl?.type).toBe('string');
		expect(byName.baseUrl?.default).toBe('http://127.0.0.1:5567');
		expect(byName.apiKey?.typeOptions?.password).toBe(true);
		expect(byName.ignoreSslIssues?.type).toBe('boolean');
	});

	it('ships a branded RocketRide icon', () => {
		expect(cred.icon).toBeDefined();
	});
});
