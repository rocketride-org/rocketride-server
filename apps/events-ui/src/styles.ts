// =============================================================================
// EVENTS-UI — Styles (built on commonStyles + --rr-* tokens)
// =============================================================================

import type { CSSProperties } from 'react';
import { commonStyles } from 'shared/themes/styles';

export const styles = {
	// ─── Root layout ───
	root: {
		...commonStyles.columnFill,
	} as CSSProperties,

	// ─── Toolbar (top controls bar) ───
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '8px 16px',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		flexShrink: 0,
		flexWrap: 'wrap',
	} as CSSProperties,

	toolbarGroup: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	} as CSSProperties,

	toolbarSpacer: {
		flex: 1,
	} as CSSProperties,

	toolbarLabel: {
		...commonStyles.labelUppercase,
	} as CSSProperties,

	// ─── Controls ───
	input: {
		...commonStyles.inputField,
		width: 'auto',
		padding: '4px 8px',
		fontSize: 12,
	} as CSSProperties,

	tokenInput: {
		width: 180,
	} as CSSProperties,

	select: {
		...commonStyles.inputField,
		width: 'auto',
		padding: '4px 8px',
		fontSize: 12,
		cursor: 'pointer',
	} as CSSProperties,

	button: {
		...commonStyles.buttonSecondary,
		...commonStyles.buttonSmall,
	} as CSSProperties,

	buttonActive: {
		...commonStyles.buttonPrimary,
		...commonStyles.buttonSmall,
	} as CSSProperties,

	buttonDanger: {
		...commonStyles.buttonDangerOutline,
		...commonStyles.buttonSmall,
	} as CSSProperties,

	buttonDisabled: {
		...commonStyles.buttonDisabled,
	} as CSSProperties,

	// ─── Stats bar ───
	statsBar: {
		display: 'flex',
		alignItems: 'center',
		gap: 16,
		padding: '4px 16px',
		borderBottom: '1px solid var(--rr-border)',
		backgroundColor: 'var(--rr-bg-paper)',
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		flexShrink: 0,
	} as CSSProperties,

	statValue: {
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
		fontVariantNumeric: 'tabular-nums',
	} as CSSProperties,

	// Status indicator item in the stats bar (dot + label).
	statusItem: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
	} as CSSProperties,

	// ─── Event type toggle chips ───
	typeChipsRow: {
		...commonStyles.toggleGroup,
		flexWrap: 'wrap',
	} as CSSProperties,

	// ─── Event list ───
	eventListContainer: {
		flex: 1,
		overflow: 'auto',
		minHeight: 0,
	} as CSSProperties,

	eventList: {
		...commonStyles.fontMono,
		fontSize: 12,
		lineHeight: '20px',
	} as CSSProperties,

	// ─── Event row ───
	eventRow: {
		borderBottom: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
		cursor: 'pointer',
	} as CSSProperties,

	eventRowHeader: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '4px 16px',
	} as CSSProperties,

	eventRowHeaderHover: {
		backgroundColor: 'var(--rr-bg-list-hover)',
	} as CSSProperties,

	eventTime: {
		...commonStyles.fontMono,
		color: 'var(--rr-text-disabled)',
		fontSize: 11,
		fontVariantNumeric: 'tabular-nums',
		flexShrink: 0,
		width: 80,
	} as CSSProperties,

	eventIndex: {
		color: 'var(--rr-text-disabled)',
		fontSize: 10,
		flexShrink: 0,
		width: 50,
		textAlign: 'right',
	} as CSSProperties,

	eventType: {
		fontSize: 11,
		fontWeight: 600,
		flexShrink: 0,
		minWidth: 120,
	} as CSSProperties,

	eventToken: {
		...commonStyles.textEllipsis,
		...commonStyles.fontMono,
		color: 'var(--rr-text-disabled)',
		fontSize: 10,
		flexShrink: 0,
		maxWidth: 80,
	} as CSSProperties,

	eventSummary: {
		...commonStyles.textEllipsis,
		color: 'var(--rr-text-secondary)',
		fontSize: 11,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	expandArrow: {
		color: 'var(--rr-text-disabled)',
		fontSize: 10,
		flexShrink: 0,
		width: 16,
		textAlign: 'center',
	} as CSSProperties,

	// ─── JSON tree (expanded event body) ───
	jsonPanel: {
		padding: '8px 16px 12px 56px',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		borderTop: '1px solid color-mix(in srgb, var(--rr-border) 30%, transparent)',
		overflow: 'auto',
		maxHeight: 400,
	} as CSSProperties,

	jsonKey: {
		color: 'var(--rr-chart-purple)',
	} as CSSProperties,

	jsonString: {
		color: 'var(--rr-color-success)',
	} as CSSProperties,

	jsonNumber: {
		color: 'var(--rr-color-info)',
	} as CSSProperties,

	jsonBool: {
		color: 'var(--rr-chart-orange)',
	} as CSSProperties,

	jsonNull: {
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic',
	} as CSSProperties,

	jsonToggle: {
		cursor: 'pointer',
		userSelect: 'none',
		color: 'var(--rr-text-disabled)',
		display: 'inline-block',
		width: 16,
		textAlign: 'center',
	} as CSSProperties,

	jsonBracket: {
		color: 'var(--rr-text-disabled)',
	} as CSSProperties,

	jsonLine: {
		...commonStyles.fontMono,
		whiteSpace: 'pre',
		lineHeight: '20px',
		fontSize: 12,
	} as CSSProperties,

	// ─── Empty state ───
	emptyState: {
		...commonStyles.empty,
		height: '100%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 13,
	} as CSSProperties,

	// ─── Status indicators (re-export for convenience) ───
	indicatorSuccess: commonStyles.indicatorSuccess,
	indicatorError: commonStyles.indicatorError,
	indicatorMuted: commonStyles.indicatorMuted,
};

// Event type → color map using --rr-chart-* and semantic tokens
const EVENT_COLORS: Record<string, string> = {
	apaevt_status_update: 'var(--rr-chart-blue)',
	apaevt_task: 'var(--rr-chart-green)',
	apaevt_flow: 'var(--rr-chart-orange)',
	apaevt_output: 'var(--rr-chart-purple)',
	apaevt_detail: 'var(--rr-chart-red)',
	apaevt_sse: 'var(--rr-color-info)',
	apaevt_dashboard: 'var(--rr-color-success)',
	apaevt_billing: 'var(--rr-chart-yellow)',
	apaevt_status_upload: 'var(--rr-chart-purple)',
};

export function eventColor(eventName: string): string {
	return EVENT_COLORS[eventName] ?? 'var(--rr-text-secondary)';
}

/**
 * Returns commonStyles.toggleButton with the given active state.
 * Convenience re-export so Toolbar doesn't need to import from shared directly.
 */
export function toggleChip(active: boolean): CSSProperties {
	return commonStyles.toggleButton(active);
}
