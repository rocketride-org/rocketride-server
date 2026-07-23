import React, { CSSProperties, useEffect, useState } from 'react';
import { ConnectionManager } from '../../connection/connection';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';

const styles = {
	banner: {
		position: 'fixed',
		top: 0,
		left: 0,
		right: 0,
		zIndex: 1000,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 12,
		minHeight: 36,
		padding: '6px 12px',
		backgroundColor: 'var(--rr-bg-paper)',
		borderBottom: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-family)',
		fontSize: 'var(--rr-font-size-widget)',
	} as CSSProperties,
	message: { flex: '0 1 auto' } as CSSProperties,
	action: {
		border: 0,
		background: 'none',
		padding: 0,
		color: 'var(--rr-brand)',
		font: 'inherit',
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,
	dismiss: {
		position: 'absolute',
		right: 12,
		border: 0,
		background: 'none',
		padding: '0 4px',
		color: 'var(--rr-text-secondary)',
		fontSize: 20,
		lineHeight: 1,
		cursor: 'pointer',
	} as CSSProperties,
};

export interface ConnectionErrorBannerProps {
	/** Override the status-derived failure message for other connection errors. */
	message?: string;
	/** Override retry handling; defaults to ConnectionManager.reconnect(). */
	onRetry?: () => void | Promise<void>;
	/** Override sign-in handling; defaults to ConnectionManager.startOAuth(false). */
	onSignIn?: () => void | Promise<void>;
}

/** A dismissible recovery banner for authentication and transport failures. */
export const ConnectionErrorBanner: React.FC<ConnectionErrorBannerProps> = ({ message, onRetry, onSignIn }) => {
	const status = useConnectionStatus();
	const [dismissed, setDismissed] = useState(false);
	// The failure is latched manager-side (status.lastFailure) so reconnect
	// attempts and anonymous connects can't erase it before it renders.
	const failure = status.lastFailure;

	useEffect(() => {
		setDismissed(false);
	}, [failure?.kind, failure?.lastError, failure?.errorKind]);

	if (dismissed || !failure) return null;

	const isNetworkFailure = failure.kind === 'network';
	const isOAuthCallbackFailure = !isNetworkFailure && failure.errorKind === 'oauth-callback';
	const defaultMessage = isNetworkFailure
		? 'Can\'t reach the server — check your connection and retry.'
		: isOAuthCallbackFailure
			? `Sign-in didn't complete: ${failure.lastError}`
			: 'Your session has expired — please sign in again.';
	const action = isNetworkFailure ? 'Retry' : isOAuthCallbackFailure ? 'Try again' : 'Sign in';
	const onAction = isNetworkFailure
		? onRetry ?? (() => {
			// A reload re-runs bootstrap, which recovers every shape: a stored
			// token logs back in, tokenless renders the landing, and a still-
			// unreachable server re-latches this banner. In-place recovery via
			// ConnectionManager.reconnect() stalls in CONNECTING even against a
			// healthy server (pre-existing; tracked separately) — don't use it
			// as the default action.
			window.location.reload();
		})
		: onSignIn ?? (() => ConnectionManager.getInstance().startOAuth(false));

	return (
		<div style={styles.banner} role="alert">
			<span style={styles.message} title={failure.lastError}>{message ?? defaultMessage}</span>
			<button type="button" style={styles.action} onClick={() => {
				void Promise.resolve().then(onAction).catch((error) => {
					console.error('[ConnectionErrorBanner] Recovery action failed:', error);
				});
			}}>
				{action}
			</button>
			<button type="button" style={styles.dismiss} aria-label="Dismiss connection error" onClick={() => setDismissed(true)}>
				×
			</button>
		</div>
	);
};
