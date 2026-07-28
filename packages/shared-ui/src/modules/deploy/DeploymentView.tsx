// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploymentView — the file-less deployment tab (mockup v5, screen A).
 *
 * One team's deployment of one project, constructed entirely from ids —
 * no file behind it. Page strip: STATUS (header + stat tiles + latest-run
 * strip + schedules + history) | RUNS (the per-source SourcePanels bound
 * to the team's deploy continuum — DVR, report cards) | DESIGN (readonly
 * render of the immutable registry artifact, no save affordances).
 *
 * Operational surface: per-source Run/Stop (the smoke-test path), a
 * DetailPanel schedule editor (cron + enabled + server-previewed next
 * occurrences — nothing client-side parses cron), and confirmations on
 * every action that changes what an environment executes (deploy/rollback,
 * pause, stop, remove, schedule clear). History renders in the stock
 * CardDataGrid per the style guide.
 *
 * All data flows in as view models; actions flow out as async callbacks;
 * the run-log adapters are team-scoped closures the host binds to
 * client.log with this team's id.
 */

import React, { useEffect, useMemo, useState, CSSProperties, ComponentProps } from 'react';

import { commonStyles } from '../../themes/styles';
import { Button } from '../../components/button/Button';
import { Modal } from '../../components/modal/Modal';
import { ConfirmDialog } from '../../components/modal/ConfirmDialog';
import { Card } from '../../components/card/Card';
import { CardDataGrid } from '../../components/data-grid/CardDataGrid';
import { ContentHeader } from '../../components/content-header/ContentHeader';
import { TabControl } from '../../components/tab-control/TabControl';
import { TabPanel } from '../../components/tab-panel/TabPanel';
import CanvasPanel from '../../components/canvas';
import { SourcePanel } from '../project/components/SourcePanel';
import { SchedulePanel, describeCron, describeTtl } from './components/SchedulePanel';
import { OAUTH_ROOT_URL } from '../../config/oauth';
import { formatTime } from '../server/util/formatters';
import type { CellComponent } from 'tabulator-tables';
import type { GridColumnDefinition } from '../../components/data-grid/defaults';
import type { ViewMenu } from '../../types/viewMenu';
import type { TaskEventSession, TaskTimeline } from '../project/hooks/useTaskEvents';
import type { DeployHistoryRow, DeployScheduleRow, DeployVersionCard } from './types';

// =============================================================================
// PROPS
// =============================================================================

/** The deployment header state rendered on the STATUS page. */
export interface DeploymentInfo {
	/** Pipeline display name (from the registry artifact). */
	pipelineName: string;
	/** The registry version this team points at. */
	version: number;
	state: 'active' | 'paused' | 'errored' | 'removed';
	/** Deployed-by attribution (display name). */
	deployedBy: string;
	/** Unix seconds of the pointer move. */
	deployedAt: number;
}

/** Cron preview result (THE single evaluator, proxied by the host). */
export interface SchedulePreviewResult {
	valid?: boolean;
	error?: string;
	next?: number[];
}

/** Props for {@link DeploymentView}. */
export interface IDeploymentViewProps {
	/** Team display name (tab context, e.g. 'Production'). */
	teamName: string;
	/** The deployment record (header + state). */
	deployment: DeploymentInfo;
	/** The immutable registry artifact this team runs (readonly DESIGN). */
	pipeline: ComponentProps<typeof CanvasPanel>['project'];
	/** Service catalog for the readonly canvas render. */
	servicesJson: ComponentProps<typeof CanvasPanel>['servicesJson'];
	/** Pipeline validation passthrough (the canvas requires one). */
	handleValidatePipeline: ComponentProps<typeof CanvasPanel>['handleValidatePipeline'];
	/** Per-source schedules, for the STATUS schedules panel. */
	schedules: DeployScheduleRow[];
	/** This team's audit history, newest first. */
	history: DeployHistoryRow[];
	/** Registry versions (the Deploy version… / Rollback pickers). */
	versions: DeployVersionCard[];
	/** Next scheduled occurrence (host-previewed), if any schedule is armed. */
	nextRun?: { at: number; sourceId: string; cron: string };
	/** sourceId -> true while a run of that source is live on the server. */
	runningSources?: Record<string, boolean>;
	/** Caller holds task.control on this team (actions render only then). */
	canControl: boolean;
	isConnected: boolean;
	isSubscribed?: boolean;
	serverHost?: string;
	/** Team-scoped DVR session factory for one source's deploy continuum. */
	openSession?: (sourceId: string) => TaskEventSession;
	/** Team-scoped chapters fetch for one source's deploy continuum. */
	fetchTimeline?: (sourceId: string) => Promise<TaskTimeline>;
	/** Pause / resume this team deployment. */
	onSetPaused: (paused: boolean) => Promise<void>;
	/** Point this team at a version (Deploy version… and Rollback alike). */
	onDeployVersion: (version: number) => Promise<void>;
	/** Soft-remove this team deployment (schedules stop; history survives). */
	onRemove: (() => Promise<void>) | undefined;
	/** Start one source NOW (the manual smoke-test dispatch). */
	onRunSource?: (sourceId: string) => Promise<void>;
	/** Stop one source's live run. */
	onStopSource?: (sourceId: string) => Promise<void>;
	/** Set (cron string) or clear (null) one source's schedule + run window. */
	onSetSchedule?: (sourceId: string, cron: string | null, enabled: boolean, ttl: number | null) => Promise<void>;
	/** Cron preview via the server's single evaluator. */
	previewSchedule?: (cron: string, count: number) => Promise<SchedulePreviewResult>;
	onOpenLink?: (url: string, displayName?: string) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
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
	actions: {
		marginLeft: 'auto',
		display: 'flex',
		gap: 8,
	} as CSSProperties,
	tiles: {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, 1fr)',
		gap: 12,
		marginBottom: 20,
	} as CSSProperties,
	tile: {
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		padding: '12px 14px',
		background: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	tileValue: {
		fontSize: 20,
		fontWeight: 700,
		marginTop: 4,
	} as CSSProperties,
	tileDetail: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,
	scheduleRow: (clickable: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '8px 14px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12.5,
		cursor: clickable ? 'pointer' : 'default',
	}),
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
	errorText: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		marginTop: 8,
	} as CSSProperties,
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	} as CSSProperties,
	pageBody: {
		// NO overflow here: the stock TabPanel panels are the single
		// scroll region — the strip and the title above stay pinned.
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
	} as CSSProperties,
	canvasPadding: {
		height: '100%',
		minHeight: 480,
	} as CSSProperties,
	previewList: {
		margin: '10px 0 0',
		padding: '10px 12px',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		fontSize: 12.5,
		lineHeight: 1.7,
	} as CSSProperties,
};

/** State → chip color for the header state chip. */
const STATE_COLOR: Record<DeploymentInfo['state'], string> = {
	active: 'var(--rr-color-success)',
	paused: 'var(--rr-text-secondary)',
	errored: 'var(--rr-color-error)',
	removed: 'var(--rr-text-disabled)',
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The deployment tab: STATUS | RUNS | DESIGN (READONLY) over one team's
 * deployment. See the module docstring.
 */
export const DeploymentView: React.FC<IDeploymentViewProps> = ({ teamName, deployment, pipeline, servicesJson, handleValidatePipeline, schedules, history, versions, nextRun, runningSources = {}, canControl, isConnected, isSubscribed, serverHost, openSession, fetchTimeline, onSetPaused, onDeployVersion, onRemove, onRunSource, onStopSource, onSetSchedule, previewSchedule, onOpenLink }) => {
	const [mode, setMode] = useState<'status' | 'runs' | 'design'>('status');
	// The canvas must NOT initialize inside a hidden panel: a display:none
	// container measures 0x0 and the viewport fit computes garbage. Mount
	// it on the page's FIRST activation (then keep it mounted for state).
	const [designVisited, setDesignVisited] = useState(false);
	useEffect(() => {
		if (mode === 'design') setDesignVisited(true);
	}, [mode]);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [pauseOpen, setPauseOpen] = useState(false);
	// A staged pointer move awaiting confirmation (picker choice or rollback).
	const [pendingVersion, setPendingVersion] = useState<number | null>(null);
	// A staged stop awaiting confirmation.
	const [pendingStop, setPendingStop] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	// --- Schedule editor (SchedulePanel) state --------------------------------

	// The source whose schedule is being edited; null = panel closed.
	const [editSource, setEditSource] = useState<string | null>(null);

	/** Open the v4 schedule panel for one source. */
	const openScheduleEditor = (row: DeployScheduleRow): void => {
		setEditSource(row.sourceId);
		setError('');
	};

	// --- Sources from the ARTIFACT pipeline (same derivation as ProjectView) --

	const components = useMemo(() => (Array.isArray(pipeline?.components) ? pipeline.components : []), [pipeline]);
	const sources = useMemo(
		() =>
			components
				.filter((c: { config?: { mode?: string } }) => c.config?.mode === 'Source')
				.map((c: { id?: string; name?: string; provider?: string }) => ({ id: c.id || c.name || c.provider || '', name: c.name || c.id || c.provider || '' }))
				.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
		[components]
	);
	const componentNames: Map<string, string> = useMemo(() => {
		const map = new Map<string, string>();
		for (const c of components) {
			if (c.id && c.name) map.set(c.id, c.name);
		}
		return map;
	}, [components]);
	const projectId: string = (pipeline as { project_id?: string })?.project_id ?? '';

	// --- Run stats from the team continuum (tiles + latest-run strip) ---------
	// Refetched whenever the host's data refresh cycles (schedules identity
	// changes on every poll fetch), so the tiles track live runs.
	const [timelines, setTimelines] = useState<Map<string, TaskTimeline>>(new Map());
	useEffect(() => {
		if (!fetchTimeline || !isConnected) return;
		let cancelled = false;
		void (async () => {
			const next = new Map<string, TaskTimeline>();
			for (const src of sources) {
				try {
					next.set(src.id, await fetchTimeline(src.id));
				} catch {
					// A never-run source has no continuum — an empty timeline.
				}
			}
			if (!cancelled) setTimelines(next);
		})();
		return () => {
			cancelled = true;
		};
	}, [fetchTimeline, isConnected, sources, schedules]);

	// The newest chapter across all sources = the deployment's latest run.
	const latest = useMemo(() => {
		let best: { sourceId: string; chapter: TaskTimeline['chapters'][number] } | null = null;
		for (const [sourceId, timeline] of timelines) {
			for (const chapter of timeline.chapters) {
				if (!best || chapter.beginTime > best.chapter.beginTime) best = { sourceId, chapter };
			}
		}
		return best;
	}, [timelines]);

	// Runs in the last 7 days + failures, across every source continuum.
	const runs7d = useMemo(() => {
		const cutoff = Date.now() / 1000 - 7 * 24 * 3600;
		let total = 0;
		let failed = 0;
		for (const timeline of timelines.values()) {
			for (const chapter of timeline.chapters) {
				if (chapter.beginTime >= cutoff) {
					total += 1;
					if (chapter.outcome && chapter.outcome !== 'ok') failed += 1;
				}
			}
		}
		return { total, failed };
	}, [timelines]);

	/** Run one async action with shared busy/error handling. */
	const run = async (action: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await action();
			setPickerOpen(false);
			setPendingVersion(null);
			setPendingStop(null);
			setPauseOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	// Rollback target = the most recent PREVIOUS version this team ran,
	// derived from the audit trail (falls back to version - 1 in the registry).
	const rollbackVersion = useMemo(() => {
		for (const row of history) {
			if ((row.action === 'deploy' || row.action === 'rollback') && row.version !== deployment.version) return row.version;
		}
		const older = versions.find((v) => v.version < deployment.version);
		return older?.version;
	}, [history, versions, deployment.version]);

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
				rrDescription: 'What happened to this team deployment: deploys, rollbacks, pauses, removals; publishes ride along org-wide.',
				widthGrow: 3,
				formatter: (cell: CellComponent) => {
					const row = cell.getRow().getData() as DeployHistoryRow;
					const verb = row.action === 'publish' ? 'published' : row.action === 'deploy' ? 'deployed' : row.action;
					return `${verb} v${row.version}${row.comment ? ` “${row.comment}”` : ''}`;
				},
			},
		],
		[]
	);

	// --- Page strip -----------------------------------------------------------

	const viewMenu: ViewMenu = useMemo(
		() => ({
			entries: [
				{ id: 'status', label: 'Status' },
				{ id: 'runs', label: 'Runs' },
				{ id: 'design', label: 'Design (Readonly)' },
			],
		}),
		[]
	);

	const editRow = editSource !== null ? schedules.find((row) => row.sourceId === editSource) : undefined;

	// --- STATUS page ----------------------------------------------------------

	const statusPage = (
		<div style={commonStyles.tabContent}>
			{/* ── Deployment header ─────────────────────────────────────── */}
			<div style={S.header}>
				<h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{deployment.pipelineName}</h3>
				<span style={{ ...S.chip, ...S.chipVersion }}>v{deployment.version}</span>
				<span style={{ ...S.chip, color: STATE_COLOR[deployment.state] }}>&#9679; {deployment.state}</span>
				<span style={S.who}>
					deployed by {deployment.deployedBy} &middot; {formatTime(deployment.deployedAt)}
				</span>
				{canControl && (
					<div style={S.actions}>
						{deployment.state === 'paused' ? (
							<Button variant="secondary" small disabled={busy} onClick={() => void run(() => onSetPaused(false))}>
								Resume
							</Button>
						) : (
							<Button variant="secondary" small disabled={busy} onClick={() => setPauseOpen(true)}>
								Pause
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
						{onRemove && (
							<Button variant="danger" small disabled={busy} onClick={() => setRemoveOpen(true)}>
								Remove
							</Button>
						)}
					</div>
				)}
			</div>
			{error && !pickerOpen && pendingVersion === null && !removeOpen && !pauseOpen && editSource === null && <div style={{ ...S.errorText, marginBottom: 12 }}>{error}</div>}

			{/* ── Stat tiles ────────────────────────────────────────────── */}
			<div style={S.tiles}>
				<div style={S.tile}>
					<div style={commonStyles.labelUppercase}>Last run</div>
					<div style={{ ...S.tileValue, color: latest?.chapter.outcome === 'ok' ? 'var(--rr-color-success)' : latest?.chapter.outcome ? 'var(--rr-color-error)' : undefined }}>{latest ? (latest.chapter.outcome ?? 'live').toUpperCase() : '—'}</div>
					<div style={S.tileDetail}>{latest ? `${formatTime(latest.chapter.beginTime)} · ${componentNames.get(latest.sourceId) ?? latest.sourceId}` : 'no runs yet'}</div>
				</div>
				<div style={S.tile}>
					<div style={commonStyles.labelUppercase}>Next run</div>
					<div style={S.tileValue}>{nextRun ? formatTime(nextRun.at) : '—'}</div>
					<div style={S.tileDetail}>{nextRun ? `${componentNames.get(nextRun.sourceId) ?? nextRun.sourceId} · ${describeCron(nextRun.cron)}` : deployment.state === 'paused' ? 'paused' : 'no schedule'}</div>
				</div>
				<div style={S.tile}>
					<div style={commonStyles.labelUppercase}>Runs (7d)</div>
					<div style={S.tileValue}>{runs7d.total}</div>
					<div style={S.tileDetail}>{runs7d.failed > 0 ? `${runs7d.failed} failed` : 'all ok'}</div>
				</div>
			</div>

			{/* ── Schedules + run/stop per source ───────────────────────── */}
			<div style={{ ...commonStyles.card, marginBottom: 18 }}>
				<div style={commonStyles.cardHeader}>
					<span>Schedules</span>
					<span style={{ ...commonStyles.textMuted, fontSize: 11.5 }}>{canControl && onSetSchedule ? 'per source · click a row to edit' : 'per source'}</span>
				</div>
				{/* Rows carry NO verbs (house rule: row click opens the record
				    panel and every verb lives in its footer). */}
				{schedules.length > 0 ? (
					schedules.map((row, index) => {
						const running = Boolean(runningSources[row.sourceId]);
						const editable = canControl && Boolean(onSetSchedule);
						return (
							<div key={row.sourceId} style={{ ...S.scheduleRow(editable), ...(index === schedules.length - 1 ? { borderBottom: 'none' } : {}) }} onClick={() => editable && openScheduleEditor(row)} title={editable ? 'Open schedule' : undefined}>
								<span style={{ fontWeight: 600, minWidth: 160 }}>{row.sourceName || row.sourceId}</span>
								<span style={S.schedulePill(Boolean(row.cron) && row.enabled)}>{row.cron ? `${describeCron(row.cron)}${row.ttl ? ` · ${describeTtl(row.ttl)}` : ''}${row.enabled ? '' : ' · disabled'}` : 'manual'}</span>
								{running && <span style={{ ...S.schedulePill(true), borderStyle: 'dashed' }}>running</span>}
								{row.lastRunAt ? <span style={{ fontSize: 11.5, color: 'var(--rr-text-secondary)' }}>last fired {formatTime(row.lastRunAt)}</span> : null}
							</div>
						);
					})
				) : (
					<div style={commonStyles.empty}>No sources</div>
				)}
			</div>

			{/* ── History (stock grid) ──────────────────────────────────── */}
			<Card noBodyPadding>
				<CardDataGrid<DeployHistoryRow & Record<string, unknown>> title="History" columns={historyColumns} data={history as Array<DeployHistoryRow & Record<string, unknown>>} tableId="deployment-history" emptyTitle="No history" emptyDescription="Deploys, rollbacks, pauses, and removals land here, immutable." />
			</Card>
		</div>
	);

	// --- RUNS page ------------------------------------------------------------

	const runsPage = <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src: { id: string; name: string }) => <SourcePanel key={`${src.id}.deploy`} source={src} runKind="deploy" projectId={projectId} liveEvents={[]} openSession={openSession ? () => openSession(src.id) : null} fetchTimeline={fetchTimeline ? () => fetchTimeline(src.id) : null} componentNames={componentNames} isConnected={isConnected} isSubscribed={isSubscribed} isReadonly serverHost={serverHost} onOpenLink={onOpenLink} />) : <div style={commonStyles.empty}>No source components found</div>}</div>;

	// --- DESIGN page (readonly artifact render) -------------------------------

	const designPage = <div style={S.canvasPadding}>{pipeline && designVisited && <CanvasPanel oauth2RootUrl={OAUTH_ROOT_URL} project={pipeline} servicesJson={servicesJson} handleValidatePipeline={handleValidatePipeline} isConnected={isConnected} isSubscribed={isSubscribed} serverHost={serverHost} onOpenLink={onOpenLink} isReadonly />}</div>;

	// --- Render ---------------------------------------------------------------

	return (
		<div style={S.container}>
			<TabControl menu={viewMenu} activeId={mode} onSelect={(id) => setMode(id as 'status' | 'runs' | 'design')} />
			{/* Title is PINNED with the strip; only the page body scrolls. The
			    canvas page carries no header (the ProjectView design-page rule —
			    the canvas is a full-bleed surface). */}
			{mode !== 'design' && <ContentHeader title={`${teamName} / ${deployment.pipelineName}`} subtitle={mode === 'status' ? 'Deployment status' : 'Scheduled runs — team continuum'} />}
			<div style={S.pageBody}>
				<TabPanel
					panels={{
						status: { content: statusPage },
						runs: { content: runsPage },
						design: { content: designPage },
					}}
					activeId={mode}
				/>
			</div>

			{/* ── Pause confirmation ────────────────────────────────────── */}
			{pauseOpen && <ConfirmDialog title={`Pause ${deployment.pipelineName} on ${teamName}?`} message="Scheduled runs stop firing until you resume. Nothing is removed." confirmLabel="Pause" cancelLabel="Cancel" onConfirm={() => void run(() => onSetPaused(true))} onCancel={() => setPauseOpen(false)} />}

			{/* ── Stop-run confirmation ─────────────────────────────────── */}
			{pendingStop !== null && onStopSource && <ConfirmDialog title={`Stop ${pendingStop}?`} message="Terminates the live run of this source. Everything logged so far stays in the team continuum." confirmLabel="Stop run" cancelLabel="Cancel" onConfirm={() => void run(() => onStopSource(pendingStop))} onCancel={() => setPendingStop(null)} />}

			{/* ── Remove (soft) confirmation ────────────────────────────── */}
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

			{/* ── Pointer-move confirmation (deploy and rollback alike) ─── */}
			{pendingVersion !== null && <ConfirmDialog title={pendingVersion < deployment.version ? `Roll ${teamName} back to v${pendingVersion}?` : `Deploy v${pendingVersion} to ${teamName}?`} message={`${teamName} currently runs v${deployment.version}. Its next runs will execute v${pendingVersion} — schedules and history carry over.`} confirmLabel={pendingVersion < deployment.version ? 'Rollback' : 'Deploy'} cancelLabel="Cancel" onConfirm={() => void run(() => onDeployVersion(pendingVersion))} onCancel={() => setPendingVersion(null)} />}

			{/* ── Deploy version… picker (stages a confirmation) ────────── */}
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

			{/* ── Schedule editor (the v4 mockup panel) ─────────────────── */}
			{editSource !== null && (
				<SchedulePanel
					open
					sourceId={editSource}
					sourceName={componentNames.get(editSource) ?? editSource}
					teamName={teamName}
					pipelineName={deployment.pipelineName}
					initialCron={editRow?.cron ?? ''}
					{...(editRow?.ttl ? { initialTtl: editRow.ttl } : {})}
					onSave={async (cron, ttl) => {
						await onSetSchedule?.(editSource, cron, true, ttl);
					}}
					onClose={() => setEditSource(null)}
					{...(previewSchedule ? { previewSchedule } : {})}
					running={Boolean(runningSources[editSource])}
					{...(canControl && onRunSource && deployment.state === 'active' ? { onRunNow: () => void run(() => onRunSource(editSource)) } : {})}
					{...(canControl && onStopSource ? { onStopRun: () => setPendingStop(editSource) } : {})}
				/>
			)}
		</div>
	);
};
