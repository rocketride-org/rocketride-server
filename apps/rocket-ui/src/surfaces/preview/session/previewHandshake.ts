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
// PREVIEW HANDSHAKE — how the builder answers a dev preview realm
// =============================================================================

/**
 * The App Builder's Design preview, its debug tab and the agent's hidden
 * preview speak one protocol, kept here so the copies cannot drift. A dev
 * shell posts shell:devReady and waits for rrdev:auth (its token store is
 * frame-local in-memory); the session then adopts it as the injection target.
 */

import type { WebDevSession } from './devSession';

/** Whether a posted message is an object, so its fields can be read. */
function isMessage(data: unknown): data is Record<string, unknown> {
	return typeof data === 'object' && data !== null;
}

/**
 * Answers one message from a dev preview realm. On shell:devReady it posts rrdev:auth with the token and adopts
 * the realm, and the returned promise settles when the realm's first build has run. Any other message feeds
 * the session and returns null. The provider keeps its own rrdev:signedOut branch ahead of this.
 *
 * @param session - The dev session that injects into the realm.
 * @param source - The realm that posted the message; the caller has checked it is its own preview.
 * @param data - The posted message.
 * @param token - The session to answer with ('' = signed out), read on each devReady.
 * @returns The first build's promise on shell:devReady, else null.
 */
export function answerPreviewMessage(session: WebDevSession, source: Window, data: unknown, token: () => string): Promise<void> | null {
	if (!isMessage(data)) return null;
	if (data.type === 'shell:devReady') {
		// step: ALWAYS answer with the definitive session state ('' = signed
		// out) so any embedded dev shell boots authenticated
		source.postMessage({ type: 'rrdev:auth', token: token() }, window.location.origin);
		return session.attachPreview(source);
	}
	session.handlePreviewMessage(data);
	return null;
}
