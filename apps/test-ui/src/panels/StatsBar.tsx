// =============================================================================
// StatsBar — Bottom status bar with live counters
// =============================================================================

import React from 'react';
import type { TestMetrics } from '../types';
import { styles } from '../styles';

interface Props {
	metrics: TestMetrics;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
	return `${(bytes / 1073741824).toFixed(1)} GB`;
}

const StatsBar: React.FC<Props> = ({ metrics }) => (
	<div style={styles.statsBar}>
		<span>WS: <span style={styles.statsValue}>{metrics.wsConnections} active</span></span>
		<span>Tasks: <span style={styles.statsValue}>{metrics.activePipelines} running</span></span>
		<span>Queue: <span style={styles.statsValue}>{metrics.queuedOps} pending</span></span>
		<span>Errors: <span style={{ ...styles.statsValue, color: metrics.failed > 0 ? 'var(--rr-color-error)' : undefined }}>{metrics.failed}</span></span>
		<span>Data TX: <span style={styles.statsValue}>{formatBytes(metrics.dataTransferred)}</span></span>
		<span style={{ flex: 1, textAlign: 'right' }}>RocketRide Test UI v1.0</span>
	</div>
);

export default StatsBar;
