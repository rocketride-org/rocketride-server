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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WidgetProps, RJSFSchema, StrictRJSFSchema, FormContextType } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import DeleteIcon from '@mui/icons-material/Delete';
import { useFlow } from '../../../modules/project-canvas/FlowContext';
import '../google-api-types';

/**
 * Represents a single include/exclude path item in the Google Drive source
 * configuration. The path field holds the Google Drive file/folder ID used
 * by the backend for scanning, while the optional name is for display only.
 */
interface PathItem {
	path: string;
	name?: string; // Optional name for display purposes (not used by backend)
}

/** Base URL for Google Drive REST API v3 requests. */
const GOOGLE_DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';

/**
 * Dynamically loads the Google API script and initializes the Picker module.
 * Resolves immediately if the Picker is already available on the window.
 * This lazy-loading approach avoids including the Google JS bundle in the
 * main application bundle.
 *
 * @returns A promise that resolves when the Google Picker API is ready.
 */
function loadGoogleApi(): Promise<void> {
	return new Promise((resolve, reject) => {
		// Skip loading if the Picker API is already available (e.g., from a previous widget mount)
		if (window.google && window.google.picker) {
			resolve();
			return;
		}

		// Inject the Google API script and then use gapi.load to initialize the Picker module
		const script = document.createElement('script');
		script.src = 'https://apis.google.com/js/api.js';
		script.onload = () => {
			window.gapi!.load('picker', { callback: resolve, onerror: reject });
		};
		script.onerror = reject;
		document.body.appendChild(script);
	});
}

/**
 * RJSF widget that integrates the Google Drive Picker UI for selecting files
 * and folders from the user's Google Drive. Manages OAuth token lifecycle,
 * loads the Google Picker API on demand, resolves file names via the Drive REST API,
 * and stores selections as an array of PathItem objects in the form value.
 * Displays authentication prompts, session expiry warnings, and the current
 * selection with clear/change controls.
 */
export default function GoogleDrivePickerWidget<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ value, onChange, disabled, required, rawErrors, formContext }: WidgetProps<T, S, F>) {
	const { t } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const [apiLoaded, setApiLoaded] = useState(false);
	// Cache of file ID to display name, populated lazily via the Drive REST API
	const [fileNames, setFileNames] = useState<Record<string, string>>({});

	// Google Picker config: host passes via formContext because shared-ui has no access to process.env
	const developerKey = (formContext?.googlePickerDeveloperKey as string) ?? '';
	const clientId = (formContext?.googlePickerClientId as string) ?? '';
	// The appId is the numeric prefix of the OAuth client ID (before the first dash)
	const appId = clientId.split('-')[0] || '';

	const flow = useFlow();
	const { selectedNode } = flow;

	// Store last valid tokens in refs to survive re-renders where the token may temporarily be absent
	const lastValidAccessToken = useRef<string | undefined>(undefined);
	const lastValidUserToken = useRef<string | undefined>(undefined);

	// Resolve the effective form data by choosing between two sources:
	// 1. selectedNode.data.formData (most reliable, directly from the canvas node)
	// 2. formContext.formValues (fallback, may lag behind after recent OAuth updates)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const fullFormData = useMemo((): Record<string, any> => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const selectedNodeFormData = (selectedNode?.data?.formData || {}) as Record<string, any>;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const formContextFormValues = (formContext?.formValues || {}) as Record<string, any>;

		// Prefer the node's formData if it already has Google OAuth tokens; otherwise fall back to formContext
		if (
			selectedNodeFormData.parameters?.google?.userToken ||
			selectedNodeFormData.parameters?.google?.accessToken
		) {
			return selectedNodeFormData;
		}
		return formContextFormValues;
	}, [selectedNode?.data?.formData, formContext?.formValues]);

	// Transform the raw form value into a displayable selection list, filtering out wildcards
	const selection = useMemo(() => {
		// No selection if value is empty or not an array
		if (!Array.isArray(value) || value.length === 0) {
			return null;
		}

		// A single wildcard entry means "scan all" which is the unselected default state
		if (value.length === 1 && value[0]?.path === '*') {
			return null;
		}

		// Map each PathItem to a display object, preferring the stored name then the fetched name
		return value
			.filter((item: PathItem) => item?.path && item.path !== '*')
			.map((item: PathItem) => ({
				id: item.path,
				name: item.name || fileNames[item.path] || null,
			}));
	}, [value, fileNames]);

	// All three Google API credentials must be present before the picker can function
	const envReady = Boolean(developerKey && clientId && appId);

	// Derive the current access token, validating its expiry timestamp.
	// Falls back to the last known valid token stored in a ref to handle transient re-renders.
	const accessToken = useMemo(() => {
		const token = fullFormData.parameters?.google?.accessToken;
		const expiry = fullFormData.parameters?.google?.tokenExpiry;

		if (token && expiry) {
			const now = Date.now();
			// Only use the token if it has not expired yet
			if (now < expiry) {
				lastValidAccessToken.current = token;
				return token;
			}
		}
		// Token is missing or expired; return the last valid one as a fallback
		return lastValidAccessToken.current;
	}, [fullFormData]);

	// Determine if the user has completed the OAuth flow (has a refresh/user token)
	const isAuthenticated = useMemo(() => {
		// userToken may be nested under `google` or directly under `parameters` depending on provider
		const userToken =
			fullFormData.parameters?.google?.userToken || fullFormData.parameters?.userToken;
		if (userToken) {
			lastValidUserToken.current = userToken;
			return true;
		}
		// Fall back to ref to handle re-renders where formData hasn't propagated yet
		return Boolean(lastValidUserToken.current);
	}, [fullFormData]);

	// The picker button is only enabled when all three conditions are met
	const pickerAvailable = Boolean(isAuthenticated && accessToken && apiLoaded);

	// Load Google API on mount
	useEffect(() => {
		if (envReady) {
			loadGoogleApi()
				.then(() => {
					setApiLoaded(true);
				})
				.catch(() => {
					setError(
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						t('addSource.googleDrivePicker.failedToLoadApi' as any)
					);
				});
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [envReady]);

	// Fetch file names from Google Drive API when we have IDs without names
	useEffect(() => {
		if (!accessToken || !selection) return;

		// Find IDs that don't have names
		const idsWithoutNames = selection
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.filter((sel: any) => sel.id && !sel.name)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((sel: any) => sel.id);

		if (idsWithoutNames.length === 0) return;

		// Fetch file metadata using Google Drive API REST endpoint
		const fetchFileNames = async () => {
			try {
				// Fetch file metadata for each ID using REST API
				const namePromises = idsWithoutNames.map(async (fileId: string) => {
					try {
						const response = await fetch(
							`${GOOGLE_DRIVE_API_BASE_URL}/files/${fileId}?fields=id,name`,
							{
								headers: {
									Authorization: `Bearer ${accessToken}`,
								},
							}
						);

						if (!response.ok) {
							return { id: fileId, name: null };
						}

						const data = await response.json();
						return {
							id: fileId,
							name: data.name || null,
						};
					} catch {
						// If we can't fetch the name, just return the ID
						return { id: fileId, name: null };
					}
				});

				const results = await Promise.all(namePromises);
				const newFileNames: Record<string, string> = {};
				results.forEach((result) => {
					if (result.name) {
						newFileNames[result.id] = result.name;
					}
				});

				if (Object.keys(newFileNames).length > 0) {
					setFileNames((prev) => ({ ...prev, ...newFileNames }));
				}
			} catch {
				console.error(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					t('addSource.googleDrivePicker.failedToFetchNames' as any)
				);
			}
		};

		fetchFileNames();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [accessToken, selection]);

	// Reset selection to the wildcard default, meaning "scan entire drive"
	const handleClear = useCallback(() => {
		onChange([{ path: '*' }] as T);
		setError(null);
	}, [onChange]);

	const handleOpenPicker = useCallback(() => {
		// Guard: all prerequisites must be met before opening the picker dialog
		if (!pickerAvailable || disabled || !window.google || !window.google.picker) return;

		const gPicker = window.google.picker;

		try {
			// Configure a docs view: folders are visible for navigation but only files can be selected.
			// Users must navigate into a folder and select individual files.
			const docsView = new gPicker.DocsView(gPicker.ViewId.DOCS)
				.setIncludeFolders(true)
				.setSelectFolderEnabled(false);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const pickerCallback = (data: any) => {
				// The Google Picker API reports the action in different ways depending on environment;
				// check all known formats to reliably detect a completed selection.
				const isPicked =
					data.action === 'picked' ||
					data.action === gPicker.Action.PICKED ||
					data[gPicker.Response.ACTION] === gPicker.Action.PICKED;

				if (isPicked) {
					// Documents may be keyed differently; try both direct and constant-keyed access
					const docs = data.docs || data[gPicker.Response.DOCUMENTS] || [];

					if (!docs || docs.length === 0) {
						return;
					}

					// Normalize each document into a consistent shape regardless of Picker API version
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const selections = docs.map((doc: any) => ({
						id: doc.id || doc[gPicker.Document.ID],
						name: doc.name || doc[gPicker.Document.NAME],
						mimeType: doc.mimeType || doc[gPicker.Document.MIME_TYPE],
						type: doc.type || doc[gPicker.Document.TYPE],
						parentId: doc.parent || doc[gPicker.Document.PARENT_ID],
						url: doc.url || doc[gPicker.Document.URL],
					}));

					// Transform selections into the PathItem format expected by the backend and form schema
					const includeArray: PathItem[] = selections.map(
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(sel: any) => ({
							path: sel.id,
							name: sel.name,
						})
					);
					onChange(includeArray as T);

					setError(null);
				}
			};

			// Build and display the picker dialog with multi-select enabled
			const picker = new gPicker.PickerBuilder()
				.setAppId(appId)
				.setOAuthToken(accessToken!)
				.setDeveloperKey(developerKey)
				.addView(docsView)
				.setCallback(pickerCallback)
				.enableFeature(gPicker.Feature.MULTISELECT_ENABLED)
				.build();

			picker.setVisible(true);
		} catch {
			setError(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				t('addSource.googleDrivePicker.failedToOpenPicker' as any)
			);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pickerAvailable, disabled, accessToken, appId, developerKey, onChange]);

	if (!envReady) {
		return (
			<Alert severity="warning" sx={{ mt: 1 }}>
				{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
				{t('addSource.googleDrivePicker.configureEnv' as any)}
			</Alert>
		);
	}

	// Determine if there is an active selection to display (excluding null/empty states)
	const hasSelection =
		selection !== null && (Array.isArray(selection) ? selection.length > 0 : true);
	// Normalize selection to an array for uniform rendering in the JSX below
	const selectionsArray = Array.isArray(selection) ? selection : selection ? [selection] : [];

	return (
		<Stack spacing={1} sx={{ mt: 1 }}>
			{error && (
				<Alert severity="error" onClose={() => setError(null)}>
					{error}
				</Alert>
			)}

			{!isAuthenticated && (
				<Alert severity="info" sx={{ mt: 1 }}>
					{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
					{t('addSource.googleDrivePicker.authenticateFirst' as any)}
				</Alert>
			)}

			{isAuthenticated && !accessToken && (
				<Alert severity="warning" sx={{ mt: 1 }}>
					{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
					{t('addSource.googleDrivePicker.sessionExpired' as any)}
				</Alert>
			)}

			{hasSelection && selectionsArray.length > 0 && (
				<Stack spacing={1}>
					{selectionsArray.map(
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(sel: any, index: number) => (
							<Stack
								key={sel?.id || index}
								direction="row"
								spacing={1}
								alignItems="center"
							>
								<FolderOpenIcon color="primary" />
								<Typography variant="body2" flex={1}>
									{sel?.name ||
										sel?.id ||
										(t(
											// eslint-disable-next-line @typescript-eslint/no-explicit-any
											'addSource.googleDrivePicker.selectedItem' as any
										) as string)}
								</Typography>
							</Stack>
						)
					)}
					<Button
						size="small"
						startIcon={<DeleteIcon />}
						onClick={handleClear}
						disabled={disabled}
						sx={{ alignSelf: 'flex-start' }}
					>
						{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
						{t('addSource.googleDrivePicker.clearSelection' as any)}
					</Button>
				</Stack>
			)}

			<Button
				startIcon={<FolderOpenIcon />}
				onClick={handleOpenPicker}
				disabled={disabled || !pickerAvailable}
				variant="outlined"
				color="primary"
				fullWidth
			>
				{hasSelection
					? (t(
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							'addSource.googleDrivePicker.changeSelection' as any
						) as string)
					: (t(
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							'addSource.googleDrivePicker.chooseInGoogleDrive' as any
						) as string)}
			</Button>

			{required && !hasSelection && rawErrors && (
				<Typography variant="caption" color="error">
					{/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
					{t('addSource.googleDrivePicker.selectionRequired' as any)}
				</Typography>
			)}
		</Stack>
	);
}
