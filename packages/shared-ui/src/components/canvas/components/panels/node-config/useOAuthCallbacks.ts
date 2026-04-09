// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * useOAuthCallbacks — Applies OAuth callback tokens from URL parameters
 * into form data, without depending on any React context.
 *
 * Uses `oauth2RootUrl` from FlowProjectContext to construct refresh URLs.
 * All callback helpers are pure data transforms — they read URL params,
 * merge tokens into the provided form data, and return the enriched result.
 */

import { useCallback } from 'react';
import { getNativeQueryParam } from '../../../util/query-helper';
import { useFlowProject } from '../../../context/FlowProjectContext';

// =============================================================================
// Hook
// =============================================================================

export function useOAuthCallbacks() {
	const { oauth2RootUrl } = useFlowProject();

	/**
	 * Applies Google OAuth callback tokens from URL into form data.
	 * Reads `tokens` and `state` query params, parses them, and merges
	 * access/refresh tokens + expiry into the form data's parameters.
	 */
	const applyGoogleOAuth = useCallback(
		(formData: Record<string, unknown>): Record<string, unknown> => {
			const tokensParam = getNativeQueryParam('tokens');
			if (!tokensParam) return formData;

			let parsedState: Record<string, unknown> = {};
			let service: Record<string, unknown> = {};
			let tokens: Record<string, unknown> = {};
			let authType = '';

			try {
				const state = getNativeQueryParam('state');
				if (state) {
					parsedState = JSON.parse(state);
					service = JSON.parse((parsedState?.service as string) ?? '{}');
					authType = (parsedState?.type as string) || '';
				}
				tokens = JSON.parse(tokensParam);
			} catch (error) {
				console.error('Error parsing Google OAuth callback data:', error);
			}

			const existingParams = (formData.parameters as Record<string, unknown>) || {};
			const serviceParams = (service.parameters as Record<string, unknown>) || {};

			const oAuthServerUrl = tokens.oauth_server_url || `${oauth2RootUrl || ''}/refresh`;

			const fullTokenObject = {
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				scope: tokens.scope,
				token_type: tokens.token_type || 'Bearer',
				expiry_date: tokens.expiry_date,
				oauth_server_url: oAuthServerUrl,
			};
			const userTokenJson = JSON.stringify(fullTokenObject);

			return {
				...formData,
				parameters: {
					...existingParams,
					...serviceParams,
					userToken: userTokenJson,
					...(authType && { authType }),
					google: {
						...((existingParams.google as Record<string, unknown>) || {}),
						...((serviceParams.google as Record<string, unknown>) || {}),
						userToken: userTokenJson,
						accessToken: tokens.access_token,
						tokenExpiry: tokens.expiry_date,
					},
				},
			};
		},
		[oauth2RootUrl]
	);

	/**
	 * Applies Microsoft OAuth callback tokens from URL into form data.
	 * Reads `name`, `type`, `client_id`, `client_secret`, `refresh_token`.
	 */
	const applyMicrosoftOAuth = useCallback((formData: Record<string, unknown>): Record<string, unknown> => {
		const error = getNativeQueryParam('oauth_error');
		if (error) console.error('Microsoft OAuth error:', error);

		const name = getNativeQueryParam('name');
		const authType = getNativeQueryParam('type');
		const clientId = getNativeQueryParam('client_id');
		const clientSecret = getNativeQueryParam('client_secret');
		const refreshToken = getNativeQueryParam('refresh_token');

		let result = { ...formData };
		if (name) result = { ...result, name };
		if (authType) {
			result = { ...result, parameters: { ...((result.parameters as Record<string, unknown>) ?? {}), authType } };
		}
		if (clientId && clientSecret && refreshToken) {
			result = { ...result, parameters: { ...((result.parameters as Record<string, unknown>) ?? {}), clientId, clientSecret, refreshToken } };
		}
		return result;
	}, []);

	/**
	 * Applies Slack OAuth callback token from URL into form data.
	 * Reads `access_token` query param.
	 */
	const applySlackOAuth = useCallback((formData: Record<string, unknown>): Record<string, unknown> => {
		const error = getNativeQueryParam('oauth_error');
		if (error) console.error('Slack OAuth error:', error);

		const userToken = getNativeQueryParam('access_token');
		if (!userToken) return formData;

		return {
			...formData,
			parameters: { ...((formData.parameters as Record<string, unknown>) ?? {}), userToken },
		};
	}, []);

	/**
	 * Applies all OAuth provider callbacks sequentially.
	 * Each provider checks for its own URL params and merges if found.
	 */
	const applyOAuthCallbacks = useCallback(
		(formData: Record<string, unknown>): Record<string, unknown> => {
			let result = formData;
			result = applyGoogleOAuth(result);
			result = applyMicrosoftOAuth(result);
			result = applySlackOAuth(result);
			return result;
		},
		[applyGoogleOAuth, applyMicrosoftOAuth, applySlackOAuth]
	);

	/**
	 * Strips all query parameters from the URL to remove sensitive tokens.
	 * Uses replaceState so the token-bearing URL doesn't remain in history.
	 */
	const clearSecureParamsFromUrl = useCallback(() => {
		// Skip in srcdoc iframes — replaceState is not allowed when origin is "null"
		if (window.location.origin === 'null' || window.location.protocol === 'about:') return;
		const cleanUrl = window.location.origin + window.location.pathname;
		window.history.replaceState({}, document.title, cleanUrl);
	}, []);

	return { applyOAuthCallbacks, clearSecureParamsFromUrl };
}
