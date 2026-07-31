// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeploymentView — the file-less deployment tab (mockup v5, screen A).
 *
 * One team's deployment of one project, FOCUSED on a single source — a
 * task IS project.source, so the record is the (team, project, source)
 * combination, never the whole pipeline. Page strip: STATUS (header +
 * stat tiles + history) | RUNS (the focused source's SourcePanel bound
 * to the team's deploy continuum — DVR, report cards) | DESIGN (readonly
 * render of the immutable registry artifact, no save affordances).
 *
 * Schedules are NOT here: they are edited on the DEPLOY page (the
 * where-live pill opens the SchedulePanel). Run/Stop for the focused
 * source live in the record panel's footer (verbs-in-footer rule, next
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
import { Button } from '../button/Button';
import { Modal } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { Card } from '../card/Card';
import { CardDataGrid } from '../data-grid/CardDataGrid';
import { ContentHeader } from '../content-header/ContentHeader';
import { TabControl } from '../tab-control/TabControl';
import { TabPanel } from '../tab-panel/TabPanel';
import CanvasPanel from '../canvas';
import { SourcePanel } from '../../modules/project/components/SourcePanel';
import { describeCron } from './SchedulePanel';
import { OAUTH_ROOT_URL } from '../../config/oauth';
import { formatTime } from '../../modules/server/util/formatters';
import type { CellComponent } from 'tabulator-tables';
import type { GridColumnDefinition } from '../data-grid/defaults';
import type { ViewMenu } from '../../types/viewMenu';
import type { TaskEventMessage, TaskEventSession, TaskTimeline } from '../../modules/project/hooks/useTaskEvents';
import { DEPLOY_ACTION_VERBS } from './types';
import type { DeployHistoryRow } from './types';

// =============================================================================
// PROPS
// =============================================================================

/** The deployment header state rendered on the STATUS page. */
export interface DeploymentInfo {
	/** Pipeline display name (from the registry artifact). */
	pipelineName: string;
	/** The registry version this team points at. */
	version: number;
	state: 'enabled' | 'disabled' | 'errored' | 'removed';
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
	/**
	 * Document display name for the pinned page header. When provided, the
	 * non-canvas pages render a stock {@link ContentHeader} titled with it
	 * (the ProjectView/MonitorView convention). A DRAWER host omits it — the
	 * DetailPanel's EntityHeader already names the deployment, and a second
	 * in-view title would double it.
	 */
	documentTitle?: string;
	/** The deployment record (header + state). */
	deployment: DeploymentInfo;
	/** The immutable registry artifact this team runs (readonly DESIGN). */
	pipeline: ComponentProps<typeof CanvasPanel>['project'];
	/** Service catalog for the readonly canvas render. */
	servicesJson: ComponentProps<typeof CanvasPanel>['servicesJson'];
	/** Pipeline validation passthrough (the canvas requires one). */
	handleValidatePipeline: ComponentProps<typeof CanvasPanel>['handleValidatePipeline'];
	/** The FOCUSED source id — this record is (team, project, source). */
	sourceId: string;
	/** Focused source display name (falls back to the id). */
	sourceName?: string;
	/** The focused source's EFFECTIVE execution settings (panel-staged over
	    server truth); absent hides the Execution card. */
	sourceConfig?: { traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut: boolean };
	/** Stage an execution-settings change (the PANEL owns dirty/Save). */
	onSourceConfigChange?: (next: { traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut: boolean }) => void;
	/** This team's audit history, newest first. */
	history: DeployHistoryRow[];
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
	/**
	 * Host-fed live events for THIS team's deploy runs (stamped bodies,
	 * already team-filtered via isTeamLiveEvent) — the RUNS page routes
	 * them per source so the report cards track live without polling.
	 */
	liveEvents?: TaskEventMessage[];
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
	configRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '10px 14px',
		borderBottom: '1px solid var(--rr-border)',
		fontSize: 12.5,
	} as CSSProperties,
	configLabel: {
		fontWeight: 600,
		minWidth: 110,
	} as CSSProperties,
	configSelect: {
		padding: '4px 8px',
		border: '1px solid var(--rr-border)',
		borderRadius: 4,
		background: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		fontSize: 12.5,
	} as CSSProperties,
	configHint: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	configCheck: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 7,
		cursor: 'pointer',
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
	enabled: 'var(--rr-color-success)',
	disabled: 'var(--rr-text-secondary)',
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
export const DeploymentView: React.FC<IDeploymentViewProps> = ({ teamName, documentTitle, deployment, pipeline, servicesJson, handleValidatePipeline, sourceId, sourceName, sourceConfig, onSourceConfigChange, history, nextRun, runningSources = {}, canControl, isConnected, isSubscribed, serverHost, openSession, fetchTimeline, liveEvents, onOpenLink }) => {
	const [mode, setMode] = useState<'status' | 'runs' | 'design'>('status');
	// The canvas must NOT initialize inside a hidden panel: a display:none
	// container measures 0x0 and the viewport fit computes garbage. Mount
	// it on the page's FIRST activation (then keep it mounted for state).
	const [designVisited, setDesignVisited] = useState(false);
	useEffect(() => {
		if (mode === 'design') setDesignVisited(true);
	}, [mode]);
	// --- The focused source, verified against the ARTIFACT pipeline -----------

	const components = useMemo(() => (Array.isArray(pipeline?.components) ? pipeline.components : []), [pipeline]);
	// One entry: the focused source (name from the artifact when present).
	const sources = useMemo(
		() =>
			components
				.filter((c: { config?: { mode?: string } }) => c.config?.mode === 'Source')
				.map((c: { id?: string; name?: string; provider?: string }) => ({ id: c.id || c.name || c.provider || '', name: c.name || c.id || c.provider || '' }))
				.filter((src: { id: string }) => src.id === sourceId),
		[components, sourceId]
	);
	const componentNames: Map<string, string> = useMemo(() => {
		const map = new Map<string, string>();
		for (const c of components) {
			if (c.id && c.name) map.set(c.id, c.name);
		}
		return map;
	}, [components]);
	const projectId: string = (pipeline as { project_id?: string })?.project_id ?? '';

	// --- Run stats from the focused source's continuum (tiles) ----------------
	// Refetched whenever the host's data refresh cycles (the pipeline object
	// is re-set on every poll fetch, re-minting `sources`), so the tiles
	// track live runs.
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
	}, [fetchTimeline, isConnected, sources]);

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
					const verb = DEPLOY_ACTION_VERBS[row.action] ?? row.action;
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

	// --- STATUS page ----------------------------------------------------------

	const statusPage = (
		<div style={commonStyles.tabContent}>
			{/* ── Deployment header ─────────────────────────────────────── */}
			<div style={S.header}>
				<h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{deployment.pipelineName}</h3>
				<span style={{ ...S.chip, ...S.chipVersion }}>v{deployment.version}</span>
				<span style={{ ...S.chip, color: STATE_COLOR[deployment.state] }}>&#9679; {deployment.state}</span>
				<span style={S.chip}>{sourceName || sourceId}</span>
				<span style={S.who}>
					deployed by {deployment.deployedBy} &middot; {formatTime(deployment.deployedAt)}
				</span>
			</div>

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
					<div style={S.tileDetail}>{nextRun ? `${componentNames.get(nextRun.sourceId) ?? nextRun.sourceId} · ${describeCron(nextRun.cron)}` : deployment.state === 'disabled' ? 'disabled' : 'no schedule'}</div>
				</div>
				<div style={S.tile}>
					<div style={commonStyles.labelUppercase}>Runs (7d)</div>
					<div style={S.tileValue}>{runs7d.total}</div>
					<div style={S.tileDetail}>{runs7d.failed > 0 ? `${runs7d.failed} failed` : 'all ok'}</div>
				</div>
			</div>

			{/* ── Execution settings (trace level + debug output) ────────
			    Rides every deploy run of THIS source, like the dev-run
			    settings page. The PANEL owns staging + Save/Cancel. */}
			{sourceConfig && (
				<div style={{ ...commonStyles.card, marginBottom: 18 }}>
					<div style={commonStyles.cardHeader}>
						<span>Execution</span>
						<span style={{ ...commonStyles.textMuted, fontSize: 11.5 }}>applies to every run of this source</span>
					</div>
					<div style={S.configRow}>
						<span style={S.configLabel}>Trace level</span>
						{/* Unset renders as the effective default (full); picking a
						    value persists it explicitly. */}
						<select style={S.configSelect} value={sourceConfig.traceLevel ?? 'full'} disabled={!canControl || !onSourceConfigChange} onChange={(e) => onSourceConfigChange?.({ ...sourceConfig, traceLevel: e.target.value as Exclude<typeof sourceConfig.traceLevel, null> })}>
							<option value="none">none</option>
							<option value="metadata">metadata</option>
							<option value="summary">summary</option>
							<option value="full">full</option>
						</select>
						<span style={S.configHint}>Controls tracing verbosity for this source&rsquo;s deploy runs.</span>
					</div>
					<div style={{ ...S.configRow, borderBottom: 'none' }}>
						<span style={S.configLabel}>Debug output</span>
						<label style={S.configCheck}>
							<input type="checkbox" checked={sourceConfig.debugOut} disabled={!canControl || !onSourceConfigChange} onChange={(e) => onSourceConfigChange?.({ ...sourceConfig, debugOut: e.target.checked })} />
							Enable full debug output
						</label>
					</div>
				</div>
			)}

			{/* ── History (stock grid) ──────────────────────────────────── */}
			<Card noBodyPadding>
				<CardDataGrid<DeployHistoryRow & Record<string, unknown>> title="History" columns={historyColumns} data={history as Array<DeployHistoryRow & Record<string, unknown>>} tableId="deployment-history" emptyTitle="No history" emptyDescription="Deploys, rollbacks, pauses, and removals land here, immutable." />
			</Card>
		</div>
	);

	// --- RUNS page ------------------------------------------------------------

	// Route the host's team-scoped live feed per source (the dev pages'
	// liveBySource precedent) so each report card folds only its own run.
	const liveBySource = useMemo(() => {
		const bySource = new Map<string, TaskEventMessage[]>();
		for (const message of liveEvents ?? []) {
			const body = (message.body ?? {}) as Record<string, unknown>;
			if (typeof body.source === 'string') {
				const bucket = bySource.get(body.source) ?? [];
				bucket.push(message);
				bySource.set(body.source, bucket);
			}
		}
		return bySource;
	}, [liveEvents]);

	const runsPage = <div style={commonStyles.tabContent}>{sources.length > 0 ? sources.map((src: { id: string; name: string }) => <SourcePanel key={`${projectId}.${src.id}.deploy`} source={src} runKind="deploy" projectId={projectId} liveEvents={liveBySource.get(src.id) ?? []} openSession={openSession ? () => openSession(src.id) : null} fetchTimeline={fetchTimeline ? () => fetchTimeline(src.id) : null} componentNames={componentNames} isConnected={isConnected} isSubscribed={isSubscribed} isReadonly serverHost={serverHost} onOpenLink={onOpenLink} />) : <div style={commonStyles.empty}>No source components found</div>}</div>;

	// --- DESIGN page (readonly artifact render) -------------------------------

	const designPage = <div style={S.canvasPadding}>{pipeline && designVisited && <CanvasPanel oauth2RootUrl={OAUTH_ROOT_URL} project={pipeline} servicesJson={servicesJson} handleValidatePipeline={handleValidatePipeline} isConnected={isConnected} isSubscribed={isSubscribed} serverHost={serverHost} onOpenLink={onOpenLink} isReadonly />}</div>;

	// --- Render ---------------------------------------------------------------

	return (
		<div style={S.container}>
			<TabControl menu={viewMenu} activeId={mode} onSelect={(id) => setMode(id as 'status' | 'runs' | 'design')} />
			{/* Title is PINNED with the strip; only the page body scrolls. The
			    canvas page carries no header (the ProjectView design-page rule —
			    the canvas is a full-bleed surface). */}
			{documentTitle && mode !== 'design' && <ContentHeader title={documentTitle} subtitle={mode === 'status' ? 'Deployment status' : 'Scheduled runs — team continuum'} />}
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
		</div>
	);
};
