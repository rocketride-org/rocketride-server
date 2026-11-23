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
 * The API Params page: a MAP EDITOR (named-pipes mockup 2.4, option 4C of `params-alternatives-mockup.html`,
 * option 4B; plan §5.5).
 *
 * One row per entry of the pipeline's `parameters` map (public name ->
 * `nodeId.configKey`, plan §5.2): the public name, the target picked from a
 * searchable list grouped by node (a field already exposed is greyed; picking
 * fills the public name with the field's name), the Default as its own
 * column (the .pipe config value, the node's default when unset — option 4C,
 * decided 2026-11-16), the type and description from the catalog ("int
 * 256–4096 · Largest input edge"), and a remove. "+ Add parameter" opens a
 * new row. Defaults are the node's configured values and change on DESIGN,
 * never here. The live call examples (M-1.6) use the real public names and
 * stay pinned at the bottom of the pane while the table above them scrolls.
 * The page is the API Params side tab of the PACKAGE page, which gives it a
 * column of definite height to lay itself out in.
 *
 * Built on the shell's controls and style surface: `InputField`, `Button`,
 * `ToggleGroup`, `AnchoredPopup`, `commonStyles` (table header and cells,
 * menu rows, popup chrome). The page writes the map through the document; the
 * canvas picks the new map up through its project reload path.
 */

import { CSSProperties, KeyboardEvent, ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceParamDescriptor } from 'rocketride';

import { AnchoredPopup, Button, commonStyles, InputField, ToggleGroup } from 'shell';

import { getAtPath, publicNameProblem, PUBLIC_NAME_PATTERN } from '../../../../components/node-config';
import { buildCallExamples, CALL_EXAMPLE_TABS, exampleValue, type CallExampleTabId } from './callExamples';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	// The pane: the map editor scrolls, the call examples stay at the bottom.
	// In a window too short for both, the editor keeps a usable height and
	// the pane itself scrolls, so the table and Add parameter stay reachable.
	page: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
	} as CSSProperties,

	editor: {
		flex: '1 1 auto',
		minHeight: 160,
		overflowY: 'auto',
		paddingBottom: 12,
	} as CSSProperties,

	examples: {
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,

	table: {
		width: '100%',
		borderCollapse: 'collapse',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	// The remove column: the button's width and nothing more.
	removeHeader: {
		...commonStyles.tableHeader,
		width: 36,
	} as CSSProperties,

	cellTop: {
		...commonStyles.tableCell,
		verticalAlign: 'top',
	} as CSSProperties,

	cellInfo: {
		...commonStyles.tableCell,
		verticalAlign: 'top',
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,

	cellDefault: {
		...commonStyles.tableCell,
		verticalAlign: 'top',
		fontSize: 12,
		whiteSpace: 'nowrap',
	} as CSSProperties,

	cellRemove: {
		...commonStyles.tableCell,
		verticalAlign: 'top',
		width: 36,
		padding: '6px 8px',
	} as CSSProperties,

	cellEmpty: {
		...commonStyles.tableCell,
		...commonStyles.textMuted,
	} as CSSProperties,

	nameInput: {
		...commonStyles.fontMono,
		height: 28,
		fontSize: 12,
		width: 170,
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
		minWidth: 230,
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

	infoStrong: {
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
	} as CSSProperties,

	actions: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginTop: 12,
	} as CSSProperties,

	help: {
		...commonStyles.textMuted,
		marginTop: 8,
		lineHeight: 1.5,
	} as CSSProperties,

	// The picker popup: the shell's popup chrome, a search box, grouped rows.
	picker: {
		padding: 6,
		maxHeight: 360,
		overflowY: 'auto',
		minWidth: 440,
	} as CSSProperties,

	search: {
		height: 28,
		fontSize: 12,
		width: '100%',
		marginBottom: 6,
	} as CSSProperties,

	group: {
		...commonStyles.labelUppercase,
		fontSize: 10,
		padding: '8px 10px 4px',
	} as CSSProperties,

	// One pickable field: the shell's menu row, as a three-column line.
	option: {
		...commonStyles.menuRow,
		display: 'grid',
		gridTemplateColumns: 'minmax(130px, 1fr) minmax(130px, 1fr) minmax(110px, 1fr)',
		gap: 12,
		fontSize: 12,
		whiteSpace: 'normal',
	} as CSSProperties,

	optionActive: {
		background: 'var(--rr-bg-list-active)',
		color: 'var(--rr-fg-list-active)',
	} as CSSProperties,

	optionTaken: {
		color: 'var(--rr-text-secondary)',
		cursor: 'default',
		opacity: 0.6,
	} as CSSProperties,

	optionField: {
		...commonStyles.fontMono,
	} as CSSProperties,

	optionMuted: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	pickerFoot: {
		...commonStyles.textMuted,
		fontSize: 11,
		padding: '6px 10px',
		borderTop: '1px solid var(--rr-border)',
		marginTop: 4,
	} as CSSProperties,

	examplesHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 12,
		margin: '12px 0 8px',
	} as CSSProperties,

	examplesControls: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,

	code: {
		...commonStyles.fontMono,
		fontSize: 12,
		lineHeight: 1.5,
		margin: 0,
		padding: 14,
		borderRadius: 7,
		background: 'var(--rr-bg-secondary)',
		border: '1px solid var(--rr-border)',
		whiteSpace: 'pre',
		// A long example scrolls inside its block: the pinned strip never takes the table's room
		maxHeight: 220,
		overflow: 'auto',
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

/** A provider's descriptors as fetched: the list, or the failure to retry. */
type FetchedParams = ServiceParamDescriptor[] | 'failed';

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

/**
 * The map with one entry added or replaced, as an OWN property whatever the
 * name (`__proto__` included): a computed key in a fresh object literal.
 *
 * @param parameters - The current map.
 * @param name - The public name.
 * @param target - The `nodeId.configKey` target.
 * @returns The new map.
 */
function withEntry(parameters: Record<string, string>, name: string, target: string): Record<string, string> {
	return { ...parameters, [name]: target };
}

/**
 * The map without one entry.
 *
 * @param parameters - The current map.
 * @param name - The public name to drop.
 * @returns The new map.
 */
function withoutEntry(parameters: Record<string, string>, name: string): Record<string, string> {
	return Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== name));
}

// =============================================================================
// Target picker
// =============================================================================

/** Props for {@link TargetPicker}. */
interface ITargetPickerProps {
	/** The picker's element id (the listbox and option ids derive from it). */
	id: string;
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
 * exposed by another row). Keyboard: Arrow keys move the active option, Enter
 * picks it, Escape closes; the search box owns focus and names the active
 * option (`aria-activedescendant`).
 *
 * @param props - {@link ITargetPickerProps}.
 * @returns The picker.
 */
function TargetPicker({ id, value, options, parameters, autoOpen, disabled, onPick }: ITargetPickerProps): ReactElement {
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(Boolean(autoOpen));
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const exposedBy = useMemo(() => {
		const byTarget = new Map<string, string>();
		for (const [name, target] of Object.entries(parameters)) byTarget.set(target, name);
		return byTarget;
	}, [parameters]);
	const needle = query.trim().toLowerCase();
	// The visible options in order (the groups are a presentation of this list)
	const visible = useMemo(
		() => options.filter((option) => !needle || `${option.nodeTitle} ${option.nodeId} ${option.descriptor.field} ${option.descriptor.title ?? ''}`.toLowerCase().includes(needle)),
		[options, needle]
	);
	const isTaken = useCallback((option: ITargetOption): boolean => exposedBy.has(option.target) && option.target !== value, [exposedBy, value]);
	const groups = useMemo(() => {
		const byNode = new Map<string, { title: string; items: ITargetOption[] }>();
		for (const option of visible) {
			const group = byNode.get(option.nodeId) ?? { title: option.nodeTitle, items: [] };
			group.items.push(option);
			byNode.set(option.nodeId, group);
		}
		return Array.from(byNode.entries());
	}, [visible]);
	const listId = `${id}-list`;
	const optionId = (option: ITargetOption): string => `${listId}-${option.target.replace(/[^A-Za-z0-9_-]/g, '-')}`;

	const close = useCallback(() => {
		setOpen(false);
		setQuery('');
		setActive(0);
	}, []);

	const pick = useCallback(
		(option: ITargetOption) => {
			if (isTaken(option)) return;
			onPick(option);
			close();
		},
		[isTaken, onPick, close]
	);

	/** Move the active option past the taken ones, wrapping. */
	const step = useCallback(
		(delta: number) => {
			if (visible.length === 0) return;
			let next = active;
			for (let i = 0; i < visible.length; i++) {
				next = (next + delta + visible.length) % visible.length;
				if (!isTaken(visible[next])) break;
			}
			setActive(next);
		},
		[visible, active, isTaken]
	);

	const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				step(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				step(-1);
				break;
			case 'Enter':
				event.preventDefault();
				if (visible[active]) pick(visible[active]);
				break;
			case 'Escape':
				event.preventDefault();
				close();
				anchorRef.current?.focus();
				break;
			default:
				break;
		}
	};

	const activeOption = visible[active];
	return (
		<>
			<button ref={anchorRef} type="button" style={{ ...styles.target, ...(value ? {} : styles.targetEmpty) }} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((o) => !o)}>
				<span>{value ?? 'Pick a node field…'}</span>
				<span style={styles.caret} aria-hidden="true">
					▾
				</span>
			</button>
			<AnchoredPopup anchorRef={anchorRef} open={open} onClose={close} style={{ ...commonStyles.popupMenu, ...styles.picker }}>
				<InputField
					style={styles.search}
					placeholder="Search node or field…"
					value={query}
					autoFocus
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={open}
					aria-controls={listId}
					aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
					aria-label="Search node or field"
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={handleSearchKeyDown}
				/>
				<div id={listId} role="listbox" aria-label="Node fields">
					{groups.map(([nodeId, group]) => (
						<div key={nodeId} role="group" aria-label={`${group.title} · ${nodeId}`}>
							<div style={styles.group}>
								{group.title} · {nodeId}
							</div>
							{group.items.map((option) => {
								const taken = isTaken(option);
								const isActive = activeOption?.target === option.target;
								return (
									<div
										key={option.target}
										id={optionId(option)}
										role="option"
										tabIndex={-1}
										aria-selected={option.target === value}
										aria-disabled={taken || undefined}
										style={{ ...styles.option, ...(taken ? styles.optionTaken : {}), ...(isActive && !taken ? styles.optionActive : {}) }}
										onMouseEnter={() => setActive(visible.indexOf(option))}
										onClick={() => pick(option)}
									>
										<span style={styles.optionField}>{option.descriptor.field}</span>
										<span style={styles.optionMuted}>{typeAndBounds(option.descriptor)}</span>
										<span style={styles.optionMuted}>{taken ? `exposed as ${exposedBy.get(option.target)}` : `default ${showValue(option.stored ?? option.descriptor.default)}`}</span>
									</div>
								);
							})}
						</div>
					))}
					{visible.length === 0 && <div style={{ ...styles.option, ...styles.optionMuted }}>No matching field</div>}
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
 * Renders the API Params page.
 *
 * @param props - {@link IParamsPanelProps}.
 * @returns The page body.
 */
export default function ParamsPanel({ project, servicesJson, getNodeSchema, onContentChanged, address, serverHost }: IParamsPanelProps): ReactElement {
	const readonly = !onContentChanged;
	const parameters = useMemo(() => project.parameters ?? {}, [project.parameters]);
	const components = useMemo(() => (project.components ?? []).filter((c) => c && typeof c.id === 'string' && typeof c.provider === 'string'), [project.components]);

	// --- Descriptors per provider: the catalog's when it carries them, else fetched -------------
	// Request bookkeeping lives in refs (never an effect dependency): recording
	// an outstanding request must not re-run the effect and cancel it. A
	// failure is kept apart from an empty list and can be retried.
	const [fetched, setFetched] = useState<Record<string, FetchedParams>>({});
	const askedRef = useRef(new Set<string>());
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const request = useCallback(
		(providers: string[]) => {
			if (!getNodeSchema) return;
			for (const provider of providers) {
				if (askedRef.current.has(provider)) continue;
				askedRef.current.add(provider);
				getNodeSchema(provider)
					.then((definition) => {
						if (!mountedRef.current) return;
						const params = (definition as { params?: ServiceParamDescriptor[] } | undefined)?.params ?? [];
						setFetched((prev) => ({ ...prev, [provider]: params }));
					})
					.catch(() => {
						if (!mountedRef.current) return;
						askedRef.current.delete(provider);
						setFetched((prev) => ({ ...prev, [provider]: 'failed' }));
					});
			}
		},
		[getNodeSchema]
	);
	const providers = useMemo(() => Array.from(new Set(components.map((c) => c.provider))), [components]);
	useEffect(() => {
		request(providers.filter((p) => !servicesJson?.[p]?.params && !(p in fetched)));
	}, [providers, servicesJson, fetched, request]);
	const failedProviders = useMemo(() => providers.filter((p) => fetched[p] === 'failed'), [providers, fetched]);
	const retryFailed = useCallback(() => {
		setFetched((prev) => Object.fromEntries(Object.entries(prev).filter(([, value]) => value !== 'failed')));
	}, []);

	// --- Every pickable target, in canvas order ---------------------------------
	const options = useMemo((): ITargetOption[] => {
		const out: ITargetOption[] = [];
		for (const component of components) {
			const known = fetched[component.provider];
			const descriptors = servicesJson?.[component.provider]?.params ?? (Array.isArray(known) ? known : []);
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

	/** Write a new map through the document (the canvas takes it, plan §5.5). */
	const commit = useCallback(
		(next: Record<string, string>) => {
			onContentChanged?.({ ...project, parameters: next, docRevision: (project.docRevision ?? 0) + 1 });
		},
		[onContentChanged, project]
	);

	const dropDraft = useCallback((key: string) => {
		setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
	}, []);

	/** A picked target: on a committed row it retargets the name; on a new row it creates the entry under the field's name. */
	const pick = useCallback(
		(row: IRow, option: ITargetOption) => {
			if (row.name) {
				commit(withEntry(parameters, row.name, option.target));
				return;
			}
			const typed = drafts[row.key]?.trim();
			const name = typed && !publicNameProblem(typed, option.target, parameters, describeTarget) ? typed : proposePublicName(option.descriptor.field, parameters);
			commit(withEntry(parameters, name, option.target));
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
			commit(withoutEntry(parameters, row.name));
		},
		[parameters, commit, dropDraft]
	);

	/** Commit a typed rename when it is free and well-formed; leave the draft showing its problem otherwise. */
	const commitName = useCallback(
		(row: IRow) => {
			// Own entries only: a row named __proto__ must not read Object.prototype as its draft
			const draft = Object.hasOwn(drafts, row.key) ? drafts[row.key] : undefined;
			if (draft === undefined || !row.name || !row.target || draft === row.name) return;
			if (publicNameProblem(draft, row.target, parameters, describeTarget)) return;
			commit(withEntry(withoutEntry(parameters, row.name), draft, row.target));
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
		<div style={styles.page}>
			{/* The map editor: the only part of the pane that scrolls. */}
			<div style={styles.editor}>
				<table style={styles.table}>
					<thead>
						<tr>
							<th style={commonStyles.tableHeader}>Public name</th>
							<th style={commonStyles.tableHeader}>Target (node.field)</th>
							<th style={commonStyles.tableHeader}>Default</th>
							<th style={commonStyles.tableHeader}>Type · description</th>
							<th style={styles.removeHeader} />
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const option = row.target ? optionByTarget.get(row.target) : undefined;
							const draft = Object.hasOwn(drafts, row.key) ? drafts[row.key] : undefined;
							const shown = draft ?? row.name ?? '';
							const problem = draft !== undefined && draft !== row.name ? publicNameProblem(draft, row.target ?? '', parameters, describeTarget) : null;
							const rowId = `rr-param-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
							return (
								<tr key={row.key}>
									<td style={styles.cellTop}>
										<InputField
											id={rowId}
											type="text"
											style={{ ...styles.nameInput, ...(problem ? styles.nameInvalid : {}) }}
											value={shown}
											disabled={readonly}
											placeholder="publicName"
											aria-label={row.target ? `Public name of ${describeTarget(row.target)}` : 'Public name of the new parameter'}
											aria-invalid={problem ? true : undefined}
											aria-describedby={problem ? `${rowId}-problem` : undefined}
											pattern={PUBLIC_NAME_PATTERN.source}
											onChange={(event) => setDrafts((prev) => ({ ...prev, [row.key]: event.target.value }))}
											onBlur={() => commitName(row)}
											onKeyDown={(event) => {
												if (event.key === 'Enter') commitName(row);
												if (event.key === 'Escape') dropDraft(row.key);
											}}
										/>
										{problem && (
											<div id={`${rowId}-problem`} style={styles.problem}>
												{problem}
											</div>
										)}
									</td>
									<td style={styles.cellTop}>
										<TargetPicker id={`${rowId}-target`} value={row.target} options={options} parameters={parameters} autoOpen={!row.target} disabled={readonly} onPick={(picked) => pick(row, picked)} />
									</td>
									{/* Default is its own column (option 4C, decided 2026-11-16):
									    the node's config value as set on DESIGN, the node's own
									    default when unset — what a caller gets when the parameter
									    is omitted. Type and description stay prose beside it. */}
									<td style={styles.cellDefault}>{option ? <span style={styles.infoStrong}>{showValue(option.stored ?? option.descriptor.default)}</span> : null}</td>
									<td style={styles.cellInfo}>
										{option ? (
											<>
												<span style={styles.infoStrong}>{typeAndBounds(option.descriptor)}</span>
												{(option.descriptor.description || option.descriptor.title) && <> · {option.descriptor.description || option.descriptor.title}</>}
											</>
										) : row.target ? (
											<span>{row.target.split('.')[0]} is not on this pipeline, or its field is not a per-call parameter</span>
										) : (
											<span>Pick the node field this name sets</span>
										)}
									</td>
									<td style={styles.cellRemove}>
										{!readonly && (
											<Button variant="ghost" small onClick={() => remove(row)} title="Remove this parameter" aria-label={`Remove ${row.name ?? 'the new parameter'}`}>
												✕
											</Button>
										)}
									</td>
								</tr>
							);
						})}
						{rows.length === 0 && (
							<tr>
								<td colSpan={5} style={styles.cellEmpty}>
									No public parameters yet.
								</td>
							</tr>
						)}
					</tbody>
				</table>
				{!readonly && (
					<div style={styles.actions}>
						<Button variant="ghost" small onClick={() => setAdding((prev) => [...prev, `new-${Date.now()}-${prev.length}`])} disabled={options.length === 0}>
							+ Add parameter
						</Button>
						{failedProviders.length > 0 && (
							<Button variant="secondary" small onClick={retryFailed} title={failedProviders.join(', ')}>
								Retry loading {failedProviders.length} node definition{failedProviders.length === 1 ? '' : 's'}
							</Button>
						)}
					</div>
				)}
				<div style={styles.help}>
					Each row is one entry of the .pipe <code style={commonStyles.fontMono}>parameters</code> map: public name → node.field. Defaults are the node's config values; change them on DESIGN.
					{options.length === 0 && failedProviders.length === 0 && ' No node on this pipeline declares a per-call parameter.'}
				</div>
			</div>

			{/* The call examples: pinned at the bottom of the pane. */}
			<div style={styles.examples}>
				<div style={styles.examplesHeader}>
					<div style={commonStyles.labelUppercase}>Call examples</div>
					<div style={styles.examplesControls}>
						<ToggleGroup options={CALL_EXAMPLE_TABS.map((t) => ({ id: t.id, label: t.label }))} value={tab} onChange={setTab} small />
						<Button variant="secondary" small onClick={copy} title="Copy to clipboard">
							Copy
						</Button>
					</div>
				</div>
				<pre style={styles.code}>{examples[tab]}</pre>
			</div>
		</div>
	);
}
