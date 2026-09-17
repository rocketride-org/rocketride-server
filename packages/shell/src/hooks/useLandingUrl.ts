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
// USE LANDING URL — what the visitor arrived with
// =============================================================================

import { getLandingUrl, type LandingUrl } from '../util/landingUrl';

/**
 * The URL this document was opened with, snapshotted in bootstrap before the
 * shell rewrote it (the OAuth callback and the connect path both strip the
 * query string).
 *
 * Deliberately NOT stateful: the snapshot is frozen for the life of the
 * document, so there is nothing to subscribe to and no re-render to trigger.
 * Read it whenever you need it.
 *
 * An app reading a campaign or referral parameter is responsible for its own
 * privacy posture — the capture is unconditional, so honour Global Privacy
 * Control (`navigator.globalPrivacyControl`) and skip automated browsers
 * (`navigator.webdriver`) on this side if that matters for your use.
 *
 * @returns The landing-URL snapshot; empty when nothing was captured.
 *
 * @example
 * ```tsx
 * const landing = useLandingUrl();
 * const ref = landing.params.ref;   // ?ref=... as the visitor arrived
 * ```
 */
export function useLandingUrl(): LandingUrl {
	return getLandingUrl();
}

export default useLandingUrl;
