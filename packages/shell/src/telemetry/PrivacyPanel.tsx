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
// Privacy section of the cloud Settings overlay: the device's consent record,
// rendered and controlled. The toggle writes the SAME localStorage record
// through the SAME transitions as the banner (consentState.ts) — this UI holds
// no state of its own. Cloud shell only; VS Code's one telemetry switch is the
// editor's own setting. Withdrawal here runs the full teardown the banner's
// "No thanks" runs (recording stopped, PostHog storage scrubbed, fresh journey
// key): withdrawal must be as easy as consent.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { decideConsent, getConsentState, subscribeConsent, withdrawConsent } from './consentState';
import { privacySignalOn } from 'rocketride/analytics';
import type { ConsentState } from './consent';

// ==== styles ================================================================

const styles = {
	root: {
		display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560,
		color: 'var(--rr-text-primary)', fontSize: 13, lineHeight: '19px',
	} as React.CSSProperties,
	title: { fontSize: 15, fontWeight: 600, margin: 0 } as React.CSSProperties,
	row: {
		display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
		padding: '12px 14px', borderRadius: 6,
		background: 'var(--rr-bg-paper)', border: '1px solid var(--rr-border)',
	} as React.CSSProperties,
	rowText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } as React.CSSProperties,
	rowTitle: { fontWeight: 600 } as React.CSSProperties,
	rowDetail: { color: 'var(--rr-text-secondary)' } as React.CSSProperties,
	toggle: (on: boolean, disabled: boolean) => ({
		position: 'relative', flex: 'none', width: 40, height: 22, borderRadius: 11,
		border: '1px solid var(--rr-border)',
		background: on ? 'var(--rr-brand)' : 'var(--rr-bg-titleBar-inactive)',
		cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
		transition: 'background 120ms ease',
	}) as React.CSSProperties,
	knob: (on: boolean) => ({
		position: 'absolute', top: 2, left: on ? 20 : 2, width: 16, height: 16,
		borderRadius: '50%', background: 'var(--rr-fg-button)',
		transition: 'left 120ms ease',
	}) as React.CSSProperties,
	muted: { color: 'var(--rr-text-secondary)', margin: 0 } as React.CSSProperties,
	link: { color: 'var(--rr-brand)', textDecoration: 'none' } as React.CSSProperties,
} as const;

// ==== component =============================================================

/**
 * The Settings overlay's Privacy section: consent status, the opt-in/out
 * toggle, what the opt-in enables, and the policy links.
 */
export const PrivacyPanel: React.FC = () => {
	const [state, setState] = useState<ConsentState>(() => {
		return getConsentState();
	});
	const [signal] = useState(() => {
		return privacySignalOn();
	});
	// Follow decisions made anywhere: the banner, another tab, this toggle.
	useEffect(() => {
		return subscribeConsent((next) => {
			setState(next);
		});
	}, []);

	const isOn = state === 'accepted';
	const onToggle = (): void => {
		if (signal) {
			return;
		}
		if (isOn) {
			// The full withdrawal: recording stopped, PostHog storage scrubbed, fresh journey key.
			withdrawConsent();
		} else {
			decideConsent('accepted');
		}
	};

	let statusDetail = 'You have not decided yet; only anonymous, cookieless measurement runs.';
	if (signal) {
		statusDetail = 'Your browser sends a privacy signal (Do Not Track / Global Privacy Control), so nothing is captured and the opt-in is unavailable.';
	} else if (state === 'accepted') {
		statusDetail = 'Analytics cookies are on for this browser: product analytics and session replay on signed-out pages.';
	} else if (state === 'rejected') {
		statusDetail = 'Analytics cookies are off for this browser; only anonymous, cookieless measurement runs.';
	}

	return (
		<div style={styles.root}>
			<h3 style={styles.title}>Privacy</h3>
			<div style={styles.row}>
				<div style={styles.rowText}>
					<span style={styles.rowTitle}>Analytics cookies</span>
					<span style={styles.rowDetail}>{statusDetail}</span>
				</div>
				<div
					role="switch"
					aria-checked={isOn}
					aria-label="Analytics cookies"
					tabIndex={signal ? -1 : 0}
					style={styles.toggle(isOn, signal)}
					onClick={onToggle}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onToggle();
						}
					}}
				>
					<div style={styles.knob(isOn)} />
				</div>
			</div>
			<p style={styles.muted}>
				This choice applies to this browser only — it is never stored on your account, and signed-in
				screens are never recorded either way. Details:{' '}
				<a href="/legal/privacy" target="_blank" rel="noreferrer" style={styles.link}>Privacy Policy</a>
				{' '}·{' '}
				<a href="/legal/cookies" target="_blank" rel="noreferrer" style={styles.link}>Cookie Policy</a>.
			</p>
		</div>
	);
};
