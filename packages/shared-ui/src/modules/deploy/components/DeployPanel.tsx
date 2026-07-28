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

import { commonStyles } from '../../../themes/styles';
import { Button } from '../../../components/button/Button';
import { Modal } from '../../../components/modal/Modal';
import { ConfirmDialog } from '../../../components/modal/ConfirmDialog';
import { Card } from '../../../components/card/Card';
import { CardDataGrid } from '../../../components/data-grid/CardDataGrid';
import { mutedEl } from '../../../components/data-grid/defaults';
import { formatTime } from '../../server/util/formatters';
import type { CellComponent } from 'tabulator-tables';
import type { GridColumnDefinition } from '../../../components/data-grid/defaults';
import type { DeployHistoryRow, DeployTeamRef, DeployVersionCard, TeamDeploymentRow } from '../types';

// =============================================================================
// PROPS
// =============================================================================

/** The registry snapshot {@link IDeployPanelProps.fetchLifecycle} returns. */
export interface DeploySnapshot {
	/** Registry versions, newest first. */
	versions: DeployVersionCard[];
	/** Merged audit history, newest first. */
	history: DeployHistoryRow[];
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
	/** Open the file-less deployment tab for one team. */
	onOpenDeployment?: (teamId: string) => void;
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
	versionCard: {
		minWidth: 168,
		border: '1px solid var(--rr-border)',
		borderRadius: 6,
		background: 'var(--rr-bg-paper)',
		padding: '10px 12px',
		flexShrink: 0,
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
	envTags: {
		display: 'flex',
		gap: 5,
		marginTop: 8,
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
	rowButtons: {
		display: 'flex',
		gap: 6,
		marginTop: 9,
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
};

// =============================================================================
// HELPERS
// =============================================================================

/** Short sha rendering: first 8 hex chars + ellipsis. */
function shortSha(sha: string): string {
	return sha ? `${sha.slice(0, 8)}…` : '';
}

/** Human wording for one audit row (mockup's history phrasing). */
function historyWording(row: DeployHistoryRow, multiTeam: boolean): string {
	const team = multiTeam && row.teamName ? ` to ${row.teamName}` : '';
	switch (row.action) {
		case 'publish':
			return `published v${row.version}${row.comment ? ` “${row.comment}”` : ''}`;
		case 'rollback':
			return `rollback${multiTeam && row.teamName ? ` ${row.teamName}` : ''} → v${row.version}`;
		case 'deploy':
			return `deployed v${row.version}${team}`;
		default:
			return `${row.action} v${row.version}${team}`;
	}
}

/** State cell colour (matches the mockup's chip palette). */
function stateColor(state: TeamDeploymentRow['state']): string {
	if (state === 'errored') return 'var(--rr-color-error)';
	if (state === 'active') return 'var(--rr-color-success)';
	return 'var(--rr-text-secondary)';
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The DEPLOY-page lifecycle surface: version strip, where-live grid,
 * merged history grid. See the module docstring for the collapsing rules.
 */
export const DeployPanel: React.FC<IDeployPanelProps> = ({ fetchLifecycle, deployments, teams, canPublish = true, publishDisabledReason, requiresSave = false, onSaveDocument, onPublish, onDeploy, onOpenDeployment }) => {
	// --- Panel-owned registry data (fetched, never passed in) -----------------

	const [versions, setVersions] = useState<DeployVersionCard[]>([]);
	const [history, setHistory] = useState<DeployHistoryRow[]>([]);
	const [loading, setLoading] = useState(true);

	/** (Re-)fetch the registry snapshot; a failed fetch keeps the last data. */
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const snapshot = await fetchLifecycle();
			setVersions(snapshot.versions);
			setHistory(snapshot.history);
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

	// version -> live teams (for the env badges on each card).
	const liveByVersion = useMemo(() => {
		const map = new Map<number, TeamDeploymentRow[]>();
		for (const dep of deployments) {
			if (dep.state === 'removed') continue;
			const rows = map.get(dep.version) ?? [];
			rows.push(dep);
			map.set(dep.version, rows);
		}
		return map;
	}, [deployments]);

	const nextVersion = (versions[0]?.version ?? 0) + 1;

	// --- Modal + action state -------------------------------------------------

	// The version awaiting a team choice (Deploy to… picker).
	const [pickerVersion, setPickerVersion] = useState<number | null>(null);
	// A chosen (version, team) pointer move awaiting CONFIRMATION.
	const [pendingDeploy, setPendingDeploy] = useState<{ version: number; team: DeployTeamRef; fromVersion?: number } | null>(null);
	const [publishOpen, setPublishOpen] = useState(false);
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

	const whereLiveColumns: GridColumnDefinition[] = useMemo(
		() => [
			{ title: 'Team', field: 'teamName', rrType: 'string', rrDefault: true, rrDescription: 'The team (environment) this deployment belongs to.', width: 180, widthGrow: 2 },
			{ title: 'Version', field: 'version', rrType: 'number', rrDefault: true, rrDescription: 'The registry version this team currently points at.', width: 90, formatter: (cell: CellComponent) => `v${cell.getValue()}` },
			{
				title: 'State',
				field: 'state',
				rrType: 'enum',
				rrDefault: true,
				rrOptions: ['active', 'paused', 'errored'],
				width: 110,
				rrDescription: 'Deployment state: active (schedules fire), paused, or errored (a dispatch was denied).',
				formatter: (cell: CellComponent) => {
					const el = document.createElement('span');
					el.style.color = stateColor(cell.getValue() as TeamDeploymentRow['state']);
					el.textContent = `● ${cell.getValue()}`;
					return el;
				},
			},
			{ title: 'Schedules', field: 'schedulesSummary', rrType: 'string', rrDefault: true, rrDescription: 'Per-source cron summary, or manual when nothing is scheduled.', width: 220, widthGrow: 3 },
			{
				title: 'Last run',
				field: 'lastRunAt',
				rrType: 'date',
				rrDefault: true,
				width: 150,
				rrDescription: 'When the scheduler last dispatched any source of this deployment (local time).',
				formatter: (cell: CellComponent) => mutedEl(cell.getValue() ? formatTime(cell.getValue() as number) : '—'),
			},
		],
		[]
	);

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
				rrDescription: 'What happened: publishes, deploys, rollbacks, pauses, removals.',
				widthGrow: 3,
				formatter: (cell: CellComponent) => historyWording(cell.getRow().getData() as DeployHistoryRow, multiTeam),
			},
		],
		[multiTeam]
	);

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
						<div key={v.version} style={{ ...S.versionCard, ...(index === 0 ? S.versionCardNewest : {}) }}>
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
								{live.map((dep) => (
									<span key={dep.teamId} style={S.envTag} title={`Live on ${dep.teamName} (${dep.state})`}>
										{multiTeam ? dep.teamName : 'deployed'}
									</span>
								))}
							</div>
							{controlTeams.length > 0 && (
								<div style={S.rowButtons}>
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

			{/* ── Where live (stock grid; hidden with a single team) ────── */}
			{multiTeam && deployments.length > 0 && (
				<div style={S.gridWrap}>
					<Card noBodyPadding>
						<CardDataGrid<TeamDeploymentRow & Record<string, unknown>> title="Where this project is live" columns={whereLiveColumns} data={deployments as Array<TeamDeploymentRow & Record<string, unknown>>} tableId="deploy-where-live" emptyTitle="Not deployed anywhere" emptyDescription="Deploy a published version to a team to see it here." {...(onOpenDeployment ? { onRowClick: (row: TeamDeploymentRow & Record<string, unknown>) => onOpenDeployment(row.teamId) } : {})} />
					</Card>
				</div>
			)}

			{/* ── Merged history (stock grid) ───────────────────────────── */}
			<div style={S.gridWrap}>
				<Card noBodyPadding>
					<CardDataGrid<DeployHistoryRow & Record<string, unknown>> title="History" columns={historyColumns} data={history as Array<DeployHistoryRow & Record<string, unknown>>} tableId="deploy-history" emptyTitle={loading ? 'Loading…' : 'No deployment history yet'} emptyDescription="Publishes and every team's deploys land here, merged and immutable." />
				</Card>
			</div>

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
				</Modal>
			)}

			{/* ── Pointer-move confirmation (deploy and rollback alike) ─── */}
			{pendingDeploy && <ConfirmDialog title={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? `Roll ${pendingDeploy.team.name} back to v${pendingDeploy.version}?` : `Deploy v${pendingDeploy.version} to ${pendingDeploy.team.name}?`} message={pendingDeploy.fromVersion !== undefined ? `${pendingDeploy.team.name} currently runs v${pendingDeploy.fromVersion}. Its next runs will execute v${pendingDeploy.version} — schedules and history carry over.` : `${pendingDeploy.team.name} is not running this project yet. Its runs will execute v${pendingDeploy.version}.`} confirmLabel={pendingDeploy.fromVersion !== undefined && pendingDeploy.fromVersion > pendingDeploy.version ? 'Rollback' : 'Deploy'} cancelLabel="Cancel" onConfirm={() => void run(() => onDeploy(pendingDeploy.version, pendingDeploy.team.id))} onCancel={() => setPendingDeploy(null)} />}
		</div>
	);
};
