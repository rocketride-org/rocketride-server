// =============================================================================
// STORAGE GUARD - what posthog-js writes to its own storage is reduced first.
//
// posthog-js stores the first page address and referrer of a visitor
// ($initial_person_info) and of every session ($client_session_props), plus
// campaign values, click ids and Meta ids, in its persistence: the PostHog
// cookie and localStorage for the opted-in instance, sessionStorage for the
// session copy. Those values feed the /flags request (on identify and reset)
// and the person properties, and never pass before_send. Every write goes
// through PostHogPersistence.register or register_once, so both are wrapped on
// the class's prototype (shared by every instance, installed once, before the
// opted-in instance exists): each write is reduced by reduceStoredProps, so a
// raw address, referrer or click id never reaches storage and never leaves in
// a request. If the guard cannot be installed, the opted-in instance is not
// created at all (consented.ts): the visitor stays cookieless. What a
// persistence already holds when the guard arrives (loaded from storage, or
// written by an older build) is reduced by scrubStoredProps.
// Pure, no DOM, no imports (the reduction is passed in: sanitize.ts's
// reduceStoredProps): unit-tested under node:test.
// =============================================================================

/** The reduction applied to every write (sanitize.ts: reduceStoredProps). */
export type ReduceProps = (props: Record<string, unknown>) => Record<string, unknown>;

type Register = (this: unknown, props: unknown, ...rest: unknown[]) => unknown;

type PersistenceLike = {
	register?: Register;
	register_once?: Register;
};

const GUARDED = '__rrStorageGuard';

/** A write's properties, reduced; anything that cannot be reduced is not written (fail closed). */
function reduceWrite(props: unknown, reduce: ReduceProps): unknown {
	if (!props || typeof props !== 'object' || Array.isArray(props)) {
		return props;
	}
	try {
		return reduce(props as Record<string, unknown>);
	} catch {
		return {};
	}
}

/**
 * Wrap register and register_once on a persistence prototype so every write is reduced. Idempotent.
 *
 * @param proto - The persistence class's prototype (persistenceProto).
 * @param reduce - The reduction (sanitize.ts: reduceStoredProps).
 * @returns Whether the prototype is guarded: false when it is not an object or lacks either method.
 */
export function installStorageGuard(proto: unknown, reduce: ReduceProps): boolean {
	if (!proto || typeof proto !== 'object') {
		return false;
	}
	const p = proto as PersistenceLike & Record<string, unknown>;
	if (p[GUARDED] === true) {
		return true;
	}
	const register = p.register;
	const registerOnce = p.register_once;
	if (typeof register !== 'function' || typeof registerOnce !== 'function' || typeof reduce !== 'function') {
		return false;
	}
	p.register = function guardedRegister(this: unknown, props: unknown, ...rest: unknown[]) {
		return register.call(this, reduceWrite(props, reduce), ...rest);
	};
	p.register_once = function guardedRegisterOnce(this: unknown, props: unknown, ...rest: unknown[]) {
		return registerOnce.call(this, reduceWrite(props, reduce), ...rest);
	};
	try {
		Object.defineProperty(p, GUARDED, { value: true, enumerable: false });
	} catch {
		p[GUARDED] = true;
	}
	return true;
}

/**
 * The prototype of an instance's persistence object.
 *
 * @param persistence - The instance's `persistence`.
 * @returns Its prototype, or null when there is none.
 */
export function persistenceProto(persistence: unknown): object | null {
	if (!persistence || typeof persistence !== 'object') {
		return null;
	}
	try {
		const proto = Object.getPrototypeOf(persistence) as unknown;
		if (proto && typeof proto === 'object') {
			return proto as object;
		}
		return null;
	} catch {
		return null;
	}
}

type StoredLike = {
	props?: Record<string, unknown>;
	register?: (props: Record<string, unknown>) => unknown;
	unregister?: (key: string) => unknown;
};

/**
 * Reduce what a persistence already holds (values loaded from storage before the guard existed, or written by an
 * older build): changed values are registered again (and reduced on the way), dropped ones unregistered.
 *
 * @param persistence - An instance's `persistence`.
 * @param reduce - The reduction (sanitize.ts: reduceStoredProps).
 */
export function scrubStoredProps(persistence: unknown, reduce: ReduceProps): void {
	try {
		const p = persistence as StoredLike | null;
		const props = p?.props;
		if (!p || !props || typeof props !== 'object') {
			return;
		}
		const changed = changedValues(p, props, reduce(props));
		if (Object.keys(changed).length > 0) {
			p.register?.(changed);
		}
	} catch {
		/* never throws */
	}
}

/**
 * The values a reduction changed; a key it dropped is unregistered from the persistence on the way.
 *
 * @param p - The persistence.
 * @param props - What it holds.
 * @param reduced - The same, reduced.
 * @returns The keys whose value changed, with their reduced value.
 */
function changedValues(p: StoredLike, props: Record<string, unknown>, reduced: Record<string, unknown>): Record<string, unknown> {
	const changed: Record<string, unknown> = {};
	for (const key of Object.keys(props)) {
		if (!(key in reduced)) {
			unregisterKey(p, key);
		} else if (JSON.stringify(reduced[key]) !== JSON.stringify(props[key])) {
			changed[key] = reduced[key];
		}
	}
	return changed;
}

/**
 * Unregister one key; a persistence that throws keeps it.
 *
 * @param p - The persistence.
 * @param key - The key to remove.
 */
function unregisterKey(p: StoredLike, key: string): void {
	try {
		p.unregister?.(key);
	} catch {
		/* never throws */
	}
}
