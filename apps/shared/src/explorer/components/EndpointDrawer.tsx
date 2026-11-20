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
// EXPLORER — ENDPOINT DRAWER (record drawer: inspect + probe an endpoint)
// =============================================================================
//
// Pick (or inspect) an endpoint and verify it with a live probe. The drawer
// holds no connection mechanics: the app hands in what to say (`copy`), how to
// verify (`probe`) and anything extra to show about an endpoint (`details`).
// Its selection and probe rules live in drawerModel.ts, where they are tested.
// =============================================================================

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Banner, Button, DetailPanel, LabelValue, Section, StatusBadge, commonStyles } from 'shell';
import type { IExplorerClient, IExplorerEndpoint } from '../types';
import { createDrawerModel } from './drawerModel';
import { ENDPOINT_STATE_BADGE, describeRun } from './endpointState';

// =============================================================================
// TYPES
// =============================================================================

/** One line of a probe's result. */
export interface IDrawerProbeRow {
	/** The label. */
	label: string;
	/** The value. */
	value: string;
}

/** What the app reports after verifying an endpoint. */
export interface IDrawerProbe {
	/** Whether the endpoint answered. */
	ok: boolean;
	/** What the probe learned (engine, database, …). */
	rows: IDrawerProbeRow[];
	/** Failure detail when `ok` is false. */
	error?: string;
}

/** The words a drawer uses. */
export interface IEndpointDrawerCopy {
	/** Title when no endpoint is selected. */
	newTitle: string;
	/** Subtitle under the title. */
	subtitle: string;
	/** The select's only option when nothing was discovered. */
	noEndpointsOption: string;
	/** Hint under the picker. */
	pickHint: string;
}

/** Props for the {@link EndpointDrawer} component. */
export interface IEndpointDrawerProps<E extends IExplorerEndpoint> {
	/** Whether the drawer is open. */
	open: boolean;
	/** The shell's client (null while disconnected). */
	client: IExplorerClient | null;
	/** All discovered endpoints (the drawer's pick list). */
	endpoints: E[];
	/** Endpoint preselected by the caller (card click), or null for pick mode. */
	endpoint: E | null;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
	/** Fired with the selected endpoint when the user opens its workbench. */
	onOpen: (endpoint: E) => void;
	/** The avatar shown in the header. */
	avatar: ReactNode;
	/** The drawer's wording. */
	copy: IEndpointDrawerCopy;
	/** Verify an endpoint. Must not throw; failures come back as `ok: false`. */
	probe: (client: IExplorerClient, endpoint: E) => Promise<IDrawerProbe>;
	/** Extra rows for the Endpoint section (engine, version, graph, owner…). */
	details?: (endpoint: E) => ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// 42px round avatar slot content for the header.
	avatar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: 42,
		height: 42,
		borderRadius: '50%',
		background: 'var(--rr-bg-widget)',
		color: 'var(--rr-brand)',
		padding: 9,
	} as CSSProperties,

	// Endpoint <select> — the stock input treatment on a native select.
	select: {
		...commonStyles.inputField,
		width: '100%',
	} as CSSProperties,

	// Hint line under the endpoint picker.
	hint: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 6,
		lineHeight: 1.45,
	} as CSSProperties,

	// Spacer so the probe banner clears the section above it.
	bannerGap: {
		marginTop: 12,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Record drawer for one endpoint: pick (or inspect) it and verify it with a
 * live probe.
 *
 * @param props - {@link IEndpointDrawerProps}.
 * @returns The drawer element.
 */
export function EndpointDrawer<E extends IExplorerEndpoint>(props: IEndpointDrawerProps<E>): React.ReactElement {
	const { open, client, endpoints, endpoint, onClose, onOpen, avatar, copy, probe: runProbeFn, details } = props;

	// The selection and the probe lifecycle (drawerModel.ts): the endpoint
	// being inspected (caller preselection wins, else first), where its probe
	// stands, and the generation that drops a probe answering too late.
	const [model] = useState(() => createDrawerModel<IDrawerProbe>());
	const { selectedKey, status: probeStatus, probe } = useSyncExternalStore(model.subscribe, model.get, model.get);

	// Re-seed the selection every time the drawer opens (or the caller's
	// preselection changes) and drop any stale probe result.
	useEffect(() => {
		if (!open) return;
		model.seed(endpoint?.key ?? endpoints[0]?.key ?? null);
		// `endpoints` is read for the first-entry fallback only; a background
		// discovery refresh must not reset the user's selection mid-inspection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, endpoint]);

	// Follow the endpoint list. When the selection leaves it (the store reset on
	// sign-out or a change of user, organization or team), forget it with its
	// probe result and drop a probe still in flight, open or closed. Fill the
	// first-endpoint fallback when the drawer opened from the empty state (or
	// after a reset) and discovery delivers endpoints later.
	useEffect(() => {
		model.sync(endpoints, open);
	}, [model, open, endpoints]);

	// Resolve the selected endpoint object from its key.
	const selected = useMemo(
		() => endpoints.find((e) => e.key === selectedKey) ?? null,
		[endpoints, selectedKey],
	);

	/** Run the live probe against the selected endpoint. */
	const runProbe = async (): Promise<void> => {
		if (!client || !selected) return;
		// The ticket expires if the drawer re-seeds or the user switches
		// endpoints while this probe is in flight; its result is then dropped.
		const ticket = model.startProbe();
		const result = await runProbeFn(client, selected);
		model.finishProbe(ticket, result);
	};

	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			avatar={<span style={styles.avatar}>{avatar}</span>}
			title={selected ? selected.nodeName : copy.newTitle}
			subtitle={copy.subtitle}
			footer={
				<>
					<Button variant="ghost" onClick={onClose}>Close</Button>
					<Button
						variant="secondary"
						onClick={() => { void runProbe(); }}
						disabled={!client || !selected || probeStatus === 'probing'}
					>
						{probeStatus === 'probing' ? 'Testing...' : 'Test Connection'}
					</Button>
					<Button
						variant="primary"
						onClick={() => { if (selected) onOpen(selected); }}
						disabled={!selected}
					>
						Open
					</Button>
				</>
			}
		>
			{/* ── Source ─────────────────────────────────────────────────────── */}
			<Section label="Source">
				<select
					style={styles.select}
					value={selectedKey ?? ''}
					onChange={(e) => {
						// Changing the target invalidates any prior (or in-flight)
						// probe result.
						model.select(e.target.value);
					}}
				>
					{endpoints.length === 0 && <option value="">{copy.noEndpointsOption}</option>}
					{endpoints.map((e) => (
						<option key={e.key} value={e.key}>
							{e.pipelineName}: {e.nodeName} ({e.provider})
						</option>
					))}
				</select>
				<div style={styles.hint}>{copy.pickHint}</div>
			</Section>

			{/* ── Endpoint ───────────────────────────────────────────────────── */}
			{selected && (
				<Section label="Endpoint">
					<LabelValue label="Pipeline" mono>{selected.pipelineName}</LabelValue>
					<LabelValue label="Node" mono>{selected.nodeId}</LabelValue>
					<LabelValue label="Provider" mono>{selected.provider}</LabelValue>
					<LabelValue label="Run">{describeRun(selected)}</LabelValue>
					<LabelValue label="State">
						<StatusBadge variant={ENDPOINT_STATE_BADGE[selected.state].variant}>{ENDPOINT_STATE_BADGE[selected.state].label}</StatusBadge>
					</LabelValue>
					{selected.stateDetail && <div style={styles.hint}>{selected.stateDetail}</div>}
					{details?.(selected)}
				</Section>
			)}

			{/* ── Verify (probe results) ─────────────────────────────────────── */}
			{probeStatus === 'done' && probe && (
				probe.ok ? (
					<Section label="Verify">
						<LabelValue label="Probe">
							<StatusBadge variant="success">Tool reachable</StatusBadge>
						</LabelValue>
						{probe.rows.map((row) => (
							<LabelValue key={row.label} label={row.label} mono>{row.value}</LabelValue>
						))}
					</Section>
				) : (
					<div style={styles.bannerGap}>
						<Banner variant="error">Probe failed: {probe.error ?? 'unknown error'}</Banner>
					</div>
				)
			)}
		</DetailPanel>
	);
}

export default EndpointDrawer;
