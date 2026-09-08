// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Builds copy-paste integration examples for the endpoint modal (curl, wget,
 * TypeScript, Python, raw HTTP). Supports webhook POST flows and UI-style
 * endpoints (chat/dropper) where auth can be passed as `?auth=` on the URL.
 */

export type IntegrationTabId = 'curl' | 'curlCmd' | 'powershell' | 'wget' | 'typescript' | 'python' | 'http';

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
}

function parseHttpUrl(url: string): { host: string; pathWithQuery: string } {
	try {
		const u = new URL(url);
		return { host: u.host, pathWithQuery: `${u.pathname}${u.search}` };
	} catch {
		return { host: 'localhost', pathWithQuery: url };
	}
}

export function buildIntegrationExamples({ endpointUrl, authKey, isWebhook }: IBuildIntegrationExamplesParams): Record<IntegrationTabId, string> {
	const urlWithAuth = appendAuthQueryParam(endpointUrl, authKey);
	const { host, pathWithQuery } = parseHttpUrl(endpointUrl);
	const jsonOneLine = '{"event":"test","message":"hello"}';
	/** Escape double quotes for JSON inside CMD `curl.exe ... -d "..."` */
	const jsonOneLineCmd = jsonOneLine.replace(/"/g, '\\"');

	if (isWebhook) {
		const curlBash = `curl -X POST "${endpointUrl}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${authKey}" \\
  -d '${jsonOneLine}'`;

		const curlCmdOnly = `REM Use curl.exe so cmd does not use a PowerShell alias
curl.exe -X POST "${endpointUrl}" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer ${authKey}" ^
  -d "${jsonOneLineCmd}"`;

		const psInvoke = `$headers = @{
  Authorization = "Bearer ${authKey}"
}
$body = '${jsonOneLine}'
Invoke-RestMethod -Uri "${endpointUrl}" -Method Post -Headers $headers -ContentType "application/json" -Body $body`;

		return {
			curl: curlBash,
			curlCmd: curlCmdOnly,
			powershell: psInvoke,
			wget: `wget -qO- --method=POST "${endpointUrl}" \\
  --header='Content-Type: application/json' \\
  --header='Authorization: Bearer ${authKey}' \\
  --body-data='${jsonOneLine}'`,
			typescript: `const res = await fetch("${endpointUrl}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer ${authKey}",
  },
  body: JSON.stringify({ event: "test", message: "hello" }),
});
console.log(await res.text());`,
			python: `import requests

r = requests.post(
    "${endpointUrl}",
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer ${authKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",
    },
    json={"event": "test", "message": "hello"},
)
print(r.text)`,
			http: `POST ${pathWithQuery} HTTP/1.1
Host: ${host}
Content-Type: application/json
Authorization: Bearer ${authKey}

${jsonOneLine}`,
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
