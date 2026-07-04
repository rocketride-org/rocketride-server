// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PKCE — Client-side OAuth PKCE utilities
// Browser-only (uses crypto.subtle and fetch).
//
// Flow:
//   1. generatePkce()    → { verifier, challenge }
//   2. buildAuthUrl(...) → redirect browser here
//   3. Server does the exchange via cd_ credential in connectClient()
// =============================================================================

// =============================================================================
// TYPES
// =============================================================================

/**
 * A PKCE code_verifier / code_challenge pair produced by generatePkce().
 * The verifier is the secret random value kept by the client; the challenge
 * is its SHA-256 hash (base64url-encoded) sent to the authorization server.
 */
export interface PkceChallenge {
    verifier: string;
    challenge: string;
}

// =============================================================================
// STORAGE KEYS
// =============================================================================

// SessionStorage key used to persist the PKCE verifier across the OAuth
// redirect. SessionStorage is intentionally scoped to the browser tab so
// the verifier cannot be read by other tabs or be present after the session ends.
const PKCE_VERIFIER_KEY = 'rr:pkce_verifier';

// =============================================================================
// PKCE GENERATION
// =============================================================================

/**
 * Encode an ArrayBuffer as a base64url string (no padding, URL-safe characters).
 *
 * Base64url differs from standard base64 in three ways:
 *   - `+` → `-`
 *   - `/` → `_`
 *   - trailing `=` padding is stripped
 *
 * This encoding is required by the PKCE spec (RFC 7636).
 *
 * @param buffer - Raw binary data to encode.
 * @returns Base64url-encoded string.
 */
function base64UrlEncode(buffer: ArrayBuffer): string {
    // Convert the ArrayBuffer into a plain byte array for character-level access.
    const bytes = new Uint8Array(buffer);

    // Build a binary string by mapping each byte to its corresponding character.
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);

    // Use btoa() for standard base64, then replace characters that are not
    // URL-safe and strip the `=` padding characters.
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a PKCE code_verifier and code_challenge pair.
 * Stores the verifier in sessionStorage for retrieval after the redirect.
 *
 * The verifier is a cryptographically random 64-byte value encoded as
 * base64url (producing a ~86-character string). The challenge is the
 * SHA-256 hash of the verifier, also base64url-encoded.
 *
 * @returns A promise that resolves to a PkceChallenge with both values.
 */
export async function generatePkce(): Promise<PkceChallenge> {
    // Allocate a 64-byte typed array and fill it with cryptographically
    // secure random values using the Web Crypto API.
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);

    // Encode the random bytes as a base64url string to form the verifier.
    const verifier = base64UrlEncode(array.buffer);

    // Encode the verifier string as UTF-8 bytes so it can be hashed.
    const encoded = new TextEncoder().encode(verifier);

    // Compute SHA-256 of the encoded verifier. crypto.subtle.digest returns
    // an ArrayBuffer containing the 32-byte hash.
    const digest = await crypto.subtle.digest('SHA-256', encoded);

    // Encode the raw hash bytes as base64url to form the code_challenge.
    const challenge = base64UrlEncode(digest);

    // Persist the verifier in sessionStorage so it survives the browser
    // redirect to the Zitadel authorization endpoint and back.
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);

    return { verifier, challenge };
}

/**
 * Retrieve the stored PKCE verifier (set before the OAuth redirect).
 * Returns null if not found or expired.
 *
 * Called after the authorization server redirects back to the app so that
 * the verifier can be included in the token exchange request.
 *
 * @returns The verifier string, or null if it was never stored or has been cleared.
 */
export function getStoredVerifier(): string | null {
    // Read the previously stored verifier from sessionStorage.
    // Returns null if the key does not exist (e.g., the tab was closed
    // between the initial navigation and the redirect callback).
    return sessionStorage.getItem(PKCE_VERIFIER_KEY);
}

/**
 * Clear the stored PKCE verifier after use.
 *
 * Should be called immediately after the verifier has been forwarded to
 * connectClient() to prevent replay attacks and keep sessionStorage tidy.
 */
export function clearStoredVerifier(): void {
    // Remove the verifier entry from sessionStorage so it cannot be reused.
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}

// =============================================================================
// AUTH URL
// =============================================================================

/**
 * Build the Zitadel authorization URL for the PKCE flow.
 *
 * Constructs a query string with all required OAuth 2.0 / OIDC parameters
 * and appends it to the Zitadel /oauth/v2/authorize endpoint. Redirecting
 * the browser to this URL begins the authorization code flow.
 *
 * @param zitadelUrl    - Zitadel base URL (e.g. https://auth.rocketride.ai)
 * @param clientId      - Zitadel application client ID
 * @param redirectUri   - Where Zitadel redirects after auth (typically window.location.origin)
 * @param challenge     - PKCE code_challenge (from generatePkce)
 * @param register      - If true, shows signup form instead of login form
 * @returns The fully formed authorization URL string ready for browser navigation.
 */
export function buildAuthUrl(
    zitadelUrl: string,
    clientId: string,
    redirectUri: string,
    challenge: string,
    register = false,
): string {
    // Assemble the standard OAuth 2.0 authorization request parameters.
    // The scope includes openid and profile for basic identity, email and phone
    // for contact info, offline_access for refresh tokens, and the Zitadel-specific
    // audience scope so the resulting token is accepted by the RocketRide API.
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile email phone offline_access urn:zitadel:iam:org:project:id:zitadel:aud',
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });

    // register -> sign-up form; otherwise force the login UI (prompt=login) so
    // Zitadel never silently reuses its SSO session and blocks switching accounts.
    if (register) params.set('prompt', 'create');
    else params.set('prompt', 'login');

    // Strip any trailing slash from the base URL before appending the path
    // to avoid a double-slash in the resulting URL.
    return `${zitadelUrl.replace(/\/$/, '')}/oauth/v2/authorize?${params}`;
}
