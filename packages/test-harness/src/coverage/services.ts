/**
 * Fetches the authoritative node-class registry from GET /services.
 *
 * Server route: packages/ai/src/ai/modules/services/__init__.py:18.
 * Response shape: array of service definitions, each with `name` plus
 * other fields (`title`, `protocol`, etc.). We only need `name`.
 */

export type ServiceDefinition = {
	name: string;
	[k: string]: unknown;
};

export type ServicesRegistry = {
	all: ServiceDefinition[];
	names: Set<string>;
};

function toHttpUrl(rawUrl: string): string {
	// Server's /services is HTTP; normalize ws://localhost:N or http://localhost:N.
	const url = new URL(rawUrl);
	if (url.protocol === 'ws:') url.protocol = 'http:';
	else if (url.protocol === 'wss:') url.protocol = 'https:';
	return url.toString().replace(/\/$/, '');
}

export async function fetchServices(serverUrl: string, apiKey: string): Promise<ServicesRegistry> {
	const base = toHttpUrl(serverUrl);
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch(`${base}/services`, { headers });
	if (!res.ok) {
		throw new Error(`GET /services failed: ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as unknown;

	const all = normalizeServices(body);
	const names = new Set(all.map((s) => s.name));
	return { all, names };
}

function normalizeServices(raw: unknown): ServiceDefinition[] {
	if (Array.isArray(raw)) {
		return raw.filter((s): s is ServiceDefinition => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string');
	}
	if (raw && typeof raw === 'object') {
		const obj = raw as Record<string, unknown>;

		// Wrapper unwrapping: server returns { status: 'OK', data: { services: { name: {...} } } }.
		// Recurse into common wrapper keys before falling back to map-style.
		for (const key of ['services', 'data', 'items', 'result']) {
			if (obj[key] !== undefined) {
				const inner = normalizeServices(obj[key]);
				if (inner.length > 0) return inner;
			}
		}

		// Map-style: { name1: {...}, name2: {...} }.
		// Heuristic: every value is an object — treat keys as service names.
		const entries = Object.entries(obj);
		const allObjects = entries.length > 0 && entries.every(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
		if (allObjects) {
			return entries.map(([name, value]) => ({ name, ...(value as Record<string, unknown>) }));
		}
	}
	throw new Error('Unrecognised /services response shape');
}
