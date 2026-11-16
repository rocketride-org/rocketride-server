// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * The PARAMS page: a MAP EDITOR (mockup `params-alternatives-mockup.html`,
 * option 4B; plan §5.5).
 *
 * One row per entry of the pipeline's `parameters` map (public name ->
 * `nodeId.configKey`, plan §5.2): the public name, the target picked from a
 * searchable list grouped by node (a field already exposed is greyed; picking
 * fills the public name with the field's name), one info string from the
 * catalog and the .pipe config ("int 256–4096 · default 1024 · Largest
 * input edge"), and a remove. "+ Add parameter" opens a new row. Defaults
 * are the node's configured values and change on DESIGN, never here. Below
 * the table, the live call examples (M-1.6) use the real public names.
 *
 * The page writes the map through the document; the canvas picks the new
 * map up through its project reload path, the same way it takes an undo.
 */

import React, { CSSProperties, ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceParamDescriptor } from 'rocketride';

import { AnchoredPopup, Button, commonStyles, ToggleGroup } from 'shell';
import { getAtPath, publicNameProblem, PUBLIC_NAME_PATTERN } from 'shared/components/node-config';

import { buildCallExamples, CALL_EXAMPLE_TABS, exampleValue, type CallExampleTabId } from './callExamples';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	th: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		textAlign: 'left',
		padding: '6px 8px',
		borderBottom: '1px solid var(--rr-border-default)',
	} as CSSProperties,

	td: {
		padding: '6px 8px',
		borderBottom: '1px solid var(--rr-border-default)',
		verticalAlign: 'top',
	} as CSSProperties,

	nameInput: {
		...commonStyles.inputField,
		...commonStyles.fontMono,
		height: 28,
		padding: '0 8px',
		fontSize: 12,
		width: 160,
	} as CSSProperties,

	nameInvalid: {
		borderColor: 'var(--rr-color-error)',
	} as CSSProperties,

	problem: {
		fontSize: 11,
		color: 'var(--rr-color-error)',
		marginTop: 3,
	} as CSSProperties,

	// The target picker's trigger: the current target and a caret.
	target: {
		...commonStyles.inputField,
		...commonStyles.fontMono,
		display: 'inline-flex',
		alignItems: 'center',
		gap: 8,
		height: 28,
		padding: '0 8px',
		fontSize: 12,
		cursor: 'pointer',
		minWidth: 220,
		justifyContent: 'space-between',
	} as CSSProperties,

	targetEmpty: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	} as CSSProperties,

	caret: {
		color: 'var(--rr-text-secondary)',
		fontSize: 10,
	} as CSSProperties,

	// The one info string: type/bounds · default · description.
	info: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,

	infoStrong: {
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
	} as CSSProperties,

	remove: {
		background: 'none',
		border: 'none',
		color: 'var(--rr-color-error)',
		cursor: 'pointer',
		fontSize: 14,
		lineHeight: 1,
		padding: '4px 6px',
	} as CSSProperties,

	add: {
		background: 'none',
		border: 'none',
		color: 'var(--rr-color-primary)',
		cursor: 'pointer',
		fontWeight: 600,
		fontSize: 13,
		padding: 0,
		marginTop: 12,
	} as CSSProperties,

	help: {
		...commonStyles.textMuted,
		marginTop: 8,
		lineHeight: 1.5,
	} as CSSProperties,

	// The picker popup.
	picker: {
		...commonStyles.popupMenu,
		padding: 6,
		maxHeight: 360,
		overflowY: 'auto',
		minWidth: 420,
	} as CSSProperties,

	search: {
		...commonStyles.inputField,
		height: 28,
		padding: '0 8px',
		fontSize: 12,
		width: '100%',
		marginBottom: 6,
	} as CSSProperties,

	group: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		padding: '8px 10px 4px',
	} as CSSProperties,

	item: {
		display: 'grid',
		gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 1fr) minmax(100px, 1fr)',
		gap: 12,
		padding: '5px 10px',
		borderRadius: 6,
		cursor: 'pointer',
		fontSize: 12,
	} as CSSProperties,

	itemTaken: {
		color: 'var(--rr-text-secondary)',
		cursor: 'default',
		opacity: 0.6,
	} as CSSProperties,

	itemField: {
		...commonStyles.fontMono,
	} as CSSProperties,

	itemMuted: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	pickerFoot: {
		...commonStyles.textMuted,
		fontSize: 11,
		padding: '6px 10px',
		borderTop: '1px solid var(--rr-border-default)',
		marginTop: 4,
	} as CSSProperties,

	examplesHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		margin: '22px 0 8px',
	} as CSSProperties,

	code: {
		...commonStyles.fontMono,
		fontSize: 12,
		lineHeight: 1.5,
		margin: 0,
		padding: 14,
		borderRadius: 7,
		background: 'var(--rr-bg-secondary)',
		border: '1px solid var(--rr-border-default)',
		whiteSpace: 'pre',
		overflowX: 'auto',
	} as CSSProperties,
};

// =============================================================================
// Types
// =============================================================================

/** A pipeline component as the .pipe document holds it. */
interface IComponentDoc {
	id: string;
	provider: string;
	name?: string;
	config?: Record<string, unknown>;
}

/** The pipeline document fields this page reads and writes. */
export interface IParamsProject {
	project_id?: string;
	components?: IComponentDoc[];
	/** The pipeline's `parameters` map: public name -> `nodeId.configKey`. */
	parameters?: Record<string, string>;
	docRevision?: number;
}

/** Props for {@link ParamsPanel}. */
export interface IParamsPanelProps {
	/** The pipeline document. */
	project: IParamsProject;
	/** The service catalog (summaries; a full definition when the host already fetched one). */
	servicesJson: Record<string, { title?: string; params?: ServiceParamDescriptor[] } | undefined>;
	/** Fetches a provider's full definition (its `params` descriptors); absent = summaries only. */
	getNodeSchema?: (provider: string) => Promise<Record<string, unknown> | undefined>;
	/** Writes the document with a new `parameters` map; absent = read-only. */
	onContentChanged?: (project: IParamsProject) => void;
	/** The pipeline's address for the examples (`developerId.pipeId`). */
	address: string;
	/** The server origin for the HTTP example. */
	serverHost?: string;
}

/** One param-capable field of one component: a pickable target. */
interface ITargetOption {
	nodeId: string;
	nodeTitle: string;
	target: string;
	descriptor: ServiceParamDescriptor;
	/** The value the node's config holds, when any. */
	stored: unknown;
}

/** One table row: a map entry, or a row being added (no target yet). */
interface IRow {
	/** The committed public name (undefined on a row being added). */
	name?: string;
	/** The committed target (undefined on a row being added). */
	target?: string;
	/** A new row's local key. */
	key: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * The type-and-bounds text: the enum's values, or the type with its bounds.
 *
 * @param descriptor - The field's descriptor.
 * @returns `low | standard | high`, `int 256–4096`, `bool`, ...
 */
export function typeAndBounds(descriptor: ServiceParamDescriptor): string {
	if (descriptor.enum?.length) return descriptor.enum.map(String).join(' | ');
	const type = descriptor.type === 'integer' ? 'int' : descriptor.type === 'boolean' ? 'bool' : (descriptor.type ?? 'value');
	if (descriptor.type === 'integer' || descriptor.type === 'number') {
		if (descriptor.minimum !== undefined && descriptor.maximum !== undefined) return `${type} ${descriptor.minimum}–${descriptor.maximum}`;
		if (descriptor.minimum !== undefined) return `${type} ≥ ${descriptor.minimum}`;
		if (descriptor.maximum !== undefined) return `${type} ≤ ${descriptor.maximum}`;
	}
	return type;
}

/**
 * The public name proposed when a target is picked: the field's own name made
 * identifier-shaped, suffixed until it is free in the map.
 *
 * @param field - The field's config key (`max_edge`, `service.customerId`).
 * @param parameters - The current map.
 * @returns A free public name.
 */
export function proposePublicName(field: string, parameters: Record<string, string>): string {
	const base = field.split('.').pop()?.replace(/[^A-Za-z0-9_]/g, '_') || 'param';
	let candidate = base;
	let n = 2;
	while (Object.hasOwn(parameters, candidate)) candidate = `${base}_${n++}`;
	return candidate;
}

/**
 * A value as the info string shows it.
 *
 * @param value - The stored or declared value.
 * @returns The display text, or an em dash when none.
 */
function showValue(value: unknown): string {
	if (value === undefined || value === null || value === '') return '—';
	return typeof value === 'string' ? value : JSON.stringify(value);
}

// =============================================================================
// Target picker
// =============================================================================

/** Props for {@link TargetPicker}. */
interface ITargetPickerProps {
	/** The row's current target, when any. */
	value?: string;
	/** Every pickable target, in canvas order. */
	options: ITargetOption[];
	/** The map, to grey out targets another row already exposes. */
	parameters: Record<string, string>;
	/** Whether the picker opens expanded (a row just added). */
	autoOpen?: boolean;
	disabled?: boolean;
	onPick: (option: ITargetOption) => void;
}

/**
 * The target picker: a trigger showing `node.field`, and an anchored popup
 * with a search box and the fields grouped by node (greyed when already
 * exposed by another row).
 *
 * @param props - {@link ITargetPickerProps}.
 * @returns The picker.
 */
function TargetPicker({ value, options, parameters, autoOpen, disabled, onPick }: ITargetPickerProps): ReactElement {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(Boolean(autoOpen));
	const [query, setQuery] = useState('');
	const exposedBy = useMemo(() => {
		const byTarget = new Map<string, string>();
		for (const [name, target] of Object.entries(parameters)) byTarget.set(target, name);
		return byTarget;
	}, [parameters]);
	const needle = query.trim().toLowerCase();
	const groups = useMemo(() => {
		const byNode = new Map<string, { title: string; items: ITargetOption[] }>();
		for (const option of options) {
			if (needle && !`${option.nodeTitle} ${option.nodeId} ${option.descriptor.field} ${option.descriptor.title ?? ''}`.toLowerCase().includes(needle)) continue;
			const group = byNode.get(option.nodeId) ?? { title: option.nodeTitle, items: [] };
			group.items.push(option);
			byNode.set(option.nodeId, group);
		}
		return Array.from(byNode.entries());
	}, [options, needle]);

	return (
		<>
			<button ref={anchorRef} type="button" style={{ ...styles.target, ...(value ? {} : styles.targetEmpty) }} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				<span>{value ?? 'Pick a node field…'}</span>
				<span style={styles.caret}>▾</span>
			</button>
			<AnchoredPopup anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} style={styles.picker}>
				<input style={styles.search} placeholder="Search node or field…" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label="Search node or field" />
				<div role="listbox" aria-label="Node fields">
					{groups.map(([nodeId, group]) => (
						<div key={nodeId}>
							<div style={styles.group}>
								{group.title} · {nodeId}
							</div>
							{group.items.map((option) => {
								const takenBy = exposedBy.get(option.target);
								const taken = takenBy !== undefined && option.target !== value;
								return (
									<div
										key={option.target}
										role="option"
										aria-selected={option.target === value}
										aria-disabled={taken || undefined}
										style={{ ...styles.item, ...(taken ? styles.itemTaken : {}) }}
										onClick={() => {
											if (taken) return;
											onPick(option);
											setOpen(false);
											setQuery('');
										}}
									>
										<span style={styles.itemField}>{option.descriptor.field}</span>
										<span style={styles.itemMuted}>{typeAndBounds(option.descriptor)}</span>
										<span style={styles.itemMuted}>{taken ? `exposed as ${takenBy}` : `default ${showValue(option.stored ?? option.descriptor.default)}`}</span>
									</div>
								);
							})}
						</div>
					))}
					{groups.length === 0 && <div style={{ ...styles.item, ...styles.itemMuted }}>No matching field</div>}
				</div>
				<div style={styles.pickerFoot}>Greyed fields are already exposed. Picking one fills Public name with the field name.</div>
			</AnchoredPopup>
		</>
	);
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the PARAMS page.
 *
 * @param props - {@link IParamsPanelProps}.
 * @returns The page body.
 */
export default function ParamsPanel({ project, servicesJson, getNodeSchema, onContentChanged, address, serverHost }: IParamsPanelProps): ReactElement {
	const readonly = !onContentChanged;
	const parameters = useMemo(() => project.parameters ?? {}, [project.parameters]);
	const components = useMemo(() => (project.components ?? []).filter((c) => c && typeof c.id === 'string' && typeof c.provider === 'string'), [project.components]);

	// --- Descriptors per provider: the catalog's when it carries them, else fetched once ----------
	const [fetched, setFetched] = useState<Record<string, ServiceParamDescriptor[] | null>>({});
	useEffect(() => {
		if (!getNodeSchema) return;
		const missing = Array.from(new Set(components.map((c) => c.provider))).filter((p) => !servicesJson?.[p]?.params && !(p in fetched));
		if (missing.length === 0) return;
		let cancelled = false;
		// Step 1: mark every provider asked, so a slow answer is asked once
		setFetched((prev) => ({ ...prev, ...Object.fromEntries(missing.map((p) => [p, prev[p] ?? null])) }));
		// Step 2: take each answer's descriptors as it lands
		for (const provider of missing) {
			getNodeSchema(provider)
				.then((definition) => {
					if (cancelled) return;
					const params = (definition as { params?: ServiceParamDescriptor[] } | undefined)?.params ?? [];
					setFetched((prev) => ({ ...prev, [provider]: params }));
				})
				.catch(() => {
					if (!cancelled) setFetched((prev) => ({ ...prev, [provider]: [] }));
				});
		}
		return () => {
			cancelled = true;
		};
	}, [components, servicesJson, getNodeSchema, fetched]);

	// --- Every pickable target, in canvas order ---------------------------------
	const options = useMemo((): ITargetOption[] => {
		const out: ITargetOption[] = [];
		for (const component of components) {
			const descriptors = servicesJson?.[component.provider]?.params ?? fetched[component.provider] ?? [];
			const nodeTitle = component.name || servicesJson?.[component.provider]?.title || component.provider;
			for (const descriptor of descriptors) {
				out.push({ nodeId: component.id, nodeTitle, target: `${component.id}.${descriptor.field}`, descriptor, stored: getAtPath(component.config ?? {}, descriptor.field) });
			}
		}
		return out;
	}, [components, servicesJson, fetched]);
	const optionByTarget = useMemo(() => new Map(options.map((o) => [o.target, o])), [options]);

	// --- Rows: the map's entries, then the rows being added -----------------------
	const [adding, setAdding] = useState<string[]>([]);
	const rows = useMemo((): IRow[] => [...Object.entries(parameters).map(([name, target]) => ({ name, target, key: name })), ...adding.map((key) => ({ key }))], [parameters, adding]);

	// --- Names being typed: per row key, until they commit -------------------------
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const describeTarget = useCallback(
		(target: string): string => {
			const option = optionByTarget.get(target);
			const [nodeId, ...rest] = target.split('.');
			return `${option?.nodeTitle ?? nodeId} · ${rest.join('.')}`;
		},
		[optionByTarget]
	);

	/** Write a new map through the document (the canvas reloads it, plan §5.5). */
	const commit = useCallback(
		(next: Record<string, string>) => {
			onContentChanged?.({ ...project, parameters: next, docRevision: (project.docRevision ?? 0) + 1 });
		},
		[onContentChanged, project]
	);

	const dropDraft = useCallback((key: string) => {
		setDrafts((prev) => {
			const rest = { ...prev };
			delete rest[key];
			return rest;
		});
	}, []);

	/** A picked target: on a committed row it retargets the name; on a new row it creates the entry under the field's name. */
	const pick = useCallback(
		(row: IRow, option: ITargetOption) => {
			if (row.name) {
				commit({ ...parameters, [row.name]: option.target });
				return;
			}
			const typed = drafts[row.key]?.trim();
			const name = typed && !publicNameProblem(typed, option.target, parameters, describeTarget) ? typed : proposePublicName(option.descriptor.field, parameters);
			commit({ ...parameters, [name]: option.target });
			setAdding((prev) => prev.filter((k) => k !== row.key));
			dropDraft(row.key);
		},
		[parameters, drafts, describeTarget, commit, dropDraft]
	);

	const remove = useCallback(
		(row: IRow) => {
			if (!row.name) {
				setAdding((prev) => prev.filter((k) => k !== row.key));
				dropDraft(row.key);
				return;
			}
			const next = { ...parameters };
			delete next[row.name];
			commit(next);
		},
		[parameters, commit, dropDraft]
	);

	/** Commit a typed rename when it is free and well-formed; leave the draft showing its problem otherwise. */
	const commitName = useCallback(
		(row: IRow) => {
			const draft = drafts[row.key];
			if (draft === undefined || !row.name || !row.target || draft === row.name) return;
			if (publicNameProblem(draft, row.target, parameters, describeTarget)) return;
			const next = { ...parameters };
			delete next[row.name];
			next[draft] = row.target;
			commit(next);
			dropDraft(row.key);
		},
		[drafts, parameters, describeTarget, commit, dropDraft]
	);

	// --- The examples ------------------------------------------------------------
	const [tab, setTab] = useState<CallExampleTabId>('javascript');
	const examples = useMemo(
		() =>
			buildCallExamples({
				address,
				params: Object.entries(parameters).map(([name, target]) => {
					const option = optionByTarget.get(target);
					return { name, value: option ? exampleValue(option.descriptor, option.stored) : 'value' };
				}),
				host: serverHost,
			}),
		[address, parameters, optionByTarget, serverHost]
	);
	const copy = useCallback(() => {
		void navigator.clipboard?.writeText(examples[tab]);
	}, [examples, tab]);

	// --- Render ------------------------------------------------------------------
	return (
		<div>
			<table style={styles.table}>
				<thead>
					<tr>
						<th style={styles.th}>Public name</th>
						<th style={styles.th}>Target (node.field)</th>
						<th style={styles.th}>Field info (catalog + .pipe config)</th>
						<th style={styles.th} />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const option = row.target ? optionByTarget.get(row.target) : undefined;
						const draft = drafts[row.key];
						const shown = draft ?? row.name ?? '';
						const problem = draft !== undefined && draft !== row.name ? publicNameProblem(draft, row.target ?? '', parameters, describeTarget) : null;
						const inputId = `rr-param-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
						return (
							<tr key={row.key}>
								<td style={styles.td}>
									<input
										id={inputId}
										type="text"
										style={{ ...styles.nameInput, ...(problem ? styles.nameInvalid : {}) }}
										value={shown}
										disabled={readonly}
										placeholder="publicName"
										aria-label={row.target ? `Public name of ${describeTarget(row.target)}` : 'Public name of the new parameter'}
										aria-invalid={problem ? true : undefined}
										aria-describedby={problem ? `${inputId}-problem` : undefined}
										pattern={PUBLIC_NAME_PATTERN.source}
										onChange={(event) => setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))}
										onBlur={() => commitName(row)}
										onKeyDown={(event) => {
											if (event.key === 'Enter') commitName(row);
											if (event.key === 'Escape') dropDraft(row.key);
										}}
									/>
									{problem && (
										<div id={`${inputId}-problem`} style={styles.problem}>
											{problem}
										</div>
									)}
								</td>
								<td style={styles.td}>
									<TargetPicker value={row.target} options={options} parameters={parameters} autoOpen={!row.target} disabled={readonly} onPick={(picked) => pick(row, picked)} />
								</td>
								<td style={{ ...styles.td, ...styles.info }}>
									{option ? (
										<>
											<span style={styles.infoStrong}>{typeAndBounds(option.descriptor)}</span> · default <span style={styles.infoStrong}>{showValue(option.stored ?? option.descriptor.default)}</span>
											{(option.descriptor.description || option.descriptor.title) && <> · {option.descriptor.description || option.descriptor.title}</>}
										</>
									) : row.target ? (
										<span>{row.target.split('.')[0]} is not on this pipeline, or its field is not a per-call parameter</span>
									) : (
										<span>Pick the node field this name sets</span>
									)}
								</td>
								<td style={{ ...styles.td, width: 28 }}>
									{!readonly && (
										<button type="button" style={styles.remove} title="Remove this parameter" aria-label={`Remove ${row.name ?? 'the new parameter'}`} onClick={() => remove(row)}>
											✕
										</button>
									)}
								</td>
							</tr>
						);
					})}
					{rows.length === 0 && (
						<tr>
							<td colSpan={4} style={{ ...styles.td, ...commonStyles.textMuted }}>
								No public parameters yet.
							</td>
						</tr>
					)}
				</tbody>
			</table>
			{!readonly && (
				<button type="button" style={styles.add} onClick={() => setAdding((prev) => [...prev, `new-${Date.now()}-${prev.length}`])} disabled={options.length === 0}>
					+ Add parameter
				</button>
			)}
			<div style={styles.help}>
				Each row is one entry of the .pipe <code style={commonStyles.fontMono}>parameters</code> map: public name → node.field. Defaults are the node's config values; change them on DESIGN.
				{options.length === 0 && ' No node on this pipeline declares a per-call parameter.'}
			</div>

			<div style={styles.examplesHeader}>
				<div style={commonStyles.labelUppercase}>Call examples</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<ToggleGroup options={CALL_EXAMPLE_TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={setTab} small />
					<Button variant="secondary" small onClick={copy} title="Copy to clipboard">
						Copy
					</Button>
				</div>
			</div>
			<pre style={styles.code}>{examples[tab]}</pre>
		</div>
	);
}
