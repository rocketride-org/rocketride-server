// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.


// =============================================================================
// DEVELOPER REGISTRATION — the shared "claim your developer id" form state
// =============================================================================
//
// One implementation behind both register forms: the New App wizard's
// Developer ID field and the Deploy tab's banner. The state transitions are
// a plain reducer and the claim is a plain async function, so both are
// unit-tested without rendering (useDeveloperRegistration.test.ts); the hook
// only wires them to React.
// =============================================================================

import { useCallback, useReducer } from 'react';

/** The form's state: the typed id, an in-flight claim, and its failure. */
export interface IDeveloperRegistrationState {
	slug: string;
	busy: boolean;
	error: string;
}

/** Everything that changes the form's state. */
export type DeveloperRegistrationAction = { type: 'edit'; slug: string } | { type: 'start' } | { type: 'success' } | { type: 'failure'; error: string };

/** An empty, idle form. */
export const INITIAL_DEVELOPER_REGISTRATION: IDeveloperRegistrationState = { slug: '', busy: false, error: '' };

/**
 * The form's state transitions. Editing clears a previous failure, so a
 * stale server message never sits under a corrected id.
 *
 * @param state - The current state.
 * @param action - What happened.
 * @returns The next state.
 */
export function developerRegistrationReducer(state: IDeveloperRegistrationState, action: DeveloperRegistrationAction): IDeveloperRegistrationState {
	switch (action.type) {
		case 'edit':
			return { ...state, slug: action.slug, error: '' };
		case 'start':
			return { ...state, busy: true, error: '' };
		case 'success':
			return INITIAL_DEVELOPER_REGISTRATION;
		case 'failure':
			return { ...state, busy: false, error: action.error };
	}
}

/** The outcome of one claim attempt. */
export type DeveloperRegistrationOutcome<T> = { ok: true; result: T } | { ok: false };

/**
 * One claim attempt: trims and validates the id, claims it, and reports
 * each step through `dispatch`. Skips (no dispatch) on an empty or invalid id.
 *
 * @param slug - The typed id.
 * @param register - Claims the id on the server.
 * @param dispatch - Receives the state transitions.
 * @param isValid - Optional client-side shape check.
 * @returns The claim's result, or `{ ok: false }` when skipped or refused.
 */
export async function runDeveloperRegistration<T>(slug: string, register: (developerId: string) => Promise<T>, dispatch: (action: DeveloperRegistrationAction) => void, isValid?: (slug: string) => boolean): Promise<DeveloperRegistrationOutcome<T>> {
	const trimmed = slug.trim();
	if (!trimmed || (isValid && !isValid(trimmed))) return { ok: false };
	dispatch({ type: 'start' });
	try {
		const result = await register(trimmed);
		dispatch({ type: 'success' });
		return { ok: true, result };
	} catch (e) {
		dispatch({ type: 'failure', error: e instanceof Error ? e.message : String(e) });
		return { ok: false };
	}
}

/** What a register form renders from and calls. */
export interface IDeveloperRegistration extends IDeveloperRegistrationState {
	/** Updates the typed id (and clears a previous failure). */
	setSlug: (slug: string) => void;
	/** Claims the typed id; a no-op without a register function. */
	submit: () => Promise<void>;
}

/**
 * The register form's state and actions.
 *
 * @param register - Claims the id (undefined: the host cannot register).
 * @param isValid - Optional client-side shape check.
 * @param onRegistered - Called with the claim's result on success.
 * @returns See {@link IDeveloperRegistration}.
 */
export function useDeveloperRegistration<T>(register: ((developerId: string) => Promise<T>) | undefined, isValid?: (slug: string) => boolean, onRegistered?: (result: T) => void): IDeveloperRegistration {
	const [state, dispatch] = useReducer(developerRegistrationReducer, INITIAL_DEVELOPER_REGISTRATION);

	const setSlug = useCallback((slug: string) => {
		dispatch({ type: 'edit', slug });
	}, []);

	const submit = useCallback(async (): Promise<void> => {
		if (!register) return;
		const outcome = await runDeveloperRegistration(state.slug, register, dispatch, isValid);
		if (outcome.ok) onRegistered?.(outcome.result);
	}, [register, state.slug, isValid, onRegistered]);

	return { ...state, setSlug, submit };
}
