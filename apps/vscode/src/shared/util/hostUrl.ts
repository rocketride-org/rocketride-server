// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Scheme-prepending rule mirrored from `RocketRideClient.normalizeUri()`, which
 * is what actually consumes the configured host URL (see
 * `connection.ts` → `new URL(RocketRideClient.normalizeUri(hostUrl))`).
 *
 * Kept as a local copy so this module stays pure and unit-testable without
 * pulling the SDK into the test run. If the SDK's rule changes, change it here.
 */
const HAS_SCHEME = /^[a-zA-Z]+:\/\//;

/**
 * Accepted-input examples for "this Host URL is unusable" messages. Shared so
 * every entry point quotes the same formats as {@link isValidHostUrl} accepts.
 */
export const HOST_URL_EXAMPLES = 'localhost:5565 or https://engine.example.com';

/**
 * Whether a user-entered Direct Connect host URL can form a usable HTTP(S) URL.
 *
 * Deliberately permissive: `normalizeUri()` accepts bare hosts (`localhost`,
 * `my-server:5565`) and supplies the scheme and the default port, so requiring a
 * scheme here would reject input the runtime handles fine.
 *
 * This rejects input that cannot address a host at all — empty/whitespace,
 * embedded spaces, a scheme with no host, and non-HTTP schemes. It cannot
 * reject a plausible-but-wrong hostname: `asdf` is a syntactically valid
 * single-label host, indistinguishable from `localhost`. Reachability is the
 * job of Test Connection, not of this check.
 */
export function isValidHostUrl(raw: string | undefined | null): boolean {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) {
		return false;
	}

	const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return false;
	}

	// The engine speaks HTTP(S); ws/wss are derived from it downstream.
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return false;
	}

	return url.hostname.length > 0;
}
