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
 *   2. **Configuration** — the shared NodeConfigForm over the service's
 *      resolved `properties` (plan §5.6.5): ghost defaults, selector
 *      recursion, inline descriptor validation, the expose chip.
 *
 * This panel OWNS the pipeline's `parameters` map on behalf of the form (plan
 * §5.5): the chip's naming popup writes `publicName → nodeId.path` through the
 * graph context, and the map rides the project document.
 *
 * On save:
 *   1. The form validates with the server's rules; a failure stays in the form.
 *   2. The config is written to the node and validated server-side
 *      (single-component payload).
 *   3. On success, the host is notified and the panel closes.
 *
 * OAuth grants arrive out-of-band (page URL on the web, `pendingOAuthTokens`
 * in VS Code) and are written to the node's `oauth2` leaf by PATH.
 */

import { ReactElement, useRef, useState, useEffect, useMemo, useCallback, CSSProperties } from 'react';

import { IService, IServiceCatalog, IValidatePipelinePayload, PIPELINE_SCHEMA_VERSION } from '../../types';
import { Icon } from '../../util/Icon';

import { useFlowGraph } from '../../context/FlowGraphContext';
import type { FlowNode } from '../../context/FlowGraphContext';
import { useFlowProject } from '../../context/FlowProjectContext';
import { useFlowPreferences } from '../../context/FlowPreferencesContext';
import { getComponentFromNode } from '../../util/graph';

import { applyGrantToConfig, buildGoogleGrant, nodeIdFromState, useOAuthCallbacks } from './useOAuthCallbacks';
import NodeConfigForm, { OAuthEnvProvider, constantMarkers, hasConfigurableSchema, validateConfig, validationProblemFromResponse } from 'shared/components/node-config';
import type { IConfigProblem, IConfigTree, INodeConfigExposure, INodeConfigFormHandle, INodeSchema } from 'shared/components/node-config';
import { Banner, Button, ConfirmDialog, DetailPanel, commonStyles } from 'shell';

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

	// "Loading configuration…" while the full definition is fetched.
	loading: {
		...commonStyles.textMuted,
		padding: '12px 0',
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
	const formRef = useRef<INodeConfigFormHandle | null>(null);

	// --- Context ------------------------------------------------------------
	const { nodes, updateNode, onContentUpdated, parameters, setParameters } = useFlowGraph();
	const { servicesJson, requestNodeSchema, handleValidatePipeline, pendingOAuthTokens, clearPendingOAuthTokens, envKeys = [], oauth2RootUrl, oauthReturnUrl, onOpenExternal, onOpenLink } = useFlowProject();

	// The OAuth environment the form's consent-flow widgets consume — the
	// canvas bridges its project context into the form's minimal contract.
	const oauthEnv = useMemo(() => ({ oauth2RootUrl: oauth2RootUrl ?? '', oauthReturnUrl: oauthReturnUrl ?? '', ...(onOpenExternal ? { onOpenExternal } : {}), ...(onOpenLink ? { onOpenLink } : {}) }), [oauth2RootUrl, oauthReturnUrl, onOpenExternal, onOpenLink]);
	// The drawer width rides the shared PrefsContext (provided by the canvas) via
	// DetailPanel's persistKey — the same workspace store, no per-panel adapter.
	const { isLocked } = useFlowPreferences();

	// --- Annotation detection -----------------------------------------------
	const isAnnotation = node.data.provider === 'annotation';

	// --- Service lookup -----------------------------------------------------
	const service: IService | undefined = (servicesJson as IServiceCatalog)?.[node.data.provider];

	// --- OAuth callback helpers (context-free) ------------------------------
	const { readGrantFromUrl, clearSecureParamsFromUrl } = useOAuthCallbacks();

	// --- Schema from the service catalog ------------------------------------
	// The bulk catalog is summary-only: request the full definition and render
	// the form once `properties` lands. A definition with nothing to edit
	// renders no form at all.
	const schema = useMemo((): INodeSchema | undefined => {
		if (isAnnotation || !service?.properties) return undefined;
		if (!hasConfigurableSchema(service)) return undefined;
		return { properties: service.properties, params: service.params };
	}, [service, isAnnotation]);
	const schemaPending = !isAnnotation && Boolean(service) && !service?.properties;
	useEffect(() => {
		if (schemaPending) requestNodeSchema(node.data.provider);
	}, [schemaPending, node.data.provider, requestNodeSchema]);

	// --- Form state ---------------------------------------------------------
	const [name, setName] = useState(node.data.name ?? '');
	const [config, setConfig] = useState<IConfigTree>(node.data.config ?? {});
	// The latest local config for the asynchronous OAuth callbacks: a grant
	// lands on top of edits made while the sign-in was pending, never under them
	const configRef = useRef(config);
	configRef.current = config;
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

	// --- Persist an OAuth grant to the node and notify the host -------------
	// The grant is written straight to the node (no Save step: the user just
	// came back from the broker) and its validity recomputed, so a node that
	// was red only for the missing grant clears. The local form gets the same
	// grant over its unsaved edits, which stay unsaved. onContentUpdated runs
	// after React has flushed the node update so the serializer snapshots it.
	const persistGrant = useCallback(
		(apply: (config: IConfigTree) => IConfigTree) => {
			const persisted = apply(node.data.config ?? {});
			const problems = schema ? validateConfig(schema, persisted) : [];
			setConfig(apply(configRef.current));
			updateNode(node.id, { config: persisted, formDataErrors: problems.length > 0 ? problems : undefined, formDataValid: problems.length === 0 });
			queueMicrotask(() => requestAnimationFrame(() => onContentUpdated()));
		},
		[node.id, node.data.config, schema, updateNode, onContentUpdated]
	);

	// --- Initialise state when a different node is selected -----------------
	useEffect(() => {
		const stored = node.data.config ?? {};
		setName(node.data.name ?? '');
		setConfig(stored);
		setIsDirty(false);
		setValidationError(null);

		// Sync annotation-specific state
		if (node.data.provider === 'annotation') {
			const raw = (stored.content ?? '') as string;
			setAnnotationContent(raw.replace(/\\n/g, '\n'));
			setBgColor((stored.bgColor as string) || 'var(--rr-annotation-bg-default)');
			setFgColor((stored.fgColor as string) || 'var(--rr-text-primary)');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [node.id]);

	// --- Apply a grant returned in the page URL (web hosts) ------------------
	// Needs the schema (the grant is written by the oauth2 leaf's path), so it
	// waits for the full definition when the panel opened on a summary.
	const urlGrantApplied = useRef(false);
	useEffect(() => {
		if (urlGrantApplied.current || !schema) return;
		const grant = readGrantFromUrl();
		if (!grant) return;
		// A grant the broker addressed to another node stays in the URL for
		// that node's panel; malformed or absent state falls through to this one
		if (grant.nodeId && grant.nodeId !== node.id) return;
		// updateNode silently no-ops on a locked graph: keep the grant in the
		// URL and say so; unlocking re-runs this effect and applies it
		if (isLocked) {
			setValidationError('The canvas is locked. Unlock it to apply the sign-in tokens.');
			return;
		}
		setValidationError(null);
		urlGrantApplied.current = true;
		persistGrant((current) => applyGrantToConfig(schema, current, grant));
		// Strip the token-bearing query string once processed
		requestAnimationFrame(() => clearSecureParamsFromUrl());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [schema, node.id, isLocked]);

	// --- Apply a grant delivered out-of-band by the host (VS Code) ----------
	// Web hosts return tokens in the page URL (handled above); VS Code can't
	// receive a web redirect, so the host intercepts the broker's deep link and
	// pushes the tokens down via `pendingOAuthTokens`. Apply them to the node
	// that started the login, then clear so they aren't re-applied.
	useEffect(() => {
		if (!pendingOAuthTokens || !schema) return;
		const { tokens, state } = pendingOAuthTokens;

		// Brokers echo the originating node_id in `state`; ignore tokens meant
		// for another node. Malformed state falls through to the open panel.
		const targetNodeId = nodeIdFromState(state);
		if (targetNodeId && targetNodeId !== node.id) return;

		// updateNode silently no-ops on a locked graph — surface it and keep
		// the tokens pending; unlocking re-runs this effect and applies them.
		if (isLocked) {
			setValidationError('The canvas is locked. Unlock it to apply the sign-in tokens.');
			return;
		}
		setValidationError(null);

		const grant = buildGoogleGrant(tokens, state, oauth2RootUrl ?? '');
		if (grant) persistGrant((current) => applyGrantToConfig(schema, current, grant));
		clearPendingOAuthTokens?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingOAuthTokens, node.id, isLocked, schema]);

	// --- Form change handler --------------------------------------------------
	const onChange = useCallback((next: IConfigTree) => {
		setConfig(next);
		setIsDirty(true);
	}, []);

	// --- Form error handler ----------------------------------------------------
	const onError = useCallback(
		(problems: IConfigProblem[]) => {
			updateNode(node.id, { formDataErrors: problems, formDataValid: false });
			setValidationError(problems.length === 1 ? 'One field needs attention.' : `${problems.length} fields need attention.`);
		},
		[node.id, updateNode]
	);

	// --- Expose chip: this panel owns the parameters map (plan §5.5) -----------
	const exposure = useMemo((): INodeConfigExposure | undefined => {
		if (isAnnotation) return undefined;
		const catalog = servicesJson as IServiceCatalog;
		return {
			nodeId: node.id,
			nodeTitle: name || service?.title || node.data.provider,
			parameters,
			onExpose: (path, publicName) => {
				const target = `${node.id}.${path}`;
				// One name per target: drop the previous name of this target, then bind
				const next = Object.fromEntries(Object.entries(parameters).filter(([, candidate]) => candidate !== target));
				next[publicName] = target;
				setParameters(next);
				onContentUpdated();
			},
			onUnexpose: (path) => {
				const target = `${node.id}.${path}`;
				setParameters(Object.fromEntries(Object.entries(parameters).filter(([, candidate]) => candidate !== target)));
				onContentUpdated();
			},
			describeTarget: (target) => {
				const [targetNodeId, ...rest] = target.split('.');
				const owner = nodes.find((candidate) => candidate.id === targetNodeId);
				const ownerTitle = owner?.data.name || catalog?.[owner?.data.provider ?? '']?.title || targetNodeId;
				return `${ownerTitle} · ${rest.join('.')}`;
			},
		};
	}, [isAnnotation, node.id, node.data.provider, name, service, parameters, setParameters, onContentUpdated, nodes, servicesJson]);

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
		async (submitted: IConfigTree) => {
			setIsSubmitting(true);
			try {
				setValidationError(null);

				// The root constant markers (`mode: Source`) ride beneath the
				// submitted config: a panel opened before the full definition
				// arrived started from a config without them
				const next = schema ? { ...constantMarkers(schema), ...submitted } : submitted;

				// Write to node
				const updatedNode = updateNode(node.id, {
					config: next,
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
					const problem = validationProblemFromResponse(resp);
					if (problem) throw new Error(problem);
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
		[node.id, name, schema, updateNode, handleValidatePipeline, clearSecureParamsFromUrl, onContentUpdated, onClose]
	);

	// --- Save / Cancel routing ----------------------------------------------

	/** Footer [Save]: submit the form when there is a schema, else write details. */
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
				avatar={!isAnnotation && service?.icon ? <div style={styles.avatar}><Icon name={service.icon} width={22} height={22} style={styles.avatarIcon} /></div> : undefined}
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

				{/* The full definition is still on its way from the host. */}
				{schemaPending && <div style={styles.loading}>Loading configuration…</div>}

				{/* Configuration form — the context-free core (also embeddable by
				    other apps, e.g. sql-ui's connection editor). The OAuth env
				    provider is the form's ONE host coupling: this panel feeds it
				    from the flow project context so the consent-flow widgets
				    work on the canvas. */}
				{schema && (
					<OAuthEnvProvider value={oauthEnv}>
						<NodeConfigForm
							key={node.id}
							ref={formRef}
							schema={schema}
							config={config}
							onChange={onChange}
							onSubmit={(next) => { void onSubmit(next); }}
							onError={onError}
							envKeys={envKeys}
							disabled={isSubmitting || isLocked}
							provider={node.data.provider}
							nodeId={node.id}
							nodeName={name || undefined}
							exposure={exposure}
						/>
					</OAuthEnvProvider>
				)}
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
