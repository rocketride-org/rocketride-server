// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * OAuthWidget — an `oauth2` leaf. The button starts the broker's consent flow
 * for the provider the leaf names (Google / Microsoft / Slack, read from the
 * property title); the broker returns to the host, which writes the grant to
 * this leaf's path (NodeConfigPanel). A stored grant shows "Authenticated"
 * with a Disconnect affordance that deletes the key.
 *
 * The redirect carries the node's current config so the broker can restore
 * state, with every credential-shaped value stripped: the URL lands in
 * browser history and broker logs.
 */

import { CSSProperties, ReactElement, useCallback } from 'react';
import { Button, commonStyles } from 'shell';

import type { IConfigTree } from '../model';
import { useOAuthEnv } from '../OAuthEnvContext';

// =============================================================================
// Types
// =============================================================================

/** The brokers the widget knows how to start. */
export type OAuthProvider = 'google' | 'microsoft' | 'slack';

// =============================================================================
// Constants
// =============================================================================

/** Config keys never sent along on the consent redirect. */
const CREDENTIAL_KEYS = new Set(['accessToken', 'refreshToken', 'userToken', 'userAuth', 'idToken', 'tokenExpiry', 'clientSecret', 'serviceKey', 'apikey', 'apiKey', 'password', 'token', 'secureParameters']);

/**
 * Scopes per access tier, keyed by the node's provider (its protocol name
 * without `://`). The broker grants identity plus exactly the requested
 * scopes (least privilege), or its default consent when no scope is sent.
 * Maps mirror the per-service AccessSpecs in core/google_access.py and
 * core/microsoft_access.py; an unknown provider or tier sends none rather
 * than guessing another service's scopes.
 */
const GOOGLE_API = 'https://www.googleapis.com/auth';
const SERVICE_TIER_SCOPES: Record<OAuthProvider, Record<string, Record<string, string[]>>> = {
	google: {
		tool_gmail: {
			readonly: [`${GOOGLE_API}/gmail.readonly`],
			modify: [`${GOOGLE_API}/gmail.modify`],
			send: [`${GOOGLE_API}/gmail.modify`, `${GOOGLE_API}/gmail.send`],
			settings: [`${GOOGLE_API}/gmail.modify`, `${GOOGLE_API}/gmail.settings.basic`],
			settings_sharing: [`${GOOGLE_API}/gmail.modify`, `${GOOGLE_API}/gmail.settings.basic`, `${GOOGLE_API}/gmail.settings.sharing`],
			full: ['https://mail.google.com/'],
		},
	},
	microsoft: {
		// Graph's workbook API accepts only delegated Files.ReadWrite, reads
		// included; the excel readonly tier is a node-side write gate.
		tool_excel: { readonly: ['Files.ReadWrite'], write: ['Files.ReadWrite'] },
		tool_word: { readonly: ['Files.Read'], write: ['Files.ReadWrite'] },
		tool_onedrive: { readonly: ['Files.Read'], write: ['Files.ReadWrite', 'User.ReadBasic.All'] },
		tool_outlook_mail: {
			readonly: ['Mail.Read'],
			send: ['Mail.Read', 'Mail.Send'],
			modify: ['Mail.ReadWrite', 'Mail.Send'],
		},
		tool_outlook_calendar: { readonly: ['Calendars.Read'], write: ['Calendars.ReadWrite'] },
	},
	slack: {},
};

/** Button labels per provider. */
const LOGIN_LABEL: Record<OAuthProvider, string> = {
	google: 'Login with Google',
	microsoft: 'Login with Microsoft',
	slack: 'Login with Slack',
};

// =============================================================================
// Styles
// =============================================================================

const styles = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	status: {
		...commonStyles.textMuted,
		flex: 1,
	} as CSSProperties,

	// Inline provider marks (no external assets).
	mark: {
		display: 'inline-block',
		width: 14,
		height: 14,
		marginRight: 6,
		verticalAlign: '-2px',
	} as CSSProperties,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Infers the broker from the leaf's title ("Login with Google").
 *
 * @param title - The property title.
 * @returns The provider, or undefined when none is recognised.
 */
export function oauthProviderOf(title: string | undefined): OAuthProvider | undefined {
	const lowered = (title ?? '').toLowerCase();
	if (lowered.includes('google')) return 'google';
	if (lowered.includes('microsoft')) return 'microsoft';
	if (lowered.includes('slack')) return 'slack';
	return undefined;
}

/** Inline brand mark for the button. */
function ProviderMark({ provider }: { provider: OAuthProvider }): ReactElement | null {
	if (provider === 'microsoft') {
		return (
			<svg style={styles.mark} viewBox="0 0 21 21" aria-hidden="true">
				<rect x="1" y="1" width="9" height="9" fill="#F25022" />
				<rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
				<rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
				<rect x="11" y="11" width="9" height="9" fill="#FFB900" />
			</svg>
		);
	}
	if (provider === 'google') {
		return (
			<svg style={styles.mark} viewBox="0 0 24 24" aria-hidden="true">
				<path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
				<path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z" />
				<path fill="#FBBC05" d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l4-3.1z" />
				<path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
			</svg>
		);
	}
	return null;
}

// =============================================================================
// Props
// =============================================================================

/** Props for {@link OAuthWidget}. */
export interface IOAuthWidgetProps {
	/** The broker to start. */
	provider: OAuthProvider;
	/** Whether a grant is stored (plain or encrypted). */
	authenticated: boolean;
	/** The node's current config (sent, credentials stripped, so the broker can restore state). */
	config: IConfigTree;
	/** The node's logical type (scope lookup). */
	nodeProvider?: string;
	/** The canvas node id (the broker echoes it in `state`). */
	nodeId?: string;
	/** The node's display name (sent along). */
	nodeName?: string;
	/** Removes the stored grant. */
	onDisconnect: () => void;
	/** Disabled state. */
	disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the consent button.
 *
 * @param props - {@link IOAuthWidgetProps}.
 * @returns The control.
 */
export default function OAuthWidget({ provider, authenticated, config, nodeProvider, nodeId, nodeName, onDisconnect, disabled }: IOAuthWidgetProps): ReactElement {
	const { oauth2RootUrl, oauthReturnUrl, onOpenExternal, onOpenLink } = useOAuthEnv();

	const signIn = useCallback(() => {
		if (!oauth2RootUrl) return;

		// The node's config, credentials stripped at any depth
		const serviceParam = JSON.stringify(config, (key, value) => (CREDENTIAL_KEYS.has(key) ? undefined : value));

		const url = new URL(`${oauth2RootUrl}/${provider}`);
		url.searchParams.set('service', serviceParam);
		url.searchParams.set('node_id', nodeId ?? '');
		if (nodeName) url.searchParams.set('name', nodeName);

		// A login button is personal OAuth by definition; service accounts use
		// an uploaded key, never this flow. The broker echoes the type back in
		// `state`, which switches the node's auth selector to 'user' on return.
		url.searchParams.set('type', 'user');

		// Where the broker returns the grant. Web hosts come back to the page;
		// hosts that cannot receive a web redirect (VS Code) supply a deep link
		// they intercept out-of-band. The host's return URL names the google
		// bounce path; another provider's result routes through its own.
		const returnUrl = (oauthReturnUrl || window.location.href).replace('/auth/vscode/google', `/auth/vscode/${provider}`);
		url.searchParams.set('baseURL', returnUrl);

		// The selected access tier's scopes, when this node declares them
		const accessTier = typeof config.access === 'string' ? config.access : undefined;
		const tierScopes = nodeProvider && accessTier ? SERVICE_TIER_SCOPES[provider][nodeProvider]?.[accessTier] : undefined;
		if (tierScopes?.length) url.searchParams.set('scope', tierScopes.join(' '));

		const target = url.toString();
		// Consent screens refuse to render in an embedded frame: VS Code opens
		// the system browser (onOpenExternal); Slack's flow is a plain link;
		// web hosts do a full-page redirect.
		if (provider === 'slack' && onOpenLink) onOpenLink(target);
		else if (onOpenExternal) onOpenExternal(target);
		else window.location.href = target;
	}, [oauth2RootUrl, oauthReturnUrl, onOpenExternal, onOpenLink, config, provider, nodeId, nodeName, nodeProvider]);

	if (authenticated) {
		return (
			<div style={styles.row}>
				<span style={styles.status}>
					<ProviderMark provider={provider} />
					Authenticated
				</span>
				{!disabled && (
					<Button variant="ghost" small onClick={onDisconnect}>
						Disconnect
					</Button>
				)}
			</div>
		);
	}

	return (
		<Button variant="secondary" onClick={signIn} disabled={disabled || !oauth2RootUrl} title={oauth2RootUrl ? undefined : 'Sign-in is not available in this host'}>
			<ProviderMark provider={provider} />
			{LOGIN_LABEL[provider]}
		</Button>
	);
}
