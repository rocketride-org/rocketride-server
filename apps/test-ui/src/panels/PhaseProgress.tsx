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
// PhaseProgress — Live test phase status for the dashboard
// =============================================================================
//
// Shows selected phases with their live status (pending, running, passed,
// failed, skipped) and stats (pass/fail counts, duration). Displayed on
// the dashboard during and after test runs.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { PhaseResult } from '../types';
import { styles } from '../styles';

// =============================================================================
// STYLES
// =============================================================================

const s = {
	/** Full-width card spanning the grid. */
	container: {
		...styles.card,
		gridColumn: '1 / -1',
		padding: 0,
		overflow: 'hidden',
	} as CSSProperties,

	header: {
		padding: '10px 16px',
		fontSize: 12,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	list: {
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,

	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '8px 16px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Status indicator dot. */
	dot: {
		flexShrink: 0,
		width: 10,
		height: 10,
		borderRadius: '50%',
	} as CSSProperties,

	name: {
		flex: 1,
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	stats: {
		display: 'flex',
		gap: 10,
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	duration: {
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-disabled)',
		minWidth: 50,
		textAlign: 'right',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** Map phase status to a dot color. */
function dotColor(status: PhaseResult['status']): string {
	switch (status) {
		case 'passed':
			return 'var(--rr-color-success)';
		case 'failed':
			return 'var(--rr-color-error)';
		case 'running':
			return 'var(--rr-color-warning)';
		case 'skipped':
			return 'var(--rr-text-disabled)';
		case 'pending':
		default:
			return 'var(--rr-border)';
	}
}

/** Format seconds into a compact duration string. */
function formatDuration(secs: number): string {
	if (secs === 0) return '';
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const m = Math.floor(secs / 60);
	const sec = Math.floor(secs % 60);
	return `${m}m ${sec}s`;
}

// =============================================================================
// COMPONENT
// =============================================================================

interface Props {
	/** Phase results from the engine. */
	phases: PhaseResult[];
	/** Which phases were selected for this run. */
	selectedPhases: Set<string>;
}

/** Live phase progress panel for the dashboard. */
const PhaseProgress: React.FC<Props> = ({ phases, selectedPhases }) => {
	// Only show phases that were selected for the run
	const visible = phases.filter((p) => selectedPhases.has(p.id));

	// Don't render if no phases are selected or all are pending (no run started)
	if (visible.length === 0) return null;
	const allPending = visible.every((p) => p.status === 'pending');
	if (allPending) return null;

	return (
		<div style={s.container}>
			<div style={s.header}>Test Phases</div>
			<div style={s.list}>
				{visible.map((phase, idx) => (
					<div
						key={phase.id}
						style={{
							...s.row,
							// Remove border on last row
							...(idx === visible.length - 1 ? { borderBottom: 'none' } : {}),
							// Running phase gets a subtle pulse background
							...(phase.status === 'running'
								? {
										background: 'var(--rr-bg-surface-alt)',
										animation: 'rr-test-pulse 2s infinite',
									}
								: {}),
						}}
					>
						{/* Status dot */}
						<div style={{ ...s.dot, background: dotColor(phase.status) }} />

						{/* Phase name */}
						<div style={s.name}>{phase.name}</div>

						{/* Pass/fail counts (only after phase has run) */}
						{(phase.status === 'passed' || phase.status === 'failed') && (
							<div style={s.stats}>
								<span style={{ color: 'var(--rr-color-success)' }}>{phase.passed} passed</span>
								{phase.failed > 0 && <span style={{ color: 'var(--rr-color-error)' }}>{phase.failed} failed</span>}
							</div>
						)}

						{/* Duration */}
						<div style={s.duration as CSSProperties}>{formatDuration(phase.duration)}</div>
					</div>
				))}
			</div>
		</div>
	);
};

export default PhaseProgress;
