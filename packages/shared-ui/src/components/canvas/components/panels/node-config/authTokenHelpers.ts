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

/**
 * Authentication Token Persistence Helpers
 *
 * RJSF (React JSON Schema Form) drops hidden form fields during re-renders.
 * Authentication tokens are typically stored in hidden fields, so they would
 * be lost without explicit preservation. These utilities solve that by:
 *
 *   1. Extracting tokens from form data into a React ref (persist)
 *   2. Merging tokens back into form data before save/change (merge)
 *   3. Handling OAuth callback tokens and saving (persistOAuth)
 *
 * Token resolution priority (highest to lowest):
 *   previousFormData → persistedRef → new form data
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Shape of persisted authentication tokens stored in a React ref.
 * Kept separate from RJSF form state to survive field-dropping re-renders.
 */
export interface IAuthTokensRef {
	/** Generic user authentication token. */
	userToken?: string;
	/** Authentication method identifier (e.g. "oauth2", "apikey"). */
	authType?: string;
	/** Google-specific OAuth tokens and expiry metadata. */
	google?: {
		userToken?: string;
		accessToken?: string;
		tokenExpiry?: number;
	};
}

/**
 * Form data shape that may contain a `parameters` sub-object with auth tokens.
 * Used as the input/output type for token persistence and merge utilities.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IFormDataWithParameters = Record<string, any> & {
	parameters?: {
		userToken?: string;
		authType?: string;
		google?: {
			userToken?: string;
			accessToken?: string;
			tokenExpiry?: number;
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		[key: string]: any;
	};
};

// =============================================================================
// Persist — extract tokens from form data into a ref
// =============================================================================

/**
 * Extracts authentication tokens from form data and persists them to a ref.
 * Only overwrites ref values when the form data contains a non-empty value,
 * preventing accidental clearing of previously persisted tokens.
 *
 * @param formData  - Current form data containing token fields.
 * @param tokensRef - React ref to persist tokens into.
 */
export function persistTokensFromFormData(formData: IFormDataWithParameters, tokensRef: { current: IAuthTokensRef }): void {
	const params = formData?.parameters ?? {};

	// Copy each known token field, but only if a value exists
	if (params.userToken) tokensRef.current.userToken = params.userToken;
	if (params.authType) tokensRef.current.authType = params.authType;

	// Google tokens are nested and include expiry metadata
	if (params.google?.userToken || params.google?.accessToken) {
		tokensRef.current.google = {
			...(tokensRef.current.google ?? {}),
			...(params.google?.userToken && { userToken: params.google.userToken }),
			...(params.google?.accessToken && { accessToken: params.google.accessToken }),
			...(params.google?.tokenExpiry && { tokenExpiry: params.google.tokenExpiry }),
		};
	}
}

// =============================================================================
// Merge — restore tokens into form data before save/change
// =============================================================================

/**
 * Merges preserved authentication tokens back into form data.
 *
 * RJSF drops hidden fields during re-renders, so tokens must be restored
 * from two backup sources: the previous form data (most recent committed
 * state) and the persisted ref (long-lived backup).
 *
 * Also syncs the ref with the latest resolved values so they survive
 * future RJSF re-renders.
 *
 * @param formData         - New form data from RJSF (may be missing tokens).
 * @param previousFormData - Last committed form data (may contain tokens).
 * @param tokensRef        - React ref with persisted token backup.
 * @returns Form data with tokens restored.
 */
export function mergeAuthTokensIntoFormData(formData: IFormDataWithParameters, previousFormData: IFormDataWithParameters, tokensRef: { current: IAuthTokensRef }): IFormDataWithParameters {
	const prevParams = previousFormData?.parameters ?? {};
	const newParams = formData?.parameters ?? {};
	const persisted = tokensRef.current;

	// Resolve each token: previousParams > persistedRef > newParams
	const userToken = prevParams.userToken || persisted.userToken;
	const authType = prevParams.authType || persisted.authType || newParams.authType;
	const googleUserToken = prevParams.google?.userToken || persisted.google?.userToken;
	const googleAccessToken = prevParams.google?.accessToken || persisted.google?.accessToken;
	const googleTokenExpiry = prevParams.google?.tokenExpiry || persisted.google?.tokenExpiry;

	// Build merged form data with recovered tokens overlaid
	const merged: IFormDataWithParameters = {
		...formData,
		parameters: {
			...newParams,
			...(userToken && { userToken }),
			...(authType && { authType }),
			google: {
				...(newParams.google ?? {}),
				...(googleUserToken && { userToken: googleUserToken }),
				...(googleAccessToken && { accessToken: googleAccessToken }),
				...(googleTokenExpiry && { tokenExpiry: googleTokenExpiry }),
			},
		},
	};

	// Sync the ref with the latest resolved tokens
	if (userToken) tokensRef.current.userToken = userToken;
	if (authType) tokensRef.current.authType = authType;
	if (googleUserToken || googleAccessToken || googleTokenExpiry) {
		tokensRef.current.google = {
			...(tokensRef.current.google ?? {}),
			...(googleUserToken && { userToken: googleUserToken }),
			...(googleAccessToken && { accessToken: googleAccessToken }),
			...(googleTokenExpiry && { tokenExpiry: googleTokenExpiry }),
		};
	}

	return merged;
}

// =============================================================================
// OAuth — persist callback tokens and save
// =============================================================================

/**
 * Persists OAuth tokens to a node and notifies the host of changes.
 *
 * Waits for React to flush the updateNode state change before calling
 * onChanged, using a two-phase wait (microtask + animation frame)
 * to ensure the reconciliation cycle completes.
 *
 * @param nodeId     - ID of the node to update.
 * @param formData   - Form data enriched with OAuth tokens.
 * @param updateNode - Function to update the node's data.
 * @param onChanged  - Callback to notify the host that content changed.
 */
export async function persistOAuthTokensAndSave(nodeId: string, formData: IFormDataWithParameters, updateNode: (nodeId: string, data: Record<string, unknown>) => void, onChanged: () => void): Promise<void> {
	// Apply token-enriched form data to the node
	updateNode(nodeId, { formData });

	// Wait for React to flush: microtask → animation frame → resolved
	await new Promise<void>((resolve) => {
		queueMicrotask(() => {
			requestAnimationFrame(() => resolve());
		});
	});

	// Notify host of the change
	onChanged();
}
