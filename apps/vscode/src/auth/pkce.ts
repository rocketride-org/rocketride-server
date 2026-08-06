// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PKCE — Node.js OAuth PKCE utilities for VS Code extension.
 *
 * Generates code_verifier / code_challenge pairs and builds the Zitadel
 * authorization URL. Uses Node.js crypto instead of Web Crypto API.
 *
 * Flow:
 *   1. generatePkce()    → { verifier, challenge }
 *   2. buildAuthUrl(...) → open this URL in browser
 *   3. URI handler receives code → send { code, verifier, redirectUri } to server
 */

import * as crypto from 'crypto';

// =============================================================================
// TYPES
// =============================================================================

export interface PkceChallenge {
	verifier: string;
	challenge: string;
}

// =============================================================================
// PKCE GENERATION
// =============================================================================

/**
 * Encode a Buffer as a base64url string (no padding, URL-safe characters).
 */
function base64UrlEncode(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a PKCE code_verifier and code_challenge pair.
 *
 * The verifier is a cryptographically random 64-byte value encoded as
 * base64url. The challenge is the SHA-256 hash of the verifier, also
 * base64url-encoded.
 */
export function generatePkce(): PkceChallenge {
	const verifier = base64UrlEncode(crypto.randomBytes(64));
	const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

// =============================================================================
// AUTH URL
// =============================================================================

/**
 * Build the Zitadel authorization URL for the PKCE flow.
 *
 * @param zitadelUrl  - Zitadel base URL (e.g. https://auth.rocketride.ai)
 * @param clientId    - Zitadel application client ID
 * @param redirectUri - Where Zitadel redirects after auth (vscode:// URI)
 * @param challenge   - PKCE code_challenge (from generatePkce)
 */
export function buildAuthUrl(zitadelUrl: string, clientId: string, redirectUri: string, challenge: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'openid profile email phone offline_access urn:zitadel:iam:org:project:id:zitadel:aud',
		code_challenge: challenge,
		code_challenge_method: 'S256',
	});

	return `${zitadelUrl.replace(/\/$/, '')}/oauth/v2/authorize?${params}`;
}
