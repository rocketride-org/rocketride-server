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
// SettingsPanel — Config + Phase Selection + Reset
// =============================================================================
//
// Wraps ControlPanel (concurrency/chaos/payload config), PhaseList (phase
// selector checkboxes), and a standalone Reset button. Action buttons
// (Launch/Abort/Pause/Clear) live in the sidebar, not here.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { TestConfig, EngineState, PhaseResult } from '../types';
import ControlPanel from './ControlPanel';
import PhaseList from './PhaseList';

// =============================================================================
// STYLES
// =============================================================================

const s = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		overflow: 'auto',
	} as CSSProperties,

	/** Wrapper for the phase list section. */
	phaseSection: {
		padding: '16px 20px',
	} as CSSProperties,

	/** Section label above the phase list. */
	sectionLabel: {
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.05em',
		color: 'var(--rr-text-disabled)',
		marginBottom: 8,
	} as CSSProperties,

	/** Footer area with the reset button. */
	footer: {
		padding: '12px 20px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Reset button — destructive action, outlined style. */
	resetBtn: {
		padding: '6px 16px',
		borderRadius: 4,
		border: '1px solid var(--rr-color-error)',
		background: 'transparent',
		color: 'var(--rr-color-error)',
		fontSize: 11,
		fontWeight: 600,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface Props {
	/** Current test configuration. */
	config: TestConfig;
	/** Config change handler. */
	onConfigChange: (config: TestConfig) => void;
	/** Current engine state (idle/running/paused/done). */
	engineState: EngineState;
	/** Phase results from the engine. */
	phases: PhaseResult[];
	/** Currently selected phase IDs. */
	selectedPhases: Set<string>;
	/** Toggle a single phase on/off. */
	onTogglePhase: (id: string) => void;
	/** Select all phases. */
	onSelectAll: () => void;
	/** Deselect all phases. */
	onDeselectAll: () => void;
	/** Reset config and phases to defaults. */
	onReset: () => void;
}

/** Settings view — config controls, phase selector, and reset button. */
const SettingsPanel: React.FC<Props> = ({
	config,
	onConfigChange,
	engineState,
	phases,
	selectedPhases,
	onTogglePhase,
	onSelectAll,
	onDeselectAll,
	onReset,
}) => {
	const isActive = engineState === 'running' || engineState === 'paused';

	return (
		<div style={s.container}>
			{/* Config controls (concurrency, chaos, payload) */}
			<ControlPanel
				config={config}
				onChange={onConfigChange}
				engineState={engineState}
			/>

			{/* Phase selector */}
			<div style={s.phaseSection}>
				<div style={s.sectionLabel}>Test Phases</div>
				<PhaseList
					phases={phases}
					selectedPhases={selectedPhases}
					onTogglePhase={onTogglePhase}
					onSelectAll={onSelectAll}
					onDeselectAll={onDeselectAll}
					disabled={isActive}
				/>
			</div>

			{/* Reset button — only enabled when idle */}
			<div style={s.footer}>
				<button
					style={{
						...s.resetBtn,
						...(isActive ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
					}}
					onClick={onReset}
					disabled={isActive}
					title="Reset config and phases to defaults"
				>
					Reset All
				</button>
			</div>
		</div>
	);
};

export default SettingsPanel;
