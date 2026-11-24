// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXTERNAL URL GUARD — the generic half of every `host.openExternal`
// =============================================================================
//
// Lives in the shell (not apps/shared) because the shell serves a default
// `host.openExternal` itself and cannot import from shared. shared re-exports
// it for the host apps. A dependency-free leaf, so the VS Code extension host
// can load it too.
// =============================================================================

/** The only URL schemes a host may open externally. */
export const EXTERNAL_URL_SCHEMES = ['https', 'http', 'mailto'] as const;

/**
 * Validates a realm-supplied external URL — the GENERIC half of every
 * `host.openExternal` implementation. A realm must never steer the host
 * into opening file:/vscode:/javascript:/custom-app URIs.
 *
 * @param url - The URL as received off the bus.
 * @returns The validated URL in its absolute form, so what is opened is
 *          what was checked: an opener that resolves the original text
 *          against its own page reads `https:example.com` as a path of
 *          that page, while the check read it as `https://example.com/`.
 * @throws When the URL is unparseable or its scheme is not allowlisted.
 */
export function assertExternalUrl(url: string): string {
	let parsed: URL | null = null;
	try {
		parsed = new URL(url);
	} catch {
		/* unparseable — rejected below */
	}
	const scheme = parsed ? parsed.protocol.replace(':', '').toLowerCase() : '';
	if (!parsed || !(EXTERNAL_URL_SCHEMES as readonly string[]).includes(scheme)) {
		throw new Error(`Blocked external URL scheme: ${scheme || '(unparseable)'}`);
	}
	return parsed.href;
}
