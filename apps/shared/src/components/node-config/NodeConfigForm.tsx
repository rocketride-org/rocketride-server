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
 * NodeConfigForm — the context-free core of a node's configuration form.
 *
 * The schema-driven RJSF form every host can embed: the pipeline editor's
 * NodeConfigPanel wraps it in the canvas drawer, and any app that needs to
 * configure a node (e.g. sql-ui's New Connection modal) mounts it directly.
 * It reads NO canvas contexts — everything arrives through props, and the
 * CONTAINER owns the form data, dirty tracking, and what Save does.
 *
 * The container hands in a RESOLVED Pipe schema: the shell's cached services
 * summary may not carry a node's full schema, so the container awaits the
 * full fetch first and only then mounts this form.
 *
 * What the core owns (identical to the editor's behaviour):
 *  - the ThemedForm RJSF theme and translated strings;
 *  - secured-field handling (`ui:encrypted` on fields holding secured
 *    values, required-ness relaxed for them);
 *  - env-var references — validation is bypassed for values matching
 *    `${ROCKETRIDE_*}`, and an autocomplete hint renders when the container
 *    supplies `envKeys`;
 *  - friendly auth-field error messages.
 *
 * Submit is triggered through the imperative handle (`ref.submit()`), the
 * same way the editor's footer Save drives RJSF.
 */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, CSSProperties } from 'react';
import { RJSFValidationError } from '@rjsf/utils';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';

import { IFormData, IServiceSchema } from 'shell';
import ThemedForm, { translate } from './rjsf-widgets/theme';
import { getSecuredFormData, removeRequired, setUiSchemaProperty } from './rjsf';
import { commonStyles } from 'shell';
import StoredArrayField from './StoredArrayField';
import { storedArrays, preserveStoredArrays, replaceStoredArray } from './storedArrays';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	// Env-var autocomplete hint under the form.
	envHint: {
		...commonStyles.textMuted,
		marginTop: 12,
	} as CSSProperties,
};

// =============================================================================
// Validation-response helper
// =============================================================================

/**
 * Extracts the human-readable problem from a validate-pipeline response —
 * the editor's parsing, shared so every NodeConfigForm container reports
 * identical messages.
 *
 * @param resp - The response from `handleValidatePipeline` / the validate call.
 * @returns The problem string, or null when the response is clean.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validationProblemFromResponse(resp: any): string | null {
	if (resp?.error) return `Validation error: ${resp.error.message ?? ''}`;
	const errors = resp?.errors ?? resp?.data?.errors ?? [];
	if (errors.length > 0) {
		return `Validation error: ${errors.map((e: { message?: string }) => e.message).join(' ')}`;
	}
	const warnings = resp?.warnings ?? resp?.data?.warnings ?? [];
	if (warnings.length > 0) {
		return `Warning: ${warnings.map((w: { message?: string }) => w.message).join(' ')}`;
	}
	return null;
}

// =============================================================================
// Props
// =============================================================================

/** Imperative handle — the container's Save button drives the RJSF submit. */
export interface INodeConfigFormHandle {
	/** Runs RJSF validation; on success the form calls `onSubmit`. */
	submit(): void;
}

/** Props for {@link NodeConfigForm}. */
export interface INodeConfigFormProps {
	/** Service provider id (error mapping + widget context). */
	provider: string;
	/** The RESOLVED Pipe schema (container fetches the full schema first). */
	schema: IServiceSchema;
	/** Controlled form data — the container owns it. */
	formData: IFormData;
	/** Fired with the new form data on every edit. */
	onChange: (formData: IFormData) => void;
	/** Fired with the final form data when a submit passes RJSF validation. */
	onSubmit: (formData: IFormData) => void;
	/** Fired with RJSF validation errors on a failed submit. Optional. */
	onError?: (errors: RJSFValidationError[]) => void;
	/** Env-var names for `${}` autocomplete (and the hint line). Optional. */
	envKeys?: string[];
	/** Disables every field (e.g. while the container saves). Optional. */
	disabled?: boolean;
	/** Node id for widget context (OAuth state round-trips). Optional. */
	nodeId?: string;
	/** Prior RJSF errors to surface in widget context (loosely typed — the
	 *  node data carries them untyped). Optional. */
	formDataErrors?: unknown[];
	/** Google picker credentials for drive widgets. Optional. */
	googlePickerDeveloperKey?: string;
	googlePickerClientId?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the schema-driven node configuration form.
 *
 * @param props - {@link INodeConfigFormProps}.
 * @returns The themed RJSF form element.
 */
const NodeConfigForm = forwardRef<INodeConfigFormHandle, INodeConfigFormProps>(function NodeConfigForm({ provider, schema, formData, onChange, onSubmit, onError, envKeys = [], disabled = false, nodeId, formDataErrors, googlePickerDeveloperKey, googlePickerClientId }, ref) {
	const formRef = useRef<Form | null>(null);
	useImperativeHandle(ref, () => ({ submit: () => formRef.current?.submit() }), []);

	// --- Secured field transforms -------------------------------------------
	// Fields currently holding secured values render encrypted and drop their
	// required-ness (the stored value satisfies the requirement).
	const securedFormData = useMemo(() => getSecuredFormData(formData), [formData]);
	const stored = useMemo(() => storedArrays(schema.schema, formData), [schema.schema, formData]);
	const _schema = useMemo(() => {
		const storedPaths: [string[], string[]][] = stored.map(({ path }) => [path.slice(0, -1), path.slice(-1)]);
		return removeRequired(schema.schema, [...securedFormData, ...storedPaths]);
	}, [schema.schema, securedFormData, stored]);
	const _uiSchema = useMemo(() => {
		const ui = setUiSchemaProperty(schema.ui, securedFormData, { 'ui:encrypted': true });
		for (const { path } of stored) {
			let field = ui;
			for (const segment of path) {
				Object.defineProperty(field, segment, { value: { ...(Object.hasOwn(field, segment) ? field[segment] : {}) }, enumerable: true, configurable: true, writable: true });
				field = field[segment];
			}
			Object.assign(field, {
				'ui:field': 'StoredArrayField',
				'ui:storedArrayPath': path,
			});
		}
		return ui;
	}, [schema.ui, securedFormData, stored]);

	// --- Friendly auth error messages + env var bypass -----------------------
	const transformErrors = useCallback(
		(errors: RJSFValidationError[]) => {
			return errors
				.filter((error) => {
					// The engine validates the stored value; the browser only has its opaque blob.
					if (stored.some(({ path }) => error.property === `.${path.join('.')}` || error.property?.startsWith(`.${path.join('.')}.`))) return false;
					// Suppress validation errors for fields whose value is an env var reference
					if (error.property) {
						const fieldPath = error.property.replace(/^\./, '').split('.');
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const fieldValue = fieldPath.reduce((obj: any, key) => obj?.[key], formData);
						if (typeof fieldValue === 'string' && /^\$\{ROCKETRIDE_\w+\}$/.test(fieldValue)) {
							return false;
						}
					}
					return true;
				})
				.map((error) => {
					if (['accessToken', 'refreshToken', 'userToken'].includes(error.params?.missingProperty ?? '')) {
						error.stack = 'Authentication required';
					}
					return error;
				});
		},
		[formData, stored]
	);

	return (
		<>
			<ThemedForm
				ref={formRef}
				fields={{ StoredArrayField }}
				schema={_schema}
				uiSchema={{
					..._uiSchema,
					'ui:options': {
						...(typeof (_uiSchema ?? {})['ui:options'] === 'object' ? (_uiSchema ?? {})['ui:options'] : {}),
						hideRootTitle: true,
					},
					'ui:submitButtonOptions': { norender: true },
				}}
				formData={formData}
				formContext={{
					replaceStoredArray: (path: string[]) => onChange(replaceStoredArray(formData, path)),
					formValues: formData,
					compactDescriptions: _uiSchema?.['ui:options']?.compactDescriptions === true,
					hideFor: formData.parameters?.authType,
					googlePickerDeveloperKey,
					googlePickerClientId,
					nodeId,
					provider,
					formDataErrors,
					envKeys,
				}}
				disabled={disabled}
				validator={validator}
				transformErrors={transformErrors}
				onError={onError}
				onSubmit={({ formData: submitted }: Partial<{ formData: IFormData }>) => onSubmit(preserveStoredArrays(submitted ?? {}, formData, stored))}
				onChange={({ formData: changed }: Partial<{ formData: IFormData }>) => onChange(preserveStoredArrays(changed ?? {}, formData, stored))}
				translateString={translate}
			/>

			{/* Env-var autocomplete hint. */}
			{envKeys.length > 0 && <div style={styles.envHint}>Type $&#123; in a field to pick from your variables</div>}
		</>
	);
});

export default NodeConfigForm;
