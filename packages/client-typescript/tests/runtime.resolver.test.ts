import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
type AnyFn = (...args: any[]) => any;

jest.mock('../src/client/runtime/platform.js');

import { getCompatRange, resolveCompatibleVersion, resolveDockerTag, listCompatibleVersions } from '../src/client/runtime/resolver.js';
import { normalizeVersion } from '../src/client/runtime/platform.js';
import { RuntimeNotFoundError } from '../src/client/exceptions/index.js';

const mockedNormalizeVersion = jest.mocked(normalizeVersion);

// ── Global fetch mock ────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetchResponse(body: unknown, status: number = 200): void {
	(globalThis as any).fetch = jest.fn<AnyFn>().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	});
}

function mockFetchError(status: number): void {
	(globalThis as any).fetch = jest.fn<AnyFn>().mockResolvedValue({
		ok: false,
		status,
		json: () => Promise.resolve({}),
	});
}

// ── Test data ────────────────────────────────────────────────────────

const RELEASES = [
	{ tag_name: 'server-v3.2.0', published_at: '2026-02-01T00:00:00Z', prerelease: false },
	{ tag_name: 'server-v3.1.0', published_at: '2026-01-15T00:00:00Z', prerelease: false },
	{ tag_name: 'server-v3.0.0', published_at: '2026-01-01T00:00:00Z', prerelease: false },
	{ tag_name: 'server-v3.3.0-prerelease', published_at: '2026-03-01T00:00:00Z', prerelease: true },
	{ tag_name: 'server-v2.5.0', published_at: '2025-12-01T00:00:00Z', prerelease: false },
	{ tag_name: 'unrelated-tag', published_at: '2026-01-01T00:00:00Z', prerelease: false },
];

describe('resolver', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockedNormalizeVersion.mockImplementation((v: string) => v.replace(/^v/, ''));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// ── listCompatibleVersions ───────────────────────────────────────

	describe('listCompatibleVersions', () => {
		it('returns matching versions sorted descending', async () => {
			mockFetchResponse(RELEASES);

			const result = await listCompatibleVersions('>=3.0.0 <4.0.0');

			const versions = result.map((v) => v.version);
			expect(versions).toEqual(['3.2.0', '3.1.0', '3.0.0']);
		});

		it('excludes prerelease by default', async () => {
			mockFetchResponse(RELEASES);

			const result = await listCompatibleVersions('>=3.0.0 <4.0.0');

			const versions = result.map((v) => v.version);
			expect(versions).not.toContain('3.3.0-prerelease');
		});

		it('includes prerelease when flag true', async () => {
			mockFetchResponse(RELEASES);

			const result = await listCompatibleVersions('>=3.0.0 <4.0.0', true);

			const versions = result.map((v) => v.version);
			expect(versions).toContain('3.3.0-prerelease');
		});

		it('handles empty releases', async () => {
			mockFetchResponse([]);

			const result = await listCompatibleVersions('>=3.0.0 <4.0.0');

			expect(result).toEqual([]);
		});

		it('throws on HTTP error', async () => {
			mockFetchError(500);

			await expect(listCompatibleVersions('>=3.0.0 <4.0.0')).rejects.toThrow(RuntimeNotFoundError);
			await expect(listCompatibleVersions('>=3.0.0 <4.0.0')).rejects.toThrow(/HTTP 500/);
		});

		it('excludes versions outside compat range', async () => {
			mockFetchResponse(RELEASES);

			const result = await listCompatibleVersions('>=3.1.0 <3.2.0');

			const versions = result.map((v) => v.version);
			expect(versions).toEqual(['3.1.0']);
			expect(versions).not.toContain('3.0.0');
			expect(versions).not.toContain('3.2.0');
		});

		it('ignores non-matching tag patterns', async () => {
			mockFetchResponse([
				{ tag_name: 'not-a-version', published_at: '2026-01-01T00:00:00Z' },
				{ tag_name: 'server-v3.1.0', published_at: '2026-01-01T00:00:00Z' },
			]);

			const result = await listCompatibleVersions('>=3.0.0 <4.0.0');

			expect(result).toHaveLength(1);
			expect(result[0].version).toBe('3.1.0');
		});
	});

	// ── resolveCompatibleVersion ─────────────────────────────────────

	describe('resolveCompatibleVersion', () => {
		it('returns best match', async () => {
			mockFetchResponse(RELEASES);

			const result = await resolveCompatibleVersion('>=3.0.0 <4.0.0');

			expect(result).toBe('3.2.0');
		});

		it('throws when no match', async () => {
			mockFetchResponse(RELEASES);

			await expect(resolveCompatibleVersion('>=5.0.0 <6.0.0')).rejects.toThrow(RuntimeNotFoundError);
			await expect(resolveCompatibleVersion('>=5.0.0 <6.0.0')).rejects.toThrow(/No runtime release found/);
		});

		it('throws on HTTP error', async () => {
			mockFetchError(403);

			await expect(resolveCompatibleVersion('>=3.0.0 <4.0.0')).rejects.toThrow(RuntimeNotFoundError);
			await expect(resolveCompatibleVersion('>=3.0.0 <4.0.0')).rejects.toThrow(/HTTP 403/);
		});
	});

	// ── resolveDockerTag ─────────────────────────────────────────────

	describe('resolveDockerTag', () => {
		it('returns explicit version as-is', async () => {
			const fetchSpy = jest.fn();
			(globalThis as any).fetch = fetchSpy;

			const result = await resolveDockerTag('3.1.0');

			expect(result).toBe('3.1.0');
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('resolves "latest" to newest non-prerelease', async () => {
			mockFetchResponse(RELEASES);

			const result = await resolveDockerTag('latest');

			expect(result).toBe('3.2.0');
		});

		it('resolves "prerelease" to newest prerelease', async () => {
			mockFetchResponse(RELEASES);

			const result = await resolveDockerTag('prerelease');

			expect(result).toBe('3.3.0-prerelease');
		});

		it('throws when no releases match spec', async () => {
			mockFetchResponse([{ tag_name: 'server-v3.1.0', published_at: '2026-01-01T00:00:00Z' }]);

			// Only stable releases exist, so 'prerelease' spec should fail
			await expect(resolveDockerTag('prerelease')).rejects.toThrow(RuntimeNotFoundError);
		});
	});

	// ── getCompatRange ───────────────────────────────────────────────

	describe('getCompatRange', () => {
		it('returns a valid semver range string', () => {
			const range = getCompatRange();

			expect(typeof range).toBe('string');
			expect(range.length).toBeGreaterThan(0);
		});
	});
});
