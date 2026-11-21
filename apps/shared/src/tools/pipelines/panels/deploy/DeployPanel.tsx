// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DeployPanel — the file view's DEPLOY page (mockups 2.13 and 2.14).
 *
 * The publish + promotion surface for one project: the version strip from
 * the org registry (Deploy card + one card per immutable version with its
 * review badge, the audiences it is live on, and its verbs), and "Where this
 * project is live": one row per rung that holds a publication (Me, each
 * team, the store), each with its sources.
 *
 * The version cards and the Publish dialog are the App Builder's own pieces
 * (shared/components/deploy): the same badge, the same Publish to… / Submit
 * for review / Withdraw rules, the same audience dialog with Me, the teams
 * and the store (closed until the version is approved). A pipe walks the
 * app's review ladder (plan 10.1); where the server has no reviewer the host
 * offers no review verb and versions are born 'ready'. Any publication can
 * run on a schedule: every rung row opens the schedule editor.
 *
 * CAPABILITY-FED like SourcePanel: the panel OWNS its data lifecycle. The
 * host supplies one composite `fetchLifecycle` closure (the fetchTimeline
 * precedent) — the panel fetches on mount, silently re-fetches after every
 * mutation, and re-fetches on the host's deployment-change signal (any
 * session's publish, a reviewer's verdict); when those reads overlap, only
 * the newest writes. LIVE data (`deployments`, `teams`) flows in as props
 * (the liveEvents precedent).
 *
 * Every pointer move (deploy/rollback) is confirmed before it runs — it
 * changes what an audience is served. Publishing is gated on a SAVED,
 * clean document: the host passes `canPublish` + the reason when blocked.
 * No process or engine state is drawn anywhere: a row means serving.
 */

import React, { useCallback, useEffect, useMemo, useState, CSSProperties } from 'react';

import { commonStyles } from 'shell';
import { Button } from 'shell';
import { Modal } from 'shell';
import { ConfirmDialog } from 'shell';
import { Card } from 'shell';
import { formatTime, formatDayTime } from 'shell';
import { buttonize } from 'shared/utils/buttonize';
import { createLatestGate } from 'shared/utils/latestGate';
import { DeleteVersionMark, PublishToDialog, ServingStateWord, VersionCardActions, VersionStateBadge, newestSubmittableOf, versionCardActionsOf } from 'shared/components/deploy';
import { pinStatusOf, versionBadgeOf } from '../../../appdev/servingStatus';
import { audienceOfTarget, publishTargetsOf, rowOfTarget, servingOf, whereLiveRungsOf } from './whereLive';
import type { IWhereLiveRung } from './whereLive';
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
	/** Save the document (the 'Save & deploy' path). */
	onSaveDocument?: () => Promise<void>;
	/** Publish the CURRENT saved pipeline (host snapshots the file). */
	onPublish: (comment: string, deployTo?: string) => Promise<void>;
	/** Point a team at a version (promotion and rollback alike). */
	onDeploy: (version: number, teamId: string) => Promise<void>;
	/** Open a deployment record drawer: the TEAM record (header/badge
	    gestures, no sourceId) or one SOURCE's record (source-row gesture). */
	onOpenDeployment?: (teamId: string, sourceId?: string) => void;
	/** Accepted for hosts that still wire it, but the table no longer renders
	    the enable/disable toggle (decided 2026-11-16): a row means serving and
	    Unpublish is the one user verb; the server's disable state stays for
	    operators and shows as a plain word when set. */
	onSetDisabled?: (teamId: string, disabled: boolean) => Promise<void>;
	/** Soft-remove one team's deployment from the where-live header —
	    listings hide it; history and artifacts survive; re-deploying any
	    version revives it. */
	onRemove?: (teamId: string) => Promise<void>;
	/** Delete one deployed version from the server (HARD — its storage goes,
	    the number is never reused). The card's top-right mark renders only on
	    rows the server marks `deletable`; the server refuses by name otherwise
	    and the refusal shows under the strip. */
	onDeleteVersion?: (version: number) => Promise<void>;
	/** Submit one deployed version for store review (private → submit). Its
	    presence means the server reviews: the card offers it on the newest
	    version that did not fail, while a draft. */
	onSubmitForReview?: (version: number) => Promise<void>;
	/** Withdraw a pending review (submit → private); the card offers it on a
	    version in review. */
	onWithdrawReview?: (version: number) => Promise<void>;
	/** Subscribe to this pipeline's deployment changes from any session; the
	    panel re-fetches on each. Returns the unsubscribe. */
	subscribeDeployChanged?: (listener: () => void) => () => void;
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
		// The delete mark anchors to the card's top-right corner.
		position: 'relative',
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
	// The rung's handle beside its label, as the server composed it ('@me', '@Staging', '@public').
	liveHandle: {
		...commonStyles.fontMono,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
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
	liveDeployedAt: {
		marginLeft: 'auto',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
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
 * The DEPLOY-page lifecycle surface: version strip and where-live table.
 * See the module docstring for the rules.
 */
export const DeployPanel: React.FC<IDeployPanelProps> = ({ fetchLifecycle, deployments, teams, canPublish = true, publishDisabledReason, requiresSave = false, onSaveDocument, onPublish, onDeploy, onOpenDeployment, onRemove, onDeleteVersion, onSubmitForReview, onWithdrawReview, subscribeDeployChanged, onSetSchedule, onSetSchedulePaused, previewSchedule, pipelineName = '', fetchArtifact, servicesJson, handleValidatePipeline, isConnected = false, isSubscribed = true, serverHost = '', onOpenLink }) => {
	// --- Panel-owned registry data (fetched, never passed in) -----------------

	const [versions, setVersions] = useState<DeployVersionCard[]>([]);
	const [loading, setLoading] = useState(true);
	// Refreshes overlap (the mount, a deployment-change push, the refresh
	// after a verb) and answer in any order: only the newest writes.
	const [refreshGate] = useState(createLatestGate);

	/** (Re-)fetch the registry snapshot; a failed fetch keeps the last data. */
	const refresh = useCallback(async (): Promise<void> => {
		const ticket = refreshGate.take();
		try {
			const snapshot = await fetchLifecycle();
			if (refreshGate.isLatest(ticket)) setVersions(snapshot.versions);
		} catch (err) {
			// A project that was never published has no registry — empty strip.
			console.log('[DeployPanel] fetch failed:', err);
		} finally {
			if (refreshGate.isLatest(ticket)) setLoading(false);
		}
	}, [fetchLifecycle, refreshGate]);

	// Fetch on mount and whenever the host swaps the fetcher (new identity /
	// reconnect) — the SourcePanel lifecycle model.
	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Deployment changes of this pipeline from ANY session (a reviewer's
	// verdict, a teammate's publish): re-fetch so the version states and the
	// where-live rows never go stale, as the App Builder's DEPLOY view does.
	useEffect(() => subscribeDeployChanged?.(() => void refresh()), [subscribeDeployChanged, refresh]);

	// Deploy targets = the audiences the caller controls ('@me' first); the
	// Publish dialog adds the store after them.
	const controlTeams = useMemo(() => teams.filter((t) => t.canControl), [teams]);

	// The where-live rows: one per rung holding a publication, in rung order
	// (Me, teams, the store). Soft-removed deployments never render: the
	// where-live table and the card chips share this list.
	const rungs = useMemo(() => whereLiveRungsOf(deployments, teams), [deployments, teams]);
	const liveDeployments = useMemo(() => rungs.map((rung) => rung.row), [rungs]);

	// Latest-only review: Submit appears solely on the newest version that
	// did not fail (the server enforces the same rule).
	const newestSubmittable = newestSubmittableOf(versions);

	// version -> the rungs serving it (each card's audience chips, named as
	// the where-live table names them: Me, a team, Store).
	const liveByVersion = useMemo(() => {
		const map = new Map<number, IWhereLiveRung[]>();
		for (const rung of rungs) {
			const list = map.get(rung.row.version) ?? [];
			list.push(rung);
			map.set(rung.row.version, list);
		}
		return map;
	}, [rungs]);

	const nextVersion = (versions[0]?.version ?? 0) + 1;

	// --- Modal + action state -------------------------------------------------

	// The version awaiting a team choice (Deploy to… picker).
	const [pickerVersion, setPickerVersion] = useState<number | null>(null);
	// The team deployment awaiting soft-remove confirmation (null = none).
	const [removeTeam, setRemoveTeam] = useState<{ teamId: string; teamName: string } | null>(null);
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
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	/** Close any open dialog and drop the error it displayed — a canceled
	    verb must not leave its failure text under the version strip. */
	const closeDialogs = (): void => {
		setError('');
		setPublishOpen(false);
		setPickerVersion(null);
		setPendingDeploy(null);
	};

	/** Stage a pointer move for confirmation (deploy and rollback alike). The
	    audience's current row is found by rung: the caller's own space is
	    addressed '@me' while its row carries its audience `=user/<uid>`. */
	const stageDeploy = (version: number, team: DeployTeamRef): void => {
		const current = rowOfTarget(liveDeployments, team.id);
		setPickerVersion(null);
		setPendingDeploy({ version, team, ...(current ? { fromVersion: current.version } : {}) });
	};

	// --- Grid columns ---------------------------------------------------------

	// --- Render ---------------------------------------------------------------

	return (
		<div>
			{/* ── Version strip ─────────────────────────────────────────── */}
			<div style={S.stripLabel}>
				<span>Deployed versions</span>
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
						const hint = canPublish ? `snapshot the current pipeline as v${nextVersion}` : requiresSave && onSaveDocument ? `saves your changes, then deploys v${nextVersion}` : (publishDisabledReason ?? 'unavailable');
						return (
							<div style={S.publishCard(clickable)} {...buttonize(() => setPublishOpen(true), clickable)} title={hint}>
								<div style={{ fontSize: 20, fontWeight: 300 }}>+</div>
								<div>
									<b>Deploy</b>
								</div>
								<div style={{ fontSize: 11 }}>{hint}</div>
							</div>
						);
					})()}
				{versions.map((v, index) => {
					const live = liveByVersion.get(v.version) ?? [];
					// Only legal moves render (the App Builder's rules): a pipe
					// never builds, so its bytes can serve once deployed.
					const actions = versionCardActionsOf({ version: v.version, state: v.state, servable: true }, newestSubmittable, { publish: controlTeams.length > 0, submit: Boolean(onSubmitForReview), withdraw: Boolean(onWithdrawReview) });
					return (
						<div key={v.version} style={{ ...S.versionCard, ...(index === 0 ? S.versionCardNewest : {}), ...(fetchArtifact ? { cursor: 'pointer' } : {}) }} title={fetchArtifact ? 'View this version' : undefined} {...buttonize(() => openVersionDrawer(v), Boolean(fetchArtifact))}>
							{/* The delete mark (plan 2.3): present ONLY while the server
							    says the version is deletable — no rung pins it, it is not
							    in review, its build is not running. Confirmed inside; the
							    refusal, if any, lands under the strip like every verb. */}
							<DeleteVersionMark version={v.version} deletable={v.deletable} subject={pipelineName || 'this pipeline'} onDelete={onDeleteVersion ? (version) => run(() => onDeleteVersion(version)) : undefined} disabled={busy} />
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
								{/* The review state first (draft, in review, ready,
								    rejected, failed): the App Builder's badge. A pipe
								    never builds, so there is no build word. */}
								<VersionStateBadge badge={versionBadgeOf(v.state, '')} />
								{/* Each chip names an audience serving this version, as
								    the where-live table names it (Me, a team, Store); a
								    click opens that deployment's record, the same
								    gesture as its where-live row. */}
								{live.map(({ row: dep, label }) => (
									<span
										key={dep.teamId}
										style={{ ...S.envTag, ...(onOpenDeployment ? { cursor: 'pointer' } : {}) }}
										title={onOpenDeployment ? `Open the ${label} deployment (${dep.state})` : `Live on ${label} (${dep.state})`}
										{...buttonize((e) => {
											// The chip IS the deployment; the card is the version.
											e.stopPropagation();
											onOpenDeployment?.(dep.teamId);
										}, Boolean(onOpenDeployment))}
									>
										{label}
									</span>
								))}
							</div>
							{/* The card's verbs, the App Builder's row: Publish to…,
							    Submit for review, Withdraw. */}
							<VersionCardActions
								actions={actions}
								onPublish={() => setPickerVersion(v.version)}
								onSubmit={() => {
									if (onSubmitForReview) void run(() => onSubmitForReview(v.version));
								}}
								onWithdraw={() => {
									if (onWithdrawReview) void run(() => onWithdrawReview(v.version));
								}}
								disabled={busy}
							/>
						</div>
					);
				})}
				{versions.length === 0 && !loading && <div style={{ ...commonStyles.empty, minWidth: 240 }}>No published versions yet</div>}
			</div>
			{error && !publishOpen && pickerVersion === null && !pendingDeploy && <div style={S.errorText}>{error}</div>}

			{/* ── Where live (one row per rung: header + per-source rows) ── */}
			{rungs.length > 0 && (
				<div style={S.gridWrap}>
					<Card header="Where this project is live" noBodyPadding>
						<div>
							{rungs.map(({ row: dep, label, handle }) => (
								<React.Fragment key={dep.teamId}>
									{/* Rung header — the publication; click opens its record. */}
									<div style={S.liveGroupHeader(Boolean(onOpenDeployment))} title={onOpenDeployment ? 'Open the deployment' : undefined} {...buttonize(() => onOpenDeployment?.(dep.teamId), Boolean(onOpenDeployment))}>
										<span style={S.liveTeam}>{label}</span>
										{handle ? <span style={S.liveHandle}>{handle}</span> : null}
										<span style={S.liveVersion}>v{dep.version}</span>
										{/* A row means serving (decided 2026-11-16): a serving row
										    carries no state word and no process state. A deployment
										    the server holds in another state (an operator's disable,
										    an error) says so, in the App Builder's words; Unpublish
										    is the one user verb, the enable/disable toggle is gone. */}
										<ServingStateWord status={pinStatusOf(servingOf(dep))} />
										<span style={S.liveDeployedAt}>{dep.deployedAt ? `published ${formatDayTime(dep.deployedAt)}` : ''}</span>
										{onRemove && (
											// The header row opens the record; Unpublish must not,
											// by click or by Enter/Space.
											<span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
												<Button variant="secondary" small disabled={busy} onClick={() => setRemoveTeam({ teamId: dep.teamId, teamName: label })}>
													Unpublish
												</Button>
											</span>
										)}
									</div>
									{/* Source rows — schedule pill + last run, drawer-pill grammar.
									    Every rung's sources take a schedule (decided 2026-11-20):
									    any publication of a pipe can run on a timer. */}
									{dep.sources.map((src) => (
										<div key={`${dep.teamId}.${src.sourceId}`} style={S.liveSourceRow(Boolean(onOpenDeployment))} {...buttonize(() => onOpenDeployment?.(dep.teamId, src.sourceId), Boolean(onOpenDeployment))}>
											<span style={S.liveSourceName}>{src.sourceName}</span>
											<span
												style={S.livePill(Boolean(src.cron) && !src.paused, Boolean(onSetSchedule))}
												title={onSetSchedule ? 'Edit schedule' : undefined}
												{...buttonize((e) => {
													e.stopPropagation();
													setEditSchedule({ teamId: dep.teamId, teamName: label, source: src });
												}, Boolean(onSetSchedule))}
											>
												{src.cron ? `${describeCron(src.cron)}${src.ttl ? ` · ${describeTtl(src.ttl)}` : ''}${src.paused ? ' · paused' : ''}` : 'on demand'}
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

			{/* ── Soft-remove confirmation (where-live header verb) ─────── */}
			{removeTeam && onRemove && (
				<ConfirmDialog
					title={`Unpublish ${pipelineName || 'this pipeline'} from ${removeTeam.teamName}?`}
					message={`Takes ${pipelineName || 'the pipeline'} off ${removeTeam.teamName}: it stops serving there, schedules stop firing and the deployment leaves all listings. Every deployed version, the schedules and the history survive; publishing any version to ${removeTeam.teamName} again revives it.`}
					confirmLabel="Unpublish"
					cancelLabel="Cancel"
					onConfirm={() => {
						const team = removeTeam;
						setRemoveTeam(null);
						void run(() => onRemove(team.teamId));
					}}
					onCancel={() => setRemoveTeam(null)}
				/>
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
					title={`Deploy v${nextVersion}`}
					onClose={closeDialogs}
					footer={
						<>
							<Button variant="secondary" disabled={busy} onClick={closeDialogs}>
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
										await onPublish(publishComment.trim());
									})
								}
							>
								{busy ? 'Deploying…' : requiresSave ? 'Save & deploy' : 'Deploy'}
							</Button>
						</>
					}
				>
					<div style={{ fontSize: 12.5, color: 'var(--rr-text-secondary)', marginBottom: 10 }}>
						Snapshots the current saved pipeline as immutable version v{nextVersion} in the org registry.
						{requiresSave ? ' Your unsaved changes are saved first.' : ''}
					</div>
					<input style={S.commentInput} placeholder="What changed? (optional comment)" value={publishComment} onChange={(e) => setPublishComment(e.target.value)} disabled={busy} />
					{error && <div style={S.errorText}>{error}</div>}
				</Modal>
			)}

			{/* ── Publish-to audience picker (the App Builder's dialog):
			    Me and the teams, then the store, closed until the version
			    is approved ─────────────────────────────────────────────── */}
			{pickerVersion !== null && (
				<PublishToDialog
					title={`Publish v${pickerVersion} to…`}
					hint={`Points the chosen audience at v${pickerVersion}. Choosing an audience already on a newer version is a rollback: same gesture, one mental model. Internal audiences serve at once; the store takes an approved version.`}
					targets={publishTargetsOf(controlTeams, liveDeployments, pickerVersion, versions.find((v) => v.version === pickerVersion)?.state)}
					onChoose={(id) => {
						const audience = audienceOfTarget(controlTeams, id);
						if (audience) stageDeploy(pickerVersion, audience);
					}}
					onCancel={closeDialogs}
					busy={busy}
					{...(error ? { error } : {})}
				/>
			)}

			{/* ── Pointer-move confirmation (deploy and rollback alike) ───
			    The message node carries the failure text: a rejected move
			    keeps this dialog open, and the strip's error line is
			    suppressed while any dialog is up — without this the dialog
			    would fail silently and look inert. */}
			{pendingDeploy && (
				<ConfirmDialog
					title={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? `Roll ${pendingDeploy.team.name} back to v${pendingDeploy.version}?` : `Publish v${pendingDeploy.version} to ${pendingDeploy.team.name}?`}
					message={
						<>
							{pendingDeploy.fromVersion !== undefined ? `This repoints ${pendingDeploy.team.name} from v${pendingDeploy.fromVersion} to v${pendingDeploy.version}. Nothing is rebuilt, and its schedules and history carry over.` : `This is the first publish to ${pendingDeploy.team.name}; it serves v${pendingDeploy.version} at once.`}
							{error && <div style={S.errorText}>{error}</div>}
						</>
					}
					confirmLabel={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? 'Rollback' : 'Publish'}
					cancelLabel="Cancel"
					onConfirm={() => void run(() => onDeploy(pendingDeploy.version, pendingDeploy.team.id))}
					onCancel={closeDialogs}
				/>
			)}
		</div>
	);
};
