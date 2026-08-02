// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TASK RECORD PANEL — DetailPanel slide-out for one pipeline task
// =============================================================================

import React, { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { DetailPanel, Section, LabelValue, StatusBadge } from 'shell';
import type { StatusVariant } from 'shell';
import type { DashboardTask } from '../types';
import { commonStyles } from 'shell/src/themes/styles';
import { formatNumber, formatTime, formatUptime } from '../util';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link TaskRecordPanel} component. */
export interface ITaskRecordPanelProps {
	/** Id of the task to inspect; null keeps the panel closed. */
	taskId: string | null;
	/**
	 * The CURRENT task wire rows (latest fetched page or dashboard snapshot).
	 * The panel re-resolves its record from this list on every render, so each
	 * poll refresh updates the open panel in place.
	 */
	tasks: DashboardTask[];
	/** Fired when the user dismisses the panel (close glyph or Escape). */
	onClose: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Avatar background palette — the six categorical chart tokens, cycled by a
 * task-id character hash so avatars stay theme-aware (no raw hex).
 */
const AVATAR_COLORS = ['var(--rr-chart-blue)', 'var(--rr-chart-green)', 'var(--rr-chart-yellow)', 'var(--rr-chart-purple)', 'var(--rr-chart-orange)', 'var(--rr-chart-red)'];

/** Memory gauge reference: the fill scales against this many MB = 100%. */
const MEMORY_GAUGE_REFERENCE_MB = 2048;

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/**
	 * 42px avatar circle showing a short task-id prefix on an id-hashed
	 * chart-token background.
	 *
	 * @param color - Avatar background colour token.
	 */
	avatar: (color: string): CSSProperties => ({
		width: 42,
		height: 42,
		borderRadius: '50%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontWeight: 700,
		fontSize: 10,
		color: 'var(--rr-fg-button)',
		background: color,
	}),

	// Fixed-width gauge block (value label above a tinted fill bar).
	gaugeWrap: {
		display: 'inline-flex',
		flexDirection: 'column',
		width: 120,
	} as CSSProperties,

	// Right-aligned value label above the gauge bar.
	gaugeLabel: {
		fontSize: 10,
		color: 'var(--rr-text-disabled)',
		marginBottom: 2,
		textAlign: 'right',
	} as CSSProperties,

	// Gauge track (background).
	gaugeTrack: {
		display: 'block',
		height: 4,
		background: 'color-mix(in srgb, var(--rr-border) 30%, transparent)',
		borderRadius: 2,
		overflow: 'hidden',
	} as CSSProperties,

	/**
	 * Gauge fill — width and tint set per value (clamped to 100%).
	 *
	 * @param pct - Fill percentage.
	 * @param color - CSS color of the fill.
	 */
	gaugeFill: (pct: number, color: string): CSSProperties => ({
		display: 'block',
		height: '100%',
		borderRadius: 2,
		background: color,
		width: `${Math.min(pct, 100)}%`,
	}),

	// Warning tint for a TTL / Idle pair past 80% of its timeout.
	ttlWarning: {
		color: 'var(--rr-color-warning)',
	} as CSSProperties,
};

// =============================================================================
// STATUS DERIVATION (shared with the Tasks grid)
// =============================================================================

/**
 * Derive the state label of a task: completed / failed with exit code, near
 * its idle timeout, or the live status message (falling back to running).
 *
 * @param task - The task wire row.
 * @returns The status label (also the grid's Status cell / enum filter value).
 */
export function taskStatusText(task: DashboardTask): string {
	if (task.completed) {
		return task.exitCode === 0 ? 'completed' : `failed (${task.exitCode})`;
	}
	if (task.idleTime > 0 && task.ttl > 0 && task.idleTime > task.ttl * 0.8) {
		return 'idle (ttl)';
	}
	return task.status ?? 'running';
}

/**
 * Pick the status badge variant for a task: error on non-zero exit, warning
 * near the idle timeout, success otherwise (running or clean exit).
 *
 * @param completed - Whether the task has finished.
 * @param exitCode - Exit code (completed tasks only).
 * @param status - The derived status label from {@link taskStatusText}.
 * @returns The badge variant (same family as the grid's Status badges).
 */
export function taskStatusVariant(completed: boolean, exitCode: number | null, status: string): StatusVariant {
	if (completed) return exitCode === 0 ? 'success' : 'error';
	if (status === 'idle (ttl)') return 'warning';
	return 'success';
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Cycle a task id into a stable avatar palette index (character-code sum —
 * the string twin of the connection panel's numeric `id % length`).
 *
 * @param id - The task identifier.
 * @returns An index into {@link AVATAR_COLORS}.
 */
function avatarColorIndex(id: string): number {
	// Step 1: accumulate the character codes into a small stable hash.
	let hash = 0;
	for (let i = 0; i < id.length; i += 1) {
		hash += id.charCodeAt(i);
	}
	// Step 2: fold into the palette range.
	return hash % AVATAR_COLORS.length;
}

/**
 * Render a mini gauge value (numeric label above a tinted fill bar) — the
 * same semantics as the grid's CPU / Memory cells.
 *
 * @param pct - Fill percentage (clamped to 100).
 * @param label - Value label rendered above the bar.
 * @param color - CSS color of the fill.
 * @returns The gauge element.
 */
function gaugeValue(pct: number, label: string, color: string): ReactNode {
	return (
		<span style={styles.gaugeWrap}>
			<span style={styles.gaugeLabel}>{label}</span>
			<span style={styles.gaugeTrack}>
				<span style={styles.gaugeFill(pct, color)} />
			</span>
		</span>
	);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Task record panel — the DetailPanel slide-out a row click opens for a
 * pipeline task (record-panel standard: row click opens a record panel;
 * centered modals are only for confirmations and flows).
 *
 * Liveness: the caller stores only the task id; the record is re-resolved
 * from the caller's CURRENT rows on every render, so poll refreshes update the
 * open panel in place. When the row is temporarily absent from those rows (it
 * paged out of the fetched page, or the task was cleaned up), the panel keeps
 * rendering its last-known snapshot instead of auto-closing — dismissal stays
 * the user's call.
 *
 * @param props - {@link ITaskRecordPanelProps}.
 * @returns The record panel, or null while closed.
 */
export const TaskRecordPanel: React.FC<ITaskRecordPanelProps> = ({ taskId, tasks, onClose }) => {
	// Step 1: live record resolution — look the stored id up in the CURRENT
	// rows so every parent re-render (each 3s poll) refreshes the open panel.
	const lastKnownRef = useRef<DashboardTask | null>(null);
	const live = taskId != null ? tasks.find((task) => task.id === taskId) : undefined;
	if (live != null) {
		// Cache the latest resolved snapshot (a plain memo write; the ref is
		// only read by this component's own render).
		lastKnownRef.current = live;
	}

	// Step 2: fall back to the last-known snapshot when the row is absent from
	// the current rows — the id guard ensures a stale cache from a previously
	// inspected task can never render.
	const record = live ?? (lastKnownRef.current?.id === taskId ? lastKnownRef.current : null);
	if (record == null) {
		return null;
	}

	// Step 3: status derivation — the same label + badge family as the grid.
	const statusText = taskStatusText(record);
	const variant = taskStatusVariant(record.completed, record.exitCode, statusText);

	// Step 4: live resource metrics — only running tasks report them; the
	// completed placeholders mirror the grid's muted cells.
	const metrics = record.metrics as Record<string, number> | null;
	const cpu = record.completed ? null : (metrics?.cpu_percent ?? 0);
	const mem = record.completed ? null : (metrics?.cpu_memory_mb ?? 0);

	// Step 5: TTL / idle pair mirrors the grid cell — '-' once completed,
	// 'none' when no timeout is set, warning-tinted past 80% of the TTL.
	let ttlIdle: ReactNode;
	if (record.completed) {
		ttlIdle = <span style={commonStyles.textMuted}>-</span>;
	} else if (record.ttl === 0) {
		ttlIdle = <span style={commonStyles.textMuted}>none</span>;
	} else {
		ttlIdle = (
			<span style={record.idleTime / record.ttl > 0.8 ? styles.ttlWarning : undefined}>
				{formatUptime(record.idleTime)} / {formatUptime(record.ttl)}
			</span>
		);
	}

	return (
		<DetailPanel persistKey="panelDetailTaskWidth" open onClose={onClose} avatar={<div style={styles.avatar(AVATAR_COLORS[avatarColorIndex(record.id)])}>#{record.id.slice(0, 4)}</div>} title={record.name || record.id} subtitle={record.id}>
			{/* ── Task Info ────────────────────────────────────────────────── */}
			<Section label="Task Info">
				<LabelValue label="Name">{record.name || record.id}</LabelValue>
				<LabelValue label="ID" mono>
					{record.id}
				</LabelValue>
				<LabelValue label="Source">{record.source}</LabelValue>
				{record.provider && <LabelValue label="Provider">{record.provider}</LabelValue>}
				{record.projectId && (
					<LabelValue label="Project" mono>
						{record.projectId}
					</LabelValue>
				)}
				<LabelValue label="Started at" mono>
					{formatTime(record.startTime)}
				</LabelValue>
				<LabelValue label="Elapsed" mono>
					{formatUptime(record.elapsedTime)}
				</LabelValue>
			</Section>

			{/* ── Resources — CPU / memory gauges (running tasks only) ─────── */}
			<Section label="Resources">
				<LabelValue label="CPU">{cpu === null ? <span style={commonStyles.textMuted}>-</span> : gaugeValue(cpu, `${cpu.toFixed(0)}%`, 'var(--rr-border-focus)')}</LabelValue>
				<LabelValue label="Memory">{mem === null ? <span style={commonStyles.textMuted}>-</span> : gaugeValue((mem / MEMORY_GAUGE_REFERENCE_MB) * 100, `${mem.toFixed(0)} MB`, 'var(--rr-accent)')}</LabelValue>
			</Section>

			{/* ── Progress — completions and the idle-timeout pair ─────────── */}
			<Section label="Progress">
				<LabelValue label="Completions" mono>
					{formatNumber(record.completedCount)}
				</LabelValue>
				<LabelValue label="TTL / Idle" mono>
					{ttlIdle}
				</LabelValue>
			</Section>

			{/* ── Status — the same badge family as the grid ───────────────── */}
			<Section label="Status">
				<LabelValue label="State">
					<StatusBadge variant={variant}>{statusText}</StatusBadge>
				</LabelValue>
			</Section>
		</DetailPanel>
	);
};
