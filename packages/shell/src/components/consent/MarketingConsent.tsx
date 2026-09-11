// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MarketingConsent — the marketing-consent banner and the attribution relay
 * behind server-side conversion reporting.
 *
 * Renders nothing unless this environment runs ad attribution (the probe named
 * a provider) — staging and OSS never show it, nor do automated browsers or
 * visitors sending Global Privacy Control (see util/adAttribution.ts).
 *
 * - Banner: shown while the decision is 'unset' (default deny), or when a
 *   "Privacy choices" control reopens it (the Sidebar menu, or the
 *   `rr:privacy-choices` window event remotes dispatch). Allow and Reject are
 *   styled identically — rejecting must be as easy as accepting.
 * - Relay: once consent is granted AND the user is signed in, the captured
 *   ad-click reference goes to the server (account.setAttribution), which
 *   reports conversions itself. An empty reference still relays: it records
 *   the consent that lets the server match a conversion by hashed email.
 * - Reject: clears the server copy, which stops all conversion reporting for
 *   this user. Nothing needs unloading — no third-party script ever ran.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useClient } from '../../hooks/useClient';
import { Button } from '../button/Button';
import { getMarketingConsent, setMarketingConsent, subscribeMarketingConsent } from '../../util/marketingConsent';
import { PRIVACY_CHOICES_EVENT, getAttributionProvider, getClickParams, isAttributionConfigured } from '../../util/adAttribution';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	banner: {
		position: 'fixed',
		left: 16,
		right: 16,
		bottom: 16,
		marginLeft: 'auto',
		maxWidth: 520,
		zIndex: 1100,
		display: 'flex',
		flexDirection: 'column',
		gap: 12,
		padding: '14px 16px',
		borderRadius: 10,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	title: {
		fontSize: 13.5,
		fontWeight: 600,
	} as CSSProperties,
	body: {
		fontSize: 12.5,
		lineHeight: 1.55,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	actions: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export const MarketingConsent: React.FC = () => {
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
				console.warn('[MarketingConsent] attribution relay failed:', err);
			}
		})();
	}, [configured, consent, client, userId]);

	const allow = useCallback(() => {
		setReopened(false);
		setMarketingConsent('granted');
	}, []);

	const reject = useCallback(async () => {
		setReopened(false);
		setMarketingConsent('denied');
		relayedFor.current = null;
		const provider = getAttributionProvider();
		if (client && userId && provider) {
			try {
				// Deletes the stored context — the server stops reporting
				// conversions for this user from here on.
				await client.account.setAttribution(provider, null);
			} catch (err) {
				console.warn('[MarketingConsent] clearing attribution failed:', err);
			}
		}
	}, [client, userId]);

	if (!configured || (consent !== 'unset' && !reopened)) return null;

	return (
		<div role="region" aria-label="Privacy choices" style={styles.banner}>
			<div style={styles.title}>Advertising measurement</div>
			<div style={styles.body}>
				Allow RocketRide to tell our advertising partner which ad brought you here, and to share a hashed (irreversible) copy of your email address, so we can
				measure which ads work. No cookies or tracking scripts are used, and nothing is shared unless you allow it. You can change this any time under Privacy
				choices.
			</div>
			<div style={styles.actions}>
				<Button variant="secondary" small onClick={() => void reject()}>
					Reject
				</Button>
				<Button variant="secondary" small onClick={allow}>
					Allow
				</Button>
			</div>
		</div>
	);
};

export default MarketingConsent;
