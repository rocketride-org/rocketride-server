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
 * Protocol layer for the chat widget — a UI-free wrapper around the workspace
 * 'rocketride' TypeScript SDK.
 *
 * AUTH MODEL (security-critical): the widget authenticates with the pipeline's
 * PUBLIC auth key only — the same `{host}/chat?auth={public_auth}` credential
 * the chat source node publishes for end users. NEVER configure the widget
 * with an engine API key or any private token: the auth value is embedded in
 * the host page and is visible to every visitor. The public key both
 * authenticates the WebSocket connection and addresses the pipeline
 * (`client.chat({ token })`), mirroring apps/chat-ui.
 *
 * TRANSPORT SECURITY (security-critical): the SDK maps a non-TLS engine URI to
 * a plain `ws:` socket (see `RocketRideClient._getWebsocketUri`), which would
 * put the auth key and the whole conversation on the wire in cleartext. This
 * module therefore refuses cleartext for anything but loopback development
 * hosts — see {@link assertSecureEngineUrl}.
 *
 * Reconnection is owned by the SDK (`persist: true`): after a drop it retries
 * with linear backoff and never gives up; this class only translates the SDK
 * callbacks into UI-friendly state changes.
 *
 * @module connection
 */

import { ConnectionException, PIPELINE_RESULT, Question, QuestionType, RocketRideClient, RocketRideClientConfig } from 'rocketride';
import { ChatClientFactory, ChatClientLike, ChatHistoryItem, ConnectionState } from './types';

/** Maximum number of prior messages replayed to the pipeline for context (mirrors apps/chat-ui). */
export const HISTORY_LIMIT = 6;

/** Rejection message handed to an {@link WidgetConnection.ask} that {@link WidgetConnection.disconnect} closed the transport under. */
export const ASK_ABANDONED_MESSAGE = 'The connection was closed before the pipeline answered — please try again.';

/** Options for {@link WidgetConnection}. */
export interface WidgetConnectionOptions {
	/**
	 * Engine URL, e.g. `https://engine.example.com` (normalised by the SDK).
	 * Must be TLS (`https:`/`wss:`) unless it points at a loopback host — see
	 * {@link assertSecureEngineUrl}.
	 */
	engineUrl: string;
	/**
	 * The pipeline's PUBLIC auth key — the `?auth=` value from the chat source
	 * node's published link. Never an engine API key or private token.
	 */
	auth: string;
	/** Notified whenever the connection state changes. `detail` carries the error/disconnect reason. */
	onStateChange?: (state: ConnectionState, detail?: string) => void;
	/**
	 * Notified with live pipeline status ('thinking') lines while a question is
	 * processed. Used only for {@link WidgetConnection.ask} calls that pass no
	 * per-request status callback: status belongs to one request, and a caller
	 * with more than one in flight has to receive it per request to know whose
	 * it is.
	 */
	onStatus?: (text: string) => void;
	/** Client factory override for headless unit tests. Defaults to the real SDK client. */
	createClient?: ChatClientFactory;
}

/**
 * Extracts displayable answer texts from a pipeline result.
 *
 * `result_types` maps dynamic field names to data types; fields typed 'text'
 * or 'answers' hold displayable strings (either directly, as arrays, or as
 * `{ answer: string }` objects). Mirrors apps/chat-ui/src/utils/pipelineUtils.
 *
 * @param result - Pipeline result returned by `client.chat()` (narrowed defensively)
 * @returns Answer strings in result order (empty when the pipeline returned none)
 */
export function extractAnswerTexts(result: PIPELINE_RESULT | unknown): string[] {
	const texts: string[] = [];
	if (!result || typeof result !== 'object') {
		return texts;
	}
	const pipelineResult = result as PIPELINE_RESULT;
	if (!pipelineResult.result_types || typeof pipelineResult.result_types !== 'object') {
		return texts;
	}

	for (const [fieldName, fieldType] of Object.entries(pipelineResult.result_types)) {
		if (fieldType !== 'text' && fieldType !== 'answers') {
			continue;
		}
		const fieldData: unknown = pipelineResult[fieldName];
		if (Array.isArray(fieldData)) {
			for (const item of fieldData) {
				if (typeof item === 'string' && item.trim()) {
					texts.push(item);
				}
			}
		} else if (typeof fieldData === 'string' && fieldData.trim()) {
			texts.push(fieldData);
		} else if (typeof fieldData === 'object' && fieldData !== null && typeof (fieldData as Record<string, unknown>).answer === 'string') {
			// Answer objects arrive as { answer: string, expectJson: bool }.
			const answer = ((fieldData as Record<string, unknown>).answer as string).trim();
			if (answer) {
				texts.push(answer);
			}
		}
	}

	return texts;
}

/** Schemes the widget accepts in `engineUrl`; anything else is a configuration error. */
const ACCEPTED_SCHEMES = new Set(['https:', 'wss:', 'http:', 'ws:']);

/** Schemes that encrypt the transport; the rest are cleartext. */
const SECURE_SCHEMES = new Set(['https:', 'wss:']);

/**
 * True for hostnames that never leave the machine, so cleartext is acceptable
 * there: `localhost` (and any `*.localhost` subdomain, which RFC 6761 reserves
 * for loopback), the whole `127.0.0.0/8` range, and the IPv6 loopback.
 *
 * @param hostname - `URL.hostname` (IPv6 literals arrive without brackets)
 */
function isLoopbackHost(hostname: string): boolean {
	// URL.hostname keeps the brackets off IPv6 literals, but be defensive.
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Rejects an engine URL whose transport would carry the auth key and the
 * conversation in cleartext.
 *
 * The SDK downgrades silently: `RocketRideClient.normalizeUri` prefixes a
 * scheme-less URI with `http://`, and `_getWebsocketUri` turns anything that is
 * not `https:`/`wss:` into a plain `ws:` socket. A widget is embedded in
 * arbitrary third-party pages, so that downgrade has to be caught here rather
 * than left to the operator: `https:`/`wss:` is required for every host except
 * loopback, where cleartext stays allowed for local development (the demo page
 * and `http://localhost:5565` keep working unchanged).
 *
 * @param engineUrl - The configured engine URL, exactly as the embedder wrote it
 * @throws Error when the URL is unparseable, uses an unsupported scheme, or is
 *   cleartext against a non-loopback host
 */
export function assertSecureEngineUrl(engineUrl: string): void {
	const raw = engineUrl.trim();
	// Mirror the SDK's scheme defaulting so a bare 'engine.example:5565' is
	// judged as the http:// URL the SDK will actually build from it.
	const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `http://${raw}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`WidgetConnection: engineUrl is not a valid URL (${engineUrl}).`);
	}

	if (!ACCEPTED_SCHEMES.has(url.protocol)) {
		throw new Error(`WidgetConnection: unsupported engineUrl scheme "${url.protocol}" — use https:// or wss:// (http:// and ws:// are accepted for loopback hosts only).`);
	}
	if (SECURE_SCHEMES.has(url.protocol) || isLoopbackHost(url.hostname)) {
		return;
	}

	throw new Error(`WidgetConnection: refusing to connect to "${engineUrl}" over cleartext — the auth key and every message would cross the network unencrypted. Use https:// or wss:// (terminate TLS in front of the engine); plain http:// or ws:// is allowed only for loopback hosts (localhost, 127.0.0.1, ::1) during local development.`);
}

/**
 * Manages one persistent widget connection to a RocketRide engine.
 *
 * UI-free by design: all UI concerns are delivered through the callbacks in
 * {@link WidgetConnectionOptions}, so this class is unit-testable headlessly
 * with an injected {@link ChatClientFactory}.
 */
export class WidgetConnection {
	private readonly _options: WidgetConnectionOptions;
	private _client: ChatClientLike | null = null;
	private _state: ConnectionState = 'idle';
	private _manualDisconnect = false;
	/**
	 * Rejectors for every {@link ask} still awaiting an answer. `disconnect()`
	 * closes the socket underneath the SDK's `chat()` promise, which may then
	 * never settle; rejecting through these gives the caller a definite outcome
	 * instead of stranding it — and, in the widget, a composer that would stay
	 * disabled behind a request that can no longer arrive.
	 */
	private readonly _pendingAsks = new Set<(error: Error) => void>();

	/** Stores the connection options; no client is created until `connect()` is called. */
	constructor(options: WidgetConnectionOptions) {
		this._options = options;
	}

	/** Current connection state. */
	get state(): ConnectionState {
		return this._state;
	}

	/** True once the transport is connected and authenticated. */
	isConnected(): boolean {
		return this._state === 'connected' && this._client !== null && this._client.isConnected();
	}

	/**
	 * Opens the persistent connection. Resolves once the first attempt
	 * completes; with `persist` the SDK keeps retrying on failure/drop, so a
	 * resolved promise does not imply the state is 'connected' — observe
	 * `onStateChange`. Idempotent while a client exists.
	 *
	 * @throws Error when engineUrl or auth is missing
	 */
	async connect(): Promise<void> {
		if (this._client) {
			return;
		}
		if (!this._options.engineUrl || !this._options.auth) {
			throw new Error("WidgetConnection requires both engineUrl and auth (the pipeline's public auth key).");
		}
		// Security gate: never hand a credentialed connection to a cleartext
		// transport. Throws before any client exists, so nothing is sent.
		assertSecureEngineUrl(this._options.engineUrl);

		this._setState('connecting');
		this._manualDisconnect = false;

		const config: RocketRideClientConfig = {
			// PUBLIC auth key only — see the module doc comment.
			auth: this._options.auth,
			uri: this._options.engineUrl,
			// The SDK owns reconnection: linear backoff, retries forever.
			persist: true,
			// Never fall back to ambient env credentials (e.g. ROCKETRIDE_APIKEY).
			env: {},
			module: 'chat-widget',
			clientName: 'RocketRide Chat Widget',
			onConnected: async () => {
				this._setState('connected');
			},
			onDisconnected: async (reason?: string, hasError?: boolean) => {
				if (this._manualDisconnect) {
					return;
				}
				// The SDK immediately schedules a reconnect; reflect an error state
				// for server-side rejections, otherwise show 'connecting'.
				this._setState(hasError ? 'error' : 'connecting', reason || 'Connection lost');
			},
			onConnectError: (error: ConnectionException) => {
				this._setState('error', error.message);
			},
		};

		const factory: ChatClientFactory = this._options.createClient ?? ((clientConfig) => new RocketRideClient(clientConfig));
		this._client = factory(config);
		await this._client.connect();
	}

	/** Closes the connection, abandons anything still in flight on it, and disables automatic reconnection. */
	async disconnect(): Promise<void> {
		this._manualDisconnect = true;
		// Settle in-flight asks first, and synchronously: a caller that tears
		// this connection down may rely on no request still being pending on it
		// by the time `disconnect()` returns its promise.
		this._abandonPendingAsks();
		const client = this._client;
		this._client = null;
		if (client) {
			await client.disconnect();
		}
		this._setState('idle');
	}

	/** Force-retries the connection immediately (error-state Retry button). */
	async retry(): Promise<void> {
		await this.disconnect();
		await this.connect();
	}

	/**
	 * Sends one question through the pipeline and resolves with the answers.
	 *
	 * @param text - The user's question
	 * @param history - Prior conversation turns for context; only the last
	 *   {@link HISTORY_LIMIT} are sent (UI-only entries must be pre-filtered)
	 * @param onStatus - Receives the live status ('thinking') lines of THIS
	 *   request. Status is a property of a request, not of the connection: a
	 *   caller that abandons an `ask()` (through `disconnect()`, or by clearing
	 *   the transcript it belonged to) can start the next one on the same
	 *   connection while the old SDK `chat()` is still streaming, and only a
	 *   per-request callback lets it tell the two apart. Falls back to the
	 *   connection-level {@link WidgetConnectionOptions.onStatus} when omitted.
	 * @returns Answer texts extracted from the pipeline result
	 * @throws Error when the connection has not been opened or the pipeline fails
	 */
	async ask(text: string, history: ChatHistoryItem[] = [], onStatus?: (text: string) => void): Promise<string[]> {
		const client = this._client;
		if (!client) {
			throw new Error('Not connected to RocketRide — call connect() first.');
		}

		const question = new Question({ type: QuestionType.PROMPT, expectJson: false });
		question.addQuestion(text);
		for (const item of history.slice(-HISTORY_LIMIT)) {
			question.addHistory({ role: item.role, content: item.content });
		}

		// Bind this request's status sink once, so every line the SDK streams is
		// attributable to the ask() that produced it.
		const forwardStatus = onStatus ?? this._options.onStatus;

		const chat = client.chat({
			// The pipeline is addressed with the same public auth key.
			token: this._options.auth,
			question,
			onSSE: async (_type: string, data: Record<string, unknown>) => {
				const message = data.message;
				if (typeof message === 'string' && message) {
					forwardStatus?.(message);
				}
			},
		});

		// Race the SDK call against an abandon signal so a `disconnect()` under
		// it (element removed, engine/auth swap, Retry) always settles this
		// promise instead of leaving the caller waiting on a dead socket.
		let abandon!: (error: Error) => void;
		const abandoned = new Promise<never>((_resolve, reject) => {
			abandon = reject;
		});
		this._pendingAsks.add(abandon);

		try {
			return extractAnswerTexts(await Promise.race([chat, abandoned]));
		} finally {
			this._pendingAsks.delete(abandon);
		}
	}

	/**
	 * Rejects every in-flight {@link ask} with {@link ASK_ABANDONED_MESSAGE}.
	 * The underlying SDK call is left to settle (or not) on its own; its result
	 * is discarded by the {@link Promise.race} in `ask()`.
	 */
	private _abandonPendingAsks(): void {
		if (this._pendingAsks.size === 0) {
			return;
		}
		const pending = Array.from(this._pendingAsks);
		this._pendingAsks.clear();
		for (const abandon of pending) {
			abandon(new Error(ASK_ABANDONED_MESSAGE));
		}
	}

	/** Records the new state and notifies the `onStateChange` callback. */
	private _setState(state: ConnectionState, detail?: string): void {
		this._state = state;
		this._options.onStateChange?.(state, detail);
	}
}
