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
// USE MARKETING CONSENT — the decision, and the relay behind it
// =============================================================================

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuthUser } from './useAuthUser';
import { useClient } from './useClient';
import { getMarketingConsent, setMarketingConsent, subscribeMarketingConsent, type MarketingConsent } from '../util/marketingConsent';
import { PRIVACY_CHOICES_EVENT, getAttributionProvider, getClickParams, isAttributionConfigured } from '../util/adAttribution';

/** What a consent surface needs to render itself and record a decision. */
export interface MarketingConsentState {
	/** True where this environment runs ad attribution (the probe named a provider). */
	configured: boolean;
	/** The stored decision ('unset' until the visitor chooses). */
	consent: MarketingConsent;
	/**
	 * Whether a consent surface should be on screen: no decision yet, or a
	 * "Privacy choices" control reopened it. False whenever `configured` is.
	 */
	visible: boolean;
	/** Record consent and close. */
	allow: () => void;
	/** Refuse, close, and clear the server copy so reporting stops. */
	reject: () => void;
}

/**
 * The marketing-consent decision plus the attribution relay behind server-side
 * conversion reporting.
 *
 * The decision itself, the ad-click capture, and the opt-out checks all live in
 * the shell (they run in bootstrap, before any remote exists, and the OAuth
 * redirect reads the decision). This hook is the surface a consent UI needs —
 * including one owned by a remote, which cannot reach `util/marketingConsent`
 * or `util/adAttribution` directly.
 *
 * Renders nothing anywhere unless this environment runs ad attribution: staging
 * and OSS never do, nor do automated browsers or visitors sending Global
 * Privacy Control (see util/adAttribution.ts).
 *
 * - Relay: once consent is granted AND the user is signed in, the captured
 *   ad-click reference goes to the server (account.setAttribution), which
 *   reports conversions itself. An empty reference still relays: it records the
 *   consent that lets the server match a conversion by hashed email.
 * - Reject: clears the server copy, which stops all conversion reporting for
 *   this user. Nothing needs unloading — no third-party script ever ran.
 */
export function useMarketingConsent(): MarketingConsentState {
	const consent = useSyncExternalStore(subscribeMarketingConsent, getMarketingConsent, getMarketingConsent);
	const identity = useAuthUser();
	const client = useClient();
	const configured = isAttributionConfigured();
	const [reopened, setReopened] = useState(false);
	// The user whose attribution this page already relayed — once per page
	// per user, re-sent after a sign-in as someone else.
	const relayedFor = useRef<string | null>(null);

	// "Privacy choices" from anywhere (remotes dispatch the window event).
	useEffect(() => {
		if (!configured) return;
		const open = () => setReopened(true);
		window.addEventListener(PRIVACY_CHOICES_EVENT, open);
		return () => window.removeEventListener(PRIVACY_CHOICES_EVENT, open);
	}, [configured]);

	// Relay the ad-click reference once consent and sign-in both hold. An
	// empty reference is still relayed: the stored row is what permits
	// server-side reporting at all, and a conversion with no click can still
	// match the ad that was seen (hashed email, server side).
	const userId = identity?.userId ?? null;
	useEffect(() => {
		const provider = getAttributionProvider();
		if (!configured || !provider || consent !== 'granted' || !client || !userId) return;
		if (relayedFor.current === userId) return;
		void (async () => {
			try {
				await client.account.setAttribution(provider, getClickParams());
				relayedFor.current = userId;
			} catch (err) {
				// Attribution is best-effort; never surface it to the user.
				console.warn('[useMarketingConsent] attribution relay failed:', err);
			}
		})();
	}, [configured, consent, client, userId]);

	const allow = useCallback(() => {
		setReopened(false);
		setMarketingConsent('granted');
	}, []);

	const reject = useCallback(() => {
		setReopened(false);
		setMarketingConsent('denied');
		relayedFor.current = null;
		const provider = getAttributionProvider();
		if (client && userId && provider) {
			void (async () => {
				try {
					// Deletes the stored context — the server stops reporting
					// conversions for this user from here on.
					await client.account.setAttribution(provider, null);
				} catch (err) {
					console.warn('[useMarketingConsent] clearing attribution failed:', err);
				}
			})();
		}
	}, [client, userId]);

	return {
		configured,
		consent,
		visible: configured && (consent === 'unset' || reopened),
		allow,
		reject,
	};
}

export default useMarketingConsent;
