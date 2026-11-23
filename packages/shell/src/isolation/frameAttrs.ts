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

// =============================================================================
// FRAME ATTRIBUTES — the exact iframe an isolated app gets (PR2b, plan §3.3)
// =============================================================================
//
// The frame's `src` is the app origin plus the ticket path only
// (`/_rr/frame.html[?c=<ticket>]`); the frame token never appears in it. An app
// origin that is same-site with any shell origin gets no frame (`null`): the
// separation would be void. The site test is deliberately coarse (the last two
// host labels, the whole host for IPs and single labels), so a public suffix
// like `co.uk` errs towards `null`.
// =============================================================================

/** The exact attributes of an isolated app frame. */
export type IFrameAttributes = {
	src: string;
	sandbox: string;
	allow: string;
	referrerPolicy: 'no-referrer';
	title: string;
};

/** The app frame's sandbox: no navigation, popup or modal right. */
export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads';

/** The logout sweep frame: a non-opaque origin, so `/_rr/clear` sees `Sec-Fetch-Site: same-origin`. */
export const SWEEP_SANDBOX = 'allow-scripts allow-same-origin';

const FRAME_PATH_RE = /^\/_rr\/frame\.html(?:\?c=[A-Za-z0-9._-]+)?$/;

function pureOrigin(raw: string): URL | null {
	try {
		const u = new URL(raw);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
		if (u.origin !== raw) return null;
		return u;
	} catch {
		return null;
	}
}

/** The site of a host: the last two labels; the whole host for an IP or a single label. */
export function siteOf(hostname: string): string {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return host;
	const labels = host.split('.');
	return labels.length <= 2 ? host : labels.slice(-2).join('.');
}

/** True when the two hosts share a site (fail closed: unparsable counts as same-site). */
export function sameSite(a: string, b: string): boolean {
	return siteOf(a) === siteOf(b);
}

/** The attributes for an app frame, or `null` when it must not be framed. */
export function frameAttributes(origin: string, framePath: string, shellOrigins: readonly string[], title: string): IFrameAttributes | null {
	if (typeof framePath !== 'string' || !FRAME_PATH_RE.test(framePath)) return null;
	const app = pureOrigin(origin);
	if (!app) return null;
	for (const s of shellOrigins) {
		let shell: URL;
		try {
			shell = new URL(s);
		} catch {
			return null;
		}
		if (sameSite(app.hostname, shell.hostname)) return null;
	}
	return {
		src: app.origin + framePath,
		sandbox: FRAME_SANDBOX,
		allow: 'clipboard-write',
		referrerPolicy: 'no-referrer',
		title: String(title),
	};
}
