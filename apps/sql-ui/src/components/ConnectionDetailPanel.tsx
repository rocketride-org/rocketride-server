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
// SQL-UI — CONNECTION DETAIL PANEL (record drawer: inspect + probe an endpoint)
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RocketRideClient } from 'shell';
import { Banner, Button, DetailPanel, LabelValue, Section, StatusBadge } from 'shell';
import { commonStyles } from 'shell';
import type { ISqlEndpoint, ISqlProbeResult } from '../connect';
import { probeSqlEndpoint } from '../connect';
import { DatabaseIcon } from '../icons';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link ConnectionDetailPanel} component. */
export interface IConnectionDetailPanelProps {
	/** Whether the drawer is open. */
	open: boolean;
	/** The shell's RocketRide client (null while disconnected). */
	client: RocketRideClient | null;
	/** All discovered endpoints (the drawer's pick list). */
	endpoints: ISqlEndpoint[];
	/** Endpoint preselected by the caller (card click), or null for pick mode. */
	endpoint: ISqlEndpoint | null;
	/** Fired when the user dismisses the drawer. */
	onClose: () => void;
	/** Fired with the selected endpoint when the user opens its workbench. */
	onOpen: (endpoint: ISqlEndpoint) => void;
}

/** Probe lifecycle local to the drawer. */
type ProbeStatus = 'idle' | 'probing' | 'done';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// 42px round avatar slot content for the EntityHeader.
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
 * Record drawer for one database endpoint: pick (or inspect) an endpoint and
 * verify it with a live probe (dialect + shallow schema summary). This panel
 * only renders connect/ results — all attach mechanics stay in connect/.
 */
export const ConnectionDetailPanel: React.FC<IConnectionDetailPanelProps> = (props) => {
	const { open, client, endpoints, endpoint, onClose, onOpen } = props;

	// The endpoint being inspected: caller preselection wins, else first.
	const [selectedKey, setSelectedKey] = useState<string | null>(null);

	// Probe lifecycle + result for the selected endpoint.
	const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle');
	const [probe, setProbe] = useState<ISqlProbeResult | null>(null);

	// Re-seed the selection every time the drawer opens (or the caller's
	// preselection changes) and drop any stale probe result.
	useEffect(() => {
		if (!open) return;
		setSelectedKey(endpoint?.key ?? endpoints[0]?.key ?? null);
		setProbeStatus('idle');
		setProbe(null);
	}, [open, endpoint, endpoints]);

	// Resolve the selected endpoint object from its key.
	const selected = useMemo(
		() => endpoints.find((e) => e.key === selectedKey) ?? null,
		[endpoints, selectedKey],
	);

	/**
	 * Run the live probe against the selected endpoint.
	 */
	const runProbe = async (): Promise<void> => {
		if (!client || !selected) return;
		setProbeStatus('probing');
		setProbe(null);
		const result = await probeSqlEndpoint(client, selected);
		setProbeStatus('done');
		setProbe(result);
	};

	return (
		<DetailPanel
			open={open}
			onClose={onClose}
			avatar={<span style={styles.avatar}><DatabaseIcon /></span>}
			title={selected ? selected.nodeName : 'New Connection'}
			subtitle="Bind SQL Explorer to a database tool node in a running pipeline"
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
						// Changing the target invalidates any prior probe result.
						setSelectedKey(e.target.value);
						setProbeStatus('idle');
						setProbe(null);
					}}
				>
					{endpoints.length === 0 && <option value="">No database nodes found</option>}
					{endpoints.map((e) => (
						<option key={e.key} value={e.key}>
							{e.pipelineName} — {e.nodeName} ({e.provider})
						</option>
					))}
				</select>
				<div style={styles.hint}>
					Only database nodes inside running pipelines are listed. The pipeline
					node owns the database credentials — nothing is entered here.
				</div>
			</Section>

			{/* ── Endpoint ───────────────────────────────────────────────────── */}
			{selected && (
				<Section label="Endpoint">
					<LabelValue label="Pipeline" mono>{selected.pipelineName}</LabelValue>
					<LabelValue label="Node" mono>{selected.nodeId}</LabelValue>
					<LabelValue label="Provider" mono>{selected.provider}</LabelValue>
					<LabelValue label="State">
						<StatusBadge variant={selected.running ? 'success' : 'muted'}>
							{selected.running ? 'Running' : 'Stopped'}
						</StatusBadge>
					</LabelValue>
				</Section>
			)}

			{/* ── Verify (probe results) ─────────────────────────────────────── */}
			{probeStatus === 'done' && probe && (
				probe.ok ? (
					<Section label="Verify">
						<LabelValue label="Probe">
							<StatusBadge variant="success">Tool reachable</StatusBadge>
						</LabelValue>
						<LabelValue label="Dialect" mono>{probe.dialect}</LabelValue>
						{probe.database !== undefined && <LabelValue label="Database" mono>{probe.database}</LabelValue>}
						{probe.tableCount !== undefined && <LabelValue label="Tables" mono>{String(probe.tableCount)}</LabelValue>}
					</Section>
				) : (
					<div style={styles.bannerGap}>
						<Banner variant="error">Probe failed: {probe.error ?? 'unknown error'}</Banner>
					</div>
				)
			)}
		</DetailPanel>
	);
};

export default ConnectionDetailPanel;
