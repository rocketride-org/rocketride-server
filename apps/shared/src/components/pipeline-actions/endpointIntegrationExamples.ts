// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Builds copy-paste integration examples for the endpoint modal (curl, wget,
 * TypeScript, Python, raw HTTP). Supports webhook POST flows and UI-style
 * endpoints (chat/dropper) where auth can be passed as `?auth=` on the URL.
 *
 * A webhook's `Content-Type` selects which lane the engine delivers the body on,
 * so it is a choice the caller has to make, not boilerplate: a body sent on a
 * lane the pipeline does not read is accepted, answered `200 OK` and consumed by
 * nobody. Hence `WEBHOOK_PAYLOADS` — one entry per lane a plain POST can reach.
 */

export type IntegrationTabId = 'curl' | 'curlCmd' | 'powershell' | 'wget' | 'typescript' | 'python' | 'http';

export type WebhookPayloadId = 'json' | 'text' | 'raw';

export interface IWebhookPayload {
	id: WebhookPayloadId;
	/** Short label for the payload picker. */
	label: string;
	/** Lane the engine routes this Content-Type to, when a component reads it. */
	lane: string;
	contentType: string;
	/** Single-line request body to send. */
	body: string;
}

/**
 * The lanes a plain webhook POST can reach, and the Content-Type that selects each.
 *
 * Mirrors the engine's MIME → lane routing (`_determine_lane` in
 * `packages/ai/src/ai/modules/data/data_conn.py`). `application/octet-stream`
 * matches no typed branch there and falls through to the raw/tags lane, which is
 * what document-ingestion pipelines (parse, dropper-style) read.
 */
export const WEBHOOK_PAYLOADS: IWebhookPayload[] = [
	{ id: 'json', label: 'JSON', lane: 'json', contentType: 'application/json', body: '{"event":"test","message":"hello"}' },
	{ id: 'text', label: 'Text', lane: 'text', contentType: 'text/plain', body: 'hello from RocketRide' },
	{ id: 'raw', label: 'Raw bytes', lane: 'tags', contentType: 'application/octet-stream', body: 'hello from RocketRide' },
];

/** Returns the payload for `id`, falling back to JSON for an unknown value. */
export function getWebhookPayload(id?: WebhookPayloadId): IWebhookPayload {
	return WEBHOOK_PAYLOADS.find((payload) => payload.id === id) ?? WEBHOOK_PAYLOADS[0];
}

/**
 * Picks which payload a freshly opened panel should show, from the lanes the
 * running pipeline actually reads (published in the endpoint note).
 *
 * JSON wins when both are read, because it is the richer body and the
 * longstanding default; text is offered only when JSON would reach nobody.
 * With no lane information — an older engine, or a pipeline whose wiring could
 * not be read — the answer is JSON, matching the previous fixed behaviour.
 */
export function defaultWebhookPayloadId(lanes?: string[]): WebhookPayloadId {
	const read = new Set(lanes ?? []);
	if (read.has('json')) return 'json';
	if (read.has('text')) return 'text';
	return 'json';
}

/** Appends `?auth=` (or `&auth=`) so integrations can use the full URL without an Authorization header. */
export function appendAuthQueryParam(url: string, authKey: string): string {
	try {
		const u = new URL(url);
		u.searchParams.set('auth', authKey);
		return u.toString();
	} catch {
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}auth=${encodeURIComponent(authKey)}`;
	}
}

export interface IBuildIntegrationExamplesParams {
	endpointUrl: string;
	authKey: string;
	isWebhook: boolean;
	/** Which lane the webhook examples should target. Defaults to JSON. Ignored for chat/dropper. */
	payloadId?: WebhookPayloadId;
}

function parseHttpUrl(url: string): { host: string; pathWithQuery: string } {
	try {
		const u = new URL(url);
		return { host: u.host, pathWithQuery: `${u.pathname}${u.search}` };
	} catch {
		return { host: 'localhost', pathWithQuery: url };
	}
}

export function buildIntegrationExamples({ endpointUrl, authKey, isWebhook, payloadId }: IBuildIntegrationExamplesParams): Record<IntegrationTabId, string> {
	const urlWithAuth = appendAuthQueryParam(endpointUrl, authKey);
	const { host, pathWithQuery } = parseHttpUrl(endpointUrl);

	if (isWebhook) {
		const { contentType, body } = getWebhookPayload(payloadId);
		/** Escape double quotes for the body inside CMD `curl.exe ... -d "..."` */
		const bodyCmd = body.replace(/"/g, '\\"');
		/** PowerShell single-quoted strings escape a quote by doubling it. */
		const bodyPs = body.replace(/'/g, "''");
		const pythonAuthKey = authKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		// A JSON body reads better through each language's own JSON helper; the
		// text and raw payloads are plain strings and go out verbatim.
		const isJsonBody = contentType === 'application/json';
		const tsBody = isJsonBody ? `JSON.stringify(${body})` : JSON.stringify(body);
		const pythonBodyArg = isJsonBody ? `json=${body},` : `data=${JSON.stringify(body)},`;

		const curlBash = `curl -X POST "${endpointUrl}" \\
  -H "Content-Type: ${contentType}" \\
  -H "Authorization: Bearer ${authKey}" \\
  -d '${body}'`;

		const curlCmdOnly = `REM Use curl.exe so cmd does not use a PowerShell alias
curl.exe -X POST "${endpointUrl}" ^
  -H "Content-Type: ${contentType}" ^
  -H "Authorization: Bearer ${authKey}" ^
  -d "${bodyCmd}"`;

		const psInvoke = `$headers = @{
  Authorization = "Bearer ${authKey}"
}
$body = '${bodyPs}'
Invoke-RestMethod -Uri "${endpointUrl}" -Method Post -Headers $headers -ContentType "${contentType}" -Body $body`;

		return {
			curl: curlBash,
			curlCmd: curlCmdOnly,
			powershell: psInvoke,
			wget: `wget -qO- --method=POST "${endpointUrl}" \\
  --header='Content-Type: ${contentType}' \\
  --header='Authorization: Bearer ${authKey}' \\
  --body-data='${body}'`,
			typescript: `const res = await fetch("${endpointUrl}", {
  method: "POST",
  headers: {
    "Content-Type": "${contentType}",
    Authorization: "Bearer ${authKey}",
  },
  body: ${tsBody},
});
console.log(await res.text());`,
			python: `import requests

r = requests.post(
    "${endpointUrl}",
    headers={
        "Content-Type": "${contentType}",
        "Authorization": "Bearer ${pythonAuthKey}",
    },
    ${pythonBodyArg}
)
print(r.text)`,
			http: `POST ${pathWithQuery} HTTP/1.1
Host: ${host}
Content-Type: ${contentType}
Authorization: Bearer ${authKey}

${body}`,
		};
	}

	const getPath = parseHttpUrl(urlWithAuth);
	const curlUiBash = `curl -sS "${urlWithAuth}"`;
	const curlUiCmd = `REM URL already includes ?auth= — no Authorization header needed
curl.exe -sS "${urlWithAuth}"`;
	const psUiGet = `Invoke-RestMethod -Uri '${urlWithAuth.replace(/'/g, "''")}' -Method Get`;

	return {
		curl: `# Open in browser (optional — URL includes auth):
# ${urlWithAuth}

${curlUiBash}`,
		curlCmd: curlUiCmd,
		powershell: psUiGet,
		wget: `wget -qO- "${urlWithAuth}"`,
		typescript: `// Open UI with auth in the URL (recommended for embedded apps)
window.open("${urlWithAuth}", "_blank");

// Optional: fetch the HTML (usually not needed for chat UI)
const res = await fetch("${urlWithAuth}");
console.log(await res.text());`,
		python: `import webbrowser

webbrowser.open("${urlWithAuth}")`,
		http: `GET ${getPath.pathWithQuery} HTTP/1.1
Host: ${getPath.host}

`,
	};
}
