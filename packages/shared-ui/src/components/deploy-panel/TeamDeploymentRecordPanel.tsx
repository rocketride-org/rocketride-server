// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TeamDeploymentRecordPanel — one TEAM's deployment of a project as a wide
 * record drawer: the team-oriented view opened from the where-live TEAM
 * header (and the version-card team badges).
 *
 * One page: deployment header (version, state, attribution, newer-version
 * hint), the per-source STATUS GRID — every source's last outcome, schedule,
 * next fire, and 7-day failures side by side, rows drilling into the
 * per-source record drawer — and the team's audit history. The footer
 * carries the TEAM operations — Remove (soft), Enable/Disable, Rollback,
 * Deploy version… — the verbs that act on the whole deployment and
 * therefore never appear in the source-scoped drawer.
 *
 * ONE DetailPanel instance across loading→loaded (record-drawer standard).
 */

import React, { useEffect, useMemo, useState, CSSProperties } from 'react';

import { DetailPanel } from '../detail-panel/DetailPanel';
import { Button } from '../button/Button';
import { Modal } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { Card } from '../card/Card';
import { CardDataGrid } from '../data-grid/CardDataGrid';
import { commonStyles } from '../../themes/styles';
import { formatTime, formatDayTime } from '../../modules/server/util/formatters';
import { describeCron, describeTtl } from './SchedulePanel';
import type { CellComponent } from 'tabulator-tables';
import type { GridColumnDefinition } from '../data-grid/defaults';
import type { TaskTimeline } from '../../modules/project/hooks/useTaskEvents';
import type { DeploymentInfo } from './DeploymentView';
import type { DeployHistoryRow, DeployScheduleRow, DeployVersionCard } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default drawer width as a fraction of the viewport (the wide-record
    standard shared with DeploymentRecordPanel). */
const DEFAULT_HOST_FRACTION = 0.75;

/** State → chip color for the header state chip. */
const STATE_COLOR: Record<DeploymentInfo['state'], string> = {
	enabled: 'var(--rr-color-success)',
	disabled: 'var(--rr-text-secondary)',
	errored: 'var(--rr-color-error)',
	removed: 'var(--rr-text-disabled)',
};

// =============================================================================
// PROPS
// =============================================================================

/** The loaded TEAM deployment record + its verbs. */
export interface ITeamDeploymentRecordData {
	/** Team display name (title context, e.g. 'Production'). */
	teamName: string;
	/** The deployment record (header + state). */
	deployment: DeploymentInfo;
	/** Registry versions (the Deploy version… / Rollback pickers). */
	versions: DeployVersionCard[];
	/** This team's audit history, newest first. */
	history: DeployHistoryRow[];
	/** One row per source (artifact sources ∪ schedule records). */
	schedules: DeployScheduleRow[];
	/** Per-source next occurrence (host-previewed), keyed by sourceId. */
	nextRuns?: Record<string, number>;
	/** sourceId -> true while a run of that source is live on the server. */
	runningSources?: Record<string, boolean>;
	/** Caller holds task.control on this team (verbs render only then). */
	canControl: boolean;
	isConnected: boolean;
	/** Team-scoped chapters fetch (aggregate tiles read every source). */
	fetchTimeline?: (sourceId: string) => Promise<TaskTimeline>;
	/** Open one source's record drawer (sources-card row click). */
	onOpenSource?: (sourceId: string) => void;
	/** Enable/disable this team deployment (the kill switch). */
	onSetDisabled: (disabled: boolean) => Promise<void>;
	/** Point this team at a version (Deploy version… and Rollback alike). */
	onDeployVersion: (version: number) => Promise<void>;
	/** Soft-remove this team deployment (history and artifacts survive). */
	onRemove?: () => Promise<void>;
}

/** Props for {@link TeamDeploymentRecordPanel}. `data` absent renders the
    loading/error body in the SAME panel — never a second mount. */
export interface ITeamDeploymentRecordPanelProps {
	/** Whether the drawer is open (renders nothing when closed). */
	open: boolean;
	/** Dismiss the drawer (close glyph / Escape / sliver). */
	onClose: () => void;
	/** Drawer title until the record names itself (e.g. 'Staging / proj'). */
	fallbackTitle: string;
	/** Load failure message (rendered as the body while data is absent). */
	loadError?: string;
	/** The loaded record; absent = loading (or failed, when loadError set). */
	data?: ITeamDeploymentRecordData;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	stateMessage: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--rr-text-secondary)',
		fontSize: 13.5,
	} as CSSProperties,
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: 14,
		marginBottom: 18,
		flexWrap: 'wrap',
	} as CSSProperties,
	chip: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		fontSize: 12,
		fontWeight: 600,
		border: '1px solid var(--rr-border)',
		borderRadius: 14,
		padding: '3px 11px',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	chipVersion: {
		borderColor: 'var(--rr-accent-faded)',
		color: 'var(--rr-brand)',
		background: 'color-mix(in srgb, var(--rr-brand) 6%, transparent)',
	} as CSSProperties,
	who: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	chipUpdate: {
		borderColor: 'var(--rr-accent-faded)',
		color: 'var(--rr-brand)',
		background: 'transparent',
		borderStyle: 'dashed',
	} as CSSProperties,
	// ── The per-source STATUS GRID (the team screen's centerpiece) ──────────
	gridHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(150px, 1fr) minmax(180px, 1.4fr) minmax(120px, 1fr) minmax(110px, 0.8fr)',
		gap: 10,
		alignItems: 'center',
		padding: '7px 14px',
		fontSize: 10.5,
		fontWeight: 700,
		letterSpacing: '0.06em',
		textTransform: 'uppercase' as const,
		color: 'var(--rr-text-secondary)',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	gridRow: (clickable: boolean): CSSProperties => ({
		display: 'grid',
		gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(150px, 1fr) minmax(180px, 1.4fr) minmax(120px, 1fr) minmax(110px, 0.8fr)',
		gap: 10,
		alignItems: 'center',
		padding: '9px 14px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12.5,
		cursor: clickable ? 'pointer' : 'default',
	}),
	outcome: (color: string): CSSProperties => ({
		fontWeight: 700,
		color,
	}),
	cellDetail: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	schedulePill: (on: boolean): CSSProperties => ({
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		borderRadius: 14,
		padding: '3px 11px',
		fontSize: 11.5,
		fontWeight: 600,
		border: `1px solid ${on ? 'color-mix(in srgb, var(--rr-color-success) 40%, transparent)' : 'var(--rr-border)'}`,
		background: on ? 'color-mix(in srgb, var(--rr-color-success) 10%, transparent)' : 'transparent',
		color: on ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
	}),
	/** Left-anchored destructive slot in the panel footer (footer is flex-end). */
	footerDanger: {
		marginRight: 'auto',
	} as CSSProperties,
	footerError: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		alignSelf: 'center',
	} as CSSProperties,
	pickerRow: (enabled: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '9px 12px',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		marginBottom: 8,
		cursor: enabled ? 'pointer' : 'default',
		opacity: enabled ? 1 : 0.55,
	}),
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one TEAM deployment as a wide record drawer with the team
 * operations in its footer (the record-panel standard).
 *
 * @param props - {@link ITeamDeploymentRecordPanelProps}.
 * @returns The drawer element, or null while closed.
 */
export const TeamDeploymentRecordPanel: React.FC<ITeamDeploymentRecordPanelProps> = ({ open, onClose, fallbackTitle, loadError, data }) => {
	// Default width per open: 75% of the current viewport (the DetailPanel
	// clamps to its usable band and a persisted drag width overrides).
	const width = useMemo(() => Math.round(window.innerWidth * DEFAULT_HOST_FRACTION), []);

	// --- Verb flow state (dialog-guarded; the record panel owns its verbs) ---

	const [disableOpen, setDisableOpen] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	// A staged pointer move awaiting confirmation (picker choice or rollback).
	const [pendingVersion, setPendingVersion] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	/** Run one verb with shared busy/error handling (dialogs close first). */
	const run = async (action: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await action();
			setDisableOpen(false);
			setRemoveOpen(false);
			setPickerOpen(false);
			setPendingVersion(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	// Rollback target = the most recent PREVIOUS version this team ran,
	// derived from the audit trail (falls back to the registry's next-older).
	const rollbackVersion = useMemo(() => {
		if (!data) return undefined;
		for (const row of data.history) {
			if ((row.action === 'deploy' || row.action === 'rollback') && row.version !== data.deployment.version) return row.version;
		}
		const older = data.versions.find((v) => v.version < data.deployment.version);
		return older?.version;
	}, [data]);

	// --- Aggregate run stats across every source's continuum ------------------
	// Refetched whenever the record refreshes (data identity changes on the
	// host's poll), so the tiles track live runs.

	const [timelines, setTimelines] = useState<Map<string, TaskTimeline>>(new Map());
	const fetchTimeline = data?.fetchTimeline;
	const schedules = data?.schedules;
	useEffect(() => {
		if (!fetchTimeline || !schedules) return;
		let cancelled = false;
		void (async () => {
			// Fetch every source's continuum concurrently — the effect re-runs
			// on each host refresh, so N serial round trips would stack up.
			// Per-source failures stay isolated (a never-run source has no
			// continuum — an empty timeline).
			const next = new Map<string, TaskTimeline>();
			await Promise.all(
				schedules.map(async (row) => {
					try {
						next.set(row.sourceId, await fetchTimeline(row.sourceId));
					} catch {
						// Isolated per-source failure — leave this source empty.
					}
				}),
			);
			if (!cancelled) setTimelines(next);
		})();
		return () => {
			cancelled = true;
		};
	}, [fetchTimeline, schedules]);

	// Per-source stats from each continuum: the latest chapter and the
	// 7-day run/failure counts — the grid's Last-run and Runs-7d columns.
	const sourceStats = useMemo(() => {
		const cutoff = Date.now() / 1000 - 7 * 24 * 3600;
		const stats = new Map<string, { latest: TaskTimeline['chapters'][number] | null; total: number; failed: number }>();
		for (const [sourceId, timeline] of timelines) {
			let latest: TaskTimeline['chapters'][number] | null = null;
			let total = 0;
			let failed = 0;
			for (const chapter of timeline.chapters) {
				if (!latest || chapter.beginTime > latest.beginTime) latest = chapter;
				if (chapter.beginTime >= cutoff) {
					total += 1;
					if (chapter.outcome && chapter.outcome !== 'ok') failed += 1;
				}
			}
			stats.set(sourceId, { latest, total, failed });
		}
		return stats;
	}, [timelines]);

	// --- History grid columns (stock CardDataGrid) ----------------------------

	const historyColumns: GridColumnDefinition[] = useMemo(
		() => [
			{
				title: 'When',
				field: 'at',
				rrType: 'date',
				rrDefault: true,
				rrDefaultSort: 'desc',
				rrDescription: 'When the action happened (local time); newest first.',
				formatter: (cell: CellComponent) => formatTime(cell.getValue() as number),
				width: 170,
			},
			{ title: 'Actor', field: 'actor', rrType: 'string', rrDefault: true, rrDescription: 'Who performed the action (denormalized — survives account deletion).', width: 160 },
			{
				title: 'Action',
				field: 'seq',
				rrNoPopup: true,
				rrDefault: true,
				rrDescription: 'What happened to this team deployment: deploys, rollbacks, enables/disables, removals; publishes ride along org-wide.',
				widthGrow: 3,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as DeployHistoryRow;
					// Past-tense verbs; 'pause'/'resume' appear only on rows
					// written before the enable/disable vocabulary.
					const verb = { publish: 'published', deploy: 'deployed', rollback: 'rolled back', enable: 'enabled', disable: 'disabled', errored: 'errored', remove: 'removed', pause: 'paused', resume: 'resumed' }[row.action] ?? row.action;
					return `${verb} v${row.version}${row.comment ? ` “${row.comment}”` : ''}`;
				},
			},
		],
		[]
	);

	if (!open) return null;

	// Not loaded yet: the SAME drawer shell with the state message — the
	// opening gesture is never a dead click and never a double slide-in.
	if (!data) {
		return (
			<DetailPanel open onClose={onClose} title={fallbackTitle} subtitle="Team deployment — every source this team runs" width={width} persistKey="panelTeamDeploymentWidth">
				<div style={S.stateMessage}>{loadError ? `Failed to load deployment: ${loadError}` : 'Loading deployment…'}</div>
			</DetailPanel>
		);
	}

	const { teamName, deployment, versions, schedules: sourceRows, runningSources = {}, canControl, onOpenSource, onSetDisabled, onDeployVersion, onRemove } = data;

	// The TEAM operations, right-anchored; Remove is the destructive outlier
	// at the LEFT edge (footer convention).
	const footer = canControl ? (
		<>
			{onRemove && (
				<span style={S.footerDanger}>
					<Button variant="danger" small disabled={busy} onClick={() => setRemoveOpen(true)}>
						Remove
					</Button>
				</span>
			)}
			{error && <span style={S.footerError}>{error}</span>}
			{deployment.state === 'disabled' ? (
				<Button variant="secondary" small disabled={busy} onClick={() => void run(() => onSetDisabled(false))}>
					Enable
				</Button>
			) : (
				<Button variant="secondary" small disabled={busy} onClick={() => setDisableOpen(true)}>
					Disable&hellip;
				</Button>
			)}
			{rollbackVersion !== undefined && (
				<Button variant="secondary" small disabled={busy} onClick={() => setPendingVersion(rollbackVersion)}>
					Rollback to v{rollbackVersion}
				</Button>
			)}
			<Button variant="primary" small disabled={busy} onClick={() => setPickerOpen(true)}>
				Deploy version&hellip;
			</Button>
		</>
	) : undefined;

	return (
		<>
			<DetailPanel open={open} onClose={onClose} title={`${teamName} / ${deployment.pipelineName}`} subtitle="Team deployment — every source this team runs" width={width} persistKey="panelTeamDeploymentWidth" busy={busy} {...(footer ? { footer } : {})}>
				{/* ── Deployment header (with the newer-version hint) ───────── */}
				<div style={S.header}>
					<h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{deployment.pipelineName}</h3>
					<span style={{ ...S.chip, ...S.chipVersion }}>v{deployment.version}</span>
					{versions.length > 0 && versions[0].version > deployment.version && (
						<span style={{ ...S.chip, ...S.chipUpdate }} title="A newer version is published — use Deploy version…">
							v{versions[0].version} available
						</span>
					)}
					<span style={{ ...S.chip, color: STATE_COLOR[deployment.state] }}>&#9679; {deployment.state}</span>
					<span style={S.who}>
						deployed by {deployment.deployedBy} &middot; {formatDayTime(deployment.deployedAt)}
					</span>
				</div>

				{/* ── Per-source STATUS GRID (the team screen's centerpiece):
				    every source's health side by side — last outcome, schedule,
				    next fire, 7-day failures. Rows drill into the source record. */}
				<div style={{ ...commonStyles.card, marginBottom: 18 }}>
					<div style={commonStyles.cardHeader}>
						<span>Sources</span>
						<span style={{ ...commonStyles.textMuted, fontSize: 11.5 }}>{onOpenSource ? 'click a row for runs, replay, and controls' : 'per source'}</span>
					</div>
					<div style={S.gridHeader}>
						<span>Source</span>
						<span>Last run</span>
						<span>Schedule</span>
						<span>Next run</span>
						<span>Runs (7d)</span>
					</div>
					{sourceRows.length > 0 ? (
						sourceRows.map((row, index) => {
							const running = Boolean(runningSources[row.sourceId]);
							const stats = sourceStats.get(row.sourceId);
							const outcome = stats?.latest ? (stats.latest.outcome ?? 'live') : null;
							const outcomeColor = outcome === 'ok' ? 'var(--rr-color-success)' : outcome === 'live' ? 'var(--rr-brand)' : outcome ? 'var(--rr-color-error)' : 'var(--rr-text-secondary)';
							const nextAt = data.nextRuns?.[row.sourceId];
							return (
								<div key={row.sourceId} style={{ ...S.gridRow(Boolean(onOpenSource)), ...(index === sourceRows.length - 1 ? { borderBottom: 'none' } : {}) }} onClick={() => onOpenSource?.(row.sourceId)} title={onOpenSource ? 'Open this source' : undefined}>
									<span style={{ fontWeight: 600 }}>
										{row.sourceName || row.sourceId}
										{running && <span style={{ ...S.schedulePill(true), borderStyle: 'dashed', marginLeft: 8 }}>running</span>}
									</span>
									<span>
										{outcome ? <span style={S.outcome(outcomeColor)}>{outcome.toUpperCase()}</span> : <span style={S.cellDetail}>no runs yet</span>}
										{stats?.latest ? <div style={S.cellDetail}>{formatTime(stats.latest.beginTime)}</div> : null}
									</span>
									<span>
										<span style={S.schedulePill(Boolean(row.cron) && !row.paused)}>{row.cron ? `${describeCron(row.cron)}${row.ttl ? ` · ${describeTtl(row.ttl)}` : ''}${row.paused ? ' · paused' : ''}` : 'manual'}</span>
									</span>
									<span>{deployment.state !== 'enabled' ? <span style={S.cellDetail}>{deployment.state}</span> : row.paused ? <span style={S.cellDetail}>paused</span> : nextAt ? formatTime(nextAt) : <span style={S.cellDetail}>&mdash;</span>}</span>
									<span>
										{stats?.total ?? 0}
										{stats && stats.failed > 0 ? <span style={{ ...S.cellDetail, color: 'var(--rr-color-error)' }}> · {stats.failed} failed</span> : null}
									</span>
								</div>
							);
						})
					) : (
						<div style={commonStyles.empty}>No sources</div>
					)}
				</div>

				{/* ── History (stock grid) ──────────────────────────────────── */}
				<Card noBodyPadding>
					<CardDataGrid<DeployHistoryRow & Record<string, unknown>> title="History" columns={historyColumns} data={data.history as Array<DeployHistoryRow & Record<string, unknown>>} tableId="team-deployment-history" emptyTitle="No history" emptyDescription="Deploys, rollbacks, enables/disables, and removals land here, immutable." />
				</Card>
			</DetailPanel>

			{/* ── Disable confirmation ────────────────────────────────────── */}
			{disableOpen && <ConfirmDialog title={`Disable ${deployment.pipelineName} on ${teamName}?`} message="Nothing runs — schedules stop firing and manual runs are refused — until you enable it again. Nothing is removed." confirmLabel="Disable" cancelLabel="Cancel" onConfirm={() => void run(() => onSetDisabled(true))} onCancel={() => setDisableOpen(false)} />}

			{/* ── Remove (soft) confirmation ──────────────────────────────── */}
			{removeOpen && onRemove && (
				<ConfirmDialog
					title={`Remove from ${teamName}?`}
					message={`Takes ${deployment.pipelineName} off ${teamName}: schedules stop firing and the deployment leaves all listings. This is a SOFT remove — the audit history and every published version survive, and deploying any version to ${teamName} revives it.`}
					confirmLabel="Remove"
					cancelLabel="Cancel"
					onConfirm={() => {
						setRemoveOpen(false);
						void run(() => onRemove());
					}}
					onCancel={() => setRemoveOpen(false)}
				/>
			)}

			{/* ── Pointer-move confirmation (deploy and rollback alike) ───── */}
			{pendingVersion !== null && <ConfirmDialog title={pendingVersion < deployment.version ? `Roll ${teamName} back to v${pendingVersion}?` : `Deploy v${pendingVersion} to ${teamName}?`} message={`${teamName} currently runs v${deployment.version}. Its next runs will execute v${pendingVersion} — schedules and history carry over.`} confirmLabel={pendingVersion < deployment.version ? 'Rollback' : 'Deploy'} cancelLabel="Cancel" onConfirm={() => void run(() => onDeployVersion(pendingVersion))} onCancel={() => setPendingVersion(null)} />}

			{/* ── Deploy version… picker (stages a confirmation) ──────────── */}
			{pickerOpen && (
				<Modal
					title="Deploy version…"
					onClose={() => setPickerOpen(false)}
					footer={
						<Button variant="secondary" disabled={busy} onClick={() => setPickerOpen(false)}>
							Cancel
						</Button>
					}
				>
					<div style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', marginBottom: 10 }}>Points {teamName} at the chosen registry version. An older version is a rollback &mdash; same gesture.</div>
					{versions.map((v) => {
						const isCurrent = v.version === deployment.version;
						return (
							<div
								key={v.version}
								style={S.pickerRow(!busy && !isCurrent)}
								onClick={() => {
									if (!busy && !isCurrent) {
										setPickerOpen(false);
										setPendingVersion(v.version);
									}
								}}
							>
								<span style={{ fontWeight: 700 }}>v{v.version}</span>
								<span style={{ fontSize: 11.5, color: 'var(--rr-text-secondary)' }}>
									{v.publishedBy} &middot; {formatTime(v.publishedAt)}
									{v.comment ? <> &middot; &ldquo;{v.comment}&rdquo;</> : null}
								</span>
								<span style={{ ...commonStyles.textMuted, fontSize: 11.5, marginLeft: 'auto' }}>{isCurrent ? 'current' : v.version < deployment.version ? 'rollback' : 'upgrade'}</span>
							</div>
						);
					})}
				</Modal>
			)}
		</>
	);
};
