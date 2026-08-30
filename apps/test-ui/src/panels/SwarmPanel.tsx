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
// SwarmPanel — Grid of colored cells showing pipeline states
// =============================================================================

import React, { useState } from 'react';
import type { PipelineSlot } from '../types';
import { styles, swarmCellStyle } from '../styles';

/** Grid capacity — pipelines beyond this are counted in the header, not drawn. */
const TOTAL_SLOTS = 64;

interface Props {
	pipelines: PipelineSlot[];
}

const SwarmPanel: React.FC<Props> = ({ pipelines }) => {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const activeCount = pipelines.filter((p) => p.state !== 'idle').length;

	return (
		<div style={styles.card}>
			<div style={styles.cardHeader}>
				<span>
					Pipeline Swarm ({activeCount} active)
					{pipelines.length > TOTAL_SLOTS && ` · showing ${TOTAL_SLOTS}/${pipelines.length}`}
				</span>
				<div style={styles.swarmLegend}>
					<span style={{ color: 'var(--rr-color-success)' }}>&#9679; running</span>
					<span style={{ color: 'var(--rr-brand)' }}>&#9679; sending</span>
					<span style={{ color: 'var(--rr-color-info)' }}>&#9679; starting</span>
					<span style={{ color: 'var(--rr-color-error)' }}>&#9679; error</span>
					<span style={{ color: 'var(--rr-chart-purple, #a855f7)' }}>&#9679; stopped</span>
				</div>
			</div>
			<div style={styles.cardBody}>
				<div style={styles.swarmGrid}>
					{Array.from({ length: TOTAL_SLOTS }, (_, i) => {
						const slot = pipelines[i] || { id: i, state: 'idle', opsCompleted: 0, avgLatency: 0 };
						return <div key={i} style={swarmCellStyle(slot.state)} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} title={slot.state === 'idle' ? '' : `P-${String(i).padStart(2, '0')}: ${slot.state} · ${slot.opsCompleted} ops · ${Math.round(slot.avgLatency)}ms avg${slot.lastError ? ` · ${slot.lastError}` : ''}`} />;
					})}
				</div>
				{hoveredIdx !== null && pipelines[hoveredIdx] && pipelines[hoveredIdx].state !== 'idle' && (
					<div
						style={{
							marginTop: 8,
							fontSize: 10,
							fontFamily: 'var(--rr-font-mono, monospace)',
							color: 'var(--rr-text-secondary)',
							padding: '6px 8px',
							background: 'var(--rr-bg-surface-alt)',
							borderRadius: 4,
						}}
					>
						P-{String(hoveredIdx).padStart(2, '0')}: {pipelines[hoveredIdx].state}
						{' · '}
						{pipelines[hoveredIdx].opsCompleted} ops
						{' · '}
						{Math.round(pipelines[hoveredIdx].avgLatency)}ms avg
						{pipelines[hoveredIdx].lastError && <span style={{ color: 'var(--rr-color-error)' }}> · {pipelines[hoveredIdx].lastError}</span>}
					</div>
				)}
			</div>
		</div>
	);
};

export default SwarmPanel;
