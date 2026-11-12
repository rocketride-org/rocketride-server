// =============================================================================
// Capture mode - which PostHog instance every capture goes through.
//
// Undecided and rejected visitors use the cookieless instance (server-side hash
// identity, memory persistence: nothing stored). An accepted visitor gets a
// second, named instance with persistent identity (posthog-js cannot turn a
// cookieless_mode 'always' instance into a persistent one: it never stores an
// identity and its session manager is never created). It captures the same
// events as the cookieless one. Withdrawal opts the consented instance out,
// resets it, clears PostHog's storage and routes captures back to the
// cookieless instance. A sign-out reset that fails does the same and keeps the
// instance out for the rest of the page load: it may still carry the previous
// account's identity. Pure: the instances are injected; unit-tested under
// node:test.
// =============================================================================

import type { PostHog, PostHogConfig } from 'posthog-js';
import type { ConsentState } from './consent';

/**
 * Runs `fn` and drops whatever it throws: the one place a call into posthog-js or the page's storage is allowed to
 * fail silently, because telemetry never breaks the site.
 *
 * @param fn The call to make.
 */
export function quietly(fn: () => void): void {
	try {
		fn();
	} catch {
		/* telemetry never breaks the site */
	}
}

/**
 * The slice of a PostHog instance the mode switch and its callers use; a posthog-js instance satisfies it as is.
 * capture, register and set_config are always there; the rest is optional, so a test double may leave it out.
 */
export type SdkLike = Pick<PostHog, 'capture' | 'register' | 'set_config'> &
	Partial<Pick<PostHog, 'opt_out_capturing' | 'opt_in_capturing' | 'reset' | 'stopSessionRecording' | 'identify' | 'register_for_session' | 'get_session_id' | 'onSessionId' | 'webVitalsAutocapture' | 'startSessionRecording' | 'sessionRecordingStarted' | 'get_property'>>;

/**
 * A withdrawn consented instance, made inert: persistence off BEFORE the reset (a reset writes a fresh anonymous
 * identity back to storage), every capture feature pinned off again whatever the project's remote config says, and
 * a before_send that drops everything (web vitals run on their own timer, and the SDK's own opt-out flag is one of
 * the storage keys the withdrawal removes, so the instance is made inert at the capture gate itself). Its counterpart, the config that
 * revives the instance, is reviveConfig() in consented.ts.
 */
export const INERT_CONFIG: Partial<PostHogConfig> = {
	disable_persistence: true,
	capture_pageleave: false,
	capture_heatmaps: false,
	autocapture: false,
	capture_dead_clicks: false,
	capture_exceptions: false,
	capture_performance: false,
	disable_session_recording: true,
	before_send: () => {
		return null;
	},
};

/** What the capture mode needs from the page load: the two instances, the storage clear, and the super properties. */
export type ModeDeps = {
	/** Today's instance: cookieless, memory persistence. */
	cookieless: SdkLike;
	/** Creates the consented instance, or revives the one a withdrawal tore down earlier in this page load. */
	createConsented: () => SdkLike | null;
	/** Removes PostHog's own storage (localStorage keys and cookies) after a withdrawal. */
	clearSdkStorage: () => void;
	/** Super properties every instance must carry (app, rr_traffic, rr_test, is_authed...). */
	superProperties: () => Record<string, unknown>;
	/** Runs a function later (setTimeout); the storage clear is repeated because the SDK re-persists after a reset. */
	later?: (fn: () => void, ms: number) => void;
	/** Config that switches the element-level captures off (signed in) and back on (signed out). */
	captureConfig?: (signedIn: boolean) => Partial<PostHogConfig>;
	/** Properties only the consented instance carries (rr_replay_gate); registered again after every reset. */
	consentedProperties?: () => Record<string, unknown>;
};

/**
 * Which PostHog instance every capture goes through: the cookieless one for an undecided or rejected visitor, the
 * consented one after an acceptance (see the file header).
 */
export class CaptureMode {
	private consented: SdkLike | null = null;
	private current: ConsentState = 'undecided';
	/**
	 * Set when a sign-out reset threw: the instance may still hold the previous account's distinct id, so it was
	 * made inert and no acceptance revives it in this page load (the next load starts from cleared storage).
	 */
	private isResetFailed = false;

	private readonly deps: ModeDeps;

	/**
	 * @param deps - The instances, the storage clear, the super properties and the timer.
	 */
	constructor(deps: ModeDeps) {
		this.deps = deps;
	}

	/**
	 * The consent state last applied.
	 *
	 * @returns 'undecided', 'accepted' or 'rejected'.
	 */
	state(): ConsentState {
		return this.current;
	}

	/**
	 * The instance captures go through right now.
	 *
	 * @returns The consented instance after an acceptance, else the cookieless one.
	 */
	active(): SdkLike {
		if (this.current === 'accepted' && this.consented) {
			return this.consented;
		}
		return this.deps.cookieless;
	}

	/**
	 * Whether captures go to the consented instance.
	 *
	 * @returns True when the consented instance exists and is the active one.
	 */
	isConsented(): boolean {
		return this.current === 'accepted' && this.consented !== null;
	}

	/**
	 * Apply a consent state. Accepting creates the consented instance once and
	 * registers the super properties on it; a withdrawal from accepted tears the
	 * consented instance down. Every instance carries `consent_state`.
	 *
	 * @param state - The consent state to route by: 'undecided', 'accepted' or 'rejected'.
	 */
	apply(state: ConsentState): void {
		const before = this.current;
		this.current = state;
		if (state === 'accepted') {
			if (!this.accept()) {
				this.current = before; // could not switch: keep the previous routing
			}
		} else if (before === 'accepted' && this.consented) {
			this.teardown();
		}
		this.safeRegister(this.deps.cookieless, { consent_state: state });
	}

	/**
	 * Switch to the consented instance: created once, with the super properties registered on it.
	 *
	 * @returns Whether the consented instance is active now; false when it could not be created.
	 */
	private accept(): boolean {
		if (this.isResetFailed) {
			return false; // the instance kept an identity it could not drop: captures stay cookieless
		}
		if (!this.consented) {
			this.consented = this.createConsentedSafely();
		}
		if (!this.consented) {
			return false;
		}
		this.registerConsentedProperties(this.consented);
		return true;
	}

	/**
	 * The consented instance, which never breaks the page.
	 *
	 * @returns The new instance, or null when it cannot be created (the visitor stays cookieless).
	 */
	private createConsentedSafely(): SdkLike | null {
		try {
			return this.deps.createConsented();
		} catch {
			return null;
		}
	}

	/**
	 * Sign-in: the recording stops and every rich capture (replay, autocapture,
	 * heatmaps, rage and dead clicks) goes off; sign-out switches the captures
	 * back on, and analytics restarts the recording once a signed-out surface
	 * is on screen.
	 *
	 * @param signedIn - Whether an identity exists now.
	 */
	setSignedIn(signedIn: boolean): void {
		if (!this.consented) {
			return;
		}
		// Every sign-in stops the recording, whatever happened before: a recording started on a signed-out
		// surface after an earlier stop (sign-out, then idle) must not survive the next sign-in.
		if (signedIn) {
			try {
				this.consented.stopSessionRecording?.();
			} catch {
				/* never throws */
			}
		}
		if (!this.deps.captureConfig) {
			return;
		}
		try {
			this.consented.set_config?.(this.deps.captureConfig(signedIn));
		} catch {
			/* never throws */
		}
	}

	/**
	 * Sign-out: the consented instance drops the identified distinct id (a fresh
	 * anonymous one) so the visitor's later signed-out events never carry the
	 * engine user id; the super properties are registered again afterwards. A
	 * reset that throws may have stopped before clearing that id (posthog-js
	 * flushes the recording first): the instance is then torn down like a
	 * withdrawal (inert, storage cleared) and captures fall back to the
	 * cookieless instance for the rest of the page load.
	 */
	resetIdentity(): void {
		if (!this.consented) {
			return;
		}
		try {
			this.consented.reset?.();
		} catch {
			this.isResetFailed = true;
			this.teardown();
			return;
		}
		this.registerConsentedProperties(this.consented);
	}

	private teardown(): void {
		const c = this.consented;
		this.consented = null;
		quietly(() => {
			c?.stopSessionRecording?.();
		});
		quietly(() => {
			c?.opt_out_capturing?.();
		});
		quietly(() => {
			c?.set_config(INERT_CONFIG);
		});
		quietly(() => {
			c?.reset?.();
		});
		// A reset re-reads consent from the (now disabled) persistence: opt out again so the unload sends nothing.
		quietly(() => {
			c?.opt_out_capturing?.();
		});
		const clear = (): void => {
			quietly(() => {
				this.deps.clearSdkStorage();
			});
		};
		clear();
		// The SDK saves on its own schedule (debounced, and on the next capture attempt): clear again later, unless
		// the visitor accepted again meanwhile, whose revived instance's storage must stay.
		const clearUnlessConsented = (): void => {
			if (this.isConsented()) {
				return;
			}
			clear();
		};
		if (this.deps.later) {
			this.deps.later(clearUnlessConsented, 0);
			this.deps.later(clearUnlessConsented, 1000);
		}
	}

	/** Every property the consented instance carries: the super properties, its own (rr_replay_gate), and consent_state. */
	private registerConsentedProperties(sdk: SdkLike): void {
		let own: Record<string, unknown> = {};
		if (this.deps.consentedProperties) {
			own = this.deps.consentedProperties();
		}
		this.safeRegister(sdk, { ...this.deps.superProperties(), ...own, consent_state: 'accepted' });
	}

	private safeRegister(sdk: SdkLike, props: Record<string, unknown>): void {
		try {
			sdk.register(props);
		} catch {
			/* never throws */
		}
	}
}

/** A storage area as clearPostHogStorage reads it: localStorage or sessionStorage. */
type KeyStore = { key(i: number): string | null; length: number; removeItem(k: string): void };

/**
 * Remove PostHog's own storage: localStorage keys and cookies prefixed `ph_`, and the session storage keys.
 *
 * @param doc - The document, for its cookies; null leaves cookies alone.
 * @param local - localStorage, or null where there is none.
 * @param session - sessionStorage, or null where there is none.
 * @param hostname - This page's host, whose cookie domains are cleared too.
 */
export function clearPostHogStorage(doc: { cookie: string } | null, local: KeyStore | null, session: KeyStore | null, hostname = ''): void {
	for (const store of [local, session]) {
		if (store) {
			clearPostHogKeys(store);
		}
	}
	if (doc) {
		clearPostHogCookies(doc, hostname);
	}
}

/**
 * Remove PostHog's keys from one storage area; an unavailable one is left as it is.
 *
 * @param store - localStorage or sessionStorage.
 */
function clearPostHogKeys(store: KeyStore): void {
	try {
		for (const k of postHogKeys(store)) {
			store.removeItem(k);
		}
	} catch {
		/* unavailable */
	}
}

/**
 * PostHog's keys in a storage area: prefixed `ph_` or `__ph`, and a stored toolbar link.
 *
 * @param store - localStorage or sessionStorage.
 * @returns The keys, collected before any is removed.
 */
function postHogKeys(store: KeyStore): string[] {
	const keys: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i);
		if (k && (k.startsWith('ph_') || k.startsWith('__ph') || k === '_postHogToolbarParams')) {
			keys.push(k);
		}
	}
	return keys;
}

/**
 * Expire PostHog's cookies (prefixed `ph_`) on this host and on its parent domain; unavailable cookies are left.
 *
 * @param doc - The document.
 * @param hostname - This page's host.
 */
function clearPostHogCookies(doc: { cookie: string }, hostname: string): void {
	try {
		const names: string[] = [];
		for (const part of doc.cookie.split(';')) {
			const name = part.trim().split('=')[0];
			if (name.startsWith('ph_')) {
				names.push(name);
			}
		}
		// this host, the host-only cookie and the parent domain, each once
		const domains = Array.from(new Set(['', hostname, hostname.replace(/^[^.]+\./, '.')]));
		for (const name of names) {
			expireCookie(doc, name, domains);
		}
	} catch {
		/* unavailable */
	}
}

/**
 * Expire one cookie on each domain it may have been set for.
 *
 * @param doc - The document.
 * @param name - The cookie's name.
 * @param domains - '' for this host only, then the host and its parent domain.
 */
function expireCookie(doc: { cookie: string }, name: string, domains: string[]): void {
	for (const d of domains) {
		let domain = '';
		if (d) {
			domain = `; domain=${d}`;
		}
		doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
	}
}
