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

import { FormContextType, IconButtonProps, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { useCallback, useMemo } from 'react';
import { useFlowProject } from '../../../context/FlowProjectContext';

/**
 * RJSF widget button that initiates Slack OAuth2 authentication for the
 * current canvas node. Notifies the host of pending changes, then redirects
 * (or opens via host callback) to the server's Slack OAuth endpoint. Displays
 * "Authenticated" when a Slack token is present, and shows an error color
 * when required auth tokens are missing.
 */
export default function LoginWithSlackButton<T = unknown, S extends StrictRJSFSchema = RJSFSchema, F extends FormContextType = never>({ ...props }: IconButtonProps<T, S, F>) {
	const { t } = useTranslation();
	const { oauth2RootUrl, onOpenLink } = useFlowProject();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const formContext = (props as unknown as { formContext?: Record<string, any> }).formContext;
	const formValues = formContext?.formValues ?? {};
	const nodeId = formContext?.nodeId;
	// Serialize form data for the OAuth redirect so the server can restore node state on callback
	const serviceParam = JSON.stringify(formValues);

	const handleHybridSignIn = useCallback(async () => {
		if (!oauth2RootUrl) return;

		// Build the Slack OAuth redirect URL with node context for post-auth resumption
		const url = new URL(`${oauth2RootUrl}/slack`);
		url.searchParams.set('service', serviceParam ?? '');
		url.searchParams.set('node_id', nodeId ?? '');

		// Include the service name so the OAuth callback can associate the token with this node
		if (formContext?.formData?.name) {
			url.searchParams.set('name', formContext.formData.name);
		}

		// Pass the current page URL so the OAuth callback redirects back here
		url.searchParams.set('baseURL', window.location.href);

		const targetUrl = url.toString();
		// Use the host callback for embedded environments; otherwise do a full-page redirect
		if (onOpenLink) onOpenLink(targetUrl);
		else window.location.href = targetUrl;
	}, [formContext, serviceParam, nodeId, oauth2RootUrl, onOpenLink]);

	// Show error color when any required OAuth token is missing from validation errors
	const color = useMemo(() => {
		const errors = formContext?.formDataErrors ?? [];
		for (const error of errors) if (['accessToken', 'refreshToken', 'userToken'].includes(error.params?.missingProperty)) return 'error';
		return 'primary';
	}, [formContext?.formDataErrors]);

	// Slack uses a single `token` field for authentication (unlike Microsoft's three-field check)
	const authenticated = formValues?.parameters?.token?.length;

	const text = authenticated ? t('addSource.formStep.authenticated') : t('addSource.formStep.loginWithSlackButton');

	return (
		<Box sx={{ mt: 1, pl: 6.2, pr: 5.4 }}>
			<Button onClick={handleHybridSignIn} {...props} sx={{ width: 1 }} color={color} variant="outlined" disabled={authenticated}>
				{text}
			</Button>
		</Box>
	);
}
