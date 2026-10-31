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
// CLIENT OPS — the brokered SDK surface
// =============================================================================
//
// The framework root's `client.*` registrations. Registered at EVERY
// framework root: the cloud shell realm (Shell bootstrap) and the VS Code
// extension host (BusHost — which SKIPS the monitor pair and registers its
// own broker-owned, cross-realm-refcounted versions; in cloud the single
// realm's client is its own refcount authority, so the thin passthroughs
// suffice).
//
// `client.request` IS THE SURFACE. It carries any DAP message, because
// `DAPClient.request()` is the SDK's transport chokepoint: `call()` funnels
// into it, every namespace funnels into `call()`, and the methods that
// deliberately bypass `call()` to reach DAP's binary member (`fsRead`,
// `fsReadMany`, the DataPipe writes) funnel into it as well. A realm
// therefore holds a REAL client (`RocketRideClientProxy`) whose packing,
// validation and unpacking run locally through the SDK's own code, and a new
// SDK method or whole new namespace works the day it ships.
//
// The ~111 NAMED PASSTHROUGH OPS that used to live here are GONE (2026-10-21)
// — every caller holds a realm client now. They were written as an allowlist,
// but never were one: in cloud an MF remote runs in the same page already
// holding `ConnectionManager.getInstance()`, and the webviews are ours. Their
// only measured effect was drift — of 102 client methods called across the
// repo, 41 had already fallen out of the map, each failing only in a realm
// nobody tested. Do not add passthroughs here; call through the client.
//
// What remains is the STATEFUL few, where the root holds something a realm
// cannot:
//   - the socket itself (`client.request`);
//   - monitor subscriptions (socket-bound, refcounted across realms);
//   - open run-log streams, keyed by realm-allocated session id.
// Host-POLICY answers (Stripe return URL, slot-resolved env) are `host.*`
// ops — see ops/hostOps.ts and shared/ops/hostOps.ts.
// =============================================================================

import { registerOpHandlers } from './busOps';
import type { IOpBus } from './busOps';
import type { ShellOpMap, ShellOpSpec, ShellOpParams, ShellOpResult } from './busOps';
// Type-only: the SDK's own types drive the op map below without this module
// pulling the package in for them. (`errorWire` does import it at runtime,
// for the exception classes — as does `connection.ts`, which every host
// already loads, so there is no new dependency to carry.)
import type { DAPMessage, RocketRideClient } from 'rocketride';
import { decodeMessageData, encodeMessageData } from '../connection/binaryWire';
import { captureEnvelope } from '../connection/errorWire';
import type { IWireEnvelope } from '../connection/errorWire';

// ── SDK-derived typing ───────────────────────────────────────────────────────
// RESULTS DERIVE FROM THE SDK'S OWN SIGNATURES. When an SDK method's shape
// changes, this map — and therefore the frozen shell contract — fails to
// compile, instead of a realm discovering the drift at runtime.
type C = RocketRideClient;
/** One SDK method's resolved (awaited) result. */
type R<M extends (...args: never[]) => unknown> = Awaited<ReturnType<M>>;

/** A monitor key — exactly what the SDK's addMonitor takes. */
export type ClientMonitorKey = Parameters<C['addMonitor']>[0];

/**
 * The op a root BROADCASTS engine events on — the counter-flow to
 * `client.request`.
 *
 * Fire-and-forget to every attached realm (`BusHost.broadcastEmitOp`), not a
 * request: nothing asked for an event, so there is no caller to answer and no
 * one realm to answer. Each realm's ConnectionManager registers a handler and
 * feeds the message into its client's own `onEvent`, which is what makes
 * monitor subscriptions and SSE callbacks work outside the root.
 *
 * Only a MULTI-REALM host broadcasts. In cloud the one realm holds the real
 * client and already has its events.
 */
export const CLIENT_EVENT_OP = 'client.event';

/**
 * The brokered client vocabulary, strictly typed.
 */
export interface ClientOpMap extends ShellOpMap {
	// ── The surface ──────────────────────────────────────────────────────────
	/**
	 * One DAP message on the root's socket — what `RocketRideClientProxy`
	 * routes `request()` through.
	 *
	 * The SDK's TRANSPORT chokepoint, deliberately lower than `call()`:
	 * everything that bypasses `call()` to reach DAP's binary member
	 * (`fsRead`, `fsReadMany`, the DataPipe writes) funnels here too, so one
	 * op carries the file operations as well as every command.
	 *
	 * The result is an {@link IWireEnvelope}, not the response: a failure must
	 * reach the realm as the SAME EXCEPTION CLASS it was thrown as, and a
	 * rejection cannot carry that across `postMessage` (see errorWire.ts).
	 * `openEnvelope` unwraps at the realm end.
	 */
	'client.request': ShellOpSpec<{ message: DAPMessage; timeout?: number }, IWireEnvelope>;

	// ── Monitors (broker-owned in multi-realm hosts) ─────────────────────────
	'client.addMonitor': ShellOpSpec<{ key: ClientMonitorKey; types: string[] }, R<C['addMonitor']>>;
	'client.removeMonitor': ShellOpSpec<{ key: ClientMonitorKey; types: string[] }, R<C['removeMonitor']>>;

	// ── Run-log sessions (the DVR) — stateful SDK streams brokered by id.
	//    The REALM allocates the sessionId (globally unique) and registers
	//    `log.event.<sessionId>` as ITS op; the broker's play loop emits
	//    items into it (registration-is-routing — no new push machinery).
	//    A reused id releases its old stream first (leak guard). ─────────────
	'client.log.openStream': ShellOpSpec<{ sessionId: string; projectId: string; source: string; teamId?: string }, void>;
	/** seek/getStatus/getTrace — gated on the runtime allowlist (the typed
	 *  map gives NO runtime guarantee at a process boundary). Result stays
	 *  `unknown`: it is the union of three methods' returns, dispatched by a
	 *  runtime string — callers narrow per method. */
	'client.log.streamCall': ShellOpSpec<{ sessionId: string; method: 'seek' | 'getStatus' | 'getTrace'; args: unknown[] }, unknown>;
	/** LONG-LIVED: resolves at STREAM COMPLETION, not at start — callers pass
	 *  an explicit generous timeoutMs. pos=null means resume-from-position. */
	'client.log.streamPlay': ShellOpSpec<{ sessionId: string; pos: number | 'live' | null; speed: number }, void>;
	'client.log.streamPause': ShellOpSpec<{ sessionId: string }, void>;
	/** `event` is a live engine event forwarded verbatim — schemaless. */
	'client.log.streamIngest': ShellOpSpec<{ sessionId: string; event: unknown }, void>;
	'client.log.streamClose': ShellOpSpec<{ sessionId: string }, void>;
}


/** What the registration needs from its host — the SDK client and liveness.
 *  Typed structurally so BOTH ConnectionManager classes (shell and the VS
 *  Code extension host's) satisfy it without a shared base. */
export interface IClientOpsSource {
	getClient(): unknown;
	isConnected(): boolean;
}

/** Registration options. */
export interface IClientOpsOptions {
	/** Ops to leave UNREGISTERED (the VS Code root pre-registers its
	 *  broker-owned monitor pair; cloud registers everything). */
	skip?: ReadonlySet<string>;
}

/**
 * Registers the brokered `client.*` surface on a framework root's bus.
 *
 * @param bus - The root's op bus.
 * @param source - The root's client accessor + liveness.
 * @param options - Ops to skip (host-specific overrides).
 * @returns Unregister-all function.
 */
export function registerClientOps(bus: IOpBus, source: IClientOpsSource, options?: IClientOpsOptions): () => void {
	/** The connected client, or throws the standard not-connected error. */
	// The SDK client's structural surface, loosely typed — the looseness is
	// only local plumbing; every member reached below is part of the kept,
	// stateful vocabulary.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const client = (): any => {
		const c = source.getClient();
		if (!c || !source.isConnected()) throw new Error('Not connected to server');
		return c;
	};

	// One implementation per op, keyed by the op name itself and FULLY typed
	// against ClientOpMap (params and result both derive from the op's spec):
	// a duplicate name, an unknown name, a declared op with no
	// implementation, or a drifted payload shape are all COMPILE errors.
	// Run-log sessions this root brokers, by realm-allocated id. Closed
	// explicitly (streamClose / reused-id guard); a realm dying without
	// cleanup leaks one stream until its connection drops (server-side
	// sessions are per-connection). Loosely typed like `client` above.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const logSessions = new Map<string, any>();
	const LOG_SESSION_METHODS = ['seek', 'getStatus', 'getTrace'] as const;

	const impls: { [K in keyof ClientOpMap]: (p: ShellOpParams<ClientOpMap, K>) => ShellOpResult<ClientOpMap, K> | Promise<ShellOpResult<ClientOpMap, K>> } = {
		// THE op. Enveloped rather than thrown so the failure reaches the
		// realm as its own exception class (see errorWire.ts) — including the
		// not-connected error `client()` raises, which a realm classifies on.
		// DAP's one binary member is unframed on the way in and re-framed on
		// the way out: a read returns its bytes in `arguments.data` of the
		// RESPONSE, which is why `fsRead` bypasses `call()` (`client.ts:2529`).
		'client.request': (p) => captureEnvelope(async () => encodeMessageData(await client().request(decodeMessageData(p.message), p.timeout))),

		'client.addMonitor': (p) => client().addMonitor(p.key, p.types),
		'client.removeMonitor': (p) => client().removeMonitor(p.key, p.types),

		'client.log.openStream': (p) => {
			// A reused session id must release its old stream first — the
			// overwrite would otherwise leak the stream and its monitor.
			logSessions.get(p.sessionId)?.closeEventStream();
			logSessions.set(p.sessionId, client().log.openEventStream({ projectId: p.projectId, source: p.source, ...(p.teamId ? { teamId: p.teamId } : {}) }));
		},
		'client.log.streamCall': async (p) => {
			const session = logSessions.get(p.sessionId);
			if (!session) throw new Error('Session is closed');
			if (!(LOG_SESSION_METHODS as readonly string[]).includes(p.method)) {
				throw new Error(`Unsupported session method: ${p.method}`);
			}
			return (session[p.method] as (...a: unknown[]) => Promise<unknown>)(...p.args);
		},
		'client.log.streamPlay': async (p) => {
			const session = logSessions.get(p.sessionId);
			if (!session) throw new Error('Session is closed');
			// Items emit into the realm-registered `log.event.<sessionId>` op;
			// the promise resolves at stream completion (the caller's generous
			// timeout owns the lifetime).
			await session.play(p.pos === null ? undefined : p.pos, p.speed, (item: unknown) => {
				bus.emitOp(`log.event.${p.sessionId}`, item);
			});
		},
		'client.log.streamPause': (p) => {
			logSessions.get(p.sessionId)?.pause();
		},
		'client.log.streamIngest': (p) => {
			logSessions.get(p.sessionId)?.ingestLive(p.event as never);
		},
		'client.log.streamClose': (p) => {
			logSessions.get(p.sessionId)?.closeEventStream();
			logSessions.delete(p.sessionId);
		},
	};

	return registerOpHandlers<ClientOpMap>(bus, impls, options);
}
