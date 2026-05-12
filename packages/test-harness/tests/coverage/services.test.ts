import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchServices } from '../../src/coverage/services';

describe('fetchServices', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function stubFetch(body: unknown, ok = true): void {
		globalThis.fetch = vi.fn(async () => ({
			ok,
			status: ok ? 200 : 500,
			statusText: ok ? 'OK' : 'Internal Server Error',
			async json() {
				return body;
			},
		})) as unknown as typeof fetch;
	}

	it('parses the wrapped {status, data: {services: {<name>: {...}}}} shape', async () => {
		stubFetch({
			status: 'OK',
			data: {
				services: {
					llm_openai: { protocol: 'llm_openai://', title: 'OpenAI' },
					parse: { protocol: 'parse://', title: 'Parser' },
				},
			},
		});

		const registry = await fetchServices('http://localhost:5565', 'apikey');
		expect(Array.from(registry.names).sort()).toEqual(['llm_openai', 'parse']);
		expect(registry.all).toHaveLength(2);
	});

	it('parses a flat array shape', async () => {
		stubFetch([
			{ name: 'llm_openai', title: 'OpenAI' },
			{ name: 'parse', title: 'Parser' },
		]);

		const registry = await fetchServices('http://localhost:5565', '');
		expect(Array.from(registry.names).sort()).toEqual(['llm_openai', 'parse']);
	});

	it('parses a map-style shape at the top level', async () => {
		stubFetch({
			llm_openai: { protocol: 'llm_openai://' },
			parse: { protocol: 'parse://' },
		});

		const registry = await fetchServices('http://localhost:5565', '');
		expect(Array.from(registry.names).sort()).toEqual(['llm_openai', 'parse']);
	});

	it('throws on non-OK responses', async () => {
		stubFetch({}, false);
		await expect(fetchServices('http://localhost:5565', '')).rejects.toThrow(/GET \/services failed/);
	});

	it('rewrites ws:// to http:// before requesting', async () => {
		const calls: string[] = [];
		globalThis.fetch = vi.fn(async (url: unknown) => {
			calls.push(String(url));
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				async json() {
					return { status: 'OK', data: { services: {} } };
				},
			};
		}) as unknown as typeof fetch;

		await fetchServices('ws://localhost:5565', '').catch(() => {
			// shape rejection is fine here; we only assert on the URL
		});
		expect(calls[0]).toMatch(/^http:\/\//);
	});
});
