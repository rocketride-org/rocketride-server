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
// AUTH PHASE — the tab's ONE auth state machine
// =============================================================================
//
// One tab-scoped record (SS_PHASE) replaces the flag sprawl that used to
// encode the same facts by implication: an explicit-sign-out marker, the
// telemetry stamp doubling as an abandoned-sign-in signal, and a separate
// pending-app key. The states:
//
//   fresh         — no sign-in has ever been attempted in this tab
//                   (absent/unreadable record reads as fresh).
//   authorizing   — a sign-in LAUNCHED and has not completed. Found by a
//                   LATER page load with no ?code=, it means the person
//                   abandoned the IdP (Back button) — show the signed-out
//                   page, never re-fire the redirect. `appId` carries the
//                   sign-in's initiator (the app to land on afterwards).
//   authenticated — a sign-in completed in this tab.
//   signed-out    — the person EXPLICITLY signed out here; the gate shows
//                   the signed-out page instead of auto-starting a login.
//
// Writers: the ConnectionManager (completion, logout) and the auth provider
// (launch). Everyone else only reads. The one fact that deliberately stays
// OUTSIDE the record is "this document is launching the redirect right
// now" (ConnectionManager.isSignInRedirectPending) — a persisted state
// cannot distinguish the launching document from the returning one.
// =============================================================================

import { SS_PHASE } from '../constants';
import { sessionScopedStore } from '../util/devGate';
import { AuthPhase } from '../types/connection';

/** The persisted record: the state plus the sign-in's initiator app. */
export interface AuthPhaseRecord {
	state: AuthPhase;
	/** The app that initiated the current sign-in (AUTHORIZING only) —
	 *  the landing target once it completes. */
	appId?: string;
}

const VALID_STATES: readonly AuthPhase[] = [AuthPhase.FRESH, AuthPhase.AUTHORIZING, AuthPhase.AUTHENTICATED, AuthPhase.SIGNED_OUT];

/**
 * The tab's current auth phase. Absent or unreadable reads as FRESH.
 *
 * @returns The persisted phase record.
 */
export function getAuthPhase(): AuthPhaseRecord {
	try {
		const raw = JSON.parse(sessionScopedStore().getItem(SS_PHASE) ?? 'null') as Partial<AuthPhaseRecord> | null;
		if (raw && typeof raw === 'object' && VALID_STATES.includes(raw.state as AuthPhase)) {
			return { state: raw.state as AuthPhase, ...(typeof raw.appId === 'string' && raw.appId ? { appId: raw.appId } : {}) };
		}
	} catch { /* unreadable storage — a fresh tab */ }
	return { state: AuthPhase.FRESH };
}

/**
 * Replaces the tab's auth phase.
 *
 * @param record - The new record (appId rides AUTHORIZING only).
 */
export function setAuthPhase(record: AuthPhaseRecord): void {
	try {
		sessionScopedStore().setItem(SS_PHASE, JSON.stringify(record));
	} catch { /* storage unavailable — behaves as a fresh tab */ }
}
