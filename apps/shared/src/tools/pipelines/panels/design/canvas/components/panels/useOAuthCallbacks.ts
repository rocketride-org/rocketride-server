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
 * OAuth callback helpers for the node config panel.
 *
 * The brokers return to the host with the grant in the page URL (web) or
 * through the host's deep link (VS Code → `pendingOAuthTokens`). These helpers
 * turn either into ONE grant string and write it to the node's `oauth2` leaf
 * by PATH (plan §5.6.2): the leaf's own path takes the grant, and every
 * selector on the leaf's branch chain is switched to the branch that holds
 * it (Google / Microsoft: `authType` → `user`). Nothing lands at the config
 * root any more — the nodes read the grant as the leaf's short name
 * (`cfg.get('userAuth')`) off the resolver's flattened view.
 */

import { useCallback } from 'react';

import { flattenLeaves, setAtPath } from 'shared/components/node-config';
import type { IConfigTree, INodeSchema } from 'shared/components/node-config';

import { useFlowProject } from '../../context/FlowProjectContext';
import { getNativeQueryParam } from '../../util/query-helper';

// =============================================================================
// Types
// =============================================================================

/** A grant as the panel applies it. */
export interface IOAuthGrant {
	/** The JSON (or opaque token) stored on the `oauth2` leaf. */
	token: string;
	/** The broker that issued it, from the callback's `state`/`type` when known. */
	provider: 'google' | 'microsoft' | 'slack';
}

// =============================================================================
// Pure helpers
// =============================================================================

/**
 * Writes a grant to the node's `oauth2` leaf by path. Prefers a leaf whose
 * title names the provider; falls back to the node's only oauth2 leaf.
 *
 * @param schema - The node's resolved schema.
 * @param config - The node's current config.
 * @param grant - The grant.
 * @returns The new config, or the input unchanged when the node has no oauth2 leaf.
 */
export function applyGrantToConfig(schema: INodeSchema | undefined, config: IConfigTree, grant: IOAuthGrant): IConfigTree {
	const leaves = flattenLeaves(schema?.properties).filter(({ property }) => property.type === 'oauth2');
	if (leaves.length === 0) return config;
	const leaf = leaves.find(({ property }) => String(property.title ?? '').toLowerCase().includes(grant.provider)) ?? leaves[0];

	let next = setAtPath(config, leaf.path, grant.token);
	// The grant lives under a branch ("user"): select it, one key per selector
	for (const [selectorPath, branch] of leaf.under) next = setAtPath(next, selectorPath, branch);
	return next;
}

/**
 * Builds the Google grant from the broker's raw `tokens` / `state` strings —
 * shared by the URL path (web) and the host-message path (VS Code).
 *
 * @param tokensParam - JSON string of `{access_token, refresh_token, ...}`.
 * @param stateParam - JSON string of `{type, node_id, ...}` (may be empty).
 * @param oauth2RootUrl - The broker root, for the default refresh endpoint.
 * @returns The grant, or null when the tokens are missing or malformed.
 */
export function buildGoogleGrant(tokensParam: string | null, stateParam: string | null, oauth2RootUrl: string): IOAuthGrant | null {
	if (!tokensParam) return null;
	let tokens: Record<string, unknown>;
	try {
		tokens = JSON.parse(tokensParam) as Record<string, unknown>;
		if (stateParam) JSON.parse(stateParam);
	} catch (error) {
		// A malformed callback must not overwrite saved config
		console.error('Error parsing Google OAuth callback data:', error);
		return null;
	}
	const token = JSON.stringify({
		access_token: tokens.access_token,
		refresh_token: tokens.refresh_token,
		scope: tokens.scope,
		token_type: tokens.token_type || 'Bearer',
		expiry_date: tokens.expiry_date,
		oauth_server_url: tokens.oauth_server_url || `${oauth2RootUrl || ''}/refresh`,
	});
	return { token, provider: 'google' };
}

/** The node the broker's `state` names, when it does. */
export function nodeIdFromState(stateParam: string | null | undefined): string | undefined {
	try {
		return (JSON.parse(stateParam || '{}') as { node_id?: string }).node_id;
	} catch {
		return undefined;
	}
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Reads the brokers' callbacks off the page URL.
 *
 * @returns `readGrantFromUrl` and `clearSecureParamsFromUrl`.
 */
export function useOAuthCallbacks() {
	const { oauth2RootUrl } = useFlowProject();

	/**
	 * The grant carried by the current page URL, if any. Google returns
	 * `tokens`+`state`; Microsoft `client_id`/`client_secret`/`refresh_token`;
	 * Slack `access_token`. A provider's `oauth_error` is logged.
	 */
	const readGrantFromUrl = useCallback((): IOAuthGrant | null => {
		const error = getNativeQueryParam('oauth_error');
		if (error) console.error('OAuth error:', error);

		const google = buildGoogleGrant(getNativeQueryParam('tokens'), getNativeQueryParam('state'), oauth2RootUrl);
		if (google) return google;

		const clientId = getNativeQueryParam('client_id');
		const clientSecret = getNativeQueryParam('client_secret');
		const refreshToken = getNativeQueryParam('refresh_token');
		if (clientId && clientSecret && refreshToken) {
			return { token: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }), provider: 'microsoft' };
		}

		const slackToken = getNativeQueryParam('access_token');
		if (slackToken) return { token: slackToken, provider: 'slack' };

		return null;
	}, [oauth2RootUrl]);

	/**
	 * Strips every query parameter from the URL so the token-bearing URL does
	 * not stay in history (replaceState, skipped in srcdoc frames).
	 */
	const clearSecureParamsFromUrl = useCallback(() => {
		if (window.location.origin === 'null' || window.location.protocol === 'about:') return;
		window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
	}, []);

	return { readGrantFromUrl, clearSecureParamsFromUrl };
}
