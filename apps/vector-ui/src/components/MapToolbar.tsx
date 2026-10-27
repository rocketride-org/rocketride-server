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

// =============================================================================
// VECTOR-UI — MapToolbar (sample, layout, colour, query; Advanced, Export, Views)
// =============================================================================
//
// One row: Points, Layout, Colour by, the text query, the Table toggle (the
// map's non-visual alternative, and the keyboard route to select a point, so
// it is never behind a popover), then Advanced and the view's menus
// (`extras`: Export, Views). Under it, a status line of its own, always there
// at the same height: the busy words (a live region) and Cancel while a
// layout runs, empty when idle. Nothing moves when a run starts or ends, and
// nothing floats over the map or the rows under the toolbar.
// The row is kept compact (a 120 px query box, 6 px gaps) so it is one row in
// a dev-tool frame at 1440 too (measured: its controls span 1,061 px).
//
// Points: how many and which mode (Detailed up to the node's sample_max, Light
// up to sample_max_light; a light option's title and the select's description
// say a light sample has no text). Layout: PCA (the node's own), Neighbour
// graph (seeded force layout over the kNN graph), t-SNE (at most 1,000 points;
// disabled above that). A running layout shows "Laying out…" and Cancel in the
// status line; when Cancel goes with the focus on it (the layout ended or was
// cancelled), the focus moves to Layout, else to the toolbar, never to the
// page. Colour by, grouped Content / Document / Analysis, each mode without its
// data disabled with the reason as its title. The text query (disabled when
// the embedding node is unreachable). The reasons of a disabled Query and of
// t-SNE are the controls' descriptions (aria-describedby); the map view shows
// the same sentences in full in the legend's notes, where they can wrap.
//
// Advanced (components/AdvancedPopover.tsx) holds the rest in groups:
//   - Graph: Edges (None, each point's strongest Neighbours, 3, 5 or 10 per
//     point, 3 only on light samples above 3,000 points, or the spanning
//     Tree), Expand selected (adds the selected point's own kNN edges); all
//     computed from the sample, no call;
//   - Select and view: the Lasso toggle, Fit and the 3D toggle;
//   - Sample: the seed shown and New sample (the next seed), which closes the
//     panel (drawing disables its controls) and puts the focus on Advanced.
//
// Native controls with labels; no key listeners of its own. While a sample is
// drawn or laid out the controls are disabled; a focused control that becomes
// disabled hands the focus to the toolbar itself (never to the page) and gets
// it back when it is enabled again.
// =============================================================================

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EdgeMode, EdgesPerPoint, MapLayout, MapToolbarProps as ContractMapToolbarProps, SampleMode } from '../contract/types';
import { COLOUR_MODES } from '../map/colours';
import type { IColourMode, MapColourBy } from '../map/colours';
import { afterCancelFocus, focusHold } from '../map/popover';
import { MAP_STYLES } from '../map/styles';
import { num } from '../map/wording';
import { AdvancedPopover, PANEL_ATTRIBUTE } from './AdvancedPopover';

/** Props: the frozen ones (Colour by widened to the document-detail modes) plus map extras. */
export interface MapToolbarProps extends Omit<ContractMapToolbarProps, 'colourBy' | 'onColourBy'> {
	colourBy: MapColourBy;
	onColourBy(colourBy: MapColourBy): void;
	/** Why a colour mode cannot be chosen now (absent or null: it can). */
	colourReasons?: Partial<Record<MapColourBy, string | null>>;
	/** Why t-SNE is unavailable for this sample, or null. */
	tsneReason?: string | null;
	/** Show Cancel (a layout is running). */
	canCancel?: boolean;
	/** The 3D toggle (PCA only), when offered. */
	threeD?: boolean;
	onToggle3D?(): void;
	/** The similarity edges drawn (default 'none'). */
	edges?: EdgeMode;
	onEdges?(edges: EdgeMode): void;
	/** Edges per point in Neighbours mode (default 5). */
	edgesM?: EdgesPerPoint;
	onEdgesM?(m: EdgesPerPoint): void;
	/** The most edges per point this sample allows (3 on light samples above 3,000 points), or null for no cap. */
	edgesMCap?: EdgesPerPoint | null;
	/** "Expand selected": add the selected point's kNN edges; absent: no button. */
	onExpandSelected?(): void;
	/** Why Expand selected is unavailable (no point selected), or null. */
	expandReason?: string | null;
	/** The view's menus, after Advanced (Export, Views). */
	extras?: ReactNode;
	/** Open Advanced at first (only its starting state; the tests render it open). */
	initialAdvanced?: boolean;
}

/** The edge modes. */
const EDGES: Array<{ id: EdgeMode; label: string }> = [
	{ id: 'none', label: 'None' },
	{ id: 'neighbours', label: 'Neighbours' },
	{ id: 'tree', label: 'Tree' },
];

/** Edges per point offered in Neighbours mode. */
const EDGES_PER_POINT: EdgesPerPoint[] = [3, 5, 10];

/** The toolbar's hint for Tree on another layout. */
export const TREE_HINT = 'Tree reads best over the Neighbour graph layout';

/** The Colour by groups, in order. */
const COLOUR_GROUPS: Array<IColourMode['group']> = ['Content', 'Document', 'Analysis'];

/** The status line's height, CSS pixels (a small Cancel fits it). */
export const STATUS_HEIGHT = 24;

/** Layout effects run only in a browser (a server render would warn). */
const useBrowserLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Cancel of a running layout. When it leaves the page with the focus on it (the layout ended, or was cancelled),
 * a layout cleanup, which runs before it is removed, hands the focus to Layout, else to the toolbar.
 *
 * @param props - Cancel's handler and the toolbar.
 * @returns The button.
 */
function CancelButton(props: { onCancel(): void; root: React.RefObject<HTMLDivElement | null> }): React.ReactElement {
	const button = useRef<HTMLButtonElement>(null);
	const root = props.root;
	useBrowserLayoutEffect(
		() => () => {
			if (button.current === null || typeof document === 'undefined' || document.activeElement !== button.current) return;
			const toolbar = root.current;
			const layout = toolbar?.querySelector<HTMLSelectElement>('select[aria-label="Layout"]') ?? null;
			(afterCancelFocus({ present: layout !== null, disabled: !!layout?.disabled }) === 'layout' ? layout : toolbar)?.focus();
		},
		[root],
	);
	return (
		<button ref={button} type="button" style={S.cancel} onClick={props.onCancel}>
			Cancel
		</button>
	);
}

/** What a light sample lacks (the Points options say "light"; their title and the select's description say this). */
const LIGHT_WORDS = 'no text';

/** Detailed and light sizes offered (capped by the node's limits). */
const DETAILED_SIZES = [250, 500, 1000, 2000];
const LIGHT_SIZES = [3000, 5000];

const LAYOUTS: Array<{ id: MapLayout; label: string }> = [
	{ id: 'pca', label: 'PCA' },
	{ id: 'neighbour-graph', label: 'Neighbour graph' },
	{ id: 'tsne', label: 't-SNE (≤1,000)' },
];

const S = {
	// The status line: a line of its own (full width) at a fixed height, the same idle and busy.
	status: { ...MAP_STYLES.small, flexBasis: '100%', height: STATUS_HEIGHT, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', whiteSpace: 'nowrap' } as React.CSSProperties,
	words: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } as React.CSSProperties,
	cancel: { ...MAP_STYLES.button, height: STATUS_HEIGHT - 2, padding: '0 8px', fontSize: 11.5 } as React.CSSProperties,
	query: { ...MAP_STYLES.input, minWidth: 120, width: 120 } as React.CSSProperties,
	// Compact enough for one row in a dev-tool frame at 1440 (measured: 1,110 px of map width there).
	row: { ...MAP_STYLES.toolbar, gap: 6 } as React.CSSProperties,
	// A control's description, read by assistive tech; the view shows the sentence in the legend.
	described: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as React.CSSProperties,
	fieldset: { border: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 } as React.CSSProperties,
	legend: { ...MAP_STYLES.label, padding: 0, marginBottom: 4, width: '100%' } as React.CSSProperties,
};

/**
 * Keep the focus in the toolbar when the control holding it is disabled (a
 * sample being drawn disables them) or goes away (Cancel when the layout ends,
 * the Advanced panel closing): the toolbar takes it, never the page. A
 * disabled control gets it back once it is enabled again.
 *
 * @param root - The toolbar (tabIndex -1).
 */
function useFocusHold(root: React.RefObject<HTMLDivElement | null>): void {
	const last = useRef<HTMLElement | null>(null);
	const held = useRef<HTMLElement | null>(null);
	// What takes the focus meanwhile: the open Advanced panel when the control is in it (so the panel stays
	// open), else the toolbar itself.
	const holder = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const el = root.current;
		if (!el) return undefined;
		const isHolder = (node: EventTarget | null): boolean => node === el || (node instanceof HTMLElement && node.hasAttribute(PANEL_ATTRIBUTE));
		const onFocusIn = (event: FocusEvent): void => {
			if (event.target instanceof HTMLElement && !isHolder(event.target)) last.current = event.target;
		};
		// Moved on to something outside the toolbar, or pressed a pointer there: nothing to keep.
		const onFocusOut = (event: FocusEvent): void => {
			if (event.relatedTarget instanceof Node && !el.contains(event.relatedTarget)) last.current = null;
		};
		const onDown = (event: PointerEvent): void => {
			if (!(event.target instanceof Node) || !el.contains(event.target)) last.current = null;
		};
		el.addEventListener('focusin', onFocusIn);
		el.addEventListener('focusout', onFocusOut);
		document.addEventListener('pointerdown', onDown);
		return () => {
			el.removeEventListener('focusin', onFocusIn);
			el.removeEventListener('focusout', onFocusOut);
			document.removeEventListener('pointerdown', onDown);
		};
	}, [root]);
	// After every render: a control that lost the focus by being disabled or removed hands it to the toolbar, or
	// to the Advanced panel it is in (the rule is map/popover.ts focusHold).
	useEffect(() => {
		const el = root.current;
		if (!el || typeof document === 'undefined') return;
		const active = document.activeElement;
		const known = (control: HTMLElement | null): { inside: boolean; disabled: boolean } | null => (control === null ? null : { inside: el.contains(control), disabled: !!(control as HTMLElement & { disabled?: boolean }).disabled });
		const holding = active !== null && (active === el || active === holder.current);
		const where = holding ? 'toolbar' : active !== null && active === last.current ? 'last' : active === null || active === document.body ? 'page' : 'other';
		const action = focusHold({ last: known(last.current), held: known(held.current), active: where });
		if (action === 'release') {
			held.current = null;
			holder.current = null;
		} else if (action === 'give-back') {
			const back = held.current;
			held.current = null;
			holder.current = null;
			back?.focus();
		} else if (action === 'hold' || action === 'take') {
			const panel = last.current?.closest<HTMLElement>(`[${PANEL_ATTRIBUTE}]`) ?? null;
			holder.current = panel !== null && el.contains(panel) ? panel : el;
			if (action === 'hold') held.current = last.current;
			last.current = null;
			holder.current.focus();
		}
	});
}

/**
 * The map toolbar.
 *
 * @param props - Limits, sample, state and handlers.
 * @returns The toolbar.
 */
export function MapToolbar(props: MapToolbarProps): React.ReactElement {
	const [text, setText] = useState('');
	const root = useRef<HTMLDivElement>(null);
	useFocusHold(root);
	const sample = props.sample;
	const mode: SampleMode = sample?.mode ?? 'detailed';
	const n = sample?.result.n_requested ?? Math.min(props.limits.sample_default, props.limits.sample_max);
	const seed = sample?.seed ?? 7;
	const sizes = [...DETAILED_SIZES.filter((s) => s <= props.limits.sample_max).map((s) => ({ mode: 'detailed' as const, n: s })), ...LIGHT_SIZES.filter((s) => s <= props.limits.sample_max_light && s > props.limits.sample_max).map((s) => ({ mode: 'light' as const, n: s }))];
	const current = `${mode}:${n}`;
	if (!sizes.some((s) => `${s.mode}:${s.n}` === current)) sizes.push({ mode, n });
	const busy = props.busy !== null;
	const edges = props.edges ?? 'none';
	const cap: EdgesPerPoint = props.edgesMCap ?? 10;
	const capReason = `Light samples above ${num(3000)} points draw at most ${cap} edges per point`;
	const toggle = (pressed: boolean): React.CSSProperties => ({ ...MAP_STYLES.button, ...(pressed ? MAP_STYLES.buttonPressed : {}) });
	const uid = useId().replace(/:/g, '');
	const queryWhy = !props.query.enabled && props.query.reason ? props.query.reason : null;
	const tsneWhy = props.tsneReason ?? null;
	const queryWhyId = `map-query-why-${uid}`;
	const tsneWhyId = `map-tsne-why-${uid}`;
	const lightWhyId = `map-light-why-${uid}`;
	const offersLight = sizes.some((s) => s.mode === 'light');
	return (
		<div ref={root} role="toolbar" aria-label="Map controls" tabIndex={-1} style={S.row}>
			<label style={MAP_STYLES.group}>
				<span style={MAP_STYLES.label}>Points</span>
				<select
					aria-label="Points"
					aria-describedby={offersLight ? lightWhyId : undefined}
					style={MAP_STYLES.select}
					value={current}
					disabled={busy}
					onChange={(event) => {
						const [m, size] = event.target.value.split(':');
						props.onSample({ n: Number(size), mode: m === 'light' ? 'light' : 'detailed', seed });
					}}
				>
					{sizes.map((s) => (
						<option key={`${s.mode}:${s.n}`} value={`${s.mode}:${s.n}`} title={s.mode === 'light' ? `${num(s.n)} (light: ${LIGHT_WORDS})` : undefined}>
							{num(s.n)} ({s.mode})
						</option>
					))}
				</select>
			</label>
			<label style={MAP_STYLES.group}>
				<span style={MAP_STYLES.label}>Layout</span>
				<select aria-label="Layout" aria-describedby={tsneWhy ? tsneWhyId : undefined} style={MAP_STYLES.select} value={props.layout} disabled={busy || !sample} onChange={(event) => props.onLayout(event.target.value as MapLayout)}>
					{LAYOUTS.map((l) => (
						<option key={l.id} value={l.id} disabled={l.id === 'tsne' && !!props.tsneReason} title={l.id === 'tsne' ? (props.tsneReason ?? undefined) : undefined}>
							{l.label}
						</option>
					))}
				</select>
			</label>
			<label style={MAP_STYLES.group}>
				<span style={MAP_STYLES.label}>Colour by</span>
				<select aria-label="Colour by" style={MAP_STYLES.select} value={props.colourBy} onChange={(event) => props.onColourBy(event.target.value as MapColourBy)}>
					{COLOUR_GROUPS.map((group) => (
						<optgroup key={group} label={group}>
							{COLOUR_MODES.filter((c) => c.group === group).map((c) => {
								const reason = props.colourReasons?.[c.id] ?? null;
								return (
									<option key={c.id} value={c.id} disabled={reason !== null && c.id !== props.colourBy} title={reason ?? undefined}>
										{c.label}
									</option>
								);
							})}
						</optgroup>
					))}
				</select>
			</label>
			<form
				style={MAP_STYLES.group}
				onSubmit={(event) => {
					event.preventDefault();
					if (props.query.enabled && text.trim() !== '' && !busy) props.onQuery(text.trim());
				}}
			>
				<label style={MAP_STYLES.group}>
					<span style={MAP_STYLES.label}>Query</span>
					<input aria-label="Query" aria-describedby={queryWhy ? queryWhyId : undefined} style={S.query} type="search" value={text} maxLength={8000} placeholder="Place a question on the map" disabled={!props.query.enabled} onChange={(event) => setText(event.target.value)} />
				</label>
				<button type="submit" style={MAP_STYLES.button} aria-describedby={queryWhy ? queryWhyId : undefined} disabled={!props.query.enabled || busy || text.trim() === ''}>
					Run
				</button>
			</form>
			<button type="button" style={toggle(props.table)} aria-pressed={props.table} onClick={props.onToggleTable} disabled={!sample}>Table</button>
			<AdvancedPopover label="Advanced" panelLabel="Advanced map controls" initialOpen={props.initialAdvanced}>
				{(close) => (
					<>
						<fieldset style={S.fieldset}>
							<legend style={S.legend}>Graph</legend>
							<label style={MAP_STYLES.group}>
								<span style={MAP_STYLES.label}>Edges</span>
								<select aria-label="Edges" style={MAP_STYLES.select} value={edges} disabled={busy || !sample} onChange={(event) => props.onEdges?.(event.target.value as EdgeMode)}>
									{EDGES.map((e) => (
										<option key={e.id} value={e.id}>
											{e.label}
										</option>
									))}
								</select>
							</label>
							{edges === 'neighbours' ? (
								<label style={MAP_STYLES.group}>
									<span style={MAP_STYLES.label}>Per point</span>
									<select aria-label="Edges per point" style={MAP_STYLES.select} value={String(Math.min(props.edgesM ?? 5, cap))} disabled={busy || !sample} onChange={(event) => props.onEdgesM?.(Number(event.target.value) as EdgesPerPoint)}>
										{EDGES_PER_POINT.map((m) => (
											<option key={m} value={String(m)} disabled={m > cap} title={m > cap ? capReason : undefined}>
												{m}
											</option>
										))}
									</select>
								</label>
							) : null}
							{props.onExpandSelected ? (
								<button type="button" style={MAP_STYLES.button} disabled={busy || !sample || !!props.expandReason} title={props.expandReason ?? 'Add the selected point\'s neighbour edges'} onClick={props.onExpandSelected}>
									Expand selected
								</button>
							) : null}
							{edges === 'tree' && props.layout !== 'neighbour-graph' ? <span style={MAP_STYLES.small}>{TREE_HINT}</span> : null}
						</fieldset>
						<fieldset style={S.fieldset}>
							<legend style={S.legend}>Select and view</legend>
							<button type="button" style={toggle(props.lasso)} aria-pressed={props.lasso} onClick={props.onToggleLasso} disabled={!sample}>Lasso</button>
							<button type="button" style={MAP_STYLES.button} onClick={props.onFit} disabled={!sample}>
								Fit
							</button>
							{props.onToggle3D ? (
								<button type="button" style={toggle(!!props.threeD)} aria-pressed={!!props.threeD} onClick={props.onToggle3D} disabled={!sample || props.layout !== 'pca'}>3D</button>
							) : null}
						</fieldset>
						<fieldset style={S.fieldset}>
							<legend style={S.legend}>Sample</legend>
							{sample ? <span style={MAP_STYLES.small}>This sample: seed {seed}</span> : null}
							<button
								type="button"
								style={MAP_STYLES.button}
								disabled={busy}
								onClick={() => {
									close(true);
									props.onSample({ n, mode, seed: seed + 1 });
								}}
							>
								New sample (seed {seed + 1})
							</button>
						</fieldset>
					</>
				)}
			</AdvancedPopover>
			{props.extras ?? null}
			{/* The status line: always there, at the same height idle or busy, so nothing moves with a run. */}
			<div style={S.status} data-map-status="">
				<span role="status" style={S.words} title={props.busy ?? undefined}>
					{props.busy ?? ''}
				</span>
				{props.busy && props.canCancel ? <CancelButton onCancel={props.onCancel} root={root} /> : null}
			</div>
			{queryWhy ? (
				<span id={queryWhyId} style={S.described}>
					{queryWhy}
				</span>
			) : null}
			{tsneWhy ? (
				<span id={tsneWhyId} style={S.described}>
					{tsneWhy}
				</span>
			) : null}
			{offersLight ? (
				<span id={lightWhyId} style={S.described}>
					A light sample has {LIGHT_WORDS}.
				</span>
			) : null}
		</div>
	);
}

export default MapToolbar;
