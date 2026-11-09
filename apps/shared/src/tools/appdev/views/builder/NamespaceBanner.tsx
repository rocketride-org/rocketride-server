// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The read-only banner above STORE and DEPLOY when the app's id is outside
 * the org's developer namespace. For a `local.<name>` app on a host that can
 * rewrite its files, it offers to move the app to `<developerId>.<name>`,
 * asking first; otherwise it keeps the hand-edit instruction.
 *
 * Imports nothing from the shell, so node:test can render it.
 */

import React, { useState } from 'react';
import { adoptedAppId } from '../../namespaceAdoption';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	banner: {
		margin: '12px 26px 0',
		padding: '10px 14px',
		border: '1px solid var(--rr-color-warning)',
		borderRadius: 8,
		background: 'rgba(232,185,49,0.10)',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.5,
		flexShrink: 0,
	},
	row: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' },
	note: { marginTop: 8, color: 'var(--rr-text-secondary)' },
	primaryBtn: {
		padding: '4px 10px',
		fontSize: 11.5,
		fontWeight: 600,
		background: 'var(--rr-brand)',
		color: 'var(--rr-text-on-brand, #ffffff)',
		border: '1px solid transparent',
		borderRadius: 4,
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	secondaryBtn: {
		padding: '4px 10px',
		fontSize: 11.5,
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		cursor: 'pointer',
	},
	error: { marginTop: 8, fontSize: 12, color: 'var(--rr-color-error)' },
};

// =============================================================================
// VIEW
// =============================================================================

/** Where the move stands: offered, being confirmed, running, or done. */
export type NamespaceBannerPhase = 'idle' | 'confirm' | 'busy' | 'done';

/** Props for {@link NamespaceBannerView}. */
export interface INamespaceBannerViewProps {
	/** The app's current id. */
	appId: string;
	/** The org's developer id. */
	developerId: string;
	/** The id the app can move to; null = no move offered (hand-edit text). */
	targetId: string | null;
	/** Where the move stands. */
	phase: NamespaceBannerPhase;
	/** The last failure, shown under the buttons. */
	error?: string;
	/** Open the confirmation. */
	onAsk: () => void;
	/** Run the move. */
	onConfirm: () => void;
	/** Close the confirmation. */
	onCancel: () => void;
}

/**
 * The banner, stateless: every phase renders from props.
 *
 * @param props - See {@link INamespaceBannerViewProps}.
 */
export const NamespaceBannerView: React.FC<INamespaceBannerViewProps> = ({ appId, developerId, targetId, phase, error, onAsk, onConfirm, onCancel }) => (
	<div style={styles.banner}>
		<div>
			<strong>Read-only:</strong> this app&rsquo;s id <code>{appId}</code> is outside your organization&rsquo;s developer namespace <code>{developerId}</code>.{' '}
			{targetId ? (
				<>
					Move it to <code>{targetId}</code> to publish it from this org.
				</>
			) : (
				<>
					Rename the app id in package.json to <code>{developerId}.&lt;name&gt;</code> to publish it from this org.
				</>
			)}
		</div>
		{targetId && phase === 'idle' && (
			<div style={styles.row}>
				<button style={styles.primaryBtn} onClick={onAsk}>
					Move to {targetId}
				</button>
			</div>
		)}
		{targetId && (phase === 'confirm' || phase === 'busy') && (
			<>
				<div style={styles.note}>
					This changes the app id to <code>{targetId}</code> in package.json (and the publisher and package name, if they are still the ones the app was created with), and in the .rrapp file and src/AppDescriptor.ts when they carry it. The App Builder then reopens on the new id. Nothing on the server changes. Settings saved for you under <code>{appId}</code>, including the App Builder&rsquo;s layout and the preview&rsquo;s saved state, stay under the old id.
				</div>
				<div style={styles.row}>
					<button style={styles.primaryBtn} disabled={phase === 'busy'} onClick={onConfirm}>
						{phase === 'busy' ? 'Moving…' : 'Move app'}
					</button>
					<button style={styles.secondaryBtn} disabled={phase === 'busy'} onClick={onCancel}>
						Cancel
					</button>
				</div>
			</>
		)}
		{targetId && phase === 'done' && (
			<div style={styles.note}>
				Moved to <code>{targetId}</code>. The App Builder is reopening on the new id.
			</div>
		)}
		{error ? <div style={styles.error}>{error}</div> : null}
	</div>
);

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link NamespaceBanner}. */
export interface INamespaceBannerProps {
	/** The app's current id. */
	appId: string;
	/** The org's developer id. */
	developerId: string;
	/** The host's move action (IAppBuilderHost.adoptDeveloperId); absent = no move offered. */
	onAdopt?: (developerId: string) => Promise<void>;
}

/**
 * The banner with its confirm-then-move state.
 *
 * @param props - See {@link INamespaceBannerProps}.
 */
export const NamespaceBanner: React.FC<INamespaceBannerProps> = ({ appId, developerId, onAdopt }) => {
	const [phase, setPhase] = useState<NamespaceBannerPhase>('idle');
	const [error, setError] = useState('');
	const targetId = onAdopt ? adoptedAppId(appId, developerId) : null;

	/** Run the confirmed move; a failure returns to the confirmation with the reason. */
	const confirm = async (): Promise<void> => {
		if (!onAdopt) return;
		setPhase('busy');
		setError('');
		try {
			await onAdopt(developerId);
			// The host reopens the App Builder on the new id, which unmounts this.
			setPhase('done');
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setPhase('confirm');
		}
	};

	return (
		<NamespaceBannerView
			appId={appId}
			developerId={developerId}
			targetId={targetId}
			phase={phase}
			error={error}
			onAsk={() => setPhase('confirm')}
			onConfirm={() => void confirm()}
			onCancel={() => {
				setPhase('idle');
				setError('');
			}}
		/>
	);
};
