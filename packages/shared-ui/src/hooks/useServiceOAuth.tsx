// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { getNativeQueryParam } from '../utils/query-helper';
import { useFlow } from '../modules/project-canvas/FlowContext';

/**
 * Hook that provides helper functions for processing OAuth callback data from
 * Google, Microsoft, and Slack. After a user completes an OAuth flow, the callback
 * URL contains tokens and state in query parameters. This hook extracts those
 * parameters, merges them into the service form data, and provides a utility to
 * strip sensitive tokens from the URL for security.
 *
 * @returns An object with `applyGoogleOAuthCallbackData`, `applyMicrosoftOAuthCallbackData`,
 *          `applySlackOAuthCallbackData`, and `clearSecureParamsFromUrl`.
 */
export function useServiceOAuth() {
	// Retrieve the base OAuth2 URL from the canvas flow context, used to construct refresh endpoints
	const { oauth2RootUrl } = useFlow();
	/**
	 * Extracts Google OAuth tokens and state from URL query parameters and merges
	 * them into the provided form data. Preserves existing form parameters while
	 * adding the userToken JSON string and Google-specific fields.
	 *
	 * @param formData - The current form data to enrich with OAuth tokens.
	 * @returns Updated form data with Google OAuth credentials merged in.
	 */
	const applyGoogleOAuthCallbackData = (
		formData: Record<string, unknown>
	): Record<string, unknown> => {
		// Read the raw token and state payloads injected into the URL by the OAuth callback redirect
		const tokensParam = getNativeQueryParam('tokens');
		const state = getNativeQueryParam('state');

		// No tokens means this page load is not an OAuth callback -- return data unchanged
		if (!tokensParam) {
			return formData;
		}

		let parsedState: Record<string, unknown> = {};
		let service: Record<string, unknown> = {};
		let tokens: Record<string, unknown> = {};
		let authType = '';

		try {
			if (state) {
				// The state param is a double-encoded JSON string: outer JSON contains
				// a "service" field which is itself a JSON string of service config.
				parsedState = JSON.parse(state);
				service = JSON.parse((parsedState?.service as string) ?? '{}');
				authType = (parsedState?.type as string) || '';
			}
			// Parse the tokens JSON to extract access_token, refresh_token, and expiry_date
			tokens = JSON.parse(tokensParam);
		} catch (error) {
			console.error('Error parsing OAuth callback data:', error);
		}

		// Preserve existing formData parameters and merge with service parameters
		// so that fields already set by the user (e.g., custom config) are not overwritten.
		const existingParameters = (formData.parameters as Record<string, unknown>) || {};
		const serviceParameters = (service.parameters as Record<string, unknown>) || {};

		const accessToken = tokens.access_token;
		const tokenExpiry = tokens.expiry_date;

		// Determine the OAuth refresh URL: prefer the one returned by the OAuth lambda,
		// fall back to the canvas-configured oauth2RootUrl + "/refresh".
		const oAuthServerUrl =
			tokens.oauth_server_url ||
			`${oauth2RootUrl || ''}/refresh`;

		// Assemble the complete token payload that the backend expects for token refresh
		const fullTokenObject = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			scope: tokens.scope,
			token_type: tokens.token_type || 'Bearer',
			expiry_date: tokens.expiry_date,
			oauth_server_url: oAuthServerUrl,
		};

		// Serialize as a JSON string because the backend/services expect userToken as a string field
		const userTokenJson = JSON.stringify(fullTokenObject);

		// Merge everything into the form data, layering: existing -> service -> OAuth tokens.
		// The google sub-object duplicates accessToken/tokenExpiry for the GoogleDrivePickerWidget.
		const _formData = {
			...formData,
			parameters: {
				...existingParameters,
				...serviceParameters,
				userToken: userTokenJson,
				// Conditionally spread authType only when present to avoid setting it to empty string
				...(authType && { authType }),
				google: {
					...((existingParameters.google as Record<string, unknown>) || {}),
					...((serviceParameters.google as Record<string, unknown>) || {}),
					userToken: userTokenJson,
					accessToken: accessToken,
					tokenExpiry: tokenExpiry,
				},
			},
		};

		return _formData;
	};

	/**
	 * Extracts Microsoft OAuth callback data (name, auth type, client credentials,
	 * refresh token) from URL query parameters and merges them into the form data.
	 *
	 * @param formData - The current form data to enrich with Microsoft OAuth credentials.
	 * @returns Updated form data with Microsoft OAuth fields merged in.
	 */
	const applyMicrosoftOAuthCallbackData = (
		formData: Record<string, unknown>
	): Record<string, unknown> => {
		// Check for an error returned by the OAuth provider before processing tokens
		const error = getNativeQueryParam('oauth_error');
		if (error) {
			console.error('Error parsing Microsoft OAuth callback data:', error);
		}

		// Extract individual credential fields from the callback URL query string
		const name = getNativeQueryParam('name');
		const authType = getNativeQueryParam('type');
		const clientId = getNativeQueryParam('client_id');
		const clientSecret = getNativeQueryParam('client_secret');
		const refreshToken = getNativeQueryParam('refresh_token');

		let _formData = { ...formData };

		// Merge the display name into the top-level form data if provided
		if (name) {
			_formData = {
				..._formData,
				name,
			};
		}

		// Merge authType into the parameters sub-object (e.g., 'personal' or 'delegated')
		if (authType) {
			_formData = {
				..._formData,
				parameters: { ...((_formData.parameters as Record<string, unknown>) ?? {}), authType },
			};
		}

		// Only merge client credentials when all three are present to avoid partial/broken config
		if (clientId && clientSecret && refreshToken) {
			_formData = {
				..._formData,
				parameters: {
					...((_formData.parameters as Record<string, unknown>) ?? {}),
					clientId,
					clientSecret,
					refreshToken,
				},
			};
		}

		return _formData;
	};

	/**
	 * Extracts Slack OAuth access token from URL query parameters and merges it
	 * into the form data as `userToken`.
	 *
	 * @param formData - The current form data to enrich with the Slack access token.
	 * @returns Updated form data with the Slack userToken merged in.
	 */
	const applySlackOAuthCallbackData = (
		formData: Record<string, unknown>
	): Record<string, unknown> => {
		// Check for an error from the Slack OAuth redirect before processing
		const error = getNativeQueryParam('oauth_error');
		if (error) {
			console.error('Error parsing Slack OAuth callback data:', error);
		}

		// Slack only provides a single access_token (no refresh token or client credentials)
		const userToken = getNativeQueryParam('access_token');

		let _formData = { ...formData };

		// Merge the access token into the parameters if present
		if (userToken) {
			_formData = {
				..._formData,
				parameters: {
					...((_formData.parameters as Record<string, unknown>) ?? {}),
					userToken,
				},
			};
		}

		return _formData;
	};

	/**
	 * Removes all query parameters from the current URL without reloading the page.
	 * Should be called after OAuth callback data has been consumed to prevent
	 * sensitive tokens from remaining visible in the address bar or browser history.
	 */
	const clearSecureParamsFromUrl = () => {
		// Reconstruct the URL without any query parameters to remove sensitive OAuth tokens
		const cleanUrl = window.location.origin + window.location.pathname;
		// replaceState instead of pushState so the token-bearing URL is not left in browser history
		window.history.replaceState({}, document.title, cleanUrl);
	};

	return {
		applyGoogleOAuthCallbackData,
		applyMicrosoftOAuthCallbackData,
		applySlackOAuthCallbackData,
		clearSecureParamsFromUrl,
	};
}
