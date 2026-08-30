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
// LatencyPanel — Sparkline of response latencies (log scale)
// =============================================================================

import React from 'react';
import type { LatencySample } from '../types';
import { styles, sparkBarColor } from '../styles';

interface Props {
	samples: LatencySample[];
}

const MAX_BARS = 60;

/** Format milliseconds for display. */
function fmtMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

const LatencyPanel: React.FC<Props> = ({ samples }) => {
	const visible = samples.slice(-MAX_BARS);

	// Log scale: map each value to log2(1 + ms) so small and large values
	// are both visible. A 2ms bar and a 30s bar differ by ~14x in log
	// space instead of ~15000x in linear space.
	const logValues = visible.map((s) => Math.log2(1 + s.value));
	const maxLog = Math.max(1, ...logValues);

	const p50 = visible.length > 0 ? [...visible].sort((a, b) => a.value - b.value)[Math.floor(visible.length * 0.5)]?.value : 0;
	const p99 = visible.length > 0 ? [...visible].sort((a, b) => a.value - b.value)[Math.floor(visible.length * 0.99)]?.value : 0;

	return (
		<div style={styles.card}>
			<div style={styles.cardHeader}>
				<span>Response Latency (ms)</span>
				<span style={{ fontSize: 10, color: 'var(--rr-text-disabled)', fontFamily: 'var(--rr-font-mono, monospace)' }}>
					p50: {fmtMs(p50)} · p99: {fmtMs(p99)}
				</span>
			</div>
			<div style={styles.cardBody}>
				<div style={styles.sparklineContainer}>
					{visible.length === 0 && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--rr-text-disabled)', fontSize: 11 }}>No data yet</div>}
					{visible.map((s, i) => (
						<div
							key={i}
							style={{
								flex: 1,
								minWidth: 2,
								borderRadius: '1px 1px 0 0',
								height: `${Math.max(2, (logValues[i] / maxLog) * 100)}%`,
								backgroundColor: sparkBarColor(s.value),
								transition: 'height 0.2s',
								cursor: 'default',
							}}
							title={`${fmtMs(s.value)}${s.source ? ` — ${s.source}` : ''}`}
						/>
					))}
				</div>
				<div style={styles.sparklineTimeAxis}>
					<span>{visible.length > 0 ? `${Math.round((Date.now() - visible[0].time) / 1000)}s ago` : ''}</span>
					<span>now</span>
				</div>
			</div>
		</div>
	);
};

export default LatencyPanel;
