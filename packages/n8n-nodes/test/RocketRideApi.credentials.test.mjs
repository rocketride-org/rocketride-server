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

	it('tests connectivity against the public GET /version route', () => {
		expect(cred.test.request.method).toBe('GET');
		expect(cred.test.request.url).toBe('/version');
		expect(cred.test.request.baseURL).toBe('={{$credentials.baseUrl}}');
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
