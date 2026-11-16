// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

// =============================================================================
// NODE-CONFIG — the shared service-configuration form
// =============================================================================
//
// MULTI-TOOL by design: the pipeline canvas's config panel and sql-ui's
// connection editor both render service configs through this module — our
// own form handler over the engine's resolved property model (plan §5.6.5):
// a recursive render over get/set/delete(path), ghost defaults, selector
// recursion, descriptor validation, secret masking, `${ROCKETRIDE_*}`
// autocomplete, upload and OAuth widgets, the expose chip. It lives in
// shared/components — never inside a tool — and depends on no tool code;
// hosting surfaces provide the OAuth environment through OAuthEnvContext
// when they support consent flows.
// =============================================================================

/**
 * The `.pipe` schema version stamped into validate payloads built from a
 * single configured component.
 */
export const PIPELINE_SCHEMA_VERSION = 1;

export { default as NodeConfigForm, default } from './NodeConfigForm';
export type { INodeConfigFormProps, INodeConfigFormHandle, INodeConfigExposure } from './NodeConfigForm';
export { OAuthEnvProvider, useOAuthEnv } from './OAuthEnvContext';
export type { IOAuthEnv } from './OAuthEnvContext';
export { getAtPath, setAtPath, deleteAtPath, clearSecure, splitPath, dottedNames, flattenLeaves, effectiveValue, hasConfigurableSchema, constantMarkers, paramDescriptor, isSelector, isGroup, leafKind, enumOptions, enumValues, isStoredSecurely } from './model';
export type { IConfigTree, INodeSchema, ILeafEntry, LeafKind } from './model';
export { validateConfig, validateLeafValue, validateLeafAt } from './validate';
export type { IConfigProblem } from './validate';
export { PUBLIC_NAME_PATTERN, publicNameProblem, describeParam } from './widgets/ExposeNameDialog';
export { oauthProviderOf } from './widgets/OAuthWidget';
export type { OAuthProvider } from './widgets/OAuthWidget';

// =============================================================================
// Validation-response helper
// =============================================================================

/**
 * Extracts the human-readable problem from a validate-pipeline response —
 * shared so every NodeConfigForm container reports identical messages.
 *
 * @param resp - The response from `handleValidatePipeline` / the validate call.
 * @returns The problem string, or null when the response is clean.
 */
export function validationProblemFromResponse(resp: unknown): string | null {
	const response = (resp ?? {}) as { error?: { message?: string }; errors?: Array<{ message?: string }>; warnings?: Array<{ message?: string }>; data?: { errors?: Array<{ message?: string }>; warnings?: Array<{ message?: string }> } };
	if (response.error) return `Validation error: ${response.error.message ?? ''}`;
	const errors = response.errors ?? response.data?.errors ?? [];
	if (errors.length > 0) return `Validation error: ${errors.map((entry) => entry.message).join(' ')}`;
	const warnings = response.warnings ?? response.data?.warnings ?? [];
	if (warnings.length > 0) return `Warning: ${warnings.map((entry) => entry.message).join(' ')}`;
	return null;
}
