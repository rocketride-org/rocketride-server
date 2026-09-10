// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * MarketingConsent — the consent banner for the Gravity ad pixel, plus the
 * attribution relay that feeds server-side conversion events.
 *
 * Renders nothing unless this environment runs the pixel (the server probe
 * advertised a Gravity advertiser ID) — staging and OSS never show it.
 *
 * - Banner: shown while the decision is 'unset' (default deny), or when a
 *   "Privacy choices" control reopens it (the Sidebar menu, or the
 *   `rr:privacy-choices` window event remotes dispatch). Allow and Reject are
 *   styled identically — rejecting must be as easy as accepting.
 * - Relay: once consent is granted AND the user is signed in, the pixel's
 *   getCAPIData() blob is sent to the server (account.setAttribution) so
 *   purchase/signup conversions can be attributed server-side.
 * - Reject: clears the server copy (signed in), and reloads if the pixel
 *   already ran on this page — a loaded third-party script cannot be
 *   unloaded any other way.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useClient } from '../../hooks/useClient';
import { Button } from '../button/Button';
import { getMarketingConsent, setMarketingConsent, subscribeMarketingConsent } from '../../util/marketingConsent';
import { PRIVACY_CHOICES_EVENT, getGravityCAPIData, hasGravityPixelStarted, isGravityPixelConfigured, whenGravityPixelReady } from '../../util/gravityPixel';

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
	const configured = isGravityPixelConfigured();
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

	// Relay the pixel's attribution blob once consent and sign-in both hold.
	const userId = identity?.userId ?? null;
	useEffect(() => {
		if (!configured || consent !== 'granted' || !client || !userId) return;
		if (relayedFor.current === userId) return;
		let cancelled = false;
		void (async () => {
			if (!(await whenGravityPixelReady()) || cancelled) return;
			const data = getGravityCAPIData();
			if (!data) return;
			try {
				await client.account.setAttribution('gravity', data);
				relayedFor.current = userId;
			} catch (err) {
				// Attribution is best-effort; never surface it to the user.
				console.warn('[MarketingConsent] attribution relay failed:', err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [configured, consent, client, userId]);

	const allow = useCallback(() => {
		setReopened(false);
		setMarketingConsent('granted');
	}, []);

	const reject = useCallback(async () => {
		const pixelRan = hasGravityPixelStarted();
		setReopened(false);
		setMarketingConsent('denied');
		relayedFor.current = null;
		if (client && userId) {
			try {
				await client.account.setAttribution('gravity', null);
			} catch (err) {
				console.warn('[MarketingConsent] clearing attribution failed:', err);
			}
		}
		if (pixelRan) window.location.reload();
	}, [client, userId]);

	if (!configured || (consent !== 'unset' && !reopened)) return null;

	return (
		<div role="region" aria-label="Privacy choices" style={styles.banner}>
			<div style={styles.title}>Advertising measurement</div>
			<div style={styles.body}>We&apos;d like to use Gravity&apos;s advertising pixel to measure which ads bring people to RocketRide. It sets identifiers in your browser and stays off unless you allow it. You can change this any time under Privacy choices.</div>
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
