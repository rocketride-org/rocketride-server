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
 * Shared product telemetry for RocketRide.
 *
 * Lives in the client SDK so BOTH the web shell and the VS Code extension use
 * the exact same reporting path (per the 2026-07-01 telemetry review). Transport
 * is a plain HTTPS POST to our first-party PostHog proxy (e.rocketride.ai), so it
 * has no browser-only or Node-only dependency and behaves identically in the
 * browser and in the extension host.
 *
 * Privacy-first: explicit events only (there is no autocapture or session
 * replay by construction — we only ever send what a call site passes), PII /
 * free-content property keys are stripped before send, and an `enabled` gate the
 * host controls suppresses all capture when the user has opted out (the VS Code
 * extension wires this to `vscode.env.isTelemetryEnabled`).
 *
 * Send ONLY structural metadata (node types, counts, durations) — never node
 * config, pipeline content, or user data.
 */

export interface TelemetryConfig {
	/** PostHog public project key (`phc_…`). Telemetry is a no-op without it. */
	apiKey?: string;
	/** First-party ingest host. Defaults to the CloudFront proxy. */
	apiHost?: string;
	/** Stable id for this user/device; the host supplies one it can persist. */
	distinctId?: string;
	/**
	 * Gate the host controls — return `false` to suppress all capture. The VS
	 * Code extension passes `() => vscode.env.isTelemetryEnabled`. Defaults to on.
	 */
	enabled?: () => boolean;
}

type Props = Record<string, unknown>;

// Minimal local fetch typing so this compiles regardless of the SDK's tsconfig
// `lib` (no dependency on the DOM lib). `fetch` is a runtime global in browsers
// and in Node 18+ / the VS Code extension host.
type FetchInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	keepalive?: boolean;
};
type FetchFn = (input: string, init?: FetchInit) => Promise<unknown>;

// Property keys we never let leave the process — a backstop to the
// "structural metadata only, never config/content" rule.
const PII_KEYS = new Set([
	'email', 'name', 'first_name', 'last_name', 'phone', 'password', 'token',
	'api_key', 'apikey', 'secret', 'authorization', 'content', 'config', 'value',
	'input', 'output', 'prompt', 'text', 'body',
]);

function sanitize(props: Props): Props {
	const out: Props = {};
	for (const [k, v] of Object.entries(props)) {
		if (!PII_KEYS.has(k.toLowerCase())) out[k] = v;
	}
	return out;
}

/**
 * Framework-agnostic telemetry client. Hosts call {@link Telemetry.configure}
 * once at startup, then {@link Telemetry.report} anywhere. A shared singleton
 * ({@link telemetry}) and a free {@link report} function are exported below.
 */
export class Telemetry {
	private apiKey?: string;
	private apiHost = 'https://e.rocketride.ai';
	private distinctId = 'anonymous';
	private isEnabled: () => boolean = () => true;
	private superProps: Props = {};
	private ready = false;

	/** Configure once per host. No-op (stays disabled) when no key is provided. */
	configure(cfg: TelemetryConfig): void {
		if (!cfg.apiKey) return;
		this.apiKey = cfg.apiKey;
		if (cfg.apiHost) this.apiHost = cfg.apiHost.replace(/\/+$/, '');
		if (cfg.distinctId) this.distinctId = cfg.distinctId;
		if (cfg.enabled) this.isEnabled = cfg.enabled;
		this.ready = true;
	}

	/** Context sent with every event (app id/name, surface, version, org). */
	register(props: Props): void {
		this.superProps = { ...this.superProps, ...props };
	}

	/** Tie subsequent events to a signed-in user. */
	identify(distinctId: string): void {
		if (distinctId) this.distinctId = distinctId;
	}

	/**
	 * Report a product event. Use PostHog `category:object_action` naming, e.g.
	 * `pipeline:run`. Fire-and-forget; never throws and never blocks the app.
	 */
	report(event: string, properties: Props = {}): void {
		if (!this.ready || !this.apiKey || !this.isEnabled()) return;
		const f = (globalThis as { fetch?: FetchFn }).fetch;
		if (!f) return;
		const payload = {
			api_key: this.apiKey,
			event,
			distinct_id: this.distinctId,
			properties: { ...this.superProps, ...sanitize(properties) },
			timestamp: new Date().toISOString(),
		};
		void f(`${this.apiHost}/i/v0/e/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			keepalive: true,
		}).catch(() => {
			/* telemetry must never disrupt the app */
		});
	}

	/** Whether capture is currently active (configured + keyed + not opted out). */
	get active(): boolean {
		return this.ready && !!this.apiKey && this.isEnabled();
	}
}

/** Shared instance — configure once per host, then report from anywhere. */
export const telemetry = new Telemetry();

/** Convenience free function bound to the shared {@link telemetry} instance. */
export function report(event: string, properties?: Props): void {
	telemetry.report(event, properties);
}

/**
 * Canonical events from the telemetry review. `node_types` is the headline
 * node-usage metric — TYPES ONLY, never config.
 */
export const telemetryEvents = {
	pipelineRun: (p: {
		node_types: string[];
		node_count?: number;
		duration_ms?: number;
		status?: string;
		surface?: string;
	}) => report('pipeline:run', p),
	nodeAdd: (p: { node_type: string }) => report('pipeline:node_add', p),
	nodeRemove: (p: { node_type: string }) => report('pipeline:node_remove', p),
	appOpen: () => report('app:open'),
};
