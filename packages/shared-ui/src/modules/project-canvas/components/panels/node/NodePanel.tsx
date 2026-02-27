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

import { ReactNode, useRef, useState, useEffect, useMemo } from 'react';
import {
	Accordion,
	AccordionDetails,
	AccordionSummary,
	Box,
	Typography,
	Button,
	TextField,
} from '@mui/material';
import { ExpandMore } from '@mui/icons-material';
import { useReactFlow } from '@xyflow/react';
import validator from '@rjsf/validator-ajv8';
import { isEqual } from 'lodash';

import { RJSFValidationError } from '@rjsf/utils';
import Form from '@rjsf/core';
import { IFormData, ISchema } from '../../../../../services/dynamic-forms/types';

import { useFlow } from '../../../FlowContext';
import { IBasePanelProps } from '../types';
import BasePanel from '../BasePanel';
import BasePanelContent from '../BasePanelContent';
import BasePanelHeader from '../BasePanelHeader';
import ThemedForm, { translate } from '../../../../../components/rjsf-theme/theme';
import { useServiceOAuth } from '../../../../../hooks/useServiceOAuth';
import { useSearchParams } from '../../../../../hooks/useSearchParams';
import UnsavedFormPrompt from '../../UnsavedFormPrompt';
import { useTranslation } from 'react-i18next';
import {
	AuthTokensRef,
	persistTokensFromFormData,
	mergeAuthTokensIntoFormData,
	persistOAuthTokensAndSave,
} from './authTokenHelpers';
import { getSecuredFormData, removeRequired, setUiSchemaProperty } from '../../../../../utils/rjsf';
import { INodeData, IProject, IValidateResponse } from '../../../types';
import { transformNodeToComponent } from '../../../helpers';
import { ActionsType, NodeType, STORAGE_KEY } from '../../../constants';
import { isInVSCode } from '../../../../../utils/vscode';

/**
 * Well-known RJSF form field IDs used to detect specific authentication
 * field changes (e.g. auth type selection) and react accordingly.
 */
// eslint-disable-next-line react-refresh/only-export-components
export enum DynamicFormIds {
	ROOT_PARAMETERS_USER_SECRET = 'root_parameters_userSecret',
	ROOT_PARAMETERS_AUTH_TYPE = 'root_parameters_authType',
}

/**
 * Renders the node configuration side panel on the project canvas.
 * When the user clicks "Edit" on a pipeline node, this panel opens
 * and displays a dynamic RJSF form generated from the node's Pipe schema.
 * Handles form validation, authentication token persistence across
 * re-renders, OAuth callback data application, and server-side pipeline
 * validation on submit.
 *
 * @param onClose - Callback to dismiss the panel.
 */
export default function NodePanel({ onClose }: IBasePanelProps): ReactNode {
	const { t } = useTranslation();
	const formRef = useRef<Form | null>(null);

	// CRITICAL: Use refs to persist authentication tokens across re-renders
	// This prevents tokens from being lost when RJSF drops hidden fields
	const persistedAuthTokens = useRef<AuthTokensRef>({});

	const [searchParams] = useSearchParams();

	const { toObject } = useReactFlow();

	const {
		selectedNode,
		updateNode,
		saveChanges,
		toggleActionsPanel,
		onToolchainUpdated,
		handleValidatePipeline,
		nodeIdsWithErrors,
		nodeIdToRerun,
		setSelectedNode,
		focusOnNode,
		currentProject,
		getPreference,
		setPreference,
		googlePickerDeveloperKey,
		googlePickerClientId,
		servicesJson,
	} = useFlow();

	const nd = selectedNode?.data as INodeData | undefined;
	// Form starts dirty if the node has never been validated (formDataValid is falsy)
	const [isDirty, setIsDirty] = useState(!nd?.formDataValid);

	// User-specified node name and description (separate from the RJSF dynamic form)
	const [name, setName] = useState(nd?.name ?? '');
	const [description, setDescription] = useState(nd?.description ?? '');

	// Annotation-specific state (content, colors)
	const isAnnotation = nd?.type === NodeType.Annotation;
	const [annotationContent, setAnnotationContent] = useState(() =>
		nd?.content ? (nd.content as string).replace(/\\n/g, '\n') : ''
	);
	const [bgColor, setBgColor] = useState((nd?.bgColor as string) || '#fff9c4');
	const [fgColor, setFgColor] = useState((nd?.fgColor as string) || '#000000');

	const [schema, setSchema] = useState<ISchema | undefined>(() => {
		if (!nd?.Pipe) return undefined;
		const pipe = nd.Pipe;
		const hideForm = pipe?.schema?.properties?.hideForm;
		const noProperties =
			pipe?.schema?.properties &&
			Object.keys(pipe?.schema?.properties ?? {}).length === 0;
		if (hideForm || noProperties) return undefined;
		return pipe;
	});
	// Seed form values from the node's persisted formData or an empty object
	const [formValues, setFormValues] = useState(nd?.formData ?? {});

	// Key used to force re-mount of the ThemedForm when the selected node changes
	const [themedFormKey, setThemedFormKey] = useState('');

	// Controls whether the "unsaved changes" confirmation dialog is shown on close
	const [warnUserToSave, setWarnUserToSave] = useState(true);
	const [openDialog, setOpenDialog] = useState(false);

	// Tracks whether a server-side validation request is in-flight
	const [isSubmitting, setIsSubmitting] = useState(false);

	const {
		applyGoogleOAuthCallbackData,
		applyMicrosoftOAuthCallbackData,
		applySlackOAuthCallbackData,
		clearSecureParamsFromUrl,
	} = useServiceOAuth();

	// Save button is disabled when there are no changes or a submit is in-flight (allow save while task is running)
	const disableSave = !isDirty || isSubmitting;

	// TODO: Placeholder for future per-field disable logic
	const disable = false;

	// Holds the error message from the most recent server-side validation attempt
	const [validationError, setValidationError] = useState<string | null>(null);

	/**
	 * Transforms RJSF validation errors to provide user-friendly messages.
	 * Replaces generic "required property" errors for token fields with
	 * an "Authentication required" message.
	 */
	const transformErrors = (errors: RJSFValidationError[]) => {
		return errors.map((error) => {
			// Replace cryptic "required property" messages for auth fields with a friendlier prompt
			if (['accessToken', 'refreshToken', 'userToken'].includes(error.params?.missingProperty ?? ''))
				error.stack = 'Authentication required';
			return error;
		});
	};

	/** Handles RJSF validation errors by updating the node's error state. */
	const onError = (errors: RJSFValidationError[]) => {
		updateNode(selectedNode!.id, {
			formDataErrors: errors,
			formDataValid: false,
		});
	};

	/**
	 * Handles every form change event from RJSF. Merges authentication tokens
	 * back into the form data (since RJSF drops hidden fields), updates dirty
	 * state, and handles special fields like auth type selection.
	 */
	const onChange = async ({ formData }: Partial<{ formData: IFormData }>, id?: string) => {
		// Track dirty state by deep-comparing the current form data against the last saved values
		if (!isEqual(formData, formValues)) setIsDirty(true);
		else setIsDirty(false);

		// CRITICAL: Preserve hidden authentication tokens during form updates
		// RJSF drops hidden fields, so we must merge them back from previous state
		const previousFormData = (selectedNode?.data as INodeData)?.formData || {};
		const mergedFormData = mergeAuthTokensIntoFormData(
			formData ?? {},
			previousFormData,
			persistedAuthTokens
		);

		setFormValues(mergedFormData);

		// When the user changes the auth type, sync the value to URL search params
		// so OAuth redirect flows can restore the correct auth context
		if (id === DynamicFormIds.ROOT_PARAMETERS_AUTH_TYPE) {
			searchParams.set('type', formData?.parameters?.authType);
		}
	};

	/**
	 * Saves only the Details fields (custom name and description) without
	 * triggering RJSF form validation. Used when the node has no configuration
	 * schema and only the Details accordion is rendered.
	 */
	const handleSaveDetailsOnly = () => {
		const updates: Record<string, unknown> = {
			name: name || undefined,
			description: description || undefined,
		};
		if (isAnnotation) {
			updates.content = annotationContent;
			updates.bgColor = bgColor;
			updates.fgColor = fgColor;
		}
		updateNode(selectedNode!.id, updates);
		setIsDirty(false);
		onToolchainUpdated();
		toggleActionsPanel(undefined);
	};

	/**
	 * Handles form submission. Merges auth tokens, updates the node data,
	 * sends the component to the server for validation, and either saves
	 * successfully or displays validation errors/warnings.
	 */
	const onSubmit = async ({ formData }: Partial<{ formData: IFormData }>) => {
		setIsSubmitting(true);
		try {
			// Reset previous validation error before a new attempt
			setValidationError(null);
			setFormValues(formData ?? {});

			// CRITICAL: Preserve hidden parameters (like userToken) that RJSF drops
			// These are authentication credentials that must persist across form updates
			const previousFormData = (selectedNode?.data as INodeData)?.formData || {};
			const mergedFormData = mergeAuthTokensIntoFormData(
				formData ?? {},
				previousFormData,
				persistedAuthTokens
			);

			// Persist the merged form data and name/description to the node
			const updatedNode = updateNode(selectedNode!.id, {
				formData: mergedFormData,
				formDataErrors: undefined,
				formDataValid: true,
				name: name || undefined,
				description: description || undefined,
			});

			// Convert the node into the component payload format expected by the server
			const flowObject = toObject();
			const componentProperty = transformNodeToComponent(flowObject, updatedNode!);

			const payload: Record<string, unknown> = {
				version: currentProject?.version,
				component: componentProperty,
			};

			// Send the component to the server for validation (e.g. credential check, schema check)
			const resp: IValidateResponse = await handleValidatePipeline!(payload as IProject);

			// Handle top-level server errors
			if (resp?.error) {
				throw new Error(
					`${t('flow.notification.validationError')}: ${resp?.error?.message || ''}`
				);
			}

			// Handle field-level validation errors returned by the server
			if ((resp?.data?.errors ?? []).length > 0) {
				let fullValidationError = '';
				resp.data!.errors!.forEach((error: { message?: string }) => {
					fullValidationError += `${error.message} `;
				});
				throw new Error(
					`${t('flow.notification.validationError')}: ${fullValidationError}`
				);
			}

			// Treat warnings as errors to surface them to the user before proceeding
			if ((resp?.data?.warnings ?? []).length > 0) {
				let fullValidationWarning = '';
				resp.data!.warnings!.forEach((warning: { message?: string }) => {
					fullValidationWarning += `${warning.message} `;
				});
				throw new Error(
					`${t('flow.notification.validationWarning')}: ${fullValidationWarning}`
				);
			}

			// Validation passed -- mark the form as clean and close the panel
			setIsDirty(false);
			clearSecureParamsFromUrl();
			onToolchainUpdated();
			toggleActionsPanel(undefined);

			// If multiple nodes have errors, auto-navigate to the next one after saving
			if (nodeIdsWithErrors.length > 1) {
				const currentIndex = nodeIdsWithErrors.findIndex((id: string) => id === selectedNode!.id);
				if (currentIndex < nodeIdsWithErrors.length - 1) {
					// Move to the next node with errors so the user can fix them sequentially
					const nextNode = nodeIdsWithErrors[currentIndex + 1];
					toggleActionsPanel(ActionsType.Node);
					setIsDirty(false);
					setValidationError(null);
					setSelectedNode(nextNode);
					focusOnNode(nextNode);
				} else if (nodeIdToRerun) {
					// All error nodes resolved; focus on the node that triggered the re-run
					focusOnNode(nodeIdToRerun);
				}
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			setValidationError(msg || 'Validation failed.');
		} finally {
			setIsSubmitting(false);
		}
	};

	/**
	 * Attempts to apply OAuth callback data from URL parameters into the form data.
	 * Sequentially tries Google, Microsoft, and Slack OAuth helpers.
	 */
	const tryApplyOAuthData = (formData: Record<string, unknown>): Record<string, unknown> => {
		// Sequentially apply each provider's OAuth callback handler.
		// Each function checks URL params for its provider-specific tokens
		// and merges them into the form data if found.
		const formData1 = applyGoogleOAuthCallbackData(formData as Record<string, unknown>);
		const formData2 = applyMicrosoftOAuthCallbackData(formData1);
		const _formData = applySlackOAuthCallbackData(formData2);
		return _formData;
	};

	// Initialization effect: runs when the selected node or URL params change
	useEffect(() => {
		if (!selectedNode) return;
		const _nd = selectedNode?.data as INodeData;

		// Sync name/description state when switching between nodes
		setName(_nd?.name ?? '');
		setDescription(_nd?.description ?? '');

		// Sync annotation-specific state
		if (_nd?.type === NodeType.Annotation) {
			setAnnotationContent(_nd?.content ? (_nd.content as string).replace(/\\n/g, '\n') : '');
			setBgColor((_nd?.bgColor as string) || '#fff9c4');
			setFgColor((_nd?.fgColor as string) || '#000000');
		}

		if (!_nd?.Pipe) return;

		// Auto-save when the panel opens for a newly created project
		if (window.location.pathname.includes('/projects/new')) saveChanges();

		let schema: ISchema | undefined = _nd.Pipe;
		const formData = _nd?.formData ?? {};

		// Suppress the form entirely when hideForm is set or the schema has no editable properties
		const hideForm = schema?.schema?.properties?.hideForm;
		const noProperties =
			schema?.schema?.properties &&
			Object.keys(schema?.schema?.properties ?? {}).length === 0;
		if (hideForm || noProperties) schema = undefined;

		// Attempt to merge any OAuth callback tokens from the URL into the form data
		const _formData = tryApplyOAuthData(formData);

		// CRITICAL: Also persist tokens from existing formData to the ref
		// This ensures tokens survive RJSF updates
		persistTokensFromFormData(_formData, persistedAuthTokens);

		setSchema(schema);
		setFormValues(_formData);

		// Detect whether OAuth tokens are present in the URL query string
		const hasOAuthTokens = window.location.search.includes('tokens=');

		if (hasOAuthTokens) {
			// When tokens are in the URL, persist them to the node and trigger a save
			// so the tokens are stored server-side before the URL is cleaned up
			persistOAuthTokensAndSave(selectedNode!.id, _formData, updateNode, saveChanges).catch(
				(error) => {
					console.error('Error persisting OAuth tokens:', error);
				}
			);
		} else {
			// No OAuth tokens -- just update the node's in-memory form data
			updateNode(selectedNode!.id, { formData: _formData });
		}

		// Clean sensitive token data from the URL after a brief delay to let
		// other components (e.g. OAuth hooks) read the params first
		requestAnimationFrame(() => {
			clearSecureParamsFromUrl();
		});
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedNode?.id, window.location.search]);

	// Auto-focus the first visible input when the form is rendered or the selected node changes
	useEffect(() => {
		if (formRef.current) {
			if (!formRef.current?.formElement?.current?.querySelector) {
				return;
			}
			// Find the first visible, interactive input element, skipping hidden inputs
			// and combobox roles (which have their own focus management)
			const firstInput = formRef.current.formElement.current.querySelector(
				'input:not([type="hidden"], [role="combobox"], textarea'
			);

			firstInput?.focus();
		}
	}, [themedFormKey]);

	// Update the form key whenever form values or the selected node change,
	// forcing RJSF to re-mount with fresh data rather than stale internal state
	useEffect(() => {
		setThemedFormKey(selectedNode?.id ?? '');

	}, [formValues, selectedNode?.id]);

	useEffect(() => {
		/**
		 * Read NODE_PANEL_SHOW_UNSAVED_PROMPT from preferences or local storage
		 * If it doesn't exist, set it
		 * If it's set to false, set our local state to `false`
		 *
		 * By default the state's value is `true`
		 */
		const key = STORAGE_KEY.NODE_PANEL_SHOW_UNSAVED_PROMPT;
		const warnUserValue = getPreference
			? (getPreference(key) as string | null)
			: localStorage.getItem(key);

		if (!warnUserValue) {
			if (setPreference) setPreference(key, 'true');
			else localStorage.setItem(key, 'true');
		}

		if (warnUserValue === 'false') {
			setWarnUserToSave(false);
		}
	}, [warnUserToSave, getPreference, setPreference]);

	// Identify fields that contain encrypted/secured values (e.g. "***" placeholders)
	// so we can adjust schema constraints and UI rendering accordingly
	const securedFormData: [string[], string[]][] = getSecuredFormData(formValues);

	// Remove `required` constraints for already-secured fields so the user is not
	// forced to re-enter credentials that are stored server-side as encrypted blobs
	const _schema = useMemo(
		() => removeRequired(schema?.schema, securedFormData),
		[schema?.schema, securedFormData]
	);

	// Apply `ui:encrypted` flags to secured fields so RJSF widgets render
	// them with masked inputs and appropriate "already configured" indicators
	const _uiSchema = useMemo(
		() =>
			setUiSchemaProperty(schema?.ui, securedFormData, {
				'ui:encrypted': true,
			}),
		[schema?.ui, securedFormData]
	);

	if (!selectedNode) return null;

	const outlinedAccordionSx = {
		border: '1px solid',
		borderColor: 'divider',
		borderRadius: '8px !important',
		boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
		'&::before': { display: 'none' },
		'&:not(:last-child)': { mb: '1rem' },
		'& .MuiAccordionSummary-root': { minHeight: 36, py: 0 },
		'& .MuiAccordionSummary-content': { my: '6px' },
	};

	const nodeData = selectedNode.data as INodeData;
	const isAnnotationNode = nodeData.type === NodeType.Annotation;

	// Look up service catalog title and description from the provider
	const serviceInfo = (servicesJson as Record<string, { title?: string; description?: string }> | undefined)?.[nodeData.provider as string];

	return (
		<>
			<BasePanel resizable defaultWidth={400} minWidth={200} maxWidth={800}>
				{/* 1. Header — always shows the service/provider name (or "Note" for annotations) */}
				<BasePanelHeader
					title={isAnnotationNode ? 'Note' : (serviceInfo?.title || nodeData.provider) as string}
					icon={!isAnnotationNode ? (
						<Box
							component="img"
							sx={{
								height: '70%',
								objectFit: 'cover',
								mr: '1rem',
							}}
							src={nodeData.icon}
						/>
					) : undefined}
					description={!isAnnotationNode ? (nodeData.description || serviceInfo?.description) as string : undefined}
					documentation={nodeData.documentation}
					onClose={() => {
						if (warnUserToSave && isDirty) {
							return setOpenDialog(true);
						}
						onClose();
					}}
				/>
				<BasePanelContent sx={{
					display: 'flex',
					flexDirection: 'column',
					p: '1rem',
					pt: '8px',
				}}>
					{/* 2 & 3. Scrollable area: Details + Configuration scroll together */}
					<Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, px: '6px', pb: '6px', pr: '12px' }}>
						{/* 2. Details panel — expand by default when there is no Configuration panel */}
						<Accordion defaultExpanded={!schema} sx={outlinedAccordionSx}>
							<AccordionSummary expandIcon={<ExpandMore />}>
								<Typography variant="subtitle2">
									{t('flow.panels.node.details', 'Details')}
								</Typography>
							</AccordionSummary>
							<AccordionDetails>
								<Box sx={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
									{!isAnnotationNode && (
										<>
											<TextField
												label={t('flow.panels.node.nodeName', 'Node Name')}
												value={name}
												onChange={(e) => {
													setName(e.target.value);
													setIsDirty(true);
												}}
												placeholder={serviceInfo?.title}
												size="small"
												fullWidth
											/>
											<TextField
												label={t('flow.panels.node.description', 'Description')}
												value={description}
												onChange={(e) => {
													setDescription(e.target.value);
													setIsDirty(true);
												}}
												placeholder={serviceInfo?.description}
												size="small"
												fullWidth
												multiline
												minRows={2}
												maxRows={4}
											/>
										</>
									)}
									{isAnnotationNode && (
										<>
											<TextField
												label={t('flow.panels.node.content', 'Content (Markdown)')}
												value={annotationContent}
												onChange={(e) => {
													setAnnotationContent(e.target.value);
													setIsDirty(true);
												}}
												placeholder={t('flow.panels.node.contentPlaceholder', 'Enter markdown content...')}
												size="small"
												fullWidth
												multiline
												minRows={4}
												maxRows={12}
											/>
											<Box sx={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
												<Box sx={{ flex: 1 }}>
													<Typography variant="caption">
														{t('flow.panels.node.bgColor', 'Background')}
													</Typography>
													<input
														type="color"
														value={bgColor}
														onChange={(e) => {
															setBgColor(e.target.value);
															setIsDirty(true);
														}}
														style={{ width: '100%', height: 32, border: 'none', cursor: 'pointer', padding: 0 }}
													/>
												</Box>
												<Box sx={{ flex: 1 }}>
													<Typography variant="caption">
														{t('flow.panels.node.fgColor', 'Text Color')}
													</Typography>
													<input
														type="color"
														value={fgColor}
														onChange={(e) => {
															setFgColor(e.target.value);
															setIsDirty(true);
														}}
														style={{ width: '100%', height: 32, border: 'none', cursor: 'pointer', padding: 0 }}
													/>
												</Box>
											</Box>
										</>
									)}
								</Box>
							</AccordionDetails>
						</Accordion>

						{/* 3. Configuration panel (RJSF form) */}
						{schema && (
							<Accordion defaultExpanded sx={outlinedAccordionSx}>
								<AccordionSummary expandIcon={<ExpandMore />}>
									<Typography variant="subtitle2">
										{t('flow.panels.node.configuration', 'Configuration')}
									</Typography>
								</AccordionSummary>
								<AccordionDetails sx={{ overflowX: 'hidden' }}>
								<Box sx={{ ml: '-10px' }}>
									<ThemedForm
										key={themedFormKey}
										ref={formRef}
										schema={_schema}
										uiSchema={{
											..._uiSchema,
											'ui:options': {
												...(typeof (_uiSchema ?? {})['ui:options'] === 'object' &&
												(_uiSchema ?? {})['ui:options']
													? (_uiSchema ?? {})['ui:options']
													: {}),
												hideRootTitle: true,
											},
											'ui:submitButtonOptions': {
												norender: true,
											},
										}}
										formData={formValues}
										formContext={{
											formValues,
											hideFor: formValues.parameters?.authType,
											googlePickerDeveloperKey,
											googlePickerClientId,
										}}
										disabled={disable}
										validator={validator}
										transformErrors={transformErrors}
										onError={onError}
										onSubmit={onSubmit}
										onChange={onChange}
										translateString={translate}
									/>
								</Box>
								</AccordionDetails>
							</Accordion>
						)}
					</Box>

					{/* 4. Fixed bottom: validation error + Save button */}
					{validationError && (
						<Typography color="error" sx={{ mt: 1, mb: 1 }}>
							{validationError}
						</Typography>
					)}
					<Button
						fullWidth
						variant="contained"
						disabled={disableSave}
						onClick={() => {
							if (schema) {
								formRef?.current?.submit();
							} else {
								handleSaveDetailsOnly();
							}
						}}
						sx={{
							mt: 1,
							flexShrink: 0,
							...(isInVSCode() && {
								backgroundColor: 'var(--vscode-button-background)',
								color: 'var(--vscode-button-foreground)',
								'&:hover': {
									backgroundColor: 'var(--vscode-button-hoverBackground)',
								},
							}),
						}}
					>
						{isSubmitting
							? t('flow.panels.node.validating')
							: t('flow.panels.node.saveChanges')}
					</Button>
				</BasePanelContent>
			</BasePanel>
			{warnUserToSave && (
				<UnsavedFormPrompt
					isOpen={openDialog}
					onClose={() => setOpenDialog(false)}
					onCheck={() => {
						const key = STORAGE_KEY.NODE_PANEL_SHOW_UNSAVED_PROMPT;
						if (setPreference) setPreference(key, 'false');
						else localStorage.setItem(key, 'false');
						setWarnUserToSave(false);
					}}
					onAccept={() => {
						setIsDirty(false);
						toggleActionsPanel(undefined);
					}}
				/>
			)}
		</>
	);
}
