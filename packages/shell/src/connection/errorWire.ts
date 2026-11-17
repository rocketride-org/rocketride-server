// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ERROR WIRE — carrying a thrown SDK error across a realm boundary
// =============================================================================
//
// WHY THIS EXISTS AT ALL: `busOps.ts` rejects with
// `err instanceof Error ? err : new Error(String(err))`. In the cloud host the
// realm and the root share one JS context, so the real Error travels BY
// REFERENCE and `instanceof` already works — nothing here runs.
//
// It is the BRIDGED path that loses it: a VS Code webview talks to the
// extension host over `postMessage`, so the error arrives as a structured
// clone with its prototype gone. Every
// `catch (e) { if (e instanceof AuthenticationException) ... }` in app code
// silently stops matching — no crash, no warning, just a session-expired
// banner that never appears. Happy-path tests cannot see it.
//
// So the root SERIALIZES (name + message + own fields) and the realm
// REHYDRATES against the class registry below.
//
// WHY AN ENVELOPE AND NOT A REJECTION: a handler that THREW the wire form
// would not survive its own bus. `runLocal` (`busOps.ts:227`) coerces a
// non-Error rejection with `new Error(String(err))` — the wire object would
// arrive as the string `[object Object]`. So failure travels as a RESOLVED
// value (`{ ok: false, error }`) and the realm rethrows it. Bus-level
// failures (timeout, no handler) keep rejecting as they always did; they are
// not the callee's errors.
//
// The envelope runs in BOTH hosts, including cloud where the Error could
// have passed by reference. Uniformity is the point of this whole effort —
// one behaviour per realm, not one per host — and the alternative (ship the
// live Error alongside) risks a structured clone of an uncloneable field
// taking down the entire message, not just its error detail.
// =============================================================================

import {
	AuthenticationException,
	ConnectionException,
	DAPException,
	ExecutionException,
	LoginAttemptCancelledError,
	PipeException,
	RocketRideException,
	ValidationException,
} from 'rocketride';

/** Marks a serialized error on the wire (a plain object, never an Error). */
const ERROR_MARKER = '__rrerr';

/**
 * The SDK error classes a realm can receive, keyed by the `name` each
 * constructor assigns.
 *
 * Keyed by NAME rather than by constructor identity: the realm and the root
 * may hold different module instances of the SDK (two bundles, two copies),
 * so identity comparison is not available across the boundary — but the name
 * each class writes in its own constructor is stable.
 */
const ERROR_CLASSES: Record<string, new (...args: never[]) => Error> = {
	DAPException,
	RocketRideException,
	ConnectionException,
	AuthenticationException,
	LoginAttemptCancelledError,
	PipeException,
	ExecutionException,
	ValidationException,
};

/** A thrown error flattened for transport. */
export interface IWireError {
	/** Discriminant — present only on a serialized error. */
	[ERROR_MARKER]: true;
	/** The class name, for {@link rehydrateError}'s registry lookup. */
	name: string;
	/** The human-readable message. */
	message: string;
	/** The originating realm's stack, kept for the rethrown error's trace. */
	stack?: string;
	/** Own enumerable fields (`code`, `hint`, `dapResult`, `reason`, …). */
	fields: Record<string, unknown>;
}

/**
 * Whether a value came off the wire as a serialized error.
 *
 * @param value - Any value received from the bus.
 * @returns True when {@link rehydrateError} can rebuild it.
 */
export function isWireError(value: unknown): value is IWireError {
	return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[ERROR_MARKER] === true;
}

/**
 * Flattens a thrown value for transport — ROOT side.
 *
 * Own enumerable properties are copied because the SDK's exceptions carry
 * their meaning in fields, not in the message: `DAPException.code` is what an
 * application classifies on ("classify on it rather than on the message text,
 * which is written for people and may be reworded"), and dropping it would
 * leave a correctly-typed error that no longer answers the question.
 *
 * @param err - The thrown value.
 * @returns The wire form.
 */
export function serializeError(err: unknown): IWireError {
	if (!(err instanceof Error)) {
		return { [ERROR_MARKER]: true, name: 'Error', message: String(err), fields: {} };
	}
	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(err)) {
		// `name`/`message`/`stack` travel as named members, not as fields.
		if (key === 'name' || key === 'message' || key === 'stack') continue;
		fields[key] = (err as unknown as Record<string, unknown>)[key];
	}
	return {
		[ERROR_MARKER]: true,
		name: err.name || err.constructor.name,
		message: err.message,
		...(err.stack !== undefined ? { stack: err.stack } : {}),
		fields,
	};
}

/**
 * Rebuilds a thrown error from its wire form — REALM side.
 *
 * Built with `Object.create(prototype)` rather than by calling the
 * constructor: each SDK exception takes a different shape
 * (`AuthenticationException(dapResult)`, `LoginAttemptCancelledError(reason)`),
 * and all that survives transport is a bag of fields. Going through the
 * prototype restores `instanceof` — the whole point — without having to know
 * or maintain every signature.
 *
 * An unrecognised name degrades to a plain `Error` carrying the original
 * name, so a class the registry has not been taught still reads correctly in
 * a log rather than disappearing.
 *
 * @param wire - The serialized error.
 * @returns The rethrowable error.
 */
export function rehydrateError(wire: IWireError): Error {
	const Cls = ERROR_CLASSES[wire.name];
	const err = Cls ? (Object.create(Cls.prototype) as Error) : new Error(wire.message);
	Object.assign(err, wire.fields);
	err.message = wire.message;
	err.name = wire.name;
	// The realm's own stack ends at the bus call, which says nothing about
	// what failed; keep the originating one and mark where it crossed.
	if (wire.stack) err.stack = `${wire.stack}\n    --- via shell bus ---`;
	return err;
}

/** One brokered outcome: a value, or an error that kept its class. */
export type IWireEnvelope = { ok: true; value: unknown } | { ok: false; error: IWireError };

/**
 * Runs brokered work and reports its outcome as a VALUE — ROOT side.
 *
 * @param run - The work to attempt.
 * @returns The outcome. Never rejects.
 */
export async function captureEnvelope(run: () => unknown): Promise<IWireEnvelope> {
	try {
		return { ok: true, value: await run() };
	} catch (err) {
		return { ok: false, error: serializeError(err) };
	}
}

/**
 * Unpacks a brokered outcome — REALM side.
 *
 * A value that is not an envelope is returned as-is: a host may override a
 * brokered op with its own handler (VS Code does, for the monitor pair and
 * the env slots), and such a handler returns a bare result.
 *
 * @param value - What the bus resolved with.
 * @returns The result.
 * @throws The originating error, with its class intact.
 */
export function openEnvelope(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || !('ok' in value)) return value;
	const env = value as IWireEnvelope;
	if (env.ok) return env.value;
	throw rehydrateError(env.error);
}
