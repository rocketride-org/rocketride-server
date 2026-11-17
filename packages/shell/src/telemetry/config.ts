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
// Runtime telemetry config. The key and host arrive from the SERVER via the
// pre-auth probe (posthogPublishableKey / posthogHost on rrext_public_probe) —
// never from a build-time define, so one shell bundle serves every environment
// and no app bundle ever carries a key. Unset (OSS, no telemetry configured)
// means every telemetry path is a structural no-op. Set once at Shell mount,
// before the TelemetryHost initialises.
// =============================================================================

/** The probe-served telemetry config; null until the shell received the probe. */
export type TelemetryConfig = {
	/** The PostHog project token (`phc_*`); '' = telemetry off. */
	key: string;
	/** The analytics ingestion address every request goes to. */
	host: string;
	/**
	 * How the consent machinery decides whether capture is allowed:
	 * 'stored' follows the device's consent record (cloud); 'host' follows the
	 * embedding host's telemetry setting (VS Code) and never consults the
	 * record. Never combined.
	 */
	consentSource: 'stored' | 'host';
};

let config: TelemetryConfig | null = null;

/**
 * Install the probe-served config. Called once at Shell mount; a second call
 * is ignored (the page's instances are already keyed to the first).
 *
 * @param next - The config as the probe delivered it.
 */
export function setTelemetryConfig(next: TelemetryConfig): void {
	if (config === null) {
		config = next;
	}
}

/** @returns The installed config, or null before setTelemetryConfig (telemetry off). */
export function telemetryConfig(): TelemetryConfig | null {
	return config;
}

/** @returns The project token, or '' when telemetry is off. */
export function telemetryKey(): string {
	return config?.key ?? '';
}

/** @returns The ingestion address (meaningless without a key). */
export function telemetryHost(): string {
	return config?.host ?? '';
}

/**
 * The page's own scroller, by contract: every surface that scrolls an inner
 * column (not the window) tags it with this attribute, and scroll-depth
 * measurement reads against it. Shared shell/app contract, like
 * `data-rr-private` for replay masking.
 */
export const SCROLL_ROOT = '[data-rr-scroll-root]';
