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

import '../google-api-types';

/**
 * Loads the Google Picker API scripts, waits for them to initialize, then opens
 * the Google Drive Picker dialog for folder selection. After the user picks folders,
 * updates the canvas node's formData with the selected folder IDs and persists
 * the changes.
 *
 * IMPORTANT: This function should ONLY be called from GoogleDrivePickerWidget.
 * It should NEVER be called automatically from LoginWithGoogleButton.
 *
 * @param apiKey - Google API developer key for authenticating Picker requests.
 * @param clientId - Google OAuth client ID (app ID is derived from the prefix).
 * @param accessToken - Valid OAuth2 access token for the authenticated user.
 * @param nodeId - The canvas node ID to update with the selected folder paths.
 * @param serviceParam - Serialized service configuration (may be stale; not used for formData).
 * @param selectedNode - The currently selected canvas node with its data.
 * @param updateNode - Callback to update a node's data in the canvas store.
 * @param saveChanges - Async callback to persist changes after node update.
 */
export async function loadGooglePicker(
	apiKey: string,
	clientId: string,
	accessToken: string,
	nodeId: string,
	serviceParam: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	selectedNode: { id: string; data?: { formData?: any; provider?: string } },
	updateNode: (nodeId: string, data: Record<string, unknown>) => void,
	saveChanges: () => Promise<void>
) {
	// Callback invoked by the Google Picker after the user completes or cancels selection
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const handlePickerCallback = async (data: any) => {
		if (!data || !window.google?.picker) {
			return;
		}

		// Detect the PICKED action using both constant-keyed and string-keyed access for cross-env safety
		const action = data[window.google.picker.Response.ACTION] || data.action;
		const isPicked = action === window.google.picker.Action.PICKED || action === 'picked';

		// Ignore cancel/close actions
		if (!isPicked) {
			return;
		}

		const docs = data[window.google.picker.Response.DOCUMENTS] || data.docs || [];
		if (!Array.isArray(docs) || docs.length === 0) {
			return;
		}

		// Extract only folder documents; non-folder files are ignored for this use case
		const folderIds = docs
			.filter(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(doc: any) => doc?.mimeType === 'application/vnd.google-apps.folder'
			)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((doc: any) => doc?.id)
			.filter((id: string | undefined): id is string => Boolean(id));

		if (folderIds.length > 0) {
			// Convert folder IDs to PathItem objects for the backend scanning config
			const selectedFolderPaths = folderIds.map((id: string) => ({
				path: id,
			}));

			// Read the current formData directly from the node (not from the potentially stale serviceParam)
			// to ensure the latest userToken and other fields are preserved
			const formData = selectedNode?.data?.formData || {};

			// Pipe nodes use a namespaced key (Pipe.include/Pipe.exclude) while Source nodes use plain keys
			const isPipeNode = formData['Pipe.include'] !== undefined || formData['Pipe.exclude'] !== undefined;

			// Clone formData so we can safely mutate include/exclude fields
			const updateData: Record<string, unknown> = {
				...formData,
			};

			// Read the current include/exclude arrays based on node type
			const currentInclude = isPipeNode ? formData['Pipe.include'] || [] : formData.include || [];
			const currentExclude = isPipeNode ? formData['Pipe.exclude'] || [] : formData.exclude || [];

			// A wildcard in include means "scan everything"; replace it with specific folders
			const hasWildcardInInclude = currentInclude.some((item: { path?: string }) => item?.path === '*');

			// Strategy: wildcard -> replace include; existing excludes -> append to exclude; else append to include
			if (hasWildcardInInclude) {
				if (isPipeNode) {
					updateData['Pipe.include'] = selectedFolderPaths;
				} else {
					updateData.include = selectedFolderPaths;
				}
			} else if (currentExclude.length > 0) {
				const updatedExclude = [...currentExclude, ...selectedFolderPaths];
				if (isPipeNode) {
					updateData['Pipe.exclude'] = updatedExclude;
				} else {
					updateData.exclude = updatedExclude;
				}
			} else {
				const updatedInclude = [...currentInclude, ...selectedFolderPaths];
				if (isPipeNode) {
					updateData['Pipe.include'] = updatedInclude;
				} else {
					updateData.include = updatedInclude;
				}
			}

			// Persist the updated formData to the canvas node store
			updateNode(nodeId, {
				formData: updateData,
			});

			// Save changes to the backend and clean up OAuth-related URL params left by the redirect flow
			try {
				await saveChanges();

				const cleanUrl = window.location.origin + window.location.pathname;
				window.history.replaceState({}, document.title, cleanUrl);
			} catch (error) {
				console.error('Error saving changes after Google Picker selection:', error);
			}
		}
	};

	// Helper to dynamically inject a <script> tag and wait for it to load.
	// Skips injection if the script already exists in the DOM (idempotent).
	const loadScript = (src: string): Promise<void> => {
		return new Promise((resolve, reject) => {
			const existingScript = document.querySelector(`script[src="${src}"]`);
			if (existingScript) {
				resolve();
				return;
			}

			const script = document.createElement('script');
			script.src = src;
			script.onload = () => {
				resolve();
			};
			script.onerror = () => {
				reject(new Error(`Failed to load ${src}`));
			};
			document.head.appendChild(script);
		});
	};

	try {
		// Sequentially load both Google API scripts (jsapi for core, api.js for gapi.load)
		await loadScript(`https://www.google.com/jsapi?key=${apiKey}`);
		await loadScript(`https://apis.google.com/js/api.js?key=${apiKey}`);

		// Poll for the Google API objects to become available, then load the Picker module.
		// Scripts are loaded async so they may not be ready immediately after onload fires.
		await new Promise<void>((resolve, reject) => {
			let attempts = 0;
			let loadInitiated = false;
			const maxAttempts = 100; // 100 attempts * 100ms = 10 seconds max

			const checkGoogle = () => {
				attempts++;
				const hasGoogle = !!window.google;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const gapiLoader = (window as any).gapi;
				const hasGapiLoad = !!gapiLoader?.load;

				// Once both google and gapi.load are available, initiate the picker module load once
				if (!loadInitiated && hasGoogle && hasGapiLoad) {
					loadInitiated = true;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const loadOptions: any = {
						callback: () => {
							resolve();
						},
						onerror: () => {
							reject(new Error('Failed to load Google Picker module'));
						},
					};
					gapiLoader.load('picker', loadOptions);
					return;
				}

				if (attempts >= maxAttempts) {
					reject(new Error('Timeout waiting for Google APIs to load'));
				} else {
					// Retry after a short delay
					setTimeout(checkGoogle, 100);
				}
			};

			checkGoogle();
		});

		// Configure a documents view with folder navigation and selection in list mode
		const docsView = new window.google!.picker!.DocsView(window.google!.picker!.ViewId.DOCUMENTS).setIncludeFolders(true).setSelectFolderEnabled(true).setMode(window.google!.picker!.DocsViewMode.LIST);

		// Add a dedicated folders view as an additional tab for folder-only browsing
		const foldersView = new window.google!.picker!.DocsView(window.google!.picker!.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true);

		// Construct and display the picker with shared/team drive support and multi-select
		const picker = new window.google!.picker!.PickerBuilder().enableFeature(window.google!.picker!.Feature.SUPPORT_DRIVES).enableFeature(window.google!.picker!.Feature.MULTISELECT_ENABLED).setDeveloperKey(apiKey).addView(docsView).addView(foldersView).setOAuthToken(accessToken).setCallback(handlePickerCallback).build();

		picker.setVisible(true);
	} catch (error) {
		console.error('Error loading Google Picker:', error);
	}
}
