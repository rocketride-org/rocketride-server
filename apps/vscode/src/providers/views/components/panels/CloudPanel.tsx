// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CloudPanel — target panel for Cloud connection mode.
 *
 * Renders: sign-in/out status and the subscribe prompt. The run team is never
 * chosen here: development runs use the user's profile-assigned development
 * team, deployed runs use the team on the deployment record.
 * Used by ConnectionSettings (dev) and DeployTargetSettings (deploy).
 */

import React, { useEffect, useState, useCallback } from 'react';
import cloudLogoDark from '../../../../../rocketride-dark-icon.png';
import cloudLogoLight from '../../../../../rocketride-light-icon.png';
import { settingsStyles as S } from '../../Settings/SettingsWebview';
import { useTheme } from '../../hooks/useTheme';
import { useStripeKey } from '../../hooks/useStripeKey';
import { CheckoutUnavailableNotice } from '../CheckoutUnavailableNotice';
import { Banner, CheckoutModal } from 'shell';
import type { CheckoutPlan } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

export interface CloudPanelProps {
	/** Whether the user is currently signed in via OAuth. */
	cloudSignedIn: boolean;
	/** Display name of the signed-in user. */
	cloudUserName: string;
	/** The cloud server the session's token was minted against ('' when
	 * unknown — sessions minted before this field existed carry no URL). */
	cloudSignedInUrl?: string;
	/** Last sign-in attempt came back WAITLISTED: authentication succeeded
	 * but access is queued, so no session exists — rendered as a friendly
	 * banner mirroring the browser shell's waitlist screen. */
	waitlisted?: boolean;
	/** Display name from the waitlisted attempt (may be empty). */
	waitlistedName?: string;
	/** Trigger the OAuth sign-in flow. */
	onCloudSignIn: () => void;
	onCloudSignOut: () => void;
	/** Staged (uncommitted) auth change — a completed sign-in or a requested
	 * sign-out that applies only when the user saves. Rendered as a pending
	 * row with an Undo action. */
	pending?: { signIn: boolean; signOut: boolean; userName: string; url: string };
	/** Discard the staged auth change (the pending row's Undo). */
	onUndoPending?: () => void;
	/** Unique prefix for HTML element IDs. */
	idPrefix: string;
	/** When true, hides advanced fields (used on Welcome page). */
	simplified?: boolean;
	/** Cloud mode: connect to the custom server instead of the default cloud. */
	useCustomServer?: boolean;
	/** Cloud mode: the custom server address. */
	customUrl?: string;
	/** The default cloud server (the setting's default, sent by the host —
	 * this webview bakes no address). */
	defaultCloudUrl?: string;
	/** Toggle the custom-server opt-in. */
	onUseCustomServerChange?: (value: boolean) => void;
	/** Edit the custom server address. */
	onCustomUrlChange?: (value: string) => void;
	/**
	 * Whether the server supports SaaS/OAuth (from probe result).
	 * undefined = probing in progress, false = incompatible server.
	 */
	isSaas?: boolean;
	/** The probe could not REACH the server (transport failure) — distinct
	 * from a reachable server that does not support RocketRide Cloud. */
	probeUnreachable?: boolean;
	/** Called on mount to probe the cloud server. Receives the cloud endpoint URL. */
	onProbeServer?: (cloudUrl: string) => void;
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

/** Comparable identity of a server URL — origin when parseable, else the
 *  trimmed string sans trailing slashes (both sides normalize identically). */
const serverIdentity = (url: string): string => {
	const trimmed = url.trim().replace(/\/+$/, '');
	try {
		return new URL(trimmed).origin.toLowerCase();
	} catch {
		return trimmed.toLowerCase();
	}
};

export const CloudPanel: React.FC<CloudPanelProps> = ({ cloudSignedIn, cloudUserName, cloudSignedInUrl, waitlisted, waitlistedName, onCloudSignIn, onCloudSignOut, pending, onUndoPending, idPrefix, simplified, useCustomServer, customUrl, defaultCloudUrl, onUseCustomServerChange, onCustomUrlChange, isSaas, probeUnreachable, onProbeServer, isSubscribed, onFetchPlans, onCreateCheckout, onConfirmPending, onCheckoutSuccess }) => {
	const theme = useTheme();
	const [showCheckout, setShowCheckout] = useState(false);

	// Server-supplied Stripe publishable key — only fetched when this panel
	// can actually render a checkout (simplified/Welcome panels never do).
	const { key: stripeKey, reason: stripeKeyReason } = useStripeKey(Boolean(onFetchPlans));

	const handleCheckoutSuccess = useCallback(() => {
		setShowCheckout(false);
		onCheckoutSuccess?.();
	}, [onCheckoutSuccess]);

	// The effective target: the user's custom server when opted in, else the
	// default cloud from the host. Nothing is baked into this bundle.
	const cloudUrl = (useCustomServer && customUrl) || defaultCloudUrl || '';

	// Probe on mount (and when the target changes) to confirm server is SaaS.
	useEffect(() => {
		if (onProbeServer && cloudUrl) onProbeServer(cloudUrl);
	}, [cloudUrl]); // eslint-disable-line react-hooks/exhaustive-deps

	// Subscribe gate: the session's facts (signed-in, subscription state) and
	// the checkout handlers all ride the CURRENT connection — the server the
	// token was minted against. When the form's target names a DIFFERENT
	// server, offering Subscribe here would bill the old server while the
	// panel talks about the new one, so the money path closes until the user
	// signs in on the selected server. Unknown session URL (a session minted
	// before it was recorded) stays permissive — the target is unchanged in
	// the overwhelming case, and sign-out/in refreshes the record.
	const sessionMatchesTarget =
		!cloudSignedIn || !cloudSignedInUrl || !cloudUrl || serverIdentity(cloudSignedInUrl) === serverIdentity(cloudUrl);

	return (
		<>
			<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
				<img src={theme === 'dark' ? cloudLogoLight : cloudLogoDark} alt="RocketRide Cloud" style={{ width: 48, height: 48, objectFit: 'contain', flexShrink: 0 }} />
				<div style={S.modeConfigDesc}>Sign in with your RocketRide account to connect to the cloud.</div>
			</div>

			{/* Custom server opt-in — the address is a SETTING, never a bake. */}
			{!simplified && onUseCustomServerChange && (
				<div style={S.formGroup}>
					<label htmlFor={`${idPrefix}-useCustomServer`} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
						<input
							id={`${idPrefix}-useCustomServer`}
							type="checkbox"
							checked={Boolean(useCustomServer)}
							onChange={(e) => onUseCustomServerChange(e.target.checked)}
						/>
						<span style={S.label}>Use custom server</span>
					</label>
					{useCustomServer && (
						<input
							id={`${idPrefix}-cloudUrl`}
							type="text"
							value={customUrl || ''}
							placeholder={defaultCloudUrl || 'https://staging.rocketride.ai'}
							onChange={(e) => onCustomUrlChange?.(e.target.value)}
							style={{ marginTop: 6 }}
						/>
					)}
					{!useCustomServer && defaultCloudUrl && <div style={{ ...S.modeConfigDesc, marginTop: 4 }}>Server: {defaultCloudUrl}</div>}
					{useCustomServer && <div style={{ ...S.modeConfigDesc, marginTop: 4 }}>Sign-in and all traffic target this server.</div>}
				</div>
			)}

			{/* Probing server... (only before the FIRST result — a re-probe keeps
			    showing the last result instead of flickering back to this) */}
			{!probeUnreachable && isSaas === undefined && <div style={S.modeConfigDesc}>Checking server compatibility...</div>}

			{/* Server cannot be reached (transport failure) — distinct from a
			    reachable server that lacks cloud support */}
			{probeUnreachable && <div style={{ padding: '12px 16px', borderRadius: 4, backgroundColor: 'var(--vscode-inputValidation-warningBackground, #4d3a00)', border: '1px solid var(--vscode-inputValidation-warningBorder, #f0c000)', color: 'var(--rr-text-primary)', fontSize: 13, lineHeight: 1.5 }}>The server at {cloudUrl || 'the configured address'} cannot be reached. Check the address and that the server is running.</div>}

			{/* Server answered but does not support cloud/OAuth */}
			{!probeUnreachable && isSaas === false && <div style={{ padding: '12px 16px', borderRadius: 4, backgroundColor: 'var(--vscode-inputValidation-warningBackground, #4d3a00)', border: '1px solid var(--vscode-inputValidation-warningBorder, #f0c000)', color: 'var(--rr-text-primary)', fontSize: 13, lineHeight: 1.5 }}>The configured server does not support RocketRide Cloud. Cloud mode requires a RocketRide Cloud server. Please use a different connection mode.</div>}

			{/* Staged sign-in — a completed browser sign-in that applies when the
			    user saves. Rendered regardless of the probe state (it is a fact
			    about the sign-in, not about the form's current target). */}
			{pending?.signIn && (
				<div style={S.formGroup}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
						<span style={{ fontSize: 20, color: 'var(--vscode-editorWarning-foreground, #e2b93d)' }}>&#10003;</span>
						<div>
							<div style={{ fontWeight: 600, color: 'var(--rr-text-primary)' }}>{pending.userName || 'Signed in'}</div>
							<div style={S.modeConfigDesc}>Sign-in staged. Save settings to apply.</div>
						</div>
					</div>
					<button
						type="button"
						onClick={onUndoPending}
						style={{
							width: 'auto',
							marginTop: 8,
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
						}}
					>
						Undo
					</button>
				</div>
			)}

			{/* Staged sign-out — the stored session is deleted when the user saves. */}
			{!pending?.signIn && pending?.signOut && (
				<div style={S.formGroup}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
						<span style={{ fontSize: 20, color: 'var(--rr-text-secondary)' }}>&#10005;</span>
						<div>
							<div style={{ fontWeight: 600, color: 'var(--rr-text-secondary)', textDecoration: 'line-through' }}>{cloudUserName || 'Signed in'}</div>
							<div style={S.modeConfigDesc}>Sign-out staged. Save settings to apply.</div>
						</div>
					</div>
					<button
						type="button"
						onClick={onUndoPending}
						style={{
							width: 'auto',
							marginTop: 8,
							backgroundColor: 'var(--vscode-button-secondaryBackground)',
							color: 'var(--vscode-button-secondaryForeground)',
						}}
					>
						Undo
					</button>
				</div>
			)}

			{/* Sign-in status. Deliberately NOT gated on the probe: a signed-in
			    user must always be able to sign out, even when the configured
			    server is unreachable or fails the compatibility check. */}
			{cloudSignedIn && !pending?.signIn && !pending?.signOut && (
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
			{isSaas && !cloudSignedIn && !pending?.signIn && (
				<div style={S.formGroup}>
					{/* Waitlisted sign-in: auth succeeded, access is queued (the
					    server minted no token) — the browser shell's friendly
					    waitlist screen, as the platform's stock Banner. */}
					{waitlisted && (
						<div style={{ marginBottom: 10 }}>
							<Banner variant="info">
								Thanks for signing up{waitlistedName ? `, ${waitlistedName}` : ''}! Your account is all set — we&#39;re rolling out
								access in waves and you&#39;re in the queue. We&#39;ll email you as soon as your account is activated.
							</Banner>
						</div>
					)}
					<button type="button" onClick={onCloudSignIn} style={{ width: 'auto', padding: '10px 24px', fontWeight: 600 }}>
						Sign In
					</button>
				</div>
			)}

			{/* Session/target mismatch — the signed-in session belongs to a
			    different server than the form now targets; billing surfaces
			    are withheld until the user signs in on the selected server. */}
			{isSaas && cloudSignedIn && !pending?.signIn && !pending?.signOut && !sessionMatchesTarget && (
				<div style={S.modeConfigDesc}>
					Signed in to {cloudSignedInUrl}. Sign out and sign in again to use {cloudUrl}.
				</div>
			)}

			{/* Subscribe prompt — shown when signed in but not subscribed, and
			    only when the session actually belongs to the targeted server.
			    Hidden while an auth change is staged: the money path rides the
			    SAVED session, which is about to change. */}
			{isSaas && cloudSignedIn && !pending?.signIn && !pending?.signOut && sessionMatchesTarget && isSubscribed === false && onFetchPlans && (
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
			{showCheckout && !stripeKey && <CheckoutUnavailableNotice reason={stripeKeyReason} onClose={() => setShowCheckout(false)} />}

		</>
	);
};
