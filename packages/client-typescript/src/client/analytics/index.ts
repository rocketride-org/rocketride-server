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
// rocketride/analytics — the one shared event-report function
// =============================================================================
//
// Bare bones. Every app calls `report(event, props)` with any string event and a
// free-form props bag — event names are NOT constrained to a central list; each
// app owns its own taxonomy. The transport and the emitting app's id are
// injected once per app via `initReport(app, sink)` — home-ui wires
// `posthog.capture`, the product/VS Code side wires `client.report()`. Every
// reported event carries `app` so downstream can tell which app emitted it.
// Nothing else lives here.
// =============================================================================

export type ReportSink = (event: string, props?: Record<string, unknown>) => void;

let _sink: ReportSink = () => {};
let _app = '';

/** Wire the emitting app id + transport once, at app init (e.g. `initReport('home-ui', posthog.capture)`). */
export function initReport(app: string, sink: ReportSink): void {
	_app = app;
	_sink = sink;
}

/**
 * The shared loose event report — any non-empty string event, free-form props.
 * Stamps `app` (from initReport) on every event. Never throws.
 */
export function report(event: string, props?: Record<string, unknown>): void {
	if (typeof event !== 'string' || !event) return; // string-ish enforcement, nothing stricter
	try {
		// Stamp last so caller props can never overwrite the emitting-app id.
		_sink(event, { ...props, app: _app });
	} catch {
		// Telemetry must never break the app.
	}
}
