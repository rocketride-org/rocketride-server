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
import SvgIcon, { SvgIconProps } from '@mui/material/SvgIcon';

import { FormContextType, IconButtonProps, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { useCallback, useMemo } from 'react';
import { useFlowProject } from '../../../context/FlowProjectContext';

// =============================================================================
// Icon
// =============================================================================

/** Inline four-square Microsoft logo (no external asset). */
function MicrosoftIcon(props: SvgIconProps) {
	return (
		<SvgIcon {...props} viewBox="0 0 21 21">
			<rect x="1" y="1" width="9" height="9" fill="#F25022" />
			<rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
			<rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
			<rect x="11" y="11" width="9" height="9" fill="#FFB900" />
		</SvgIcon>
	);
}

// =============================================================================
// Component
// =============================================================================

/**
 * RJSF widget button that initiates Microsoft OAuth2 authentication for the
 * current canvas node. Saves pending changes, then redirects (or opens via
 * host callback) to the server's Microsoft OAuth endpoint with the node's
 * service configuration. Displays an "Authenticated" label when a user token
 * is already present, and shows an error color when required auth tokens are
 * missing.
 */
export default function LoginWithMicrosoftButton<T = unknown, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = never>({
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
	const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'userToken', 'idToken', 'tokenExpiry', 'clientSecret'];
	const serviceParam = JSON.stringify(formValues, (key, value) => (CREDENTIAL_KEYS.includes(key) ? undefined : value));

	const handleHybridSignIn = useCallback(async () => {
		if (!oauth2RootUrl) return;

		// Build the OAuth redirect URL with all context needed to resume after authentication
		const url = new URL(`${oauth2RootUrl}/microsoft`);
		url.searchParams.set('service', serviceParam ?? '');
		url.searchParams.set('node_id', nodeId ?? '');

		// Include the service name if available, so the OAuth callback knows which service this is for
		if (formContext?.formData?.name) {
			url.searchParams.set('name', formContext.formData.name);
		}

		// "Login with Microsoft" is personal OAuth by definition; service accounts
		// use an uploaded key, never this flow. The broker echoes the type back
		// in `state`, which switches the node's authType to 'user' on success.
		url.searchParams.set('type', 'user');

		// Tell the broker where to return tokens. Web hosts redirect back to the
		// current page; hosts that can't receive a web redirect (VS Code) supply
		// a deep link via oauthReturnUrl that they intercept out-of-band.
		// The host's return URL is provider-agnostic and historically names the
		// google bounce path; route this provider's result through the microsoft
		// bounce so the editor deep link carries the right provider label.
		const returnUrl = (oauthReturnUrl || window.location.href).replace('/auth/vscode/google', '/auth/vscode/microsoft');
		url.searchParams.set('baseURL', returnUrl);

		// Pass the selected tier's scopes explicitly, keyed by the node's
		// provider — the broker grants identity plus exactly the requested
		// scopes (least privilege), or its legacy default consent when no
		// scope param is sent. Maps mirror the per-service AccessSpecs in
		// core/microsoft_access.py. An unknown provider or tier sends no scope
		// param rather than guessing another service's scopes.
		// offline_access + identity scopes are appended by the broker, matching the Google flow.
		const SERVICE_TIER_SCOPES: Record<string, Record<string, string[]>> = {
			// Graph's workbook API accepts only delegated Files.ReadWrite, reads
			// included; the excel readonly tier is a node-side write gate.
			excel: { readonly: ['Files.ReadWrite'], write: ['Files.ReadWrite'] },
			word: { readonly: ['Files.Read'], write: ['Files.ReadWrite'] },
			onedrive: { readonly: ['Files.Read'], write: ['Files.ReadWrite', 'User.ReadBasic.All'] },
			outlook_mail: {
				readonly: ['Mail.Read'],
				send: ['Mail.Read', 'Mail.Send'],
				modify: ['Mail.ReadWrite', 'Mail.Send'],
			},
			outlook_calendar: { readonly: ['Calendars.Read'], write: ['Calendars.ReadWrite'] },
		};
		const provider = formContext?.provider as string | undefined;
		const accessTier = (formValues.access ?? formValues.parameters?.access) as string | undefined;
		const tierScopes = provider && accessTier ? SERVICE_TIER_SCOPES[provider]?.[accessTier] : undefined;
		if (tierScopes?.length) {
			url.searchParams.set('scope', tierScopes.join(' '));
		}

		const targetUrl = url.toString();
		// VS Code (onOpenExternal) opens the system browser — Microsoft's consent
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

	// Check if user is already authenticated. Flat node schemas keep userToken
	// at the config root; the parameters.* locations are legacy.
	const authenticated = formValues?.userToken?.length || formValues?.parameters?.microsoft?.userToken?.length || formValues?.parameters?.userToken?.length;

	// i18n is not initialized in every host (e.g. the VS Code webview). When a key
	// doesn't resolve, t() returns the key itself — fall back to a literal so the
	// button never shows a raw key.
	const label = (key: string, fallback: string): string => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const value = t(key as any) as string;
		return value && value !== key ? value : fallback;
	};
	const text = authenticated ? label('addSource.formStep.authenticated', 'Authenticated') : label('addSource.formStep.loginWithMicrosoftButton', 'Login with Microsoft');

	return (
		<Box sx={{ mt: 1, pl: 6.2, pr: 5.4 }}>
			<Button startIcon={<MicrosoftIcon />} onClick={handleHybridSignIn} {...props} sx={{ width: 1, textTransform: 'none' }} color={color} variant="outlined" disabled={authenticated}>
				{text}
			</Button>
		</Box>
	);
}
