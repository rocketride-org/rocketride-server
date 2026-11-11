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
// connection editor both render service configs through this module
// (schema-driven RJSF form, secured fields, `${ROCKETRIDE_*}` env
// references, OAuth widgets). It lives in shared/components — never inside
// a tool — and depends on no tool code; hosting surfaces provide the OAuth
// environment through OAuthEnvContext when they support consent flows.
// =============================================================================

/**
 * The `.pipe` schema version stamped into validate payloads built from a
 * single configured component.
 */
export const PIPELINE_SCHEMA_VERSION = 1;

export { default as NodeConfigForm, default, validationProblemFromResponse } from './NodeConfigForm';
export type { INodeConfigFormProps, INodeConfigFormHandle } from './NodeConfigForm';
export { OAuthEnvProvider, useOAuthEnv } from './OAuthEnvContext';
export type { IOAuthEnv } from './OAuthEnvContext';
export { getSecuredFormData, removeRequired, setUiSchemaProperty, validateFormData, getDefaultFormState } from './rjsf';
