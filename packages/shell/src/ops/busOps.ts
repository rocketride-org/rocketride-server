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
// BUS OPS — the shell bus's addressed-operation lane
// =============================================================================
//
// The shell bus has exactly three lanes; THIS file is the second:
//
//   - EVENTS: `emit('ns:event')` — realm-local broadcast, fire-and-forget
//     (ConnectionManager's event lane; unchanged).
//   - OPS: `request('ns.verb') → Promise` / `handle('ns.verb', fn)` — an
//     addressed operation routed to WHOEVER REGISTERED THE NAME, wherever
//     that handler lives (this realm, the framework root, or another
//     realm's controller, via the bridge in busBridge.ts).
//   - RETAINED TOPICS: `publish`/`subscribe`/`read` — cross-realm state with
//     last-value replay, layered ABOVE this file (see retained.ts).
//
// REGISTRATION IS THE ALLOWLIST IS THE ROUTING ENTRY. There is no generic
// passthrough anywhere: an op exists because someone registered it, and an
// op nobody registered rejects. The framework root registers `client.*`
// (the brokered SDK surface); tool controllers register their namespaces
// (`explorer.*`, `sql.*`, ...).
//
// The `.` / `:` separator split (dot = addressed op, colon = event-shaped)
// is VOLUNTARY CONVENTION for readers — the bus matches full name strings
// and does not care.
//
// LANES ARE THE CALLER'S CHOICE, not the name's: the same registered op can
// be `request`ed (await the result) or `emitOp`ed (fire-and-forget; the
// handler runs, the return value is discarded).
//
// In-realm state is just the handler registry. Correlation tables exist
// ONLY where a transport is crossed (busBridge.ts) — an in-realm request is
// a direct async call. Retention, buffering, summon, and replay are NOT
// op-lane concerns; they belong to the layers above (retained.ts, the
// router's summon table).
// =============================================================================

/** Default per-request timeout — matches the tool-op lane's generosity
 *  (engine-side work can legitimately run long); override per call. */
export const DEFAULT_BUS_REQUEST_TIMEOUT_MS = 120_000;

/** One operation's compile-time shape: params in, result out. */
export interface ShellOpSpec<P, R> {
	/** Phantom carriers — never read at runtime. */
	readonly params: P;
	readonly result: R;
}

/**
 * The base op map a domain's op vocabulary extends — the protocol-map
 * pattern (ShellConnectionEventMap, ToolOpMap) applied to the bus. A domain
 * declares, in its own module:
 *
 *   interface ClientOps extends ShellOpMap {
 *       'client.setTeam': ShellOpSpec<{ teamId: string }, void>;
 *   }
 *
 * The interface key is the wire name, so a typo'd string or drifted payload
 * shape fails to compile at both ends.
 */
export interface ShellOpMap {}

/** The params type of one op in a map. */
export type ShellOpParams<O, K extends keyof O> = O[K] extends ShellOpSpec<infer P, unknown> ? P : never;

/** The result type of one op in a map. */
export type ShellOpResult<O, K extends keyof O> = O[K] extends ShellOpSpec<unknown, infer R> ? R : never;

/** Per-request options. */
export interface IBusRequestOptions {
	/** Overrides {@link DEFAULT_BUS_REQUEST_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** A registered op handler — a plain async function, no transport knowledge. */
export type BusOpHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * Where an unresolved op goes when this realm is bridged (set by
 * busBridge.ts). Absent on the framework root (nothing above it) and in
 * unbridged realms (tests, standalone).
 */
export interface IBusForwarder {
	/** Forwards a request; resolves/rejects with the remote outcome. */
	request(op: string, params: unknown, timeoutMs: number): Promise<unknown>;
	/** Forwards a fire-and-forget op invocation. */
	emitOp(op: string, params: unknown): void;
	/** Announces a local registration (routing entry at the root). */
	register(op: string): void;
	/** Withdraws a local registration. */
	unregister(op: string): void;
}

/** Thrown when a request resolves to no handler anywhere. */
export class BusNoHandlerError extends Error {
	constructor(op: string) {
		super(`No handler registered for op '${op}'`);
		this.name = 'BusNoHandlerError';
	}
}

/** The op lane of one realm's bus. */
export interface IOpBus {
	/**
	 * Registers THE handler for an op. One handler per name — a second
	 * registration throws (registration is the allowlist; ambiguity is a
	 * bug, not a fan-out).
	 *
	 * @param op - The wire name (`ns.verb` by convention).
	 * @param handler - Plain async function; its return value answers requests.
	 * @returns An unregister function.
	 */
	handle(op: string, handler: BusOpHandler): () => void;

	/**
	 * Invokes an op and awaits its result — local handler first, else the
	 * forwarder (the bridge to the framework root), else rejects with
	 * {@link BusNoHandlerError}.
	 */
	request(op: string, params: unknown, opts?: IBusRequestOptions): Promise<unknown>;

	/**
	 * Invokes an op fire-and-forget — the handler runs (local or forwarded),
	 * the return value is discarded, failures are debug-logged, an unknown
	 * op is DROPPED with a debug trace (never buffered at this layer).
	 */
	emitOp(op: string, params: unknown): void;

	/** True when THIS realm registered the op. */
	hasHandler(op: string): boolean;

	/** The ops this realm registered (the bridge announces these). */
	localOps(): string[];

	/** Wires the realm's upstream (bridge-owned; root has none). */
	setForwarder(forwarder: IBusForwarder | null): void;

	/** Observes registration changes (the bridge re-announces on change). */
	onRegistrationChange(cb: (op: string, registered: boolean) => void): () => void;
}

/**
 * Creates one realm's op bus. ConnectionManager holds exactly one and
 * exposes it as `request`/`handle`/`emitOp`; the bridge and router build on
 * the same object.
 *
 * @returns The op bus.
 */
/**
 * An implementation table for (a subset of) an op map: one function per op
 * name, FULLY typed against the map — params and result both derive from the
 * op's ShellOpSpec, so a drifted payload shape or wrong return type fails to
 * compile in the table itself. THE one way every domain registers —
 * clientOps, hostOps, and host-specific override tables all ride this.
 */
export type OpImplTable<M extends ShellOpMap> = Partial<{ [K in keyof M]: (params: ShellOpParams<M, K>) => ShellOpResult<M, K> | Promise<ShellOpResult<M, K>> }>;

/**
 * Registers an implementation table on a bus. Per entry: skipped when the
 * host already registered its own override (`hasHandler`) or when listed in
 * `skip` — specific-before-shared is the composition rule.
 *
 * @param bus - The realm's op bus.
 * @param impls - One implementation per op name.
 * @param options - Ops to leave unregistered.
 * @returns Unregister-all function.
 */
export function registerOpHandlers<M extends ShellOpMap>(bus: IOpBus, impls: OpImplTable<M>, options?: { skip?: ReadonlySet<string> }): () => void {
	const offs = Object.entries(impls as Record<string, BusOpHandler>)
		.filter(([op]) => !options?.skip?.has(op) && !bus.hasHandler(op))
		.map(([op, fn]) => bus.handle(op, fn));
	return () => offs.forEach((off) => off());
}

export function createOpBus(): IOpBus {
	const handlers = new Map<string, BusOpHandler>();
	const regWatchers = new Set<(op: string, registered: boolean) => void>();
	let forwarder: IBusForwarder | null = null;

	const notify = (op: string, registered: boolean): void => {
		for (const cb of regWatchers) {
			try {
				cb(op, registered);
			} catch (err) {
				console.error(`[OpBus] registration watcher threw for '${op}':`, err);
			}
		}
	};

	/** Runs the LOCAL handler with a timeout race (a hung handler must not
	 *  hold the caller's promise forever — same honesty rule as tool ops:
	 *  'did not answer' is NOT 'did not happen'). */
	const runLocal = (op: string, handler: BusOpHandler, params: unknown, timeoutMs: number): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Op '${op}' timed out after ${timeoutMs}ms`)), timeoutMs);
			Promise.resolve()
				.then(() => handler(params))
				.then(
					(result) => {
						clearTimeout(timer);
						resolve(result);
					},
					(err: unknown) => {
						clearTimeout(timer);
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				);
		});

	return {
		handle(op, handler) {
			if (handlers.has(op)) {
				throw new Error(`Op '${op}' already has a handler — registration is exclusive by design`);
			}
			handlers.set(op, handler);
			forwarder?.register(op);
			notify(op, true);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				handlers.delete(op);
				forwarder?.unregister(op);
				notify(op, false);
			};
		},

		request(op, params, opts) {
			const timeoutMs = opts?.timeoutMs ?? DEFAULT_BUS_REQUEST_TIMEOUT_MS;
			const handler = handlers.get(op);
			if (handler) return runLocal(op, handler, params, timeoutMs);
			if (forwarder) return forwarder.request(op, params, timeoutMs);
			return Promise.reject(new BusNoHandlerError(op));
		},

		emitOp(op, params) {
			const handler = handlers.get(op);
			if (handler) {
				Promise.resolve()
					.then(() => handler(params))
					.catch((err: unknown) => {
						console.error(`[OpBus] emitOp handler for '${op}' threw:`, err);
					});
				return;
			}
			if (forwarder) {
				forwarder.emitOp(op, params);
				return;
			}
			// Unknown op on the fire-and-forget lane: drop loudly enough to
			// debug, quietly enough not to crash anything.
			console.debug(`[OpBus] emitOp '${op}' dropped — no handler, no forwarder`);
		},

		hasHandler(op) {
			return handlers.has(op);
		},

		localOps() {
			return [...handlers.keys()];
		},

		setForwarder(f) {
			forwarder = f;
			// A late-attached bridge must learn the already-registered ops.
			if (f) for (const op of handlers.keys()) f.register(op);
		},

		onRegistrationChange(cb) {
			regWatchers.add(cb);
			return () => regWatchers.delete(cb);
		},
	};
}

// =============================================================================
// TYPED WRAPPER — per-domain compile-time safety over one bus
// =============================================================================

/** The typed facade over a bus for one op map. */
export interface ITypedBusOps<O extends ShellOpMap> {
	/** Awaits the op's result. */
	request<K extends keyof O & string>(op: K, params: ShellOpParams<O, K>, opts?: IBusRequestOptions): Promise<ShellOpResult<O, K>>;
	/** Fires the op without a result (same handler, return value discarded). */
	emit<K extends keyof O & string>(op: K, params: ShellOpParams<O, K>): void;
	/** Registers the op's handler. */
	handle<K extends keyof O & string>(op: K, handler: (params: ShellOpParams<O, K>) => ShellOpResult<O, K> | Promise<ShellOpResult<O, K>>): () => void;
}

/**
 * Types one op map over a bus — the `typedToolChannel` convention applied
 * to the bus lane. Domains hold one of these; raw string ops never appear
 * at call sites.
 *
 * @param bus - The realm's op bus.
 * @returns The typed facade.
 */
export function typedBusOps<O extends ShellOpMap>(bus: IOpBus): ITypedBusOps<O> {
	return {
		request: (op, params, opts) => bus.request(op, params, opts) as Promise<never>,
		emit: (op, params) => bus.emitOp(op, params),
		handle: (op, handler) => bus.handle(op, handler as BusOpHandler),
	};
}
