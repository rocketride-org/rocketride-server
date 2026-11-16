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
 * NodeConfigForm — the form handler for a node's configuration, one recursive
 * `render(properties, config)` over three primitives (plan §5.6.5):
 *
 *   display = get(config, path) ?? default   (a ghost while nothing is stored)
 *   change  = set(config, path, value)        (ONE key; a branch switch is a set)
 *   reset   = delete(config, path)            (the ghost default returns)
 *
 * For a selector it picks `enum[stored ?? default]` and recurses into that
 * branch's properties with the SAME config, so nesting is recursion and
 * `path` already encodes depth. No defaults are materialized, no clearing
 * logic, no shape reconciliation, no per-node knowledge.
 *
 * Form-owned edge cases: a stored selector value with no branch (renamed in a
 * later node version) is an ERROR STATE showing the stale value with reset,
 * never a silent fallback; inline validation comes from the leaf descriptor
 * through the same rules the server runs (validate.ts). `name` stays
 * editor-owned (the container renders it). Flags drive affordances only:
 * `secret` masks, `env` autocompletes, `readonly` disables, `hidden` skips,
 * and a property present in `params` shows the expose chip (plan §5.5).
 *
 * The form is context-free: everything arrives through props and the
 * CONTAINER owns the config, dirty tracking, what Save does, and — for the
 * expose chip — the pipeline's `parameters` map. Hosts without OAuth flows
 * mount it without an OAuthEnvProvider and the login buttons render disabled.
 */

import { CSSProperties, ReactNode, forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ServiceParamDescriptor, ServiceProperty } from 'rocketride';
import { Button, commonStyles } from 'shell';

import { IConfigTree, INodeSchema, clearSecure, deleteAtPath, dottedNames, effectiveValue, enumOptions, getAtPath, isFlagged, isGroup, isStoredSecurely, leafKind, paramDescriptor, selectorBranches, setAtPath } from './model';
import { IConfigProblem, validateConfig } from './validate';
import ArrayWidget from './widgets/ArrayWidget';
import BooleanWidget from './widgets/BooleanWidget';
import EnumWidget from './widgets/EnumWidget';
import ExposeNameDialog from './widgets/ExposeNameDialog';
import OAuthWidget, { oauthProviderOf } from './widgets/OAuthWidget';
import PropertyField from './widgets/PropertyField';
import TextWidget from './widgets/TextWidget';
import UploadWidget from './widgets/UploadWidget';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	// A grouped subsection.
	group: {
		marginBottom: 14,
	} as CSSProperties,

	groupTitle: {
		...commonStyles.sectionHeaderLabel,
		marginBottom: 8,
	} as CSSProperties,

	groupBody: {
		paddingLeft: 10,
		borderLeft: '2px solid var(--rr-border)',
	} as CSSProperties,

	// A selector's branch properties, indented under the selector.
	branch: {
		paddingLeft: 10,
		borderLeft: '2px solid var(--rr-border)',
		marginBottom: 14,
	} as CSSProperties,

	// Stale-selector error state (the file holds a value with no branch).
	stale: {
		...commonStyles.textMuted,
		color: 'var(--rr-color-error)',
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginTop: 4,
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

/** Imperative handle — the container's Save button drives the submit. */
export interface INodeConfigFormHandle {
	/** Validates; on success calls `onSubmit`, else `onError`. Returns whether it passed. */
	submit(): boolean;
}

/** The expose-chip contract the container (owner of the `parameters` map) provides. */
export interface INodeConfigExposure {
	/** The canvas node id — targets in the map are `nodeId.path`. */
	nodeId: string;
	/** The node's display title (dialog subtitle). */
	nodeTitle: string;
	/** The pipeline's current `parameters` map (public name → `nodeId.path`). */
	parameters: Record<string, string>;
	/** Exposes (or renames) a property under `name`. */
	onExpose: (path: string, name: string) => void;
	/** Removes a property's exposure. */
	onUnexpose: (path: string) => void;
	/** Renders a target for the collision message ("Depth Estimation · max_edge"). */
	describeTarget: (target: string) => string;
}

/** Props for {@link NodeConfigForm}. */
export interface INodeConfigFormProps {
	/** The service's resolved schema (`properties` with paths, `params`). */
	schema: INodeSchema;
	/** The node's stored config — the container owns it. */
	config: IConfigTree;
	/** Fired with the new config on every edit. */
	onChange: (config: IConfigTree) => void;
	/** Fired with the config when a submit passes validation. */
	onSubmit: (config: IConfigTree) => void;
	/** Fired with the problems on a failed submit. Optional. */
	onError?: (problems: IConfigProblem[]) => void;
	/** Env-var names for the `${}` autocomplete (and the hint line). Optional. */
	envKeys?: string[];
	/** Disables every field (e.g. while the container saves). Optional. */
	disabled?: boolean;
	/** The node's logical type (OAuth scope lookup). Optional. */
	provider?: string;
	/** The canvas node id (OAuth state round-trips, element ids). Optional. */
	nodeId?: string;
	/** The node's display name (sent on the OAuth redirect). Optional. */
	nodeName?: string;
	/** Expose-chip support; absent → no chips (hosts without a parameters map). Optional. */
	exposure?: INodeConfigExposure;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the node configuration form.
 *
 * @param props - {@link INodeConfigFormProps}.
 * @returns The form element.
 */
const NodeConfigForm = forwardRef<INodeConfigFormHandle, INodeConfigFormProps>(function NodeConfigForm({ schema, config, onChange, onSubmit, onError, envKeys = [], disabled = false, provider, nodeId, nodeName, exposure }, ref) {
	// Required-empty messages stay quiet until the leaf was touched or a submit
	// was attempted; every other problem (type, enum, bounds, stale selector)
	// shows at once.
	const [touched, setTouched] = useState<Set<string>>(() => new Set());
	const [submitted, setSubmitted] = useState(false);
	const [exposingPath, setExposingPath] = useState<string | null>(null);

	const problems = useMemo(() => validateConfig(schema, config), [schema, config]);
	const problemAt = useMemo(() => new Map(problems.map((problem) => [problem.path, problem.message])), [problems]);
	// Declared names holding a dot ("gpt-5.2") segment as one key
	const dotted = useMemo(() => dottedNames(schema.properties), [schema.properties]);

	// Edits apply to the LATEST config, not the one a callback closed over: an
	// upload finishing after another field changed must not undo that change.
	const configRef = useRef(config);
	configRef.current = config;

	useImperativeHandle(
		ref,
		() => ({
			submit: () => {
				setSubmitted(true);
				if (problems.length > 0) {
					onError?.(problems);
					return false;
				}
				onSubmit(config);
				return true;
			},
		}),
		[problems, config, onSubmit, onError]
	);

	// --- The three primitives ----------------------------------------------
	const set = useCallback(
		(path: string, value: unknown) => {
			setTouched((prev) => new Set(prev).add(path));
			const next = value === undefined ? deleteAtPath(configRef.current, path, dotted) : setAtPath(configRef.current, path, value, dotted);
			configRef.current = next;
			onChange(next);
		},
		[onChange, dotted]
	);
	// Reset is credential-aware: a value held in the engine's encrypted section
	// is cleared there too, else it would be restored on the next load.
	const reset = useCallback(
		(path: string) => {
			setTouched((prev) => new Set(prev).add(path));
			const next = clearSecure(configRef.current, path, dotted);
			configRef.current = next;
			onChange(next);
		},
		[onChange, dotted]
	);

	/** The inline message for a leaf, honouring the touched / submitted rule. */
	const messageFor = (path: string): string | null => {
		const message = problemAt.get(path);
		if (!message) return null;
		if (message === 'is required' && !touched.has(path) && !submitted) return null;
		return message;
	};

	/** The expose-chip state of a leaf, when it is a `param` and the host owns a map. */
	const exposeFor = (path: string): { publicName?: string; onClick: () => void } | undefined => {
		if (!exposure || !paramDescriptor(schema, path)) return undefined;
		const target = `${exposure.nodeId}.${path}`;
		const publicName = Object.entries(exposure.parameters).find(([, candidate]) => candidate === target)?.[0];
		return { publicName, onClick: () => setExposingPath(path) };
	};

	const elementId = (path: string): string => `rr-cfg-${nodeId ?? 'node'}-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`;

	// =====================================================================
	// render(properties, config) — the recursion
	// =====================================================================

	const render = (properties: ServiceProperty[] | undefined, keyPrefix: string): ReactNode[] => {
		const out: ReactNode[] = [];
		for (const [index, property] of (properties ?? []).entries()) {
			if (!property || typeof property !== 'object') continue;
			if (isFlagged(property, 'hidden')) continue;
			const key = `${keyPrefix}/${typeof property.path === 'string' ? property.path : (property.name ?? index)}`;

			// A grouped subsection: no value of its own, children carry the paths
			if (isGroup(property)) {
				const children = render(property.properties as ServiceProperty[], key);
				if (children.length === 0) continue;
				out.push(
					<div key={key} style={styles.group}>
						{property.title ? <div style={styles.groupTitle}>{String(property.title)}</div> : null}
						<div style={styles.groupBody}>{children}</div>
					</div>
				);
				continue;
			}

			const path = typeof property.path === 'string' ? property.path : '';
			if (!path) continue;
			const kind = leafKind(property);
			if (kind === 'constant' || kind === 'other') continue;

			const stored = getAtPath(config, path, dotted);
			const value = effectiveValue(config, property, dotted);
			const ghost = stored === undefined || stored === null;
			const hasDefault = property.default !== undefined && property.default !== null;
			const readonly = disabled || isFlagged(property, 'readonly');
			const required = isFlagged(property, 'required');
			const title = String(property.title ?? property.name ?? path);
			const envName = typeof property.env === 'string' ? property.env : undefined;
			const description = [typeof property.description === 'string' ? property.description : '', envName ? `Environment variable: \${${envName}}` : ''].filter(Boolean).join(' ');
			const message = messageFor(path);
			const id = elementId(path);
			// Reset is an edit: it goes with the control when the field is read-only
			const frame = { id, title, description, required, ghost: ghost && hasDefault, onReset: !readonly && !ghost && (hasDefault || !required) ? () => reset(path) : undefined, error: message, expose: exposeFor(path) };
			// The message and help the frame renders, announced with the control
			const describedBy = (shownError: string | null): string | undefined => [shownError ? `${id}-error` : '', description ? `${id}-help` : ''].filter(Boolean).join(' ') || undefined;

			// A selector: its own value, then the chosen branch with the SAME config
			if (kind === 'selector') {
				const branches = selectorBranches(property);
				const branch = branches.find(([branchValue]) => branchValue === value);
				const stale = value !== undefined && value !== null && !branch;
				out.push(
					<PropertyField key={key} {...frame} error={stale ? null : message}>
						<EnumWidget id={id} options={enumOptions(property)} value={value} ghost={ghost && hasDefault} onChange={(next) => set(path, next)} disabled={readonly} invalid={Boolean(message) || stale} describedBy={describedBy(stale ? null : message)} />
						{stale && (
							<div style={styles.stale}>
								<span>
									The file holds <b>{String(value)}</b>, which this node no longer offers.
								</span>
								<Button variant="ghost" small disabled={readonly} onClick={() => reset(path)}>
									Reset
								</Button>
							</div>
						)}
					</PropertyField>
				);
				if (branch) {
					const children = render(branch[1]?.properties, `${key}=${branch[0]}`);
					if (children.length > 0) out.push(<div key={`${key}@branch`} style={styles.branch}>{children}</div>);
				}
				continue;
			}

			// Plain leaves
			let control: ReactNode;
			switch (kind) {
				case 'enum':
					control = <EnumWidget id={id} options={enumOptions(property)} value={value} ghost={ghost && hasDefault} onChange={(next) => set(path, next)} disabled={readonly} invalid={Boolean(message)} describedBy={describedBy(message)} />;
					break;
				case 'boolean':
					control = <BooleanWidget id={id} value={value === true} ghost={ghost} onChange={(next) => set(path, next)} disabled={readonly} describedBy={describedBy(message)} />;
					break;
				case 'array':
					control = <ArrayWidget id={id} property={property} stored={stored} value={Array.isArray(value) ? value : []} ghost={ghost} onChange={(next) => set(path, next)} envKeys={envKeys} disabled={readonly} describedBy={describedBy(message)} />;
					break;
				case 'upload':
					control = <UploadWidget id={id} stored={stored} storedSecurely={isStoredSecurely(config, path)} accept={typeof (property.options as Record<string, unknown> | undefined)?.accept === 'string' ? ((property.options as Record<string, unknown>).accept as string) : undefined} onChange={(next) => (next === undefined ? reset(path) : set(path, next))} disabled={readonly} invalid={Boolean(message)} describedBy={describedBy(message)} />;
					break;
				case 'oauth2': {
					const oauthProvider = oauthProviderOf(title) ?? 'google';
					const authenticated = (typeof stored === 'string' && stored.length > 0) || isStoredSecurely(config, path);
					control = <OAuthWidget provider={oauthProvider} authenticated={authenticated} config={config} nodeProvider={provider} nodeId={nodeId} nodeName={nodeName} onDisconnect={() => reset(path)} disabled={readonly} />;
					break;
				}
				case 'object':
					// A free-form object leaf edits as JSON; the validator reports a
					// non-object the same way the server would
					control = <TextWidget id={id} type="string" stored={stored === undefined ? undefined : typeof stored === 'string' ? stored : JSON.stringify(stored, null, 2)} defaultValue={hasDefault ? JSON.stringify(property.default) : undefined} multiline onChange={(next) => set(path, parseJsonOrKeep(next))} disabled={readonly} invalid={Boolean(message)} describedBy={describedBy(message)} />;
					break;
				default:
					control = (
						<TextWidget
							id={id}
							type={kind === 'number' || kind === 'integer' ? kind : 'string'}
							stored={stored}
							defaultValue={property.default}
							onChange={(next) => set(path, next)}
							multiline={property.format === 'textarea'}
							secret={isFlagged(property, 'secret')}
							storedSecurely={isStoredSecurely(config, path)}
							placeholder={typeof property.placeholder === 'string' ? property.placeholder : undefined}
							envKeys={envKeys}
							minimum={typeof property.minimum === 'number' ? property.minimum : undefined}
							maximum={typeof property.maximum === 'number' ? property.maximum : undefined}
							disabled={readonly}
							invalid={Boolean(message)}
							describedBy={describedBy(message)}
						/>
					);
			}
			out.push(
				<PropertyField key={key} {...frame}>
					{control}
				</PropertyField>
			);
		}
		return out;
	};

	// --- Expose dialog -------------------------------------------------------
	const exposing: ServiceParamDescriptor | undefined = exposingPath && exposure ? paramDescriptor(schema, exposingPath) : undefined;

	return (
		<div>
			{render(schema.properties, '')}

			{/* Env-var autocomplete hint. */}
			{envKeys.length > 0 && <div style={styles.envHint}>Type $&#123; in a field to pick from your variables</div>}

			{exposing && exposure && exposingPath && (
				<ExposeNameDialog
					nodeTitle={exposure.nodeTitle}
					descriptor={exposing}
					target={`${exposure.nodeId}.${exposingPath}`}
					parameters={exposure.parameters}
					currentName={Object.entries(exposure.parameters).find(([, target]) => target === `${exposure.nodeId}.${exposingPath}`)?.[0]}
					describeTarget={exposure.describeTarget}
					onExpose={(name) => {
						exposure.onExpose(exposingPath, name);
						setExposingPath(null);
					}}
					onRemove={() => {
						exposure.onUnexpose(exposingPath);
						setExposingPath(null);
					}}
					onClose={() => setExposingPath(null)}
				/>
			)}
		</div>
	);
});

export default NodeConfigForm;

// =============================================================================
// Helpers
// =============================================================================

/** Parses JSON typed into an object leaf; keeps the text while it does not parse. */
function parseJsonOrKeep(text: unknown): unknown {
	if (typeof text !== 'string') return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
