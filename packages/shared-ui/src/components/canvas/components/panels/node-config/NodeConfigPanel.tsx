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
 * NodeConfigPanel — a node's configuration editor, a {@link DetailPanel} record
 * panel that opens directly in its FORM (there is no read-only inspect mode: a
 * node's identity IS its configuration). `contained` anchors it to the canvas
 * surface; the footer follows the record-panel contract — [Save] MATERIALIZES on
 * the first change to the left of a stationary [Cancel], a dirty exit
 * (Cancel / X / Escape) raises the stock discard confirm, and the panel is
 * undismissable while a validate is in flight.
 *
 * Body:
 *   1. **Details** — node name (or, for annotations, content + colours).
 *   2. **Configuration** — RJSF form from the service's Pipe schema.
 *
 * On save:
 *   1. Merges auth tokens back into formData (RJSF drops hidden fields).
 *   2. Calls handleValidatePipeline for server-side validation.
 *   3. On success, writes config to node and notifies host.
 *
 * OAuth fields are supported via the RJSF theme widgets. OAuth callback
 * tokens are applied on panel open via useOAuthCallbacks.
 */

import { ReactElement, useRef, useState, useEffect, useMemo, useCallback, CSSProperties } from 'react';
import { RJSFValidationError } from '@rjsf/utils';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';

import { IFormData } from '../../../types';
import { IServiceSchema } from '../../../types';
import ThemedForm, { translate } from '../../rjsf-widgets/theme';
import { getSecuredFormData, removeRequired, setUiSchemaProperty } from '../../../util/rjsf';
import { Icon } from '../../../util/Icon';

import { useFlowGraph } from '../../../context/FlowGraphContext';
import type { FlowNode } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { useFlowPreferences } from '../../../context/FlowPreferencesContext';
import { IService, IServiceCatalog, IValidatePipelinePayload, PIPELINE_SCHEMA_VERSION } from '../../../types';
import { getComponentFromNode } from '../../../util/graph';

import { IAuthTokensRef, persistTokensFromFormData, mergeAuthTokensIntoFormData, persistOAuthTokensAndSave } from './authTokenHelpers';
import { useOAuthCallbacks } from './useOAuthCallbacks';
import { DetailPanel } from '../../../../detail-panel/DetailPanel';
import { Button } from '../../../../button/Button';
import { Banner } from '../../../../banner/Banner';
import { ConfirmDialog } from '../../../../modal/ConfirmDialog';
import { commonStyles } from '../../../../../themes/styles';

// =============================================================================
// Constants
// =============================================================================

/** Initial drawer width; the stock resize handle takes it from here. */
const PANEL_WIDTH = 460;

/** Workspace-preference key the drawer width is remembered under. */
const WIDTH_PERSIST_KEY = 'panelDetailConfigWidth';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	// Service-icon avatar filling the DetailPanel's 42px round slot.
	avatar: {
		width: '100%',
		height: '100%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,

	avatarIcon: {
		width: 22,
		height: 22,
	} as CSSProperties,

	// Spacing wrapper for the in-panel error Banner at the top of the body.
	bannerWrap: {
		marginBottom: 12,
	} as CSSProperties,

	// One labelled field block.
	field: {
		marginBottom: 14,
	} as CSSProperties,

	fieldLabel: {
		...commonStyles.labelUppercase,
		display: 'block',
		marginBottom: 5,
	} as CSSProperties,

	// Annotation content textarea (grows vertically only).
	textarea: {
		...commonStyles.inputField,
		minHeight: 90,
		resize: 'vertical',
	} as CSSProperties,

	// Annotation colour-picker row.
	colorRow: {
		display: 'flex',
		gap: 16,
		alignItems: 'flex-end',
	} as CSSProperties,

	colorInput: {
		width: '100%',
		height: 32,
		border: '1px solid var(--rr-border-input)',
		borderRadius: 5,
		cursor: 'pointer',
		padding: 0,
		background: 'var(--rr-bg-input)',
	} as CSSProperties,

	// Env-var autocomplete hint under the form.
	envHint: {
		...commonStyles.textMuted,
		marginTop: 12,
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link NodeConfigPanel}. */
interface INodeConfigPanelProps {
	/** The live ReactFlow node being edited. */
	node: FlowNode;
	/** Close the panel. */
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the node configuration drawer.
 *
 * @param props - {@link INodeConfigPanelProps}.
 * @returns The DetailPanel drawer element.
 */
export default function NodeConfigPanel({ node, onClose }: INodeConfigPanelProps): ReactElement {
	const formRef = useRef<Form | null>(null);

	// Persist auth tokens across RJSF re-renders (RJSF drops hidden fields)
	const persistedAuthTokens = useRef<IAuthTokensRef>({});

	// --- Context ------------------------------------------------------------
	const { updateNode, onContentUpdated } = useFlowGraph();
	const { servicesJson, handleValidatePipeline, currentProject: _currentProject, googlePickerDeveloperKey, googlePickerClientId, pendingOAuthTokens, clearPendingOAuthTokens, envKeys = [] } = useFlowProject();
	// The drawer width rides the shared PrefsContext (provided by the canvas) via
	// DetailPanel's persistKey — the same workspace store, no per-panel adapter.
	const { isLocked } = useFlowPreferences();

	// --- Annotation detection -----------------------------------------------
	const isAnnotation = node.data.provider === 'annotation';

	// --- Service lookup -----------------------------------------------------
	const service: IService | undefined = (servicesJson as IServiceCatalog)?.[node.data.provider];

	// --- OAuth callback helpers (context-free) ------------------------------
	const { applyOAuthCallbacks, applyGoogleTokens, clearSecureParamsFromUrl } = useOAuthCallbacks();

	// --- Schema from the service catalog ------------------------------------
	const schema = useMemo((): IServiceSchema | undefined => {
		if (isAnnotation) return undefined;
		const pipe = service?.Pipe;
		if (!pipe) return undefined;
		if (pipe.schema?.properties?.hideForm) return undefined;
		if (Object.keys(pipe.schema?.properties ?? {}).length === 0) return undefined;
		return pipe;
	}, [service, isAnnotation]);

	// --- Form state ---------------------------------------------------------
	const [name, setName] = useState(node.data.name ?? '');
	const [formValues, setFormValues] = useState<IFormData>(node.data.config ?? {});
	const [isDirty, setIsDirty] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [validationError, setValidationError] = useState<string | null>(null);
	// Footer-Cancel discard confirm (the DetailPanel guards X / Escape itself;
	// the footer Cancel routes through this local gate per the standard).
	const [confirmDiscard, setConfirmDiscard] = useState(false);

	// --- Annotation-specific state ------------------------------------------
	const [annotationContent, setAnnotationContent] = useState(() => {
		const raw = (node.data.config?.content ?? '') as string;
		return raw.replace(/\\n/g, '\n');
	});
	const [bgColor, setBgColor] = useState<string>((node.data.config?.bgColor as string) || 'var(--rr-annotation-bg-default)');
	const [fgColor, setFgColor] = useState<string>((node.data.config?.fgColor as string) || 'var(--rr-text-primary)');

	// --- Secured field transforms -------------------------------------------
	const securedFormData = getSecuredFormData(formValues);
	const _schema = useMemo(() => removeRequired(schema?.schema, securedFormData), [schema?.schema, securedFormData]);
	const _uiSchema = useMemo(() => setUiSchemaProperty(schema?.ui, securedFormData, { 'ui:encrypted': true }), [schema?.ui, securedFormData]);

	// --- Initialise state when a different node is selected -----------------
	useEffect(() => {
		const config = node.data.config ?? {};

		// Apply any OAuth tokens from URL callback parameters
		const enrichedConfig = applyOAuthCallbacks(config);

		// Persist tokens to ref so they survive RJSF re-renders
		persistTokensFromFormData(enrichedConfig, persistedAuthTokens);

		setName(node.data.name ?? '');
		setFormValues(enrichedConfig);
		setIsDirty(false);
		setValidationError(null);

		// Sync annotation-specific state
		if (node.data.provider === 'annotation') {
			const raw = (config.content ?? '') as string;
			setAnnotationContent(raw.replace(/\\n/g, '\n'));
			setBgColor((config.bgColor as string) || 'var(--rr-annotation-bg-default)');
			setFgColor((config.fgColor as string) || 'var(--rr-text-primary)');
		}

		// If OAuth tokens are in the URL, persist to node and save immediately
		const hasOAuthTokens = window.location.search.includes('tokens=');
		if (hasOAuthTokens) {
			persistOAuthTokensAndSave(node.id, enrichedConfig, updateNode, onContentUpdated).catch((err) => console.error('Error persisting OAuth tokens:', err));
		} else if (enrichedConfig !== config) {
			// OAuth helpers enriched the data — update node
			updateNode(node.id, { config: enrichedConfig });
		}

		// Strip sensitive tokens from URL after processing
		requestAnimationFrame(() => clearSecureParamsFromUrl());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [node.id]);

	// --- Apply OAuth tokens delivered out-of-band by the host (VS Code) ------
	// Web hosts return tokens in the page URL (handled above); VS Code can't
	// receive a web redirect, so the host intercepts the broker's deep link and
	// pushes the tokens down via `pendingOAuthTokens`. Apply them to the node
	// that started the login, then clear so they aren't re-applied.
	useEffect(() => {
		if (!pendingOAuthTokens) return;
		const { tokens, state } = pendingOAuthTokens;

		// Brokers echo the originating node_id in `state`; ignore tokens meant
		// for another node. Malformed state falls through to the open panel.
		let targetNodeId: string | undefined;
		try {
			targetNodeId = (JSON.parse(state || '{}') as { node_id?: string }).node_id;
		} catch {
			/* malformed state */
		}
		if (targetNodeId && targetNodeId !== node.id) return;

		// updateNode silently no-ops on a locked graph — surface it and keep
		// the tokens pending; unlocking re-runs this effect and applies them.
		if (isLocked) {
			setValidationError('The canvas is locked — unlock it to apply the Google sign-in tokens.');
			return;
		}
		setValidationError(null);

		const enrichedConfig = applyGoogleTokens(node.data.config ?? {}, tokens, state);
		persistTokensFromFormData(enrichedConfig, persistedAuthTokens);
		setFormValues(enrichedConfig);
		persistOAuthTokensAndSave(node.id, enrichedConfig, updateNode, onContentUpdated).catch((err) => console.error('Error persisting OAuth tokens:', err));

		clearPendingOAuthTokens?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingOAuthTokens, node.id, isLocked]);

	// --- RJSF change handler ------------------------------------------------
	const onChange = useCallback(
		({ formData }: Partial<{ formData: IFormData }>) => {
			// Merge auth tokens back in (RJSF drops hidden fields)
			const previousConfig = node.data.config ?? {};
			const merged = mergeAuthTokensIntoFormData(formData ?? {}, previousConfig, persistedAuthTokens);
			setFormValues(merged);
			setIsDirty(true);
		},
		[node.data.config]
	);

	// --- RJSF error handler -------------------------------------------------
	const onError = useCallback(
		(errors: RJSFValidationError[]) => {
			updateNode(node.id, { formDataErrors: errors, formDataValid: false });
		},
		[node.id, updateNode]
	);

	// --- Friendly auth error messages + env var bypass -----------------------
	const transformErrors = useCallback(
		(errors: RJSFValidationError[]) => {
			return errors
				.filter((error) => {
					// Suppress validation errors for fields whose value is an env var reference
					if (error.property) {
						const fieldPath = error.property.replace(/^\./, '').split('.');
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const fieldValue = fieldPath.reduce((obj: any, key) => obj?.[key], formValues);
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
		[formValues]
	);

	// --- Save: details only (no schema) ------------------------------------
	const handleSaveDetailsOnly = useCallback(() => {
		if (isAnnotation) {
			updateNode(node.id, {
				name: name || undefined,
				config: {
					...node.data.config,
					content: annotationContent,
					bgColor,
					fgColor,
				},
			});
		} else {
			updateNode(node.id, {
				name: name || undefined,
			});
		}
		setIsDirty(false);
		onContentUpdated();
		onClose();
	}, [node.id, node.data.config, name, isAnnotation, annotationContent, bgColor, fgColor, updateNode, onContentUpdated, onClose]);

	// --- Save: full form with server validation ----------------------------
	const onSubmit = useCallback(
		async ({ formData }: Partial<{ formData: IFormData }>) => {
			setIsSubmitting(true);
			try {
				setValidationError(null);

				// Merge auth tokens back in before saving
				const previousConfig = node.data.config ?? {};
				const merged = mergeAuthTokensIntoFormData(formData ?? {}, previousConfig, persistedAuthTokens);

				// Write to node
				const updatedNode = updateNode(node.id, {
					config: merged,
					formDataErrors: undefined,
					formDataValid: true,
					name: name || undefined,
				});

				// Server-side validation — a single-component payload (the
				// validate endpoint accepts it alongside a full pipeline).
				if (handleValidatePipeline && updatedNode) {
					const component = getComponentFromNode(updatedNode);
					const payload: IValidatePipelinePayload = {
						version: PIPELINE_SCHEMA_VERSION,
						component,
					};

					const resp = await handleValidatePipeline(payload);

					// Check top-level error
					if (resp?.error) {
						throw new Error(`Validation error: ${resp.error.message ?? ''}`);
					}

					// Check errors — may be at resp.errors or resp.data.errors
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const respAny = resp as any;
					const errors = respAny?.errors ?? resp?.data?.errors ?? [];
					if (errors.length > 0) {
						throw new Error(`Validation error: ${errors.map((e: { message?: string }) => e.message).join(' ')}`);
					}

					// Check warnings
					const warnings = respAny?.warnings ?? resp?.data?.warnings ?? [];
					if (warnings.length > 0) {
						throw new Error(`Warning: ${warnings.map((w: { message?: string }) => w.message).join(' ')}`);
					}
				}

				// Success
				setIsDirty(false);
				clearSecureParamsFromUrl();
				onContentUpdated();
				onClose();
			} catch (e: unknown) {
				setValidationError(e instanceof Error ? e.message : String(e));
			} finally {
				setIsSubmitting(false);
			}
		},
		[node.id, node.data.config, name, updateNode, handleValidatePipeline, clearSecureParamsFromUrl, onContentUpdated, onClose]
	);

	// --- Save / Cancel routing ----------------------------------------------

	/** Footer [Save]: submit the RJSF form when there is a schema, else write details. */
	const handleSaveClick = useCallback(() => {
		if (schema) {
			formRef.current?.submit();
		} else {
			handleSaveDetailsOnly();
		}
	}, [schema, handleSaveDetailsOnly]);

	/** Footer [Cancel]: discard-confirm when dirty (the standard's ban on silent discard), else close. */
	const handleCancelClick = useCallback(() => {
		if (isDirty) setConfirmDiscard(true);
		else onClose();
	}, [isDirty, onClose]);

	// --- Render -------------------------------------------------------------

	const title = isAnnotation ? 'Note' : (service?.title ?? node.data.provider);
	const saveDisabled = isSubmitting || isLocked;

	return (
		<>
			<DetailPanel
				open
				contained
				onClose={onClose}
				title={title}
				subtitle={isAnnotation ? undefined : node.data.provider}
				avatar={!isAnnotation && service?.icon ? <div style={styles.avatar}><Icon name={service.icon} style={styles.avatarIcon} /></div> : undefined}
				editing
				dirty={isDirty}
				busy={isSubmitting}
				onExitMode={onClose}
				width={PANEL_WIDTH}
				persistKey={WIDTH_PERSIST_KEY}
				footer={
					<>
						{/* [Save] materializes on the first change, left of the stationary [Cancel]. */}
						{isDirty && (
							<Button variant="primary" small disabled={saveDisabled} onClick={handleSaveClick}>
								{isSubmitting ? 'Validating…' : 'Save'}
							</Button>
						)}
						<Button variant="ghost" small disabled={isSubmitting} onClick={handleCancelClick}>
							Cancel
						</Button>
					</>
				}
			>
				{/* In-panel error surface (interaction standard): a stock Banner at the top of the body. */}
				{validationError && (
					<div style={styles.bannerWrap}>
						<Banner variant="error">{validationError}</Banner>
					</div>
				)}

				{/* Node name field */}
				{!isAnnotation && (
					<div style={styles.field}>
						<label style={styles.fieldLabel} htmlFor="rr-node-name">
							Node Name
						</label>
						<input
							id="rr-node-name"
							style={commonStyles.inputField}
							value={name}
							placeholder={service?.title}
							onChange={(e) => {
								setName(e.target.value);
								setIsDirty(true);
							}}
							data-rr-autofocus="true"
						/>
					</div>
				)}

				{/* Annotation-specific fields */}
				{isAnnotation && (
					<>
						<div style={styles.field}>
							<label style={styles.fieldLabel} htmlFor="rr-note-content">
								Content (Markdown)
							</label>
							<textarea
								id="rr-note-content"
								style={styles.textarea}
								value={annotationContent}
								placeholder="Enter markdown content..."
								onChange={(e) => {
									setAnnotationContent(e.target.value);
									setIsDirty(true);
								}}
								data-rr-autofocus="true"
							/>
						</div>
						<div style={styles.colorRow}>
							<div style={{ flex: 1 }}>
								<label style={styles.fieldLabel} htmlFor="rr-note-bg">
									Background
								</label>
								<input
									id="rr-note-bg"
									type="color"
									value={bgColor}
									style={styles.colorInput}
									onChange={(e) => {
										setBgColor(e.target.value);
										setIsDirty(true);
									}}
								/>
							</div>
							<div style={{ flex: 1 }}>
								<label style={styles.fieldLabel} htmlFor="rr-note-fg">
									Text Color
								</label>
								<input
									id="rr-note-fg"
									type="color"
									value={fgColor}
									style={styles.colorInput}
									onChange={(e) => {
										setFgColor(e.target.value);
										setIsDirty(true);
									}}
								/>
							</div>
						</div>
					</>
				)}

				{/* Configuration form (RJSF) */}
				{schema && (
					<ThemedForm
						key={node.id}
						ref={formRef}
						schema={_schema}
						uiSchema={{
							..._uiSchema,
							'ui:options': {
								...(typeof (_uiSchema ?? {})['ui:options'] === 'object' ? (_uiSchema ?? {})['ui:options'] : {}),
								hideRootTitle: true,
							},
							'ui:submitButtonOptions': { norender: true },
						}}
						formData={formValues}
						formContext={{
							formValues,
							compactDescriptions: _uiSchema?.['ui:options']?.compactDescriptions === true,
							hideFor: formValues.parameters?.authType,
							googlePickerDeveloperKey,
							googlePickerClientId,
							nodeId: node.id,
							provider: node.data.provider,
							formDataErrors: node.data.formDataErrors,
							envKeys,
						}}
						disabled={false}
						validator={validator}
						transformErrors={transformErrors}
						onError={onError}
						onSubmit={onSubmit}
						onChange={onChange}
						translateString={translate}
					/>
				)}

				{/* Env-var autocomplete hint. */}
				{envKeys.length > 0 && <div style={styles.envHint}>Type $&#123; in a field to pick from your variables</div>}
			</DetailPanel>

			{/* Footer-Cancel discard confirm (stock dialog, same copy as the
			    DetailPanel's own X / Escape guard). */}
			{confirmDiscard && (
				<ConfirmDialog
					title="Discard changes?"
					message="Your unsaved changes will be lost."
					confirmLabel="Discard"
					cancelLabel="Keep Editing"
					destructive
					onConfirm={() => {
						setConfirmDiscard(false);
						onClose();
					}}
					onCancel={() => setConfirmDiscard(false)}
				/>
			)}
		</>
	);
}
