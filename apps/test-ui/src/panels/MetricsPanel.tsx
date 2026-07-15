// =============================================================================
// MetricsPanel — Live pass/fail/active/ops counters with progress bar
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { TestMetrics, ApiTestResult, EngineState } from '../types';
import { styles } from '../styles';

function formatNumber(n: number): string {
	return n.toLocaleString();
}

function formatTime(secs: number): string {
	const m = Math.floor(secs / 60);
	const s = Math.floor(secs % 60);
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatMs(ms: number): string {
	if (ms === 0) return '-';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// =============================================================================
// ACTION BAR STYLES
// =============================================================================

const actionStyles = {
	row: {
		display: 'flex',
		gap: 8,
		padding: '8px 16px',
		borderTop: '1px solid var(--rr-border)',
	} as CSSProperties,

	launchBtn: {
		padding: '6px 16px',
		borderRadius: 6,
		border: 'none',
		fontSize: 12,
		fontWeight: 700,
		cursor: 'pointer',
		background: 'linear-gradient(135deg, var(--rr-color-success), #2d8a4e)',
		color: '#fff',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	runningBtn: {
		padding: '6px 16px',
		borderRadius: 6,
		border: 'none',
		fontSize: 12,
		fontWeight: 700,
		cursor: 'default',
		background: 'var(--rr-color-warning)',
		color: '#fff',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	actionBtn: {
		padding: '5px 12px',
		borderRadius: 4,
		border: '1px solid var(--rr-border)',
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		fontSize: 11,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	abortBtn: {
		padding: '5px 12px',
		borderRadius: 4,
		border: '1px solid var(--rr-color-error)',
		background: 'transparent',
		color: 'var(--rr-color-error)',
		fontSize: 11,
		cursor: 'pointer',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface Props {
	metrics: TestMetrics;
	apiResults: ApiTestResult[];
	worstPing: number;
	worstPingSnapshot: string;
	engineState: EngineState;
	onStart: () => void;
	onAbort: () => void;
	onPause: () => void;
	onResume: () => void;
	onClear: () => void;
}

const MetricsPanel: React.FC<Props> = ({
	metrics, apiResults, worstPing, worstPingSnapshot,
	engineState, onStart, onAbort, onPause, onResume, onClear,
}) => {
	const pct = metrics.targetOps > 0 ? Math.round((metrics.totalOps / metrics.targetOps) * 100) : 0;
	const isRunning = engineState === 'running' || engineState === 'paused';
	const isPaused = engineState === 'paused';

	// Ping heartbeat stats — worst ping and what was running at that moment
	const pingColor = worstPing === 0 ? 'var(--rr-text-disabled)'
		: worstPing < 50 ? 'var(--rr-color-success)'
		: worstPing < 200 ? 'var(--rr-color-warning)'
		: 'var(--rr-color-error)';

	return (
		<div style={{ ...styles.card, ...styles.cardFullWidth }}>
			<div style={styles.cardHeader}>
				<span>Live Metrics</span>
				<span style={{ fontSize: 11, color: 'var(--rr-text-disabled)', fontFamily: 'var(--rr-font-mono, monospace)' }}>
					Elapsed: {formatTime(metrics.elapsed)}
				</span>
			</div>
			<div style={styles.cardBody}>
				<div style={styles.metricsRow}>
					<div style={styles.metric}>
						<div style={{ ...styles.metricValue, color: 'var(--rr-color-success)' }}>
							{formatNumber(metrics.passed)}
						</div>
						<div style={styles.metricLabel}>Passed</div>
					</div>
					<div style={styles.metric}>
						<div style={{ ...styles.metricValue, color: 'var(--rr-color-error)' }}>
							{formatNumber(metrics.failed)}
						</div>
						<div style={styles.metricLabel}>Failed</div>
					</div>
					<div style={styles.metric}>
						<div style={{ ...styles.metricValue, color: 'var(--rr-color-warning)' }}>
							{formatNumber(metrics.activePipelines)}
						</div>
						<div style={styles.metricLabel}>Active Pipelines</div>
					</div>
					<div style={styles.metric}>
						<div style={{ ...styles.metricValue, color: 'var(--rr-color-info)' }}>
							{formatNumber(metrics.opsPerSec)}
						</div>
						<div style={styles.metricLabel}>Ops/sec</div>
					</div>
					<div style={styles.metric} title={worstPing > 0 ? `Worst: ${formatMs(worstPing)}\nIn-flight: ${worstPingSnapshot}` : 'Ping heartbeat not started'}>
						<div style={{ ...styles.metricValue, color: pingColor }}>
							{worstPing > 0 ? formatMs(worstPing) : '-'}
						</div>
						<div style={styles.metricLabel}>Ping Max</div>
					</div>
				</div>

				{metrics.targetOps > 0 && (
					<>
						<div style={styles.progressBar}>
							<div style={{ ...styles.progressFill, width: `${Math.min(pct, 100)}%` }} />
						</div>
						<div style={styles.progressText}>
							<span>{pct}% complete</span>
							<span>{formatNumber(metrics.totalOps)} / {formatNumber(metrics.targetOps)} operations</span>
						</div>
					</>
				)}

				{/* ── Action Buttons ─────────────────────────────────── */}
				<div style={actionStyles.row}>
					{!isRunning ? (
						<button style={actionStyles.launchBtn} onClick={onStart}>Launch Tests</button>
					) : (
						<button style={actionStyles.runningBtn}>Running...</button>
					)}
					{isRunning && (
						<>
							<button style={actionStyles.abortBtn} onClick={onAbort}>Abort</button>
							<button style={actionStyles.actionBtn} onClick={isPaused ? onResume : onPause}>
								{isPaused ? 'Resume' : 'Pause'}
							</button>
						</>
					)}
					{!isRunning && (
						<button style={actionStyles.actionBtn} onClick={onClear}>Clear</button>
					)}
				</div>
			</div>
		</div>
	);
};

export default MetricsPanel;
