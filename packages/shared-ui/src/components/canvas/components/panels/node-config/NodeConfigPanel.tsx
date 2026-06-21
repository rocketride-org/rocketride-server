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
 * NodeConfigPanel — Side panel for editing a node's configuration.
 *
 * Sections:
 *   1. **Details** — Node name.
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

import { ReactElement, useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { RJSFValidationError } from '@rjsf/utils';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';

import { TextField } from '@mui/material';
import { IFormData } from '../../../types';
import { IServiceSchema } from '../../../types';
import ThemedForm, { translate } from '../../rjsf-widgets/theme';
import { getSecuredFormData, removeRequired, setUiSchemaProperty } from '../../../util/rjsf';

import { useFlowGraph } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { useFlowPreferences } from '../../../context/FlowPreferencesContext';
import { INode, IService, IServiceCatalog, IProject, PIPELINE_SCHEMA_VERSION } from '../../../types';
import { getComponentFromNode } from '../../../util/graph';

import { IAuthTokensRef, persistTokensFromFormData, mergeAuthTokensIntoFormData, persistOAuthTokensAndSave } from './authTokenHelpers';
import { useOAuthCallbacks } from './useOAuthCallbacks';
import { commonStyles } from '../../../../../themes/styles';

// =============================================================================
// Constants
// =============================================================================

const MIN_WIDTH = 200;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 400;

// =============================================================================
// Styles
// =============================================================================

const styles = {
	backdrop: {
		position: 'absolute' as const,
		inset: 0,
		zIndex: 29,
	},
	container: {
		position: 'absolute' as const,
		top: 0,
		right: 0,
		bottom: 0,
		display: 'flex',
		zIndex: 30,
		pointerEvents: 'auto' as const,
	},
	panel: {
		position: 'relative' as const,
		flex: 1,
		display: 'flex',
		flexDirection: 'column' as const,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-widget)',
		color: 'var(--rr-fg-widget)',
		fontFamily: 'var(--rr-font-family-widget)',
		fontSize: 'var(--rr-font-size-widget)',
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		height: '36px',
		padding: '0 8px 0 12px',
		backgroundColor: 'var(--rr-bg-widget-header)',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
	},
	headerTitle: commonStyles.labelUppercase,
	closeButton: {
		background: 'none',
		border: 'none',
		color: 'inherit',
		cursor: 'pointer',
		padding: '4px',
		fontSize: '16px',
		lineHeight: 1,
		opacity: 0.7,
	},
	body: {
		flex: 1,
		display: 'flex',
		flexDirection: 'column' as const,
		overflow: 'hidden',
		padding: '12px',
	},
	scrollArea: {
		flex: 1,
		overflowY: 'auto' as const,
		overflowX: 'hidden' as const,
		minHeight: 0,
		paddingTop: '8px',
	},
	footer: { flexShrink: 0, paddingTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' },
	footerHint: { fontSize: '11px', color: 'var(--rr-text-disabled)', marginRight: 'auto' },
	errorBox: {
		width: '100%',
		padding: '10px 14px',
		marginBottom: '8px',
		fontSize: '12px',
		borderRadius: '4px',
		boxSizing: 'border-box' as const,
		wordBreak: 'break-word' as const,
		overflowWrap: 'anywhere' as const,
		backgroundColor: 'var(--vscode-inputValidation-errorBackground, rgba(244, 67, 54, 0.1))',
		color: 'var(--vscode-inputValidation-errorForeground, #f44336)',
		border: '1px solid var(--vscode-inputValidation-errorBorder, #f44336)',
	},
	resizeHitArea: {
		position: 'absolute' as const,
		left: 0,
		top: 0,
		width: 6,
		height: '100%',
		cursor: 'col-resize',
		zIndex: 11,
	},
	resizeLine: {
		position: 'absolute' as const,
		left: 0,
		top: 0,
		width: 4,
		height: '100%',
		background: 'var(--rr-sash-hover)',
	},
};

// =============================================================================
// Props
// =============================================================================

interface INodeConfigPanelProps {
	/** The node being edited. */
	node: INode;
	/** Close the panel. */
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

export default function NodeConfigPanel({ node, onClose }: INodeConfigPanelProps): ReactElement {
	const formRef = useRef<Form | null>(null);

	// Persist auth tokens across RJSF re-renders (RJSF drops hidden fields)
	const persistedAuthTokens = useRef<IAuthTokensRef>({});

	// --- Context ------------------------------------------------------------
	const { updateNode, onContentUpdated } = useFlowGraph();
	const { servicesJson, handleValidatePipeline, currentProject: _currentProject, googlePickerDeveloperKey, googlePickerClientId, pendingOAuthTokens, clearPendingOAuthTokens, envKeys = [] } = useFlowProject();
	const { getPreference, setPreference, isLocked } = useFlowPreferences();

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

		const enrichedConfig = applyGoogleTokens(node.data.config ?? {}, tokens, state);
		persistTokensFromFormData(enrichedConfig, persistedAuthTokens);
		setFormValues(enrichedConfig);
		persistOAuthTokensAndSave(node.id, enrichedConfig, updateNode, onContentUpdated).catch((err) => console.error('Error persisting OAuth tokens:', err));

		clearPendingOAuthTokens?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingOAuthTokens, node.id]);

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
		[formValues],
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

				// Server-side validation
				if (handleValidatePipeline && updatedNode) {
					const component = getComponentFromNode(updatedNode as INode);
					const payload = {
						version: PIPELINE_SCHEMA_VERSION,
						component,
					} as unknown as IProject;

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

	// --- Resize logic -------------------------------------------------------
	const storedWidth = (getPreference?.('configPanelWidth') as number) ?? DEFAULT_WIDTH;
	const [width, setWidth] = useState(storedWidth);
	const [isResizing, setIsResizing] = useState(false);
	const [handleHover, setHandleHover] = useState(false);
	const resizeStartRef = useRef({ x: 0, width: 0 });

	const onResizeMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			setIsResizing(true);
			resizeStartRef.current = { x: e.clientX, width };
			document.body.style.cursor = 'col-resize';
			document.body.style.userSelect = 'none';
			document.querySelectorAll('iframe').forEach((f) => {
				(f as HTMLIFrameElement).style.pointerEvents = 'none';
			});
		},
		[width]
	);

	useEffect(() => {
		if (!isResizing) return;
		const onMove = (e: MouseEvent) => {
			const delta = resizeStartRef.current.x - e.clientX;
			setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeStartRef.current.width + delta)));
		};
		const onUp = () => {
			setIsResizing(false);
			setPreference?.('configPanelWidth', width);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.querySelectorAll('iframe').forEach((f) => {
				(f as HTMLIFrameElement).style.pointerEvents = '';
			});
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
		document.addEventListener('mouseleave', onUp);
		return () => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.removeEventListener('mouseleave', onUp);
		};
	}, [isResizing, width, setPreference]);

	// --- Render -------------------------------------------------------------

	const title = isAnnotation ? 'Note' : (service?.title ?? node.data.provider);
	const disableSave = !isDirty || isSubmitting || isLocked;

	return (
		<>
			<div style={styles.backdrop} onClick={onClose} />
			<div className="nopan nodrag" style={{ ...styles.container, width: `${width}px` }}>
				{/* Resize handle */}
				<div style={styles.resizeHitArea} onMouseDown={onResizeMouseDown} onMouseEnter={() => setHandleHover(true)} onMouseLeave={() => setHandleHover(false)}>
					{(handleHover || isResizing) && <div style={styles.resizeLine} />}
				</div>

				<div style={styles.panel}>
					{/* Header */}
					<div style={styles.header}>
						<span style={styles.headerTitle}>{title}</span>
						<button style={styles.closeButton} onClick={onClose} title="Close">
							✕
						</button>
					</div>

					{/* Body */}
					<div style={styles.body}>
						<div style={styles.scrollArea}>
							{/* Node name field */}
							{!isAnnotation && (
								<TextField
									label="Node Name"
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										setIsDirty(true);
									}}
									placeholder={service?.title}
									size="small"
									fullWidth
									sx={{ mb: 2 }}
								/>
							)}

							{/* Annotation-specific fields */}
							{isAnnotation && (
								<div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
									<TextField
										label="Content (Markdown)"
										value={annotationContent}
										onChange={(e) => {
											setAnnotationContent(e.target.value);
											setIsDirty(true);
										}}
										placeholder="Enter markdown content..."
										size="small"
										fullWidth
										multiline
										minRows={4}
										maxRows={12}
									/>
									<div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
										<div style={{ flex: 1 }}>
											<label style={{ display: 'block', fontSize: '11px', marginBottom: '4px', opacity: 0.7 }}>Background</label>
											<input
												type="color"
												value={bgColor}
												onChange={(e) => {
													setBgColor(e.target.value);
													setIsDirty(true);
												}}
												style={{ width: '100%', height: 32, border: 'none', cursor: 'pointer', padding: 0 }}
											/>
										</div>
										<div style={{ flex: 1 }}>
											<label style={{ display: 'block', fontSize: '11px', marginBottom: '4px', opacity: 0.7 }}>Text Color</label>
											<input
												type="color"
												value={fgColor}
												onChange={(e) => {
													setFgColor(e.target.value);
													setIsDirty(true);
												}}
												style={{ width: '100%', height: 32, border: 'none', cursor: 'pointer', padding: 0 }}
											/>
										</div>
									</div>
								</div>
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
										hideFor: formValues.parameters?.authType,
										googlePickerDeveloperKey,
										googlePickerClientId,
										nodeId: node.id,
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
						</div>

						{/* Footer */}
						<div style={styles.footer}>
							{validationError && <div style={styles.errorBox}>{validationError}</div>}
							{envKeys.length > 0 && <span style={styles.footerHint}>Type $&#123; in a field to pick from your variables</span>}
							<button
								style={{ ...commonStyles.buttonPrimary, ...(disableSave ? commonStyles.buttonDisabled : {}) }}
								disabled={disableSave}
								onClick={() => {
									if (schema) {
										formRef.current?.submit();
									} else {
										handleSaveDetailsOnly();
									}
								}}
							>
								{isSubmitting ? 'Validating...' : 'Save'}
							</button>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
