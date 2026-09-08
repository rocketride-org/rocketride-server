import type { GenericValue, IBinaryData, IDataObject } from 'n8n-workflow';

export type RocketRidePayloadMode = 'text' | 'json' | 'structured';

export interface RocketRideDocument {
	content: string;
	metadata?: IDataObject;
}

export interface RunBodyParams {
	text?: string;
	jsonBody?: unknown;
	documents?: RocketRideDocument[];
}

export interface BuiltBody {
	body: string;
	contentType: string;
}

/** Coerce a value that may be a JSON string or an object into a plain object. */
export function coerceJsonObject(value: unknown): IDataObject {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as IDataObject;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as IDataObject)
				: {};
		} catch {
			return {};
		}
	}
	return {};
}

/** Max bytes accepted for a single multipart upload — matches n8n's default payload cap. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Best-effort declared size of a binary *before* it is buffered into memory, so
 * oversized uploads can fail fast instead of being fully materialized first.
 *
 * Resolution order:
 * 1. `binary.bytes` — numeric size n8n stamps on the metadata when known.
 * 2. `getMetadata(binary.id)` — authoritative size for externally-stored
 *    binaries (filesystem / S3 modes).
 * 3. The base64 `data` payload length — exact decoded size for in-memory mode.
 *
 * Returns `undefined` when no reliable size is available; the caller's
 * post-buffer check remains authoritative (metadata is advisory in n8n).
 */
export async function declaredBinaryBytes(
	binary: IBinaryData,
	getMetadata?: (binaryDataId: string) => Promise<{ fileSize: number }>,
): Promise<number | undefined> {
	if (typeof binary.bytes === 'number') {
		return binary.bytes;
	}
	if (binary.id !== undefined && getMetadata !== undefined) {
		try {
			const meta = await getMetadata(binary.id);
			if (typeof meta?.fileSize === 'number') {
				return meta.fileSize;
			}
		} catch {
			// Advisory only — fall through to the post-buffer check.
		}
	}
	if (binary.id === undefined && typeof binary.data === 'string' && binary.data.length > 0) {
		const padding = binary.data.endsWith('==') ? 2 : binary.data.endsWith('=') ? 1 : 0;
		return Math.floor((binary.data.length * 3) / 4) - padding;
	}
	return undefined;
}

/** Human-readable byte size for error messages. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the HTTP request body + content type for a "Run Pipeline" call.
 *
 * - `text`       -> raw `text/plain` (RocketRide streams it straight to the pipeline)
 * - `json`       -> the caller's JSON, sent as `application/json`
 * - `structured` -> `{ text, documents:[{content, metadata}] }` as `application/json`
 */
export function buildRunBody(mode: RocketRidePayloadMode, params: RunBodyParams): BuiltBody {
	if (mode === 'json') {
		const raw = params.jsonBody ?? {};
		return {
			body: typeof raw === 'string' ? raw : JSON.stringify(raw),
			contentType: 'application/json',
		};
	}

	if (mode === 'structured') {
		return {
			body: JSON.stringify({ text: params.text ?? '', documents: params.documents ?? [] }),
			contentType: 'application/json',
		};
	}

	return { body: params.text ?? '', contentType: 'text/plain' };
}

export interface ChatParams {
	question: string;
	expectJson?: boolean;
	role?: string;
}

/** Build the `application/rocketride-question` body for a chat-source pipeline. */
export function buildChatBody(params: ChatParams): BuiltBody {
	const question: IDataObject = {
		type: 'question',
		questions: [{ text: params.question ?? '' }],
		expectJson: params.expectJson === true,
	};
	if (params.role && params.role.trim() !== '') {
		question.role = params.role;
	}
	return { body: JSON.stringify(question), contentType: 'application/rocketride-question' };
}

// Per-object bookkeeping keys that are not pipeline lane output.
const INTERNAL_OBJECT_KEYS = new Set(['status', 'result_types']);

/**
 * Normalize a RocketRide result envelope into an ergonomic, lane-key-agnostic shape.
 *
 * RocketRide names output lanes dynamically (e.g. `chat_response`, not `answers`), so
 * this never hard-codes lane names — the documented KeyError pitfall. For the common
 * single-object response it lifts the lane values to the top level; for multi-object
 * responses it returns the `objects` map. Counts and `resultTypes` are preserved under
 * `_rocketride`.
 */
export function normalizeRunResult(data: IDataObject): IDataObject {
	const objects =
		data && typeof data.objects === 'object' && data.objects ? (data.objects as IDataObject) : null;
	if (!objects) {
		return data;
	}

	const objectKeys = Object.keys(objects);
	const meta: IDataObject = {
		objectsRequested: data.objectsRequested ?? null,
		objectsCompleted: data.objectsCompleted ?? null,
		resultTypes: (data.resultTypes as IDataObject) ?? {},
	};

	if (objectKeys.length === 1) {
		const only = objects[objectKeys[0]];
		const lanes: IDataObject = {};
		if (only && typeof only === 'object') {
			for (const [key, value] of Object.entries(only as IDataObject)) {
				if (!INTERNAL_OBJECT_KEYS.has(key)) {
					lanes[key] = value;
				}
			}
		}
		return { ...lanes, _rocketride: { ...meta, object: objectKeys[0] } };
	}

	return { objects, _rocketride: meta };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const CONNECTION_ERROR_RE =
	/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNABORTED|EHOSTUNREACH|getaddrinfo|fetch failed|socket hang up|network/i;

/** Whether a base URL points at the local machine (where container boundaries bite). */
export function isLocalHostUrl(baseUrl: string): boolean {
	try {
		return LOCAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** Whether an error looks like a network/connection failure (vs an HTTP error response). */
export function isConnectionError(error: unknown): boolean {
	const e = error as { message?: string; code?: string; cause?: { code?: string; message?: string } };
	const text = `${e?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
	return CONNECTION_ERROR_RE.test(text);
}

/** Turn a connection failure into an actionable, deploy-aware message. */
export function reachabilityMessage(baseUrl: string, detail: string): string {
	const base = `Could not reach RocketRide at ${baseUrl} (${detail}).`;
	if (isLocalHostUrl(baseUrl)) {
		return (
			`${base} If RocketRide is on the same machine, use http://127.0.0.1:<port> instead of "localhost" — ` +
			'n8n may resolve localhost to IPv6 (::1), which a local engine does not listen on. ' +
			'If RocketRide or n8n runs in a container, "localhost" points at the container, not the host: ' +
			'use http://host.docker.internal:5567 (Docker Desktop), add `extra_hosts: ["host.docker.internal:host-gateway"]` ' +
			'on Linux, or run both on the same Docker network.'
		);
	}
	return `${base} Check the Base URL and that the RocketRide gateway is running and reachable.`;
}

/**
 * Parse a RocketRide gateway response into a plain object for n8n.
 *
 * The gateway wraps results as
 * `{ status, data: { objectsRequested, objectsCompleted, resultTypes, objects } }`.
 * Returns the inner `data` payload when present, otherwise the parsed body.
 * (Lane-level normalization of `objects`/`resultTypes` is layered on in a later phase.)
 */
export function parseRocketRideResponse(raw: unknown): IDataObject {
	let parsed: unknown = raw;

	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { result: raw };
		}
	}

	if (parsed && typeof parsed === 'object') {
		const obj = parsed as IDataObject;
		if ('data' in obj && obj.data && typeof obj.data === 'object') {
			return obj.data as IDataObject;
		}
		return obj;
	}

	return { result: parsed as GenericValue };
}
