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
import { useFlow } from '../../../modules/project-canvas/FlowContext';
import '../google-api-types';

/**
 * RJSF widget button that initiates Google OAuth2 authentication for the
 * current canvas node. Saves pending changes, then redirects (or opens via
 * host callback) to the server's Google OAuth endpoint with the node's service
 * configuration. Displays an "Authenticated" label when a user token is already
 * present, and shows an error color when required auth tokens are missing.
 */
export default function LoginWithGoogleButton<
	T = unknown,
	S extends StrictRJSFSchema = RJSFSchema,
	F extends FormContextType = never,
>({ ...props }: IconButtonProps<T, S, F>) {
	const { t } = useTranslation();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { saveChanges, selectedNode, oauth2RootUrl, onOpenLink } = useFlow() as any;

	// Serialize the current form data for the OAuth redirect so the server can restore state on callback
	const serviceParam = JSON.stringify(selectedNode?.data?.formData || {});
	const nodeId = selectedNode?.id || '';

	const handleHybridSignIn = useCallback(async () => {
		// Persist any unsaved form changes before navigating away to the OAuth flow
		await saveChanges();

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
		const authType = selectedNode?.data?.formData?.parameters?.authType || 'user';
		url.searchParams.set('type', authType);

		// Pass the current URL so the OAuth callback can redirect back here after completion
		url.searchParams.set('baseURL', window.location.href);

		const targetUrl = url.toString();
		// Use onOpenLink callback for embedded hosts (e.g., VSCode), otherwise do a full-page redirect
		if (onOpenLink) onOpenLink(targetUrl);
		else window.location.href = targetUrl;

	// eslint-disable-next-line react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any
	}, [(props as any).formContext, serviceParam, nodeId, selectedNode, oauth2RootUrl, onOpenLink]);

	// Show the button in error color if any OAuth-related token is missing from validation errors
	const color = useMemo(() => {
		for (const error of selectedNode?.data?.formDataErrors ?? [])
			if (['accessToken', 'refreshToken', 'userToken'].includes(error.params.missingProperty))
				return 'error';
		return 'primary';
	}, [selectedNode?.data?.formDataErrors]);

	// Check if user is already authenticated by looking for a userToken in either nested or flat location
	const authenticated =
		selectedNode?.data?.formData?.parameters?.google?.userToken?.length ||
		selectedNode?.data?.formData?.parameters?.userToken?.length;

	const text = authenticated
		? // eslint-disable-next-line @typescript-eslint/no-explicit-any
			t('addSource.formStep.authenticated' as any)
		: // eslint-disable-next-line @typescript-eslint/no-explicit-any
			t('addSource.formStep.loginWithGoogleButton' as any);

	// Whenever the selected node's formData changes, publish the latest user token to a global
	// marker so GoogleDrivePickerWidget can detect when a fresh token is available after OAuth.
	// This effect does NOT open the picker - it only signals token availability.
	useEffect(() => {
		if (!selectedNode) {
			return;
		}

		const formData = selectedNode?.data?.formData || {};
		// Look for the user token in both possible locations (nested under google or flat)
		const savedUserToken =
			formData.parameters?.google?.userToken || formData.parameters?.userToken;

		if (!savedUserToken) {
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(window as any).__googlePickerLastToken = savedUserToken;
	}, [selectedNode]);

	return (
		<Box sx={{ mt: 1, pl: 6.2, pr: 5.4 }}>
			<Button
				startIcon={<GoogleIcon />}
				onClick={handleHybridSignIn}
				{...props}
				sx={{ width: 1 }}
				color={color}
				variant="outlined"
				disabled={authenticated}
			>
				{text}
			</Button>
		</Box>
	);
}
