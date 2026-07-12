// =============================================================================
// TEST-UI — Shared styles (CSS-in-JS with --rr-* tokens)
// =============================================================================

import type { CSSProperties } from 'react';

// =============================================================================
// LAYOUT
// =============================================================================

export const styles = {
	// Root layout: 2-column grid (main + sidebar)
	root: {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		minHeight: 0,
		background: 'var(--rr-bg-default)',
	} as CSSProperties,

	body: {
		display: 'grid',
		gridTemplateRows: 'auto 1fr',
		flex: 1,
		minHeight: 0,
		overflow: 'hidden',
	} as CSSProperties,

	// ─── Top bar ───
	topBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '10px 20px',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		flexShrink: 0,
	} as CSSProperties,

	topBarTitle: {
		fontSize: 16,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		letterSpacing: -0.5,
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	} as CSSProperties,

	topBarTitleAccent: {
		color: 'var(--rr-brand)',
	} as CSSProperties,

	topBarSpacer: {
		flex: 1,
	} as CSSProperties,

	serverInfo: {
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	// ─── Status pills ───
	pill: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 5,
		padding: '3px 10px',
		borderRadius: 9999,
		fontSize: 11,
		fontWeight: 600,
	} as CSSProperties,

	pillConnected: {
		backgroundColor: 'color-mix(in srgb, var(--rr-color-success) 15%, transparent)',
		color: 'var(--rr-color-success)',
		border: '1px solid color-mix(in srgb, var(--rr-color-success) 30%, transparent)',
	} as CSSProperties,

	pillRunning: {
		backgroundColor: 'color-mix(in srgb, var(--rr-color-warning) 15%, transparent)',
		color: 'var(--rr-color-warning)',
		border: '1px solid color-mix(in srgb, var(--rr-color-warning) 30%, transparent)',
	} as CSSProperties,

	pillIdle: {
		backgroundColor: 'color-mix(in srgb, var(--rr-text-disabled) 15%, transparent)',
		color: 'var(--rr-text-disabled)',
		border: '1px solid color-mix(in srgb, var(--rr-text-disabled) 30%, transparent)',
	} as CSSProperties,

	pillChaos: {
		backgroundColor: 'color-mix(in srgb, var(--rr-color-error) 15%, transparent)',
		color: 'var(--rr-color-error)',
		border: '1px solid color-mix(in srgb, var(--rr-color-error) 30%, transparent)',
	} as CSSProperties,

	// ─── Control panel ───
	controlPanel: {
		padding: '16px 20px',
		display: 'flex',
		flexWrap: 'wrap',
		gap: 12,
		alignItems: 'flex-start',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,

	controlGroup: {
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: '12px 16px',
		minWidth: 190,
	} as CSSProperties,

	controlGroupTitle: {
		fontSize: 10,
		textTransform: 'uppercase',
		letterSpacing: '0.8px',
		color: 'var(--rr-text-disabled)',
		fontWeight: 600,
		marginBottom: 10,
	} as CSSProperties,

	controlRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
		marginBottom: 7,
	} as CSSProperties,

	controlLabel: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		minWidth: 85,
	} as CSSProperties,

	controlInput: {
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		padding: '4px 8px',
		borderRadius: 4,
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		width: 72,
		outline: 'none',
	} as CSSProperties,

	controlSelect: {
		background: 'var(--rr-bg-default)',
		border: '1px solid var(--rr-border)',
		color: 'var(--rr-text-primary)',
		padding: '4px 8px',
		borderRadius: 4,
		fontSize: 12,
		outline: 'none',
		minWidth: 120,
	} as CSSProperties,

	controlUnit: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,

	controlButtons: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		justifyContent: 'center',
	} as CSSProperties,

	controlButtonRow: {
		display: 'flex',
		gap: 8,
	} as CSSProperties,

	// ─── Main grid area ───
	gridArea: {
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
		padding: '16px 20px',
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
		gap: 14,
		alignContent: 'start',
		scrollbarWidth: 'thin',
		scrollbarColor: 'var(--rr-scrollbar-thumb, rgba(128,128,128,0.3)) transparent',
	} as CSSProperties,

	// ─── Cards ───
	card: {
		background: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		minWidth: 0,
	} as CSSProperties,

	cardHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '10px 14px',
		borderBottom: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-titleBar-inactive)',
		fontSize: 12,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	cardBody: {
		padding: 14,
	} as CSSProperties,

	cardFullWidth: {
		gridColumn: '1 / -1',
	} as CSSProperties,

	// ─── Metrics row ───
	metricsRow: {
		display: 'grid',
		gridTemplateColumns: 'repeat(5, 1fr)',
		gap: 10,
	} as CSSProperties,

	metric: {
		textAlign: 'center',
		padding: '10px 6px',
		background: 'var(--rr-bg-surface-alt)',
		borderRadius: 8,
	} as CSSProperties,

	metricValue: {
		fontSize: 26,
		fontWeight: 700,
		fontFamily: 'var(--rr-font-mono, monospace)',
		lineHeight: 1,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,

	metricLabel: {
		fontSize: 9,
		color: 'var(--rr-text-disabled)',
		marginTop: 4,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
	} as CSSProperties,

	// ─── Progress bar ───
	progressBar: {
		height: 4,
		background: 'var(--rr-bg-default)',
		borderRadius: 2,
		overflow: 'hidden',
		marginTop: 10,
	} as CSSProperties,

	progressFill: {
		height: '100%',
		borderRadius: 2,
		transition: 'width 0.3s',
		background: 'linear-gradient(90deg, var(--rr-color-success), var(--rr-color-info))',
	} as CSSProperties,

	progressText: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		marginTop: 3,
	} as CSSProperties,

	// ─── Pipeline swarm grid ───
	swarmGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(28px, 1fr))',
		gap: 3,
	} as CSSProperties,

	swarmLegend: {
		display: 'flex',
		gap: 8,
		fontSize: 10,
	} as CSSProperties,

	// ─── Sparkline ───
	sparklineContainer: {
		height: 100,
		display: 'flex',
		alignItems: 'flex-end',
		gap: 1,
	} as CSSProperties,

	sparklineTimeAxis: {
		display: 'flex',
		justifyContent: 'space-between',
		fontSize: 9,
		color: 'var(--rr-text-disabled)',
		marginTop: 3,
	} as CSSProperties,

	// ─── API coverage grid ───
	apiGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
		gap: 3,
	} as CSSProperties,

	apiItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 5,
		padding: '3px 7px',
		borderRadius: 3,
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	apiCategory: {
		gridColumn: '1 / -1',
		fontSize: 10,
		textTransform: 'uppercase',
		letterSpacing: '0.8px',
		color: 'var(--rr-brand)',
		marginTop: 8,
		padding: '3px 7px',
		fontWeight: 600,
	} as CSSProperties,

	apiDot: {
		width: 6,
		height: 6,
		borderRadius: '50%',
		flexShrink: 0,
	} as CSSProperties,

	// ─── Sidebar ───
	sidebar: {
		borderLeft: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		minWidth: 0,
	} as CSSProperties,

	// ─── Resize handle ───
	resizeHandle: {
		width: 4,
		cursor: 'col-resize',
		backgroundColor: 'transparent',
		flexShrink: 0,
		position: 'relative',
		zIndex: 10,
	} as CSSProperties,

	resizeHandleHover: {
		backgroundColor: 'var(--rr-brand)',
		opacity: 0.5,
	} as CSSProperties,

	sidebarHeader: {
		padding: '12px 14px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 13,
		fontWeight: 600,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	sidebarTabs: {
		display: 'flex',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,

	sidebarTab: (active: boolean): CSSProperties => ({
		flex: 1,
		textAlign: 'center',
		padding: 8,
		fontSize: 11,
		fontWeight: 500,
		color: active ? 'var(--rr-brand)' : 'var(--rr-text-disabled)',
		cursor: 'pointer',
		borderBottom: active ? '2px solid var(--rr-brand)' : '2px solid transparent',
		background: 'none',
		border: 'none',
		borderBottomWidth: 2,
		borderBottomStyle: 'solid',
		borderBottomColor: active ? 'var(--rr-brand)' : 'transparent',
	}),

	// ─── Event stream ───
	eventStream: {
		flex: 1,
		overflowY: 'auto',
		padding: 6,
		scrollbarWidth: 'thin',
		scrollbarColor: 'var(--rr-scrollbar-thumb, rgba(128,128,128,0.3)) transparent',
	} as CSSProperties,

	eventItem: {
		display: 'flex',
		gap: 6,
		padding: '4px 6px',
		borderRadius: 3,
		marginBottom: 1,
		fontSize: 10,
		fontFamily: 'var(--rr-font-mono, monospace)',
	} as CSSProperties,

	eventTime: {
		color: 'var(--rr-text-disabled)',
		flexShrink: 0,
		width: 52,
	} as CSSProperties,

	eventType: {
		fontWeight: 600,
		flexShrink: 0,
		width: 44,
	} as CSSProperties,

	eventMsg: {
		color: 'var(--rr-text-secondary)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	// ─── Scenario cards ───
	scenarioList: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
		padding: 10,
		overflowY: 'auto',
		flex: 1,
		scrollbarWidth: 'thin',
	} as CSSProperties,

	scenario: {
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: '10px 12px',
		cursor: 'pointer',
	} as CSSProperties,

	scenarioTitle: {
		fontSize: 12,
		fontWeight: 600,
		marginBottom: 3,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	scenarioDesc: {
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.4,
	} as CSSProperties,

	scenarioTags: {
		display: 'flex',
		gap: 4,
		marginTop: 6,
	} as CSSProperties,

	scenarioTag: (color: string): CSSProperties => {
		const colorMap: Record<string, string> = {
			chaos: 'var(--rr-color-error)',
			stress: 'var(--rr-color-warning)',
			api: 'var(--rr-color-info)',
			data: 'var(--rr-chart-purple, #a855f7)',
			conn: 'var(--rr-color-info)',
		};
		const c = colorMap[color] || 'var(--rr-text-secondary)';
		return {
			padding: '1px 6px',
			borderRadius: 3,
			fontSize: 9,
			fontWeight: 600,
			textTransform: 'uppercase',
			letterSpacing: '0.4px',
			backgroundColor: `color-mix(in srgb, ${c} 15%, transparent)`,
			color: c,
		};
	},

	// ─── Bottom stats bar ───
	statsBar: {
		display: 'flex',
		gap: 20,
		padding: '6px 20px',
		backgroundColor: 'var(--rr-bg-paper)',
		borderTop: '1px solid var(--rr-border)',
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-disabled)',
		flexShrink: 0,
	} as CSSProperties,

	statsValue: {
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
	} as CSSProperties,
};

// =============================================================================
// SWARM CELL COLORS — map pipeline state to border/background
// =============================================================================

export function swarmCellStyle(state: string): CSSProperties {
	const base: CSSProperties = {
		aspectRatio: '1',
		borderRadius: 3,
		border: '1px solid transparent',
		transition: 'all 0.3s',
		cursor: 'default',
	};
	switch (state) {
		case 'idle':     return { ...base, background: 'var(--rr-bg-surface-alt)' };
		case 'starting': return { ...base, background: 'color-mix(in srgb, var(--rr-color-info) 20%, transparent)', borderColor: 'var(--rr-color-info)' };
		case 'running':  return { ...base, background: 'color-mix(in srgb, var(--rr-color-success) 15%, transparent)', borderColor: 'var(--rr-color-success)' };
		case 'sending':  return { ...base, background: 'color-mix(in srgb, var(--rr-brand) 20%, transparent)', borderColor: 'var(--rr-brand)' };
		case 'error':    return { ...base, background: 'color-mix(in srgb, var(--rr-color-error) 20%, transparent)', borderColor: 'var(--rr-color-error)' };
		case 'stopped':  return { ...base, background: 'color-mix(in srgb, var(--rr-chart-purple, #a855f7) 15%, transparent)', borderColor: 'var(--rr-chart-purple, #a855f7)' };
		default:         return { ...base, background: 'var(--rr-bg-surface-alt)' };
	}
}

// =============================================================================
// SPARKLINE BAR COLOR — based on latency value
// =============================================================================

export function sparkBarColor(ms: number): string {
	if (ms < 200) return 'var(--rr-color-success)';
	if (ms < 500) return 'var(--rr-color-warning)';
	return 'var(--rr-color-error)';
}

// =============================================================================
// EVENT TYPE COLOR
// =============================================================================

export function eventTypeColor(type: string): string {
	switch (type) {
		case 'pass':  return 'var(--rr-color-success)';
		case 'fail':  return 'var(--rr-color-error)';
		case 'warn':  return 'var(--rr-color-warning)';
		case 'chaos': return 'var(--rr-color-warning)';
		case 'info':  return 'var(--rr-color-info)';
		case 'data':  return 'var(--rr-chart-purple, #a855f7)';
		default:      return 'var(--rr-text-secondary)';
	}
}

// =============================================================================
// API DOT STATUS COLOR
// =============================================================================

export function apiDotStyle(status: string): CSSProperties {
	const base: CSSProperties = { width: 6, height: 6, borderRadius: '50%', flexShrink: 0 };
	switch (status) {
		case 'passed':  return { ...base, backgroundColor: 'var(--rr-color-success)', boxShadow: '0 0 5px var(--rr-color-success)' };
		case 'failed':  return { ...base, backgroundColor: 'var(--rr-color-error)', boxShadow: '0 0 5px var(--rr-color-error)' };
		case 'running': return { ...base, backgroundColor: 'var(--rr-color-warning)' };
		case 'skipped': return { ...base, backgroundColor: 'var(--rr-text-secondary)', opacity: 0.5 };
		default:        return { ...base, backgroundColor: 'var(--rr-text-disabled)', opacity: 0.4 };
	}
}
