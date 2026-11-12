// =============================================================================
// Identity: whether this page load is signed in, and the opaque engine user id
// an accepted (consented) visitor is identified by. Rich capture runs only on a
// known signed-out surface, so "unknown" (null) counts as signed in. A sign-out
// gives the consented instance a fresh anonymous identity, so nothing the
// visitor does afterwards carries the account. analytics.ts owns one Identity
// for the page load and feeds it HomeApp's reports and the shell's sign-in and
// sign-out events. Pure: the capture mode and the page-load calls are
// injected; unit-tested under node:test (test/unit/identity.test.ts).
// =============================================================================

/** The capture mode calls Identity makes (CaptureMode satisfies it). */
export type IdentityMode = {
	isConsented(): boolean;
	/** The active instance: only its identify and its stored user state are read. */
	active(): { identify?(id: string): void; get_property?(key: string): unknown };
	setSignedIn(signedIn: boolean): void;
	resetIdentity(): void;
};

/** What Identity needs from the page load (analytics.ts). */
export type IdentityDeps = {
	/** The capture mode once the SDK started; null before. */
	mode(): IdentityMode | null;
	/** Initialise the analytics if needed; false when they are off for this page load. */
	ensureInit(): boolean;
	/** Register is_authed on every instance. */
	registerAuthed(isAuthed: boolean): void;
	/** After a sign-out on this page load, the recording restarts once a signed-out surface is on screen. */
	markReplayResumePending(): void;
};

/** The page load's signed-in state and user id, and what each change does to the consented identity. */
export class Identity {
	private readonly deps: IdentityDeps;
	/** null until HomeApp reports; true from the moment an identity exists; false only on a known signed-out surface. */
	private isAuthed: boolean | null = null;
	/** The engine's opaque user id while signed in; identify() uses it and nothing else. */
	private userId: string | null = null;

	/**
	 * @param deps - The capture mode and the page-load calls.
	 */
	constructor(deps: IdentityDeps) {
		this.deps = deps;
	}

	/**
	 * The signed-in state as last reported.
	 *
	 * @returns null before HomeApp's first report, then whether an identity exists.
	 */
	get reported(): boolean | null {
		return this.isAuthed;
	}

	/**
	 * Whether this is a known signed-out surface: the only state rich capture runs in.
	 *
	 * @returns True only after a report of signed out.
	 */
	signedOut(): boolean {
		return this.isAuthed === false;
	}

	/**
	 * HomeApp's report of the signed-in state (before its first page view, and whenever identity changes).
	 * The state is set before the analytics initialise, so a consented instance created during that init
	 * starts in the right posture. Signed in: every rich capture off. A sign-out: the user id goes, the
	 * consented identity is reset, and the recording restarts on the signed-out surface. A first report of
	 * signed out with an identified consented identity still stored (the sign-out happened where this page
	 * never saw it: an expired session, a product app): a fresh identity too.
	 *
	 * @param isAuthed - Whether an identity exists now.
	 */
	setAuthed(isAuthed: boolean): void {
		const wasAuthed = this.isAuthed;
		this.isAuthed = isAuthed;
		if (!this.deps.ensureInit()) {
			return;
		}
		this.deps.registerAuthed(isAuthed);
		// Signed in: every rich capture off (again, if markSignedIn already did it). Signed out: back on.
		if (isAuthed !== wasAuthed || isAuthed) {
			this.deps.mode()?.setSignedIn(isAuthed);
		}
		if (wasAuthed === true && !isAuthed) {
			this.userId = null;
			this.resetConsentedIdentity(false);
			this.deps.markReplayResumePending();
			return;
		}
		if (!isAuthed && wasAuthed === null) {
			this.resetConsentedIdentity(false);
		}
	}

	/**
	 * Off only, no init, no capture: HomeApp's layout phase the moment an identity exists, and the shell's sign-in
	 * event (a sign-in that never passes through HomeApp). Only setAuthed(false) switches capture back on.
	 */
	markSignedIn(): void {
		this.isAuthed = true;
		this.deps.mode()?.setSignedIn(true);
	}

	/**
	 * The signed-in user's opaque engine id, or null when signed out. An accepted visitor is identified by that id
	 * alone: no email, name or other person property ever leaves the page. Cookieless visitors are never identified.
	 *
	 * @param id - The id, or null.
	 */
	setIdentity(id: string | null): void {
		if (!this.deps.ensureInit()) {
			return;
		}
		this.userId = null;
		if (typeof id === 'string' && id) {
			this.userId = id;
		}
		this.identifyIfConsented();
	}

	/** A sign-out the shell performs, also on screens HomeApp never sees: a fresh consented identity, always. */
	shellSignedOut(): void {
		this.userId = null;
		this.resetConsentedIdentity(true);
	}

	/** The SDK started: identify an accepted, signed-in visitor; a signed-out load drops a stored identified identity. */
	sdkStarted(): void {
		this.identifyIfConsented();
		if (this.isAuthed === false) {
			this.resetConsentedIdentity(false);
		}
	}

	/** Identify the consented instance by the user id, when there is one (also after a mid-visit accept). */
	identifyIfConsented(): void {
		const mode = this.deps.mode();
		if (!this.userId || !mode || !mode.isConsented()) {
			return;
		}
		try {
			mode.active().identify?.(this.userId);
		} catch {
			/* the SDK boundary: never throws */
		}
	}

	/**
	 * A fresh anonymous identity on the consented instance: always when `force`, otherwise only when the stored
	 * identity is an identified one. Nothing to do on the cookieless instance.
	 */
	private resetConsentedIdentity(force: boolean): void {
		const mode = this.deps.mode();
		if (!mode || !mode.isConsented()) {
			return;
		}
		try {
			if (!force && mode.active().get_property?.('$user_state') !== 'identified') {
				return;
			}
			mode.resetIdentity();
		} catch {
			/* the SDK boundary: never throws */
		}
	}
}
