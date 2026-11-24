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
 * @returns The validated URL (for fluent use).
 * @throws When the URL is unparseable or its scheme is not allowlisted.
 */
export function assertExternalUrl(url: string): string {
	let scheme = '';
	try {
		scheme = new URL(url).protocol.replace(':', '').toLowerCase();
	} catch {
		/* unparseable — rejected below */
	}
	if (!(EXTERNAL_URL_SCHEMES as readonly string[]).includes(scheme)) {
		throw new Error(`Blocked external URL scheme: ${scheme || '(unparseable)'}`);
	}
	return url;
}
