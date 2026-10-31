// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ROCKETRIDE CLIENT PROXY — the realm's own client
// =============================================================================
//
// A REAL `RocketRideClient` that behaves as though this realm owned the
// socket. It differs in one respect: `request()` goes over the shell bus to
// the root instead of down a WebSocket, and engine events come back the same
// way.
//
// WHY A SUBCLASS AND NOT A HAND-WRITTEN FACADE: `request()` is the SDK's
// transport chokepoint. `call()` funnels into it, every namespace (`account`,
// `billing`, `deploy`, `log`) funnels into `call()`, and the file operations
// that bypass `call()` for DAP's binary member funnel into it too. Overriding
// that one method therefore carries the WHOLE surface, including methods and
// whole namespaces that do not exist yet. The facade it replaces had to be
// maintained by hand, and was not: of 102 client methods actually called
// across the repo, 41 had already fallen out of the brokered map, each
// failing only in a realm nobody tested.
//
// WHAT STILL NEEDS AN OVERRIDE, and why each is unavoidable:
//   - MONITORS — refcounted per instance, so a realm running them locally
//     would cancel other realms' subscriptions.
//   - EVENTS (`receiveEvent`) — nothing requested them, so no request op can
//     carry them; the root pushes.
//   - LIFECYCLE and the CREDENTIAL — the root's to own.
//   - `pipe`/`send` WITH an SSE callback — a local callback the root's socket
//     would have to dispatch into.
//
// WHAT A REALM USED TO GET INSTEAD: `null`. `useShellConnection().client` is
// `ConnectionManager.getInstance().getClient()`, and a bus-mirrored realm has
// no client — so every tool wrote its own workaround (sql's `getBusSqlClient`,
// profiler's `profiler.call`, explorer's eight fs ops), each a partial
// re-implementation of this class.
//
// NEVER CONNECTS. The SDK builds its transport in `_internalAttach`, which a
// proxy never calls, so `_transport` stays undefined and the connection
// machinery (`_bindTransport`, `_transportEpoch`) stays dormant. A realm
// opening a second socket would be a second connection to the same server,
// authenticated separately and invisible to the shell's status.
// =============================================================================

import { RocketRideClient } from 'rocketride';
import type { ConnectResult, DAPMessage, DataPipe, PIPELINE_RESULT, RocketRideClientConfig } from 'rocketride';
import { decodeMessageData, encodeMessageData } from './binaryWire';
import { isWireError, openEnvelope, rehydrateError } from './errorWire';

/**
 * The root's handshake state, as a realm sees it.
 *
 * WHY THIS IS NEEDED AT ALL: seven synchronous accessors read state the login
 * handshake populated — `isConnected`, `isAttached`, `isAuthenticated`,
 * `getAccountInfo`, `getOrgId`, `getConnectionInfo`, `getApiKey`. A "real"
 * client whose handshake never happened answers every one of them confidently
 * and WRONGLY, which is strictly worse than the `null` it replaces: null fails
 * loudly, a confident false renders a logged-out screen over a live session.
 */
export interface IProxyIdentity {
	/** The root's socket is up AND authenticated (the shell's `isConnected`). */
	connected: boolean;
	/** The handshake result, or undefined before/without one. */
	accountInfo?: ConnectResult | undefined;
	/** The server URL, for `getConnectionInfo()`. */
	uri?: string;
}

/** How the proxy reaches the root realm. */
export interface IProxyTransport {
	/**
	 * Issues one bus op against the root and resolves with its result.
	 *
	 * @param op - The op name.
	 * @param params - The op's parameters.
	 * @param timeoutMs - Overrides the bus default. Passed when the caller
	 *                    gave the SDK an explicit timeout, so a deliberately
	 *                    long command is not cut short by the shorter of the
	 *                    two limits.
	 * @returns The op's result.
	 */
	request(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** The op the root serves for every DAP message (see clientOps.ts). */
const REQUEST_OP = 'client.request';

/** The monitor ops, owned by the root because the refcounts are. */
const ADD_MONITOR_OP = 'client.addMonitor';
const REMOVE_MONITOR_OP = 'client.removeMonitor';

/** A monitor key — exactly what the SDK's addMonitor takes. Derived from the
 *  SDK rather than imported from the op map, so the proxy stays independent
 *  of the brokering vocabulary it happens to use. */
type ClientMonitorKey = Parameters<RocketRideClient['addMonitor']>[0];

/** Headroom over an explicit SDK timeout, so the ENGINE's limit expires
 *  first and the caller learns what actually happened. */
const BUS_TIMEOUT_SLACK_MS = 5_000;

/**
 * The error a root-only member raises in a realm.
 *
 * Named rather than inlined so the message stays identical everywhere: a
 * person who hits one of these needs to know WHICH realm owns the capability,
 * not merely that theirs does not.
 *
 * @param member - The member that was reached.
 * @param alternative - What to do instead.
 * @returns The error to throw.
 */
function rootOnly(member: string, alternative: string): Error {
	return new Error(`${member}() is available only in the root realm. ${alternative}`);
}

/**
 * A `RocketRideClient` whose commands ride the shell bus.
 *
 * Handed to realms by `useShellConnection()`. Callers cannot tell the
 * difference, and should not have to: that is the point.
 */
export class RocketRideClientProxy extends RocketRideClient {
	/** This realm's route to the root. */
	private readonly _proxyTransport: IProxyTransport;

	/** The root's liveness, as last mirrored. `isAttached()` reads it. */
	private _mirroredConnected = false;

	/**
	 * @param transport - How to reach the root realm.
	 * @param config - Standard client config (`uri` for display; no auth —
	 *                 the root owns the credential).
	 */
	constructor(transport: IProxyTransport, config: RocketRideClientConfig = {}) {
		super(config);
		this._proxyTransport = transport;
	}

	/**
	 * Sends one DAP message over the root realm's socket.
	 *
	 * THE OVERRIDE, and the reason the rest of the class needs almost none.
	 * This is the SDK's real transport chokepoint — `call()` funnels into it
	 * (`client.ts:3421`), and so does everything that deliberately bypasses
	 * `call()` to reach the binary member: `fsRead` (`:2535`), `fsReadMany`
	 * (`:2693`) and the DataPipe write path (`:141/206/240/293`). Overriding
	 * HERE carries all of them, so the file operations need no special case.
	 *
	 * Everything above it stays local, running the SDK's own unmodified code:
	 * `buildRequest` packs the message, `didFail` classifies the response,
	 * `call()` unwraps the body and throws the typed exception, the trace
	 * callbacks fire. A command therefore behaves identically whichever realm
	 * issued it — by construction rather than by review.
	 *
	 * The root reassigns `seq` from its own counter, since correlation belongs
	 * to the connection that actually owns the pending-request table.
	 *
	 * @param message - The DAP message to send.
	 * @param timeout - Optional per-request timeout in ms.
	 * @returns The server's response message.
	 * @throws The originating error, rebuilt with its class intact.
	 */
	override async request(message: DAPMessage, timeout?: number): Promise<DAPMessage> {
		// The SDK's timeout is in milliseconds, as is the bus's — but the
		// bus's must OUTLAST it, or a request that was going to fail with the
		// server's own timeout fails with a bus timeout and loses the reason.
		const timeoutMs = timeout !== undefined ? timeout + BUS_TIMEOUT_SLACK_MS : undefined;
		try {
			const response = openEnvelope(
				await this._proxyTransport.request(
					REQUEST_OP,
					{
						// DAP's `arguments.data` member is framed, not
						// shipped: the bridged hop is JSON-only and JSON
						// turns bytes into an index-keyed object. See
						// binaryWire.ts.
						message: encodeMessageData(message),
						...(timeout !== undefined ? { timeout } : {}),
					},
					timeoutMs
				)
			);
			return decodeMessageData(response as DAPMessage);
		} catch (err) {
			// Normally the root enveloped its failure and `openEnvelope` threw
			// it above. This catch covers the bus's own rejections (timeout, no
			// handler) and a host override that rejected rather than enveloped.
			throw isWireError(err) ? rehydrateError(err) : err;
		}
	}

	// ── Mirrored handshake state ────────────────────────────────────────────

	/**
	 * Folds the root's handshake state into this instance.
	 *
	 * Seeds the SDK's OWN private fields rather than shadowing the accessors,
	 * so `isAuthenticated()`, `getAccountInfo()`, `getOrgId()` and
	 * `getConnectionInfo()` are the SDK's unmodified implementations reading
	 * real values. A realm therefore has no parallel API to learn and no
	 * "which realm am I in" at the call site — which is the entire point.
	 *
	 * `isAttached()` is the one that cannot work this way: it reads
	 * `_transport`, and a proxy deliberately has none. It is overridden below.
	 *
	 * Called on every mirror delivery, not just the first: a reconnect at the
	 * root must move this instance too, or a realm holds a client that is
	 * confidently stale.
	 *
	 * @param identity - The root's current handshake state.
	 */
	public applyIdentity(identity: IProxyIdentity): void {
		this._mirroredConnected = identity.connected;
		const own = this as unknown as { _authenticated: boolean; _connectResult: ConnectResult | undefined; _uri: string };
		// The shell's mirrored `connected` means attached AND authenticated
		// (`ConnectionManager.isConnected()`), so it answers both.
		own._authenticated = identity.connected;
		own._connectResult = identity.accountInfo;
		if (identity.uri !== undefined) own._uri = identity.uri;
	}

	/**
	 * True when the ROOT's socket is up.
	 *
	 * Overridden because the inherited version reads `_transport?.isConnected()`
	 * and a proxy never builds a transport — inherited, it would report false
	 * in a realm whose status bar says connected.
	 *
	 * @returns The root's mirrored liveness.
	 */
	override isAttached(): boolean {
		return this._mirroredConnected;
	}

	// ── Root-only: lifecycle ────────────────────────────────────────────────
	//
	// NOT forwarded. These drive the SHARED socket every realm depends on: a
	// webview disconnecting the root would take the whole shell down with it,
	// and a realm connecting would open a second, separately-authenticated
	// connection. The shell owns the lifecycle; a realm observes it.

	override connect(): Promise<ConnectResult> {
		throw rootOnly('connect', 'The shell owns the connection lifecycle.');
	}

	override disconnect(): Promise<void> {
		throw rootOnly('disconnect', 'The shell owns the connection lifecycle.');
	}

	override identify(_clientName: string): Promise<void> {
		throw rootOnly('identify', 'The shell identifies the connection at startup.');
	}

	override ping(): Promise<void> {
		throw rootOnly('ping', 'Read liveness from useShellConnection().isConnected instead.');
	}

	// ── Events: the direction request() cannot serve ────────────────────────

	/**
	 * Delivers one engine event that arrived on the ROOT's socket.
	 *
	 * The counter-flow to {@link request}, and the reason monitors and SSE
	 * callbacks can work at all in a realm. Events are not responses: nothing
	 * asked for them, so no request/response op can carry them — the root
	 * broadcasts them and every realm feeds them in here.
	 *
	 * It goes through the SDK's OWN `onEvent`, not past it, so everything that
	 * hangs off an event happens locally and identically: the cached
	 * `_connectResult` refreshes on `apaext_account`, a DataPipe's `onSSE`
	 * callback fires from `_ssePipeCallbacks`, and the config's `onEvent`
	 * handler runs. None of that had to be re-implemented.
	 *
	 * Safe without a transport: the epoch guard admits an event carrying no
	 * epoch (`DAPClient.ts:170` — `epoch === undefined || …`), which is every
	 * event a proxy receives.
	 *
	 * @param message - The raw event message, verbatim from the root.
	 */
	public async receiveEvent(message: DAPMessage): Promise<void> {
		await super.onEvent(decodeMessageData(message));
	}

	// ── Monitors: forwarded, never run locally ──────────────────────────────
	//
	// These MUST reach the root rather than execute here. `_monitorKeys`
	// (`client.ts:2086`) is a PER-INSTANCE refcount map, and `_syncMonitor`
	// sends the merged type list for a key — so a realm running them locally
	// would tell the server about its own subscriptions only, and the last
	// realm to sync would silently cancel every other realm's. The root keeps
	// one cross-realm refcount and issues one subscription per type.
	//
	// The events the subscription produces come back via `receiveEvent`.

	override async addMonitor(key: ClientMonitorKey, types: string[]): Promise<void> {
		await this._proxyTransport.request(ADD_MONITOR_OP, { key, types });
	}

	override async removeMonitor(key: ClientMonitorKey, types: string[]): Promise<void> {
		await this._proxyTransport.request(REMOVE_MONITOR_OP, { key, types });
	}

	/**
	 * Not available in a realm.
	 *
	 * Deliberately NOT forwarded: "clear everything" is unscoped, and at the
	 * root it would drop the subscriptions of every OTHER realm too — a tool
	 * tidying up on unmount would silently blind the rest of the shell.
	 * Remove what this realm added, with the key it added it under.
	 *
	 * @returns Never — always throws.
	 */
	override clearAllMonitors(): Promise<void> {
		throw rootOnly('clearAllMonitors', 'Call removeMonitor(key, types) for the monitors this realm added.');
	}

	// ── The one thing request() cannot carry: SSE callbacks ─────────────────
	//
	// A pipe opened with `onSSE` registers the callback in a LOCAL
	// `_ssePipeCallbacks` map keyed by pipeId (`client.ts:378`, dispatched at
	// `:1972`) and asks the server for SSE events. Those events arrive as
	// EVENTS on the root's socket, dispatched by the ROOT's client — they
	// never reach this realm's map, so the callback would simply never fire.
	//
	// Pipes WITHOUT a callback work: they are pure request/response and ride
	// the override above. So the refusal is narrowed to the argument that
	// cannot be honoured, rather than the whole method. Routing engine events
	// into a realm's dispatch is Phase 3, alongside monitors.

	override pipe(token: string, objinfo: Record<string, unknown> = {}, mimeType?: string, provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<DataPipe> {
		if (onSSE) throw rootOnly('pipe(…, onSSE)', 'Engine events are not yet routed into realms; open the pipe without onSSE.');
		return super.pipe(token, objinfo, mimeType, provider, onSSE);
	}

	override send(
		token: string,
		data: string | Uint8Array,
		objinfo: Record<string, unknown> = {},
		mimetype?: string,
		onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>
	): Promise<PIPELINE_RESULT | undefined> {
		if (onSSE) throw rootOnly('send(…, onSSE)', 'Engine events are not yet routed into realms; send without onSSE.');
		return super.send(token, data, objinfo, mimetype, onSSE);
	}

	// ── Root-only: the credential ───────────────────────────────────────────

	/**
	 * Not available in a realm.
	 *
	 * Cannot be forwarded: the signature is SYNCHRONOUS and a bus round trip
	 * cannot satisfy it. Mirroring the value would preserve the signature but
	 * put the raw key in every webview, where the VS Code host deliberately
	 * keeps it in the extension process.
	 *
	 * @returns Never — always throws.
	 */
	override getApiKey(): string | undefined {
		throw rootOnly('getApiKey', 'Use the useShellApiKey() hook, which fetches it asynchronously.');
	}
}
