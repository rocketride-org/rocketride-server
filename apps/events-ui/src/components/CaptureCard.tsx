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
// EVENTS-UI — CAPTURE CARD (monitor subscription controls)
// =============================================================================

import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Button, BxPlay, BxStop, Card, InputField, ToggleGroup } from 'shell';
import type { MonitorConfig } from '../types';
import { EVENT_TYPE_NAMES } from '../types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link CaptureCard} component. */
export interface ICaptureCardProps {
	/** Current monitor configuration (token + selected subscription types). */
	config: MonitorConfig;
	/** Whether Start is currently permitted (>=1 subscription type selected). */
	canStart: boolean;
	/** Toggle monitoring on/off. */
	onToggleActive: () => void;
	/** Clear captured events. */
	onClear: () => void;
	/** Set the monitored token. */
	onSetToken: (token: string) => void;
	/** Flip one subscription category. */
	onToggleType: (type: string) => void;
	/** Select every subscription category. */
	onSelectAllTypes: () => void;
	/** Clear the subscription category selection. */
	onClearTypes: () => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Body: two labelled control rows stacked with 16px between them.
	body: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	} as CSSProperties,

	// One control row: a fixed-width caption column + the control cluster.
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
	} as CSSProperties,

	// The type row wraps its toggles, so the caption aligns to the first line.
	rowTop: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 12,
	} as CSSProperties,

	// Uppercase caption column naming each control.
	caption: {
		flexShrink: 0,
		width: 52,
		paddingTop: 4,
		fontSize: 11,
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	// Toggle cluster: the wrapping ToggleGroup plus the All / None actions.
	typeCluster: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 8,
	} as CSSProperties,

	// Run controls in the card header (Start/Stop + Clear), right-aligned.
	controls: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The capture controls card: the monitored token and the event-type
 * subscription set. Every control locks while monitoring is active — the
 * subscription is keyed on the token + types, so it is changed only between
 * runs (Stop, edit, Start), preserving the original interaction.
 *
 * @param props - {@link ICaptureCardProps}.
 * @returns The capture controls card.
 */
export const CaptureCard: React.FC<ICaptureCardProps> = ({ config, canStart, onToggleActive, onClear, onSetToken, onToggleType, onSelectAllTypes, onClearTypes }) => {
	// Stable option list for the multi-select ToggleGroup (id === label here).
	const typeOptions = useMemo(() => EVENT_TYPE_NAMES.map((name) => ({ id: name, label: name })), []);
	// Controls lock while a monitor subscription is live.
	const locked = config.active;

	// Run controls (Start/Stop + Clear) rendered in the card header.
	const controls = (
		<div style={styles.controls}>
			{config.active ? (
				<Button variant="danger" small onClick={onToggleActive}>
					<BxStop size={16} /> Stop
				</Button>
			) : (
				<Button variant="primary" small disabled={!canStart} onClick={onToggleActive} title={canStart ? undefined : 'Select at least one event type'}>
					<BxPlay size={16} /> Start
				</Button>
			)}
			<Button variant="secondary" small onClick={onClear}>
				Clear
			</Button>
		</div>
	);

	return (
		<Card header="Capture" headerActions={controls}>
			<div style={styles.body}>
				{/* Token row: which task to monitor ('*' = all tasks). */}
				<div style={styles.row}>
					<span style={styles.caption}>Token</span>
					<InputField value={config.token} onChange={(e) => onSetToken(e.target.value)} placeholder="* (all tasks)" disabled={locked} style={{ width: 260 }} />
				</div>

				{/* Types row: the multi-select subscription categories + bulk actions. */}
				<div style={styles.rowTop}>
					<span style={styles.caption}>Types</span>
					<div style={styles.typeCluster}>
						<ToggleGroup<string> multi wrap disabled={locked} options={typeOptions} values={config.types} onToggle={onToggleType} />
						<Button variant="ghost" small disabled={locked} onClick={onSelectAllTypes}>
							All
						</Button>
						<Button variant="ghost" small disabled={locked} onClick={onClearTypes}>
							None
						</Button>
					</div>
				</div>
			</div>
		</Card>
	);
};
