// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CloudPanel — target panel for Cloud connection mode.
 *
 * Renders: sign-in/out status, team selector.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useEffect, useState, useCallback } from 'react';
import cloudLogoDark from '../../../../../rocketride-dark-icon.png';
import cloudLogoLight from '../../../../../rocketride-light-icon.png';
import { settingsStyles as S } from '../../Settings/SettingsWebview';
import { useTheme } from '../../hooks/useTheme';
import { CheckoutModal } from 'shared';
import type { CheckoutPlan } from 'shared';

// =============================================================================
// TYPES
// =============================================================================

export interface CloudPanelProps {
	/** Whether the user is currently signed in via OAuth. */
	cloudSignedIn: boolean;
	/** Display name of the signed-in user. */
	cloudUserName: string;
	/** Trigger the OAuth sign-in flow. */
	onCloudSignIn: () => void;
	onCloudSignOut: () => void;
	/** Available teams for the signed-in account. */
	teams: Array<{ id: string; name: string }>;
	/** Currently selected team ID (persisted in settings). */
	selectedTeamId: string;
	onTeamChange: (teamId: string) => void;
	/** Unique prefix for HTML element IDs. */
	idPrefix: string;
	/** When true, hides advanced fields (used on Welcome page). */
	simplified?: boolean;
	/**
	 * Whether the server supports SaaS/OAuth (from probe result).
	 * undefined = probing in progress, false = incompatible server.
	 */
	isSaas?: boolean;
	/** Called on mount to probe the cloud server. Receives the cloud endpoint URL. */
	onProbeServer?: (cloudUrl: string) => void;
	/** Called when isSaas becomes true, to fetch the team list. Receives the cloud endpoint URL. */
	onFetchTeams?: (cloudUrl: string) => void;
	/** Whether the user has an active subscription. When false, shows a subscribe button. */
	isSubscribed?: boolean;
	/** Checkout callbacks -- when provided, CloudPanel renders the CheckoutModal itself. */
	onFetchPlans?: () => Promise<CheckoutPlan[]>;
	onCreateCheckout?: (priceId: string) => Promise<{ clientSecret: string; subscriptionId: string }>;
	onConfirmPending?: (subscriptionId: string, priceId: string) => Promise<void>;
	onCheckoutSuccess?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const CloudPanel: React.FC<CloudPanelProps> = ({ cloudSignedIn, cloudUserName, onCloudSignIn, onCloudSignOut, teams, selectedTeamId, onTeamChange, idPrefix, isSaas, onProbeServer, onFetchTeams, isSubscribed, onFetchPlans, onCreateCheckout, onConfirmPending, onCheckoutSuccess }) => {
	const id = (name: string) => `${idPrefix}-${name}`;
	const theme = useTheme();
	const [showCheckout, setShowCheckout] = useState(false);

	const stripeKey = process.env.RR_STRIPE_PUBLISHABLE_KEY || '';

	const handleCheckoutSuccess = useCallback(() => {
		setShowCheckout(false);
		onCheckoutSuccess?.();
	}, [onCheckoutSuccess]);

	const cloudUrl = process.env.ROCKETRIDE_URI || '';

	// Step 1: Probe on mount to confirm server is SaaS.
	useEffect(() => {
		if (onProbeServer && cloudUrl) onProbeServer(cloudUrl);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// Step 3: Once SaaS is confirmed and user is signed in, fetch teams.
	// (Step 2 — sign-in — is handled by the Sign In button / auth listener.)
	useEffect(() => {
		if (isSaas && cloudSignedIn && onFetchTeams && cloudUrl) onFetchTeams(cloudUrl);
	}, [isSaas, cloudSignedIn]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<img src={theme === 'dark' ? cloudLogoLight : cloudLogoDark} alt="RocketRide Cloud" style={{ width: 48, height: 48, objectFit: 'contain', flexShrink: 0 }} />
				<div style={S.modeConfigDesc}>Sign in with your RocketRide account to connect to the cloud.</div>
			</div>

			{/* Probing server... */}
			{isSaas === undefined && <div style={S.modeConfigDesc}>Checking server compatibility...</div>}

			{/* Server does not support cloud/OAuth */}
			{isSaas === false && <div style={{ padding: '12px 16px', borderRadius: 4, backgroundColor: 'var(--vscode-inputValidation-warningBackground, #4d3a00)', border: '1px solid var(--vscode-inputValidation-warningBorder, #f0c000)', color: 'var(--rr-text-primary)', fontSize: 13, lineHeight: 1.5 }}>The configured server does not support RocketRide Cloud. Cloud mode requires a RocketRide Cloud server. Please use a different connection mode.</div>}

			{/* Sign-in status — only when server supports cloud */}
			{isSaas && cloudSignedIn && (
				<div style={S.formGroup}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
						<span style={{ fontSize: 20, color: 'var(--vscode-testing-iconPassed, #22c55e)' }}>&#10003;</span>
						<div>
							<div style={{ fontWeight: 600, color: 'var(--rr-text-primary)' }}>{cloudUserName || 'Signed in'}</div>
						</div>
					</div>
					<button
						type="button"
						onClick={onCloudSignOut}
						style={{
							width: 'auto',
							marginTop: 8,
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
						}}
					>
						Sign Out
					</button>
				</div>
			)}
			{isSaas && !cloudSignedIn && (
				<div style={S.formGroup}>
					<button type="button" onClick={onCloudSignIn} style={{ width: 'auto', padding: '10px 24px', fontWeight: 600 }}>
						Sign In
					</button>
				</div>
			)}

			{/* Team selector */}
			{isSaas && cloudSignedIn && teams.length > 0 && (
				<div style={S.formGroup}>
					<label htmlFor={id('team')} style={S.label}>
						Team
					</label>
					<select id={id('team')} value={selectedTeamId} onChange={(e) => onTeamChange(e.target.value)}>
						<option value="">Select a team...</option>
						{teams.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</select>
					<div style={S.helpText}>Which team's engine to connect to</div>
				</div>
			)}

			{/* Subscribe prompt — shown when signed in but not subscribed */}
			{isSaas && cloudSignedIn && isSubscribed === false && onFetchPlans && (
				<div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 16px', borderRadius: 8, border: '1px solid var(--vscode-input-border, #444)', background: 'var(--vscode-editor-background)' }}>
					<div style={{ flex: 1, fontSize: 13, lineHeight: 1.5, color: 'var(--rr-text-secondary)' }}>
						You are currently not subscribed to the RocketRide Cloud. You will be able to run all your pipelines locally, but to run them in the cloud, or deploy pipelines to the cloud, requires a subscription.
					</div>
					<button
						type="button"
						onClick={() => setShowCheckout(true)}
						style={{ whiteSpace: 'nowrap', padding: '10px 24px', fontWeight: 600, flexShrink: 0 }}
					>
						Subscribe to Pipe Builder
					</button>
				</div>
			)}

			{/* Checkout modal overlay */}
			{showCheckout && stripeKey && onFetchPlans && onCreateCheckout && onConfirmPending && (
				<CheckoutModal
					appName="Pipe Builder"
					appDescription="Visual AI pipeline editor -- run and deploy pipelines on RocketRide Cloud."
					stripePublishableKey={stripeKey}
					onFetchPlans={onFetchPlans}
					onCreateCheckout={onCreateCheckout}
					onConfirmPending={onConfirmPending}
					onSuccess={handleCheckoutSuccess}
					onClose={() => setShowCheckout(false)}
				/>
			)}

		</>
	);
};
