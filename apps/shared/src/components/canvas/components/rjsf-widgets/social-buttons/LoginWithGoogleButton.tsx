// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import GoogleIcon from '@mui/icons-material/Google';

import { FormContextType, IconButtonProps, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo } from 'react';
import { useFlowProject } from '../../../context/FlowProjectContext';
import '../google-api-types';

// =============================================================================
// Component
// =============================================================================

/**
 * RJSF widget button that initiates Google OAuth2 authentication for the
 * current canvas node. Saves pending changes, then redirects (or opens via
 * host callback) to the server's Google OAuth endpoint with the node's service
 * configuration. Displays an "Authenticated" label when a user token is already
 * present, and shows an error color when required auth tokens are missing.
 */
export default function LoginWithGoogleButton<T = unknown, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = never>({
	...props
}: // The canvas passes its RJSF formContext (formValues, nodeId, provider, ...)
// down to widget buttons; @rjsf's IconButtonProps does not model it, so the
// props type is widened with the extra optional member instead of casting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
IconButtonProps<T, S, F> & { formContext?: Record<string, any> }) {
	const { t } = useTranslation();

	const { oauth2RootUrl, oauthReturnUrl, onOpenExternal } = useFlowProject();

	const formContext = props.formContext;
	const formValues = formContext?.formValues ?? {};
	const nodeId = formContext?.nodeId;
	// Serialize the current form data for the OAuth redirect so the server can
	// restore state on callback. Credential fields are stripped at any depth:
	// the URL lands in browser history and broker logs, so existing tokens must
	// never ride along.
	const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'userToken', 'idToken', 'tokenExpiry'];
	const serviceParam = JSON.stringify(formValues, (key, value) => (CREDENTIAL_KEYS.includes(key) ? undefined : value));

	const handleHybridSignIn = useCallback(async () => {
		if (!oauth2RootUrl) return;

		// Build the OAuth redirect URL with all context needed to resume after authentication
		const url = new URL(`${oauth2RootUrl}/google`);
		url.searchParams.set('service', serviceParam ?? '');
		url.searchParams.set('node_id', nodeId ?? '');

		// Include the service name if available, so the OAuth callback knows which service this is for
		if (formContext?.formData?.name) {
			url.searchParams.set('name', formContext.formData.name);
		}

		// "Login with Google" is personal OAuth by definition; service accounts
		// use an uploaded key, never this flow. The broker echoes the type back
		// in `state`, which switches the node's authType to 'user' on success.
		url.searchParams.set('type', 'user');

		// Tell the broker where to return tokens. Web hosts redirect back to the
		// current page; hosts that can't receive a web redirect (VS Code) supply
		// a deep link via oauthReturnUrl that they intercept out-of-band.
		url.searchParams.set('baseURL', oauthReturnUrl || window.location.href);

		// Pass the selected tier's scopes explicitly, keyed by the node's
		// provider — the broker grants identity plus exactly the requested
		// scopes (least privilege), or its legacy default consent when no
		// scope param is sent. Maps mirror the per-service AccessSpecs in
		// core/google_access.py. An unknown provider or tier sends no scope
		// param rather than guessing another service's scopes.
		const _G = 'https://www.googleapis.com/auth';
		const SERVICE_TIER_SCOPES: Record<string, Record<string, string[]>> = {
			tool_gmail: {
				readonly: [`${_G}/gmail.readonly`],
				modify: [`${_G}/gmail.modify`],
				send: [`${_G}/gmail.modify`, `${_G}/gmail.send`],
				settings: [`${_G}/gmail.modify`, `${_G}/gmail.settings.basic`],
				settings_sharing: [`${_G}/gmail.modify`, `${_G}/gmail.settings.basic`, `${_G}/gmail.settings.sharing`],
				full: ['https://mail.google.com/'],
			},
		};
		const provider = formContext?.provider as string | undefined;
		const accessTier = (formValues.access ?? formValues.parameters?.access) as string | undefined;
		const tierScopes = provider && accessTier ? SERVICE_TIER_SCOPES[provider]?.[accessTier] : undefined;
		if (tierScopes?.length) {
			url.searchParams.set('scope', tierScopes.join(' '));
		}

		const targetUrl = url.toString();
		// VS Code (onOpenExternal) opens the system browser — Google's consent
		// screen refuses to render in an embedded iframe — and delivers tokens
		// back via pendingOAuthTokens. Web hosts do a full-page redirect.
		if (onOpenExternal) onOpenExternal(targetUrl);
		else window.location.href = targetUrl;

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [formContext, formValues, serviceParam, nodeId, oauth2RootUrl, oauthReturnUrl, onOpenExternal]);

	// Show the button in error color if any OAuth-related token is missing from validation errors
	const color = useMemo(() => {
		for (const error of formContext?.formDataErrors ?? []) if (['accessToken', 'refreshToken', 'userToken'].includes(error.params?.missingProperty)) return 'error';
		return 'primary';
	}, [formContext?.formDataErrors]);

	// Check if user is already authenticated. Flat node schemas (tool_gmail)
	// keep userToken at the config root; the parameters.* locations are legacy.
	const authenticated = formValues?.userToken?.length || formValues?.parameters?.google?.userToken?.length || formValues?.parameters?.userToken?.length;

	// i18n is not initialized in every host (e.g. the VS Code webview). When a key
	// doesn't resolve, t() returns the key itself — fall back to a literal so the
	// button never shows a raw key.
	const label = (key: string, fallback: string): string => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const value = t(key as any) as string;
		return value && value !== key ? value : fallback;
	};
	const text = authenticated ? label('addSource.formStep.authenticated', 'Authenticated') : label('addSource.formStep.loginWithGoogleButton', 'Login with Google');

	// Whenever the selected node's formData changes, publish the latest user token to a global
	// marker so GoogleDrivePickerWidget can detect when a fresh token is available after OAuth.
	// This effect does NOT open the picker - it only signals token availability.
	useEffect(() => {
		// Look for the user token in all possible locations (config root first, then legacy nested)
		const savedUserToken = formValues.userToken || formValues.parameters?.google?.userToken || formValues.parameters?.userToken;
		const pickerWindow = window as typeof window & { __googlePickerLastToken?: string };

		if (!savedUserToken) {
			// Switching to an unauthenticated node must not leave the previous
			// node's token readable by the picker.
			delete pickerWindow.__googlePickerLastToken;
			return;
		}

		pickerWindow.__googlePickerLastToken = savedUserToken;
		return () => {
			if (pickerWindow.__googlePickerLastToken === savedUserToken) {
				delete pickerWindow.__googlePickerLastToken;
			}
		};
	}, [formValues]);

	return (
		<Box sx={{ mt: 1, pl: 6.2, pr: 5.4 }}>
			<Button startIcon={<GoogleIcon />} onClick={handleHybridSignIn} {...props} sx={{ width: 1, textTransform: 'none' }} color={color} variant="outlined" disabled={authenticated}>
				{text}
			</Button>
		</Box>
	);
}
