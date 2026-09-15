/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * PKCE sign-in helpers shared by RocketRide client front-ends.
 *
 * The transport of the redirect differs per consumer (the CLI listens on
 * a loopback port; the VS Code extension registers a `vscode://` URI
 * handler) — but the verifier/challenge generation, the authorize-URL
 * construction, and the `cd_` credential encoding are identical, and
 * live here.
 *
 * Behavioral twin of `client-common/python`'s `pkce.py`.
 */

import * as crypto from 'crypto';

/** Scope requested for the PKCE authorization. */
export const OAUTH_SCOPE = 'openid profile email phone offline_access urn:zitadel:iam:org:project:id:zitadel:aud';

/**
 * Generate a PKCE verifier and its S256 challenge.
 *
 * @returns The base64url verifier and challenge pair.
 */
export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = crypto.randomBytes(64).toString('base64url');
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

/**
 * Build the Zitadel authorize URL for a PKCE flow.
 *
 * `prompt=login` is forced so browser SSO reuse cannot silently pick the
 * wrong account when switching users.
 *
 * @param zitadelUrl - Base URL of the Zitadel instance.
 * @param clientId - OAuth public client id.
 * @param redirectUri - The consumer's redirect target.
 * @param challenge - The S256 code challenge.
 * @returns The full authorize URL to open in a browser.
 */
export function buildAuthorizeUrl(zitadelUrl: string, clientId: string, redirectUri: string, challenge: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		prompt: 'login',
	});
	return `${zitadelUrl.replace(/\/$/, '')}/oauth/v2/authorize?${params}`;
}

/**
 * Encode the PKCE grant triple as the server's `cd_` DAP credential.
 *
 * The server decodes this from the `auth` field, performs the Zitadel
 * token exchange itself, and returns an rr_* session key — no OAuth
 * token ever reaches the client.
 *
 * @param grant - The code, verifier, and exact redirect URI used.
 * @returns The `cd_`-prefixed credential string.
 */
export function encodeCdCredential(grant: { code: string; verifier: string; redirectUri: string }): string {
	return 'cd_' + Buffer.from(JSON.stringify(grant), 'utf-8').toString('base64');
}
