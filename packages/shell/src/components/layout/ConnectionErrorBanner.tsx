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
// CONNECTION ERROR DIALOG — recovery UI for latched connection failures
// =============================================================================
//
// Renders a centered modal dialog whenever ConnectionStatus carries a
// latched failure (status.lastFailure). Network failures offer a Retry that
// re-runs bootstrap via reload; auth failures offer Sign in via the shell's
// edition-aware login dispatcher (shell:loginRequest). A failure is a STOP
// — a dialog demands the decision a top strip let people scroll past.
// =============================================================================

import React, { CSSProperties, useEffect, useState } from 'react';
import { ConnectionManager } from '../../connection/connection';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { Modal } from '../modal/Modal';
import { Button } from '../button/Button';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	message: {
		margin: 0,
		fontSize: 13,
		lineHeight: 1.6,
		color: 'var(--rr-text-secondary)',
		wordBreak: 'break-word',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

export interface ConnectionErrorBannerProps {
	/** Override the status-derived failure message for other connection errors. */
	message?: string;
	/** Override retry handling; defaults to a full reload through bootstrap. */
	onRetry?: () => void | Promise<void>;
	/** Override sign-in handling; defaults to emitting shell:loginRequest. */
	onSignIn?: () => void | Promise<void>;
}

/** A dismissible centered recovery dialog for authentication and transport
 *  failures (the component keeps its historical name — same conditions,
 *  same actions, modal presentation). */
export const ConnectionErrorBanner: React.FC<ConnectionErrorBannerProps> = ({ message, onRetry, onSignIn }) => {
	const status = useConnectionStatus();
	const [dismissed, setDismissed] = useState(false);
	// The failure is latched manager-side (status.lastFailure) so reconnect
	// attempts and anonymous connects can't erase it before it renders.
	const failure = status.lastFailure;

	// A NEW failure (different kind/message) un-dismisses the banner.
	useEffect(() => {
		setDismissed(false);
	}, [failure?.kind, failure?.lastError, failure?.errorKind]);

	if (dismissed || !failure) return null;

	// Phrase message + action from the failure classification.
	const isNetworkFailure = failure.kind === 'network';
	const isOAuthCallbackFailure = !isNetworkFailure && failure.errorKind === 'oauth-callback';
	const defaultMessage = isNetworkFailure
		? 'Can\'t reach the server. Check your connection and retry.'
		: isOAuthCallbackFailure
			? `Sign-in didn't complete: ${failure.lastError}`
			: 'Your session has expired. Please sign in again.';
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
		: onSignIn ?? (() => {
			// Route through the shell's edition-aware login dispatcher: SaaS
			// starts OAuth, OSS opens the API-key form. Calling startOAuth()
			// directly here would throw "CloudAuthProvider not initialized" on
			// OSS deployments and turn this button into a silent no-op.
			ConnectionManager.getInstance().emit('shell:loginRequest', {});
		});

	const title = isNetworkFailure ? 'Connection lost' : isOAuthCallbackFailure ? 'Sign-in failed' : 'Session expired';
	return (
		<Modal
			title={title}
			onClose={() => setDismissed(true)}
			footer={
				<>
					<Button variant="secondary" onClick={() => setDismissed(true)}>Dismiss</Button>
					<Button
						onClick={() => {
							void Promise.resolve().then(onAction).catch((error) => {
								console.error('[ConnectionErrorBanner] Recovery action failed:', error);
							});
						}}
					>
						{action}
					</Button>
				</>
			}
		>
			<p style={styles.message} title={failure.lastError}>{message ?? defaultMessage}</p>
		</Modal>
	);
};
