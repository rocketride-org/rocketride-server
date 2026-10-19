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
// BUS BRIDGE — one bus across realms, the framework root as the hub
// =============================================================================
//
// Host-agnostic: a host supplies only TRANSPORT ENDPOINTS (a post/subscribe
// pair — webview postMessage in VS Code, in-process dispatch wherever both
// sides share a window). Everything else — correlation, routing, summon —
// is this file, identical in every host.
//
// Topology is hub-and-spoke. Each non-root realm attaches its op bus to the
// root through one endpoint (`attachRealmToRoot`). The root runs the router
// (`createBusRouter`): an incoming request resolves ordered —
//
//   1. the root's OWN handlers (the framework registers `client.*` here),
//   2. another realm that REGISTERED the op (tool controllers),
//   3. the SUMMON table (an installed-but-dormant owner is activated, the
//      message waits for its registration),
//   4. reject — explicitly, back to the caller. No silent drops, and
//      requests are NEVER retained.
//
// Correlation tables exist exactly where a transport is crossed: one in the
// realm bridge (its outbound requests), one per hop in the router (requests
// it forwards to a realm). Each entry dies one of three ways: response,
// timeout, or the handling realm dying (endpoint disposal rejects every
// in-flight entry against it and clears its registrations).
//
// EVENTS DO NOT CROSS HERE. `emit('ns:event')` stays realm-local by design;
// the broker PUSHES specific mirror topics into realms as part of its job
// (those arrive as ordinary local emits). There is no general event
// bridging — forwarding exists only where a handler explicitly does it.
// =============================================================================

import type { IBusForwarder, IOpBus } from './busOps';
import { BusNoHandlerError } from './busOps';
import type { IRetainedPort, IRetainedRegistry, RetainedSubscriber } from './retained';

/** The envelope key (coexists with other traffic on a shared transport). */
const ENVELOPE = '__rrbus';

/** How long a summoned owner gets to register before waiting requests fail. */
export const DEFAULT_SUMMON_TIMEOUT_MS = 30_000;

/** Fire-and-forget ops held for a summoned owner — small, oldest-evicted. */
const MAX_SUMMON_BUFFER = 64;

// =============================================================================
// WIRE
// =============================================================================

/** A correlated request crossing a transport. */
interface IBusRequestMessage {
	[ENVELOPE]: 'request';
	id: string;
	op: string;
	params?: unknown;
	/** Remaining budget — the receiving side races its own timer so a dead
	 *  transport can't hold the caller past its deadline. */
	timeoutMs: number;
}

/** A correlated response. */
interface IBusResponseMessage {
	[ENVELOPE]: 'response';
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

/** A fire-and-forget op invocation. */
interface IBusEmitOpMessage {
	[ENVELOPE]: 'emitOp';
	op: string;
	params?: unknown;
}

/**
 * Ops the root BROADCASTS to every realm rather than routing to one owner
 * (the engine-event stream, `mirror.event`). Every realm handles its own
 * copy, so these are never announced for ownership.
 *
 * @param op - The op name.
 * @returns True when the op is fanned out to all realms.
 */
function isBroadcastOp(op: string): boolean {
	return op.startsWith('mirror.');
}

/** Registration announcements (realm → root only). */
interface IBusRegisterMessage {
	[ENVELOPE]: 'register' | 'unregister';
	ops: string[];
}

/** A retained-topic publish (realm → root; absent snapshot = retract;
 *  transient = a SIGNAL — fan out, store nothing). */
interface IBusPublishMessage {
	[ENVELOPE]: 'publish';
	topic: string;
	snapshot?: unknown;
	transient?: boolean;
}

/** Topic interest announcements (realm → root only). */
interface IBusTopicSubMessage {
	[ENVELOPE]: 'subscribeTopic' | 'unsubscribeTopic';
	topic: string;
}

/** A retained-topic delivery (root → realm; replay, live updates, and
 *  signals — absent snapshot = retraction). */
interface IBusTopicMessage {
	[ENVELOPE]: 'topic';
	topic: string;
	snapshot?: unknown;
	transient?: boolean;
}

type BusWireMessage = IBusRequestMessage | IBusResponseMessage | IBusEmitOpMessage | IBusRegisterMessage | IBusPublishMessage | IBusTopicSubMessage | IBusTopicMessage;

/** Narrows an arbitrary transport payload to bus traffic. */
function asBusMessage(message: unknown): BusWireMessage | null {
	const m = message as BusWireMessage | null;
	return m && typeof m === 'object' && typeof (m as unknown as Record<string, unknown>)[ENVELOPE] === 'string' ? m : null;
}

// =============================================================================
// ENDPOINT — the ONLY thing a host supplies
// =============================================================================

/** One side of a transport between two realms. */
export interface IBusEndpoint {
	/** Sends one message to the other side. */
	post(message: unknown): void;
	/** Subscribes to messages from the other side; returns unsubscribe. */
	subscribe(cb: (message: unknown) => void): () => void;
}

// =============================================================================
// REALM SIDE
// =============================================================================

/** What attaching a realm yields: the detach function and the realm's
 *  retained-topic port (install it on the realm's ConnectionManager). */
export interface IRealmAttachment {
	/** Detach (rejects this realm's in-flight outbound requests). */
	detach: () => void;
	/** The realm's retained-topic transport (publish/subscribe/read over
	 *  the wire — the root's registry is the authority). */
	retained: IRetainedPort;
}

/**
 * Attaches a realm's op bus to the framework root over one endpoint.
 *
 * Outbound: unresolved requests/emitOps forward to the root; local
 * registrations are announced (including ones made before attach — the bus
 * replays them into the forwarder); retained publishes and topic interest
 * ride their own wire kinds. Inbound: requests from the root (ops THIS
 * realm registered) run against local handlers and answer by id; topic
 * deliveries dispatch to local subscribers.
 *
 * @param bus - This realm's op bus.
 * @param endpoint - Transport to the root.
 * @returns The attachment (detach + retained port).
 */
export function attachRealmToRoot(bus: IOpBus, endpoint: IBusEndpoint): IRealmAttachment {
	let seq = 0;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	/** Local topic subscribers; interest is announced once per topic. */
	const topicSubs = new Map<string, Set<RetainedSubscriber>>();

	const forwarder: IBusForwarder = {
		request(op, params, timeoutMs) {
			return new Promise((resolve, reject) => {
				const id = `r${++seq}`;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Op '${op}' timed out after ${timeoutMs}ms (bridged)`));
				}, timeoutMs);
				pending.set(id, { resolve, reject, timer });
				endpoint.post({ [ENVELOPE]: 'request', id, op, params, timeoutMs } satisfies IBusRequestMessage);
			});
		},
		emitOp(op, params) {
			endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
		},
		register(op) {
			// BROADCAST ops are not OWNED. The root fans them out to every
			// realm (broadcastEmitOp ignores the owner table) and each realm
			// handles its own copy locally, so announcing one would make the
			// first realm to attach the "owner" and every later realm a
			// spurious ownership conflict — the single-owner table is for
			// DIRECTED routing only.
			if (isBroadcastOp(op)) return;
			endpoint.post({ [ENVELOPE]: 'register', ops: [op] } satisfies IBusRegisterMessage);
		},
		unregister(op) {
			if (isBroadcastOp(op)) return;
			endpoint.post({ [ENVELOPE]: 'unregister', ops: [op] } satisfies IBusRegisterMessage);
		},
	};

	const unsubscribe = endpoint.subscribe((message) => {
		const m = asBusMessage(message);
		if (!m) return;
		switch (m[ENVELOPE]) {
			case 'response': {
				const entry = pending.get(m.id);
				if (!entry) return; // caller timed out / duplicate — drop silently
				pending.delete(m.id);
				clearTimeout(entry.timer);
				if (m.ok) entry.resolve(m.result);
				else entry.reject(new Error(m.error ?? `Op failed at the root`));
				break;
			}
			case 'request': {
				// The root routed an op THIS realm registered. Answer by id.
				// hasHandler guard: a just-unregistered op answers with the
				// no-handler error instead of hanging the caller.
				if (!bus.hasHandler(m.op)) {
					endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: false, error: new BusNoHandlerError(m.op).message } satisfies IBusResponseMessage);
					return;
				}
				bus.request(m.op, m.params, { timeoutMs: m.timeoutMs }).then(
					(result) => endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: true, result } satisfies IBusResponseMessage),
					(err: unknown) => endpoint.post({ [ENVELOPE]: 'response', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies IBusResponseMessage)
				);
				break;
			}
			case 'emitOp':
				if (bus.hasHandler(m.op)) bus.emitOp(m.op, m.params);
				break;
			case 'topic': {
				// A retained delivery (replay or live). Async by contract —
				// the transport already guarantees a fresh task here.
				const subs = topicSubs.get(m.topic);
				if (subs) {
					for (const cb of subs) {
						try {
							cb(m.snapshot);
						} catch (err) {
							console.error(`[busBridge] topic subscriber for '${m.topic}' threw:`, err);
						}
					}
				}
				break;
			}
			// register/unregister/publish/subscribeTopic never arrive
			// realm-side (root-only concerns).
		}
	});

	bus.setForwarder(forwarder);

	const retained: IRetainedPort = {
		publish(topic, snapshot) {
			endpoint.post({ [ENVELOPE]: 'publish', topic, snapshot } satisfies IBusPublishMessage);
		},
		signal(topic, payload) {
			endpoint.post({ [ENVELOPE]: 'publish', topic, snapshot: payload, transient: true } satisfies IBusPublishMessage);
		},
		subscribe(topic, cb) {
			let set = topicSubs.get(topic);
			if (!set) {
				set = new Set();
				topicSubs.set(topic, set);
				// First local subscriber announces interest; the root replays
				// the current snapshot (if any) as a 'topic' delivery.
				endpoint.post({ [ENVELOPE]: 'subscribeTopic', topic } satisfies IBusTopicSubMessage);
			}
			set.add(cb);
			return () => {
				const current = topicSubs.get(topic);
				if (!current) return;
				current.delete(cb);
				if (current.size === 0) {
					topicSubs.delete(topic);
					endpoint.post({ [ENVELOPE]: 'unsubscribeTopic', topic } satisfies IBusTopicSubMessage);
				}
			};
		},
		// Reads ride the request lane — the router answers from the registry.
		read: (topic) => bus.request('bus.topic.read', { topic }),
	};

	return {
		retained,
		detach: () => {
			bus.setForwarder(null);
			unsubscribe();
			topicSubs.clear();
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error('Bus bridge detached'));
			}
			pending.clear();
		},
	};
}

// =============================================================================
// ROOT SIDE — the router
// =============================================================================

/** Summon lookup: an activation thunk when the op's owner is INSTALLED but
 *  not yet registered, null otherwise. Installed-only is the caller's
 *  contract (pinned store tools + enabled builtins); summon NEVER installs. */
export type SummonLookup = (op: string) => (() => void) | null;

/** Router options. */
export interface IBusRouterOptions {
	/** The summon table (see {@link SummonLookup}). Absent = no summoning. */
	summon?: SummonLookup;
	/** How long a summoned owner gets to register. */
	summonTimeoutMs?: number;
	/** The root's retained-topic registry — THE authority realms publish to
	 *  and subscribe through. Absent = retained traffic from realms is
	 *  dropped (a root without the lane). */
	retained?: IRetainedRegistry;
}

/** The framework root's router. */
export interface IBusRouter {
	/**
	 * Attaches one realm. Returns a detach function — detaching clears the
	 * realm's registrations and rejects every in-flight request routed to it.
	 *
	 * @param endpoint - Transport to the realm.
	 * @param label - For diagnostics ('sidebar', 'page:account', ...).
	 */
	addRealm(endpoint: IBusEndpoint, label: string): () => void;
	/**
	 * Pushes one fire-and-forget op to EVERY attached realm — the broker's
	 * mirror feed (connection/account/services state into each realm's local
	 * bus). Realms that registered no handler for the op drop it silently;
	 * this is the ONE root→all path, outside the registration routing.
	 */
	broadcastEmitOp(op: string, params: unknown): void;
	/** Disposes every realm attachment. */
	dispose(): void;
}

/**
 * Creates the router over the ROOT's own op bus. The root's bus gets a
 * forwarder too, so root-initiated requests reach realm-registered ops
 * through the same resolution path.
 *
 * @param rootBus - The framework root's op bus (the broker registers here).
 * @param options - Summon configuration.
 * @returns The router.
 */
export function createBusRouter(rootBus: IOpBus, options?: IBusRouterOptions): IBusRouter {
	const summonTimeoutMs = options?.summonTimeoutMs ?? DEFAULT_SUMMON_TIMEOUT_MS;

	interface IRealm {
		endpoint: IBusEndpoint;
		label: string;
		ops: Set<string>;
		/** Retained topics this realm announced interest in. */
		topics: Set<string>;
		/** Requests this router forwarded INTO the realm, by hop id. */
		inflight: Map<string, { respond: (m: IBusResponseMessage) => void; timer: ReturnType<typeof setTimeout> }>;
		unsubscribe: () => void;
	}

	const realms = new Set<IRealm>();
	const opOwners = new Map<string, IRealm>();
	let hopSeq = 0;
	let disposed = false;

	/** Fire-and-forget ops waiting on a summoned owner, per op name. */
	const summonBuffers = new Map<string, unknown[]>();
	/** Ops with an activation already fired (dedupe repeated summons). */
	const summonsInFlight = new Set<string>();

	/** Resolves one request wherever its handler lives; answers via respond. */
	const routeRequest = (op: string, params: unknown, timeoutMs: number, respond: (m: IBusResponseMessage) => void, mintId: () => string): void => {
		// 1. The root's own handlers (client.* broker, host verbs).
		if (rootBus.hasHandler(op)) {
			rootBus.request(op, params, { timeoutMs }).then(
				(result) => respond({ [ENVELOPE]: 'response', id: '', ok: true, result }),
				(err: unknown) => respond({ [ENVELOPE]: 'response', id: '', ok: false, error: err instanceof Error ? err.message : String(err) })
			);
			return;
		}
		// 2. A realm that registered the op.
		const owner = opOwners.get(op);
		if (owner) {
			const hopId = mintId();
			const timer = setTimeout(() => {
				owner.inflight.delete(hopId);
				respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Op '${op}' timed out after ${timeoutMs}ms (routed to ${owner.label})` });
			}, timeoutMs);
			owner.inflight.set(hopId, { respond, timer });
			owner.endpoint.post({ [ENVELOPE]: 'request', id: hopId, op, params, timeoutMs } satisfies IBusRequestMessage);
			return;
		}
		// 3. Summon an installed-but-dormant owner, then retry on register.
		const activate = options?.summon?.(op);
		if (activate) {
			const started = Date.now();
			if (!summonsInFlight.has(op)) {
				summonsInFlight.add(op);
				try {
					activate();
				} catch (err) {
					summonsInFlight.delete(op);
					respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Summon for '${op}' failed: ${err instanceof Error ? err.message : String(err)}` });
					return;
				}
			}
			// Poll-free wait: watch registrations arriving from any realm.
			const giveUp = setTimeout(() => {
				cleanup();
				// Clear the in-flight marker — a timed-out summon must not
				// wedge the op name (later requests re-activate).
				summonsInFlight.delete(op);
				respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Op '${op}' owner did not register within ${summonTimeoutMs}ms of summon` });
			}, Math.min(summonTimeoutMs, timeoutMs));
			const cleanup = registerWaiters(op, () => {
				clearTimeout(giveUp);
				const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
				routeRequest(op, params, remaining, respond, mintId);
			});
			return;
		}
		// 4. Reject — explicitly, never silently.
		respond({ [ENVELOPE]: 'response', id: '', ok: false, error: new BusNoHandlerError(op).message });
	};

	/** One-shot waiters per op for summon completion. */
	const opWaiters = new Map<string, Set<() => void>>();
	const registerWaiters = (op: string, cb: () => void): (() => void) => {
		const set = opWaiters.get(op) ?? new Set<() => void>();
		set.add(cb);
		opWaiters.set(op, set);
		return () => set.delete(cb);
	};
	const fireWaiters = (op: string): void => {
		summonsInFlight.delete(op);
		const set = opWaiters.get(op);
		if (set) {
			opWaiters.delete(op);
			for (const cb of set) cb();
		}
		// Deliver fire-and-forget ops held for the summoned owner.
		const held = summonBuffers.get(op);
		if (held) {
			summonBuffers.delete(op);
			for (const params of held) routeEmitOp(op, params);
		}
	};

	/** Fire-and-forget routing: root handler → owner realm → summon-buffer → drop. */
	const routeEmitOp = (op: string, params: unknown): void => {
		if (rootBus.hasHandler(op)) {
			rootBus.emitOp(op, params);
			return;
		}
		const owner = opOwners.get(op);
		if (owner) {
			owner.endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
			return;
		}
		const activate = options?.summon?.(op);
		if (activate) {
			const held = summonBuffers.get(op) ?? [];
			held.push(params);
			if (held.length > MAX_SUMMON_BUFFER) held.shift();
			summonBuffers.set(op, held);
			if (!summonsInFlight.has(op)) {
				summonsInFlight.add(op);
				try {
					activate();
				} catch (err) {
					summonsInFlight.delete(op);
					summonBuffers.delete(op);
					console.error(`[BusRouter] summon for emitOp '${op}' failed:`, err);
				}
			}
			return;
		}
		console.debug(`[BusRouter] emitOp '${op}' dropped — no handler, not summonable`);
	};

	// Root-initiated traffic resolves through the same router paths.
	rootBus.setForwarder({
		request: (op, params, timeoutMs) =>
			new Promise((resolve, reject) => {
				routeRequest(op, params, timeoutMs, (m) => {
					if (m.ok) resolve(m.result);
					else reject(new Error(m.error ?? `Op '${op}' failed`));
				}, () => `h${++hopSeq}`);
			}),
		emitOp: (op, params) => routeEmitOp(op, params),
		register: () => { /* root registrations are local by definition */ },
		unregister: () => { /* ditto */ },
	});
	// Root-side registrations can complete a summon wait.
	rootBus.onRegistrationChange((op, registered) => {
		if (registered) fireWaiters(op);
	});

	// ── Retained-topic fan-out: every registry change goes to the realms
	//    that announced interest in that topic. Reads ride the request lane.
	const retained = options?.retained;
	let offRetained: (() => void) | null = null;
	if (retained) {
		offRetained = retained.onChange((topic, value, transient) => {
			for (const realm of realms) {
				if (realm.topics.has(topic)) {
					realm.endpoint.post({ [ENVELOPE]: 'topic', topic, snapshot: value, ...(transient ? { transient } : {}) } satisfies IBusTopicMessage);
				}
			}
		});
		if (!rootBus.hasHandler('bus.topic.read')) {
			rootBus.handle('bus.topic.read', (params) => retained.read((params as { topic: string }).topic));
		}
	}

	return {
		addRealm(endpoint, label) {
			const realm: IRealm = { endpoint, label, ops: new Set(), topics: new Set(), inflight: new Map(), unsubscribe: () => {} };
			realm.unsubscribe = endpoint.subscribe((message) => {
				const m = asBusMessage(message);
				if (!m) return;
				switch (m[ENVELOPE]) {
					case 'register':
						for (const op of m.ops) {
							const current = opOwners.get(op);
							if (current && current !== realm) {
								console.error(`[BusRouter] op '${op}' registered by '${label}' but already owned by '${current.label}' — keeping the first owner`);
								continue;
							}
							realm.ops.add(op);
							opOwners.set(op, realm);
							fireWaiters(op);
						}
						break;
					case 'unregister':
						for (const op of m.ops) {
							if (opOwners.get(op) === realm) opOwners.delete(op);
							realm.ops.delete(op);
						}
						break;
					case 'request':
						// A realm's outbound request — answer back over ITS endpoint
						// with ITS correlation id.
						routeRequest(m.op, m.params, m.timeoutMs, (resp) => endpoint.post({ ...resp, id: m.id } satisfies IBusResponseMessage), () => `h${++hopSeq}`);
						break;
					case 'emitOp':
						routeEmitOp(m.op, m.params);
						break;
					case 'response': {
						// A realm answering a request the router forwarded to it.
						const entry = realm.inflight.get(m.id);
						if (!entry) return;
						realm.inflight.delete(m.id);
						clearTimeout(entry.timer);
						entry.respond(m);
						break;
					}
					case 'publish':
						// A realm publishing a retained topic (or firing a
						// signal) — the registry is the authority; its watcher
						// fans the value back out.
						if (m.transient) retained?.signal(m.topic, m.snapshot);
						else retained?.publish(m.topic, m.snapshot);
						break;
					case 'subscribeTopic':
						realm.topics.add(m.topic);
						// Replay the current snapshot to the new interest —
						// subscribe-before-first-publish replays nothing.
						if (retained && retained.read(m.topic) !== undefined) {
							endpoint.post({ [ENVELOPE]: 'topic', topic: m.topic, snapshot: retained.read(m.topic) } satisfies IBusTopicMessage);
						}
						break;
					case 'unsubscribeTopic':
						realm.topics.delete(m.topic);
						break;
				}
			});
			realms.add(realm);

			return () => {
				realms.delete(realm);
				realm.unsubscribe();
				for (const op of realm.ops) {
					if (opOwners.get(op) === realm) opOwners.delete(op);
				}
				// A dead realm answers nothing: reject everything in flight to it.
				for (const [, entry] of realm.inflight) {
					clearTimeout(entry.timer);
					entry.respond({ [ENVELOPE]: 'response', id: '', ok: false, error: `Realm '${realm.label}' detached` });
				}
				realm.inflight.clear();
			};
		},

		broadcastEmitOp(op, params) {
			for (const realm of realms) {
				realm.endpoint.post({ [ENVELOPE]: 'emitOp', op, params } satisfies IBusEmitOpMessage);
			}
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			offRetained?.();
			for (const realm of [...realms]) {
				realm.unsubscribe();
				for (const [, entry] of realm.inflight) {
					clearTimeout(entry.timer);
					entry.respond({ [ENVELOPE]: 'response', id: '', ok: false, error: 'Bus router disposed' });
				}
			}
			realms.clear();
			opOwners.clear();
			rootBus.setForwarder(null);
		},
	};
}

/**
 * An in-process endpoint pair — the transport for two "realms" sharing one
 * JS realm (cloud root↔local attachments, tests). Delivery is a microtask,
 * matching postMessage semantics closely enough that code written against
 * one transport behaves on the other.
 *
 * @returns Two connected endpoints.
 */
export function createLocalEndpointPair(): [IBusEndpoint, IBusEndpoint] {
	const make = (): { subs: Set<(m: unknown) => void>; endpoint: IBusEndpoint & { deliver(m: unknown): void } } => {
		const subs = new Set<(m: unknown) => void>();
		return {
			subs,
			endpoint: {
				post: () => { /* wired below */ },
				subscribe: (cb) => {
					subs.add(cb);
					return () => subs.delete(cb);
				},
				deliver: (m) => {
					Promise.resolve().then(() => {
						for (const cb of subs) cb(m);
					});
				},
			},
		};
	};
	const a = make();
	const b = make();
	a.endpoint.post = (m) => b.endpoint.deliver(m);
	b.endpoint.post = (m) => a.endpoint.deliver(m);
	return [a.endpoint, b.endpoint];
}
