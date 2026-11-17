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
// rocketride/analytics — bound per-app event reporters
// =============================================================================
//
// Bare bones. A HOST (the shell) mints one reporter per app with
// `createReporter(app, sink)` and hands it over; the app calls
// `report(event, props, options?)` with any string event and a free-form props
// bag — event names are NOT constrained to a central list; each app owns its
// own taxonomy. Every reported event carries `app`, closed over at creation,
// so a late event from a backgrounded app still names its true emitter —
// there is deliberately NO module-global "current app" state to re-point.
// Nothing else lives here.
// =============================================================================

/**
 * Per-call capture options a sink may honor. `transport: 'sendBeacon'` asks
 * for delivery that survives the page being torn down a moment later (a CTA
 * that starts an OAuth redirect); `timestamp` back-dates a replayed event to
 * when it was observed; `uuid` makes a capture idempotent so an at-least-once
 * replay dedupes instead of double-counting.
 */
export type SendOptions = { transport?: 'sendBeacon'; timestamp?: Date; uuid?: string };

/** The transport a host wires a reporter to (e.g. the shell's capture queue). */
export type ReportSink = (event: string, props?: Record<string, unknown>, options?: SendOptions) => void;

/** The bound report function an app receives: its `app` stamp is fixed at creation. */
export type Reporter = (event: string, props?: Record<string, unknown>, options?: SendOptions) => void;

/**
 * Mint the bound reporter for one app.
 *
 * The returned function stamps `app` last (caller props can never overwrite
 * the emitting-app id), ignores non-string or empty event names, and never
 * throws — telemetry must never break the app.
 *
 * @param app - The emitting app's id, fixed for the reporter's lifetime.
 * @param sink - The transport events go to.
 * @returns The app's `report(event, props?, options?)`.
 */
// The analytics-consent RECORD contract (key, shape, pure parser) — the one
// cross-boundary storage format sign-in-path readers parse without booting
// any analytics. Writing consent stays the shell's alone.
export { CONSENT_KEY, CONSENT_TTL_MS, CONSENT_VERSION, parseConsent, privacySignalOn, type ConsentChoice, type ConsentRecord, type ConsentState } from './consent.js';

export function createReporter(app: string, sink: ReportSink): Reporter {
	return (event, props, options) => {
		if (typeof event !== 'string' || !event) return; // string-ish enforcement, nothing stricter
		try {
			// Stamp last so caller props can never overwrite the emitting-app id.
			sink(event, { ...props, app }, options);
		} catch {
			// Telemetry must never break the app.
		}
	};
}
