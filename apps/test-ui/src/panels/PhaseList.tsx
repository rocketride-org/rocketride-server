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

// =============================================================================
// PhaseList — Selectable test phases (checkboxes only, no status)
// =============================================================================
//
// Pure phase selector for the Settings page. Displays checkboxes with phase
// name and description. Status/progress lives in PhaseProgress on the dashboard.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { PhaseResult } from '../types';

// =============================================================================
// STYLES
// =============================================================================

const s = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		overflow: 'hidden',
	} as CSSProperties,

	selectAllRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		padding: '6px 14px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	list: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		padding: '8px 10px',
		overflowY: 'auto',
		flex: 1,
		scrollbarWidth: 'thin',
	} as CSSProperties,

	card: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 10px',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
	} as CSSProperties,

	checkbox: {
		flexShrink: 0,
		width: 14,
		height: 14,
		cursor: 'pointer',
		accentColor: 'var(--rr-brand)',
	} as CSSProperties,

	body: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	name: {
		fontSize: 11,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	desc: {
		fontSize: 10,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.3,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface Props {
	/** Phase definitions (used for name/description only). */
	phases: PhaseResult[];
	/** Currently selected phase IDs. */
	selectedPhases: Set<string>;
	/** Toggle a single phase on/off. */
	onTogglePhase: (id: string) => void;
	/** Select all phases. */
	onSelectAll: () => void;
	/** Deselect all phases. */
	onDeselectAll: () => void;
	/** Disable all checkboxes (e.g. while running). */
	disabled?: boolean;
}

/** Phase selector — checkboxes only, no status indicators. */
const PhaseList: React.FC<Props> = ({
	phases,
	selectedPhases,
	onTogglePhase,
	onSelectAll,
	onDeselectAll,
	disabled,
}) => {
	const allSelected = phases.length > 0 && selectedPhases.size === phases.length;

	if (phases.length === 0) {
		return <div style={{ padding: 24, textAlign: 'center', color: 'var(--rr-text-disabled)', fontSize: 11 }}>
			No phases defined
		</div>;
	}

	return (
		<div style={s.container}>
			<div style={s.selectAllRow}>
				<input
					type="checkbox"
					style={s.checkbox}
					checked={allSelected}
					onChange={allSelected ? onDeselectAll : onSelectAll}
					disabled={disabled}
				/>
				<span style={{ fontWeight: 600 }}>
					{allSelected ? 'Deselect All' : 'Select All'}
				</span>
				<span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--rr-text-disabled)' }}>
					{selectedPhases.size}/{phases.length} selected
				</span>
			</div>

			<div style={s.list}>
				{phases.map((phase) => (
					<div
						key={phase.id}
						style={{ ...s.card, opacity: !selectedPhases.has(phase.id) ? 0.5 : 1 }}
					>
						<input
							type="checkbox"
							style={s.checkbox}
							checked={selectedPhases.has(phase.id)}
							onChange={() => onTogglePhase(phase.id)}
							disabled={disabled}
						/>
						<div style={s.body}>
							<div style={s.name}>{phase.name}</div>
							<div style={s.desc}>{phase.description}</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

export default PhaseList;
