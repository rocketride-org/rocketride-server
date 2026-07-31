// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeployPanel — the file view's DEPLOY page (mockup v5, screen B).
 *
 * The publish + promotion surface for one project: the version strip from
 * the org registry (Publish card + one card per immutable version with team
 * badges showing where it is live), the "where live" grid (one row per team
 * deployment), and the merged audit history — both grids are the stock
 * CardDataGrid per the style guide (it replaced the in-house DataTable).
 *
 * CAPABILITY-FED like SourcePanel: the panel OWNS its data lifecycle. The
 * host supplies one composite `fetchLifecycle` closure (the fetchTimeline
 * precedent) — the panel fetches on mount and silently re-fetches after
 * every mutation. LIVE data (`deployments`, `teams`) flows in as props (the
 * liveEvents precedent) because the host already polls/pushes it for the
 * sidebar and badges.
 *
 * Cardinality-driven collapsing (never an edition check): with exactly one
 * deployable team the "Deploy to…" picker becomes a plain Deploy button,
 * badges reduce to a single DEPLOYED marker, and the where-live grid is
 * hidden (its one row is already on the strip).
 *
 * Every pointer move (deploy/rollback) is confirmed before it runs — it
 * changes what an environment executes. Publishing is gated on a SAVED,
 * clean document: the host passes `canPublish` + the reason when blocked.
 */

import React, { useCallback, useEffect, useMemo, useState, CSSProperties } from 'react';

import { commonStyles } from '../../themes/styles';
import { Button } from '../button/Button';
import { Modal } from '../modal/Modal';
import { ConfirmDialog } from '../modal/ConfirmDialog';
import { Card } from '../card/Card';
import { formatTime, formatDayTime } from '../../modules/server/util/formatters';
import { SchedulePanel, describeCron, describeTtl } from './SchedulePanel';
import { VersionRecordPanel } from './VersionRecordPanel';
import type { IVersionRecordPanelProps } from './VersionRecordPanel';
import type { SchedulePreviewResult } from './DeploymentView';
import type { DeployTeamRef, DeployVersionCard, TeamDeploymentRow, TeamDeploymentSource } from './types';

// =============================================================================
// PROPS
// =============================================================================

/** The registry snapshot {@link IDeployPanelProps.fetchLifecycle} returns. */
export interface DeploySnapshot {
	/** Registry versions, newest first. */
	versions: DeployVersionCard[];
}

/** Props for {@link DeployPanel}. */
export interface IDeployPanelProps {
	/**
	 * Fetch the registry snapshot (versions + merged history). The panel owns
	 * the lifecycle: it fetches on mount and silently re-fetches after every
	 * mutation — hosts never pre-fetch or hold this data.
	 */
	fetchLifecycle: () => Promise<DeploySnapshot>;
	/** Every team deployment of this project (LIVE "where live" rows — the
	    host polls/pushes these for its other surfaces already). */
	deployments: TeamDeploymentRow[];
	/** Teams visible to the caller (picker shows only canControl ones). */
	teams: DeployTeamRef[];
	/** Whether publishing is allowed right now (saved, clean document). */
	canPublish?: boolean;
	/** Why publishing is blocked (rendered on the dimmed publish card). */
	publishDisabledReason?: string;
	/** The document holds unsaved changes; publishing saves it FIRST. */
	requiresSave?: boolean;
	/** Save the document (the 'Save & publish' path). */
	onSaveDocument?: () => Promise<void>;
	/** Publish the CURRENT saved pipeline (host snapshots the file). */
	onPublish: (comment: string, deployTo?: string) => Promise<void>;
	/** Point a team at a version (promotion and rollback alike). */
	onDeploy: (version: number, teamId: string) => Promise<void>;
	/** Open a deployment record drawer: the TEAM record (header/badge
	    gestures, no sourceId) or one SOURCE's record (source-row gesture). */
	onOpenDeployment?: (teamId: string, sourceId?: string) => void;
	/** Toggle the whole-deployment kill switch from the where-live header. */
	onSetDisabled?: (teamId: string, disabled: boolean) => Promise<void>;
	/** Set/clear one source's schedule (the where-live pill opens the stock
	    SchedulePanel editor; cron null clears). */
	onSetSchedule?: (teamId: string, sourceId: string, cron: string | null, ttl: number | null) => Promise<void>;
	/** Pause/resume ONE source's schedule, preserving cron/ttl. */
	onSetSchedulePaused?: (teamId: string, sourceId: string, paused: boolean) => Promise<void>;
	/** Cron preview via the server's single evaluator (SchedulePanel). */
	previewSchedule?: (cron: string, count: number) => Promise<SchedulePreviewResult>;
	/** Pipeline display name (SchedulePanel context line). */
	pipelineName?: string;
	/** Fetch one immutable artifact's pipeline JSON (sha-verified by the
	    server). Its presence makes the version cards clickable — each opens
	    a readonly-canvas record drawer. */
	fetchArtifact?: (version: number) => Promise<IVersionRecordPanelProps['pipeline']>;
	/** Service catalog for the readonly canvas render. */
	servicesJson?: IVersionRecordPanelProps['servicesJson'];
	/** Pipeline validation passthrough (the canvas requires one). */
	handleValidatePipeline?: IVersionRecordPanelProps['handleValidatePipeline'];
	/** Whether the host is connected (canvas status affordances). */
	isConnected?: boolean;
	/** Whether the caller holds an active subscription (canvas gating). */
	isSubscribed?: boolean;
	/** Server host URL for {host} placeholder replacement. */
	serverHost?: string;
	/** Open an external link in the host's browser. */
	onOpenLink?: (url: string, displayName?: string) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const S = {
	strip: {
		display: 'flex',
		gap: 10,
		alignItems: 'stretch',
		overflowX: 'auto',
		padding: '4px 2px 12px',
	} as CSSProperties,
	// Flex column so the action row can ANCHOR to the card's bottom edge —
	// cards stretch to equal height in the strip, and the Deploy button must
	// sit on one line across them regardless of badge/comment content.
	versionCard: {
		minWidth: 168,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		background: 'var(--rr-bg-paper)',
		padding: '10px 12px',
		flexShrink: 0,
		display: 'flex',
		flexDirection: 'column',
	} as CSSProperties,
	versionCardNewest: {
		borderColor: 'var(--rr-accent-faded)',
	} as CSSProperties,
	versionNum: {
		fontWeight: 800,
		fontSize: 15,
	} as CSSProperties,
	versionMeta: {
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
		lineHeight: 1.5,
	} as CSSProperties,
	// marginTop:auto pins the badge row (and the verbs after it) to the
	// card's bottom — badges and buttons align across cards regardless of
	// how tall each card's meta/comment is.
	envTags: {
		display: 'flex',
		gap: 5,
		marginTop: 'auto',
		paddingTop: 8,
		flexWrap: 'wrap',
	} as CSSProperties,
	envTag: {
		fontSize: 10.5,
		fontWeight: 700,
		borderRadius: 3,
		padding: '2px 7px',
		letterSpacing: '0.03em',
		textTransform: 'uppercase' as const,
		background: 'color-mix(in srgb, var(--rr-color-success) 12%, transparent)',
		color: 'var(--rr-color-success)',
		border: '1px solid color-mix(in srgb, var(--rr-color-success) 40%, transparent)',
	} as CSSProperties,
	// Follows the bottom-pinned badge row (which carries the auto margin).
	rowButtons: {
		display: 'flex',
		gap: 6,
		paddingTop: 9,
	} as CSSProperties,
	publishCard: (enabled: boolean): CSSProperties => ({
		minWidth: 148,
		border: '1.5px dashed var(--rr-border-hover)',
		borderRadius: 6,
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 6,
		color: 'var(--rr-text-secondary)',
		fontSize: 12.5,
		background: 'var(--rr-bg-surface-alt)',
		cursor: enabled ? 'pointer' : 'default',
		opacity: enabled ? 1 : 0.55,
		flexShrink: 0,
		padding: '14px 12px',
		textAlign: 'center' as const,
	}),
	stripLabel: {
		...commonStyles.labelUppercase,
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		paddingBottom: 8,
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
	commentInput: {
		...commonStyles.inputField,
		width: '100%',
	} as CSSProperties,
	errorText: {
		color: 'var(--rr-color-error)',
		fontSize: 12.5,
		marginTop: 8,
	} as CSSProperties,
	gridWrap: {
		marginBottom: 18,
	} as CSSProperties,
	// ── Where-live grouped panel ─────────────────────────────────────────────
	liveGroupHeader: (clickable: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '9px 14px',
		background: 'var(--rr-bg-surface-alt)',
		borderTop: '1px solid var(--rr-border)',
		cursor: clickable ? 'pointer' : 'default',
	}),
	liveTeam: {
		fontWeight: 700,
		fontSize: 13.5,
	} as CSSProperties,
	liveVersion: {
		fontSize: 11.5,
		fontWeight: 700,
		border: '1px solid var(--rr-accent-faded)',
		color: 'var(--rr-brand)',
		background: 'color-mix(in srgb, var(--rr-brand) 6%, transparent)',
		borderRadius: 10,
		padding: '1px 8px',
	} as CSSProperties,
	liveState: (state: TeamDeploymentRow['state'], clickable: boolean): CSSProperties => ({
		fontSize: 11.5,
		fontWeight: 600,
		color: state === 'errored' ? 'var(--rr-color-error)' : state === 'enabled' ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
		cursor: clickable ? 'pointer' : 'inherit',
	}),
	liveDeployedAt: {
		marginLeft: 'auto',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	// Running badge — the live-run indicator on group headers + source rows
	// (the schedule-pill grammar, always in its armed/green form).
	liveRunning: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		borderRadius: 14,
		padding: '2px 10px',
		fontSize: 11.5,
		fontWeight: 600,
		border: '1px solid color-mix(in srgb, var(--rr-color-success) 40%, transparent)',
		background: 'color-mix(in srgb, var(--rr-color-success) 10%, transparent)',
		color: 'var(--rr-color-success)',
	} as CSSProperties,
	liveSourceRow: (clickable: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '7px 14px 7px 34px',
		borderTop: '1px solid var(--rr-border)',
		fontSize: 12.5,
		cursor: clickable ? 'pointer' : 'default',
	}),
	liveSourceName: {
		fontWeight: 600,
		minWidth: 140,
	} as CSSProperties,
	// The drawer's schedule-pill grammar (green while armed).
	livePill: (on: boolean, clickable: boolean): CSSProperties => ({
		cursor: clickable ? 'pointer' : 'inherit',
		display: 'inline-flex',
		alignItems: 'center',
		gap: 6,
		borderRadius: 14,
		padding: '2px 10px',
		fontSize: 11.5,
		fontWeight: 600,
		border: `1px solid ${on ? 'color-mix(in srgb, var(--rr-color-success) 40%, transparent)' : 'var(--rr-border)'}`,
		background: on ? 'color-mix(in srgb, var(--rr-color-success) 10%, transparent)' : 'transparent',
		color: on ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)',
	}),
	liveLastRun: {
		marginLeft: 'auto',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** Short sha rendering: first 8 hex chars + ellipsis. */
function shortSha(sha: string): string {
	return sha ? `${sha.slice(0, 8)}…` : '';
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The DEPLOY-page lifecycle surface: version strip, where-live grid,
 * merged history grid. See the module docstring for the collapsing rules.
 */
export const DeployPanel: React.FC<IDeployPanelProps> = ({ fetchLifecycle, deployments, teams, canPublish = true, publishDisabledReason, requiresSave = false, onSaveDocument, onPublish, onDeploy, onOpenDeployment, onSetDisabled, onSetSchedule, onSetSchedulePaused, previewSchedule, pipelineName = '', fetchArtifact, servicesJson, handleValidatePipeline, isConnected = false, isSubscribed = true, serverHost = '', onOpenLink }) => {
	// --- Panel-owned registry data (fetched, never passed in) -----------------

	const [versions, setVersions] = useState<DeployVersionCard[]>([]);
	const [loading, setLoading] = useState(true);

	/** (Re-)fetch the registry snapshot; a failed fetch keeps the last data. */
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const snapshot = await fetchLifecycle();
			setVersions(snapshot.versions);
		} catch (err) {
			// A project that was never published has no registry — empty strip.
			console.log('[DeployPanel] fetch failed:', err);
		} finally {
			setLoading(false);
		}
	}, [fetchLifecycle]);

	// Fetch on mount and whenever the host swaps the fetcher (new identity /
	// reconnect) — the SourcePanel lifecycle model.
	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Deploy targets = teams the caller controls. ONE target collapses the
	// picker into a direct Deploy button (mockup screen C).
	const controlTeams = useMemo(() => teams.filter((t) => t.canControl), [teams]);
	const singleTarget = controlTeams.length === 1 ? controlTeams[0] : null;
	const multiTeam = teams.length > 1;

	// Soft-removed deployments never render: the where-live grid and the
	// badges share this filter so a removed row can't be re-enabled by its
	// (still clickable) state dot.
	const liveDeployments = useMemo(() => deployments.filter((dep) => dep.state !== 'removed'), [deployments]);

	// version -> live teams (for the env badges on each card).
	const liveByVersion = useMemo(() => {
		const map = new Map<number, TeamDeploymentRow[]>();
		for (const dep of liveDeployments) {
			const rows = map.get(dep.version) ?? [];
			rows.push(dep);
			map.set(dep.version, rows);
		}
		return map;
	}, [liveDeployments]);

	const nextVersion = (versions[0]?.version ?? 0) + 1;

	// --- Modal + action state -------------------------------------------------

	// The version awaiting a team choice (Deploy to… picker).
	const [pickerVersion, setPickerVersion] = useState<number | null>(null);
	// A chosen (version, team) pointer move awaiting CONFIRMATION.
	const [pendingDeploy, setPendingDeploy] = useState<{ version: number; team: DeployTeamRef; fromVersion?: number } | null>(null);
	const [publishOpen, setPublishOpen] = useState(false);
	// The where-live schedule being edited in the SchedulePanel drawer.
	const [editSchedule, setEditSchedule] = useState<{ teamId: string; teamName: string; source: TeamDeploymentSource } | null>(null);
	// The version card opened as a readonly-canvas record drawer: the card
	// (title/provenance render immediately) + its artifact once fetched.
	const [openVersion, setOpenVersion] = useState<DeployVersionCard | null>(null);
	const [versionPipeline, setVersionPipeline] = useState<IVersionRecordPanelProps['pipeline'] | null>(null);
	const [versionError, setVersionError] = useState('');

	/** Open one version's record drawer and fetch its artifact into it. */
	const openVersionDrawer = (card: DeployVersionCard): void => {
		if (!fetchArtifact) return;
		setOpenVersion(card);
		setVersionPipeline(null);
		setVersionError('');
		fetchArtifact(card.version)
			.then((artifact) => setVersionPipeline(artifact))
			.catch((err: unknown) => setVersionError(err instanceof Error ? err.message : String(err)));
	};
	const [publishComment, setPublishComment] = useState('');
	const [publishAndDeploy, setPublishAndDeploy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	/** Run one async action with shared busy/error handling; a successful
	    mutation silently re-fetches the panel-owned registry snapshot. */
	const run = async (action: () => Promise<void>): Promise<void> => {
		setBusy(true);
		setError('');
		try {
			await action();
			setPickerVersion(null);
			setPendingDeploy(null);
			setPublishOpen(false);
			setPublishComment('');
			setPublishAndDeploy(false);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** Stage a pointer move for confirmation (deploy and rollback alike). */
	const stageDeploy = (version: number, team: DeployTeamRef): void => {
		const current = deployments.find((dep) => dep.teamId === team.id && dep.state !== 'removed');
		setPickerVersion(null);
		setPendingDeploy({ version, team, ...(current ? { fromVersion: current.version } : {}) });
	};

	// --- Grid columns ---------------------------------------------------------

	// --- Render ---------------------------------------------------------------

	return (
		<div>
			{/* ── Version strip ─────────────────────────────────────────── */}
			<div style={S.stripLabel}>
				<span>Published versions</span>
				<span style={{ ...commonStyles.textMuted, fontSize: 11.5, textTransform: 'none', letterSpacing: 0 }}>org registry &middot; immutable &middot; newest first</span>
			</div>
			<div style={S.strip}>
				{/* Publish card — the only affordance that creates a version.
				    Gated on a SAVED, clean document (the host owns the check). */}
				{controlTeams.length > 0 &&
					(() => {
						// A dirty doc is not a dead end: when the host can save,
						// the card stays live and the dialog saves first.
						const clickable = (canPublish || (requiresSave && Boolean(onSaveDocument))) && !busy;
						const hint = canPublish ? 'snapshot current pipeline' : requiresSave && onSaveDocument ? 'saves your changes, then publishes' : (publishDisabledReason ?? 'unavailable');
						return (
							<div style={S.publishCard(clickable)} onClick={() => clickable && setPublishOpen(true)} title={hint}>
								<div style={{ fontSize: 20, fontWeight: 300 }}>+</div>
								<div>
									<b>Publish v{nextVersion}</b>
								</div>
								<div style={{ fontSize: 11 }}>{hint}</div>
							</div>
						);
					})()}
				{versions.map((v, index) => {
					const live = liveByVersion.get(v.version) ?? [];
					return (
						<div key={v.version} style={{ ...S.versionCard, ...(index === 0 ? S.versionCardNewest : {}), ...(fetchArtifact ? { cursor: 'pointer' } : {}) }} title={fetchArtifact ? 'View this version' : undefined} onClick={() => openVersionDrawer(v)}>
							<div style={S.versionNum}>v{v.version}</div>
							<div style={S.versionMeta}>
								{v.publishedBy}
								<br />
								{formatTime(v.publishedAt)} &middot; sha <span style={commonStyles.fontMono}>{shortSha(v.sha256)}</span>
								{v.comment ? (
									<>
										<br />
										&ldquo;{v.comment}&rdquo;
									</>
								) : null}
							</div>
							<div style={S.envTags}>
								{/* Badge click opens the deployment record panel — the
								    badge IS the deployment, same gesture as its
								    where-live row. */}
								{live.map((dep) => (
									<span
										key={dep.teamId}
										style={{ ...S.envTag, ...(onOpenDeployment ? { cursor: 'pointer' } : {}) }}
										title={onOpenDeployment ? `Open the ${dep.teamName} deployment (${dep.state})` : `Live on ${dep.teamName} (${dep.state})`}
										onClick={(e) => {
											// The badge IS the team deployment; the card is the version.
											e.stopPropagation();
											onOpenDeployment?.(dep.teamId);
										}}
									>
										{multiTeam ? dep.teamName : 'deployed'}
									</span>
								))}
							</div>
							{controlTeams.length > 0 && (
								<div style={S.rowButtons} onClick={(e) => e.stopPropagation()}>
									{singleTarget ? (
										live.some((dep) => dep.teamId === singleTarget.id) ? null : (
											<Button variant="secondary" small disabled={busy} onClick={() => stageDeploy(v.version, singleTarget)}>
												Deploy
											</Button>
										)
									) : (
										<Button variant="secondary" small disabled={busy} onClick={() => setPickerVersion(v.version)}>
											Deploy to&hellip;
										</Button>
									)}
								</div>
							)}
						</div>
					);
				})}
				{versions.length === 0 && !loading && <div style={{ ...commonStyles.empty, minWidth: 240 }}>No published versions yet</div>}
			</div>
			{error && !publishOpen && pickerVersion === null && !pendingDeploy && <div style={S.errorText}>{error}</div>}

			{/* ── Where live (grouped panel: team header + per-source rows) ── */}
			{liveDeployments.length > 0 && (
				<div style={S.gridWrap}>
					<Card header="Where this project is live" noBodyPadding>
						<div>
							{liveDeployments.map((dep) => (
								<React.Fragment key={dep.teamId}>
									{/* Group header — the deployment; click opens its record. */}
									<div style={S.liveGroupHeader(Boolean(onOpenDeployment))} title={onOpenDeployment ? 'Open the team deployment' : undefined} onClick={() => onOpenDeployment?.(dep.teamId)}>
										<span style={S.liveTeam}>{dep.teamName}</span>
										<span style={S.liveVersion}>v{dep.version}</span>
										<span
											style={S.liveState(dep.state, Boolean(onSetDisabled))}
											title={onSetDisabled ? (dep.state === 'enabled' ? 'Click to disable' : 'Click to enable') : undefined}
											onClick={(e) => {
												// The dot is the kill-switch toggle; the row still
												// opens the record everywhere else.
												if (!onSetDisabled || busy) return;
												e.stopPropagation();
												void run(() => onSetDisabled(dep.teamId, dep.state === 'enabled'));
											}}
										>
											&#9679; {dep.state}
										</span>
										{/* Live-run roll-up: any source running lights the group. */}
										{dep.sources.some((src) => src.running) && <span style={S.liveRunning}>&#9679; running</span>}
										<span style={S.liveDeployedAt}>{dep.deployedAt ? `deployed ${formatDayTime(dep.deployedAt)}` : ''}</span>
									</div>
									{/* Source rows — schedule pill + last run, drawer-pill grammar. */}
									{dep.sources.map((src) => (
										<div key={`${dep.teamId}.${src.sourceId}`} style={S.liveSourceRow(Boolean(onOpenDeployment))} onClick={() => onOpenDeployment?.(dep.teamId, src.sourceId)}>
											<span style={S.liveSourceName}>{src.sourceName}</span>
											{src.running && <span style={S.liveRunning}>&#9679; running</span>}
											<span
												style={S.livePill(Boolean(src.cron) && !src.paused, Boolean(onSetSchedule))}
												title={onSetSchedule ? 'Edit schedule' : undefined}
												onClick={(e) => {
													if (!onSetSchedule) return;
													e.stopPropagation();
													setEditSchedule({ teamId: dep.teamId, teamName: dep.teamName, source: src });
												}}
											>
												{src.cron ? `${describeCron(src.cron)}${src.ttl ? ` · ${describeTtl(src.ttl)}` : ''}${src.paused ? ' · paused' : ''}` : 'manual'}
											</span>
											{src.lastRunAt ? <span style={S.liveLastRun}>last run {formatDayTime(src.lastRunAt)}</span> : null}
										</div>
									))}
								</React.Fragment>
							))}
						</div>
					</Card>
				</div>
			)}

			{/* ── Where-live schedule editor (stock SchedulePanel drawer) ── */}
			{editSchedule && onSetSchedule && (
				<SchedulePanel
					open
					sourceId={editSchedule.source.sourceId}
					sourceName={editSchedule.source.sourceName}
					teamName={editSchedule.teamName}
					pipelineName={pipelineName}
					initialCron={editSchedule.source.cron}
					{...(editSchedule.source.ttl ? { initialTtl: editSchedule.source.ttl } : {})}
					onSave={(cron, ttl) => onSetSchedule(editSchedule.teamId, editSchedule.source.sourceId, cron, ttl)}
					onClose={() => setEditSchedule(null)}
					paused={editSchedule.source.paused}
					{...(onSetSchedulePaused
						? {
								onSetPaused: async (paused: boolean) => {
									await onSetSchedulePaused(editSchedule.teamId, editSchedule.source.sourceId, paused);
									// Reflect the flip in the OPEN editor; the rows
									// themselves refresh from the host poll.
									setEditSchedule((prev) => (prev ? { ...prev, source: { ...prev.source, paused } } : prev));
								},
							}
						: {})}
					{...(previewSchedule ? { previewSchedule } : {})}
				/>
			)}

			{/* ── Version record drawer (readonly canvas, no verbs) ─────── */}
			{openVersion && fetchArtifact && servicesJson && handleValidatePipeline && <VersionRecordPanel open onClose={() => setOpenVersion(null)} card={openVersion} pipelineName={pipelineName} {...(versionPipeline ? { pipeline: versionPipeline } : {})} {...(versionError ? { loadError: versionError } : {})} servicesJson={servicesJson} handleValidatePipeline={handleValidatePipeline} isConnected={isConnected} isSubscribed={isSubscribed} serverHost={serverHost} {...(onOpenLink ? { onOpenLink } : {})} />}

			{/* ── Publish dialog ────────────────────────────────────────── */}
			{publishOpen && (
				<Modal
					title={`Publish v${nextVersion}`}
					onClose={() => setPublishOpen(false)}
					footer={
						<>
							<Button variant="secondary" disabled={busy} onClick={() => setPublishOpen(false)}>
								Cancel
							</Button>
							<Button
								variant="primary"
								disabled={busy}
								onClick={() =>
									void run(async () => {
										// Save-first: the registry snapshots what is on
										// disk, so a dirty doc saves before publishing.
										if (requiresSave && onSaveDocument) await onSaveDocument();
										await onPublish(publishComment.trim(), publishAndDeploy && singleTarget ? singleTarget.id : undefined);
									})
								}
							>
								{busy ? 'Publishing…' : requiresSave ? (publishAndDeploy && singleTarget ? 'Save, publish & deploy' : 'Save & publish') : publishAndDeploy && singleTarget ? 'Publish & deploy' : 'Publish'}
							</Button>
						</>
					}
				>
					<div style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', marginBottom: 10 }}>
						Snapshots the current saved pipeline as immutable version v{nextVersion} in the org registry.
						{requiresSave ? ' Your unsaved changes are saved first.' : ''}
					</div>
					<input style={S.commentInput} placeholder="What changed? (optional comment)" value={publishComment} onChange={(e) => setPublishComment(e.target.value)} disabled={busy} />
					{/* One-step publish+deploy — offered only when there is exactly
					    one deploy target (the small-team path, mockup screen C). */}
					{singleTarget && (
						<label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5 }}>
							<input type="checkbox" checked={publishAndDeploy} onChange={(e) => setPublishAndDeploy(e.target.checked)} disabled={busy} />
							and deploy to <b>{singleTarget.name}</b>
						</label>
					)}
					{error && <div style={S.errorText}>{error}</div>}
				</Modal>
			)}

			{/* ── Deploy-to team picker ─────────────────────────────────── */}
			{pickerVersion !== null && (
				<Modal
					title={`Deploy v${pickerVersion} to…`}
					onClose={() => setPickerVersion(null)}
					footer={
						<Button variant="secondary" disabled={busy} onClick={() => setPickerVersion(null)}>
							Cancel
						</Button>
					}
				>
					<div style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', marginBottom: 10 }}>Points the chosen team at v{pickerVersion}. Choosing a team already on a newer version is a rollback &mdash; same gesture, one mental model.</div>
					{controlTeams.map((team) => {
						const current = deployments.find((dep) => dep.teamId === team.id && dep.state !== 'removed');
						const isCurrent = current?.version === pickerVersion;
						return (
							<div key={team.id} style={S.pickerRow(!busy && !isCurrent)} onClick={() => !busy && !isCurrent && stageDeploy(pickerVersion, team)}>
								<span style={{ fontWeight: 600 }}>{team.name}</span>
								<span style={{ ...commonStyles.textMuted, fontSize: 11.5, marginLeft: 'auto' }}>{current ? (isCurrent ? `already on v${current.version}` : current.version > pickerVersion ? `rollback from v${current.version}` : `upgrade from v${current.version}`) : 'not deployed yet'}</span>
							</div>
						);
					})}
					{error && <div style={S.errorText}>{error}</div>}
				</Modal>
			)}

			{/* ── Pointer-move confirmation (deploy and rollback alike) ───
			    The message node carries the failure text: a rejected move
			    keeps this dialog open, and the strip's error line is
			    suppressed while any dialog is up — without this the dialog
			    would fail silently and look inert. */}
			{pendingDeploy && (
				<ConfirmDialog
					title={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? `Roll ${pendingDeploy.team.name} back to v${pendingDeploy.version}?` : `Deploy v${pendingDeploy.version} to ${pendingDeploy.team.name}?`}
					message={
						<>
							{pendingDeploy.fromVersion !== undefined ? `${pendingDeploy.team.name} currently runs v${pendingDeploy.fromVersion}. Its next runs will execute v${pendingDeploy.version} — schedules and history carry over.` : `${pendingDeploy.team.name} is not running this project yet. Its runs will execute v${pendingDeploy.version}.`}
							{error && <div style={S.errorText}>{error}</div>}
						</>
					}
					confirmLabel={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? 'Rollback' : 'Deploy'}
					cancelLabel="Cancel"
					onConfirm={() => void run(() => onDeploy(pendingDeploy.version, pendingDeploy.team.id))}
					onCancel={() => setPendingDeploy(null)}
				/>
			)}
		</div>
	);
};
