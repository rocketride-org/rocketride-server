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

/**
 * Shape of persisted authentication tokens stored in a React ref.
 * These tokens must survive RJSF re-renders that drop hidden form fields,
 * so they are kept separately from the form state.
 */
export type AuthTokensRef = {
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
};

/**
 * Represents form data that may contain a `parameters` sub-object
 * holding authentication tokens. Used as the input/output type for
 * token persistence and merge utilities.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FormDataWithParameters = Record<string, any> & {
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

/**
 * Extracts authentication tokens from formData and persists them to a ref
 * This ensures tokens survive RJSF updates that drop hidden fields
 */
export function persistTokensFromFormData(
	formData: FormDataWithParameters,
	tokensRef: { current: AuthTokensRef }
): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const existingParams = (formData as any).parameters || {};

	// Copy each known token field from formData into the ref, but only if a value exists.
	// This prevents overwriting previously persisted tokens with undefined.
	if (existingParams.userToken) {
		tokensRef.current.userToken = existingParams.userToken;
	}
	if (existingParams.authType) {
		tokensRef.current.authType = existingParams.authType;
	}
	// Google tokens are nested under a `google` sub-object and include expiry metadata
	if (existingParams.google?.userToken || existingParams.google?.accessToken) {
		tokensRef.current.google = {
			// Preserve any previously stored Google tokens not present in this update
			...(tokensRef.current.google || {}),
			...(existingParams.google?.userToken && {
				userToken: existingParams.google.userToken,
			}),
			...(existingParams.google?.accessToken && {
				accessToken: existingParams.google.accessToken,
			}),
			...(existingParams.google?.tokenExpiry && {
				tokenExpiry: existingParams.google.tokenExpiry,
			}),
		};
	}
}

/**
 * Ref that stores credentials from the previous profile so they survive
 * multiple RJSF onChange cycles during a single profile switch.
 */
export type ProfileCredentialsRef = {
	current: Record<string, unknown>;
};

/**
 * Carries over credential fields (e.g. apikey) when the user switches between
 * model profiles within the same provider.
 *
 * Each model profile stores its credentials in a separate conditional branch
 * (e.g. "openai-4o": { "apikey": "..." }). When RJSF switches branches it
 * drops the old profile object and may fire onChange multiple times. On the
 * first call we detect the switch and stash the old credentials in a ref;
 * on subsequent calls we restore from the ref so RJSF defaults can't
 * overwrite the carried-over values.
 */
export function carryOverProfileCredentials(
	formData: FormDataWithParameters,
	previousFormData: FormDataWithParameters,
	currentFormValues: FormDataWithParameters,
	credentialsRef: ProfileCredentialsRef
): FormDataWithParameters {
	const newProfile = formData?.profile;
	if (!newProfile) return formData;

	const stateProfile = currentFormValues?.profile;
	const savedProfile = previousFormData?.profile;

	// Detect a fresh profile switch: the incoming profile differs from what
	// React state currently holds (first onChange of the switch).
	if (stateProfile && stateProfile !== newProfile) {
		// Stash the old profile's credentials in the ref so they survive
		// subsequent onChange calls where formValues has already been updated.
		const oldData =
			(currentFormValues?.[stateProfile] as Record<string, unknown>) ??
			(previousFormData?.[stateProfile] as Record<string, unknown>);
		if (oldData && typeof oldData === 'object') {
			credentialsRef.current = { ...oldData };
		}
	} else if (savedProfile && savedProfile !== newProfile && !Object.keys(credentialsRef.current).length) {
		// formValues already updated but ref is empty — seed from saved data
		const oldData = previousFormData?.[savedProfile] as Record<string, unknown>;
		if (oldData && typeof oldData === 'object') {
			credentialsRef.current = { ...oldData };
		}
	}

	// Nothing stashed → nothing to carry over
	if (!Object.keys(credentialsRef.current).length) return formData;

	const newProfileData = formData?.[newProfile] as Record<string, unknown> | undefined;
	const newProfileObj = (newProfileData ?? {}) as Record<string, unknown>;
	const updatedProfile = { ...newProfileObj };
	let changed = false;

	for (const key of Object.keys(credentialsRef.current)) {
		if (!updatedProfile[key] && credentialsRef.current[key]) {
			updatedProfile[key] = credentialsRef.current[key];
			changed = true;
		}
	}

	if (!changed) return formData;

	// Clear the ref once the new profile has accepted the credentials,
	// so we don't keep overwriting on every subsequent onChange.
	if (newProfile === stateProfile) {
		credentialsRef.current = {};
	}

	return { ...formData, [newProfile]: updatedProfile };
}

/**
 * Merges preserved authentication tokens back into formData
 * RJSF drops hidden fields, so we must merge tokens from previous state and ref
 */
export function mergeAuthTokensIntoFormData(
	formData: FormDataWithParameters,
	previousFormData: FormDataWithParameters,
	tokensRef: { current: AuthTokensRef }
): FormDataWithParameters {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const previousParams = (previousFormData as any).parameters || {};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const newParams = (formData as any).parameters || {};
	const persistedTokens = tokensRef.current;

	// Resolve each token from multiple sources with priority:
	// previousParams (most recent committed state) > persistedRef (long-lived backup)
	const userToken = previousParams.userToken || persistedTokens.userToken;
	const authType = previousParams.authType || persistedTokens.authType || newParams.authType;
	const googleUserToken = previousParams.google?.userToken || persistedTokens.google?.userToken;
	const googleAccessToken =
		previousParams.google?.accessToken || persistedTokens.google?.accessToken;
	const googleTokenExpiry =
		previousParams.google?.tokenExpiry || persistedTokens.google?.tokenExpiry;

	// Build the merged form data by spreading the new params and then overlaying
	// the recovered tokens so RJSF-dropped hidden fields are restored
	const mergedFormData: FormDataWithParameters = {
		...formData,
		parameters: {
			...newParams,
			// Restore authentication tokens that RJSF dropped because their fields are hidden
			...(userToken && { userToken }),
			...(authType && { authType }),
			google: {
				...(newParams.google || {}),
				...(googleUserToken && { userToken: googleUserToken }),
				...(googleAccessToken && {
					accessToken: googleAccessToken,
				}),
				...(googleTokenExpiry && {
					tokenExpiry: googleTokenExpiry,
				}),
			},
		},
	};

	// Sync the ref with the latest resolved tokens so they survive future RJSF re-renders
	if (userToken) tokensRef.current.userToken = userToken;
	if (authType) tokensRef.current.authType = authType;
	if (googleUserToken || googleAccessToken || googleTokenExpiry) {
		tokensRef.current.google = {
			...(tokensRef.current.google || {}),
			...(googleUserToken && { userToken: googleUserToken }),
			...(googleAccessToken && { accessToken: googleAccessToken }),
			...(googleTokenExpiry && { tokenExpiry: googleTokenExpiry }),
		};
	}

	return mergedFormData;
}

/**
 * Persists OAuth tokens and saves changes
 * This ensures updateNode completes and React state updates are processed before saving
 */
export async function persistOAuthTokensAndSave(
	nodeId: string,
	formData: FormDataWithParameters,
	updateNode: (nodeId: string, data: Record<string, unknown>) => void,
	saveChanges: () => Promise<unknown>
): Promise<void> {
	// Apply the token-enriched form data to the node's in-memory state
	updateNode(nodeId, { formData });

	// Wait for React to flush the state update before saving. We use a two-phase
	// wait: queueMicrotask ensures the current synchronous execution completes,
	// then requestAnimationFrame waits for React's reconciliation/render cycle.
	await new Promise<void>((resolve) => {
		queueMicrotask(() => {
			requestAnimationFrame(() => {
				resolve();
			});
		});
	});

	// Persist the updated pipeline to the server after React has committed the state
	await saveChanges();
}
