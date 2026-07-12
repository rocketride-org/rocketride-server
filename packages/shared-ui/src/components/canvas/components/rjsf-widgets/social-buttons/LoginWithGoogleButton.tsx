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
export default function LoginWithGoogleButton<T = unknown, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = never>({ ...props }: IconButtonProps<T, S, F>) {
	const { t } = useTranslation();

	const { oauth2RootUrl, oauthReturnUrl, onOpenExternal } = useFlowProject();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const formContext = (props as unknown as { formContext?: Record<string, any> }).formContext;
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if ((props as any).formContext?.formData?.name) {
			url.searchParams.set(
				'name',
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(props as any).formContext.formData.name
			);
		}

		// Default to 'user' auth type for personal Google OAuth (as opposed to service account)
		const authType = formValues.parameters?.authType || 'user';
		url.searchParams.set('type', authType);

		// Tell the broker where to return tokens. Web hosts redirect back to the
		// current page; hosts that can't receive a web redirect (VS Code) supply
		// a deep link via oauthReturnUrl that they intercept out-of-band.
		url.searchParams.set('baseURL', oauthReturnUrl || window.location.href);

		// For Gmail tiers beyond the broker's default (modify), pass the required
		// scopes explicitly so the broker requests the right Google consent. Keys
		// mirror google_access.py GMAIL.scopes. readonly/modify are omitted because
		// the broker handles them by default; non-Gmail services whose access field
		// uses different values (e.g. 'write') won't match any key here.
		const _G = 'https://www.googleapis.com/auth';
		const GMAIL_EXTENDED_SCOPES: Record<string, string[]> = {
			send: [`${_G}/gmail.modify`, `${_G}/gmail.send`],
			settings: [`${_G}/gmail.modify`, `${_G}/gmail.settings.basic`],
			settings_sharing: [`${_G}/gmail.modify`, `${_G}/gmail.settings.basic`, `${_G}/gmail.settings.sharing`],
			full: ['https://mail.google.com/'],
		};
		const accessTier = formValues.parameters?.access as string | undefined;
		const tierScopes = accessTier ? GMAIL_EXTENDED_SCOPES[accessTier] : undefined;
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

	// Check if user is already authenticated by looking for a userToken in either nested or flat location
	const authenticated = formValues?.parameters?.google?.userToken?.length || formValues?.parameters?.userToken?.length;

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
		// Look for the user token in both possible locations (nested under google or flat)
		const savedUserToken = formValues.parameters?.google?.userToken || formValues.parameters?.userToken;
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
