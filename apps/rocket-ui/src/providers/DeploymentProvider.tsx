// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// DEPLOYMENT PROVIDER — drawer host for one team deployment (record panel)
// =============================================================================
//
// Owned and rendered by the surface that opens the record (the grid-view
// pattern): ProjectProvider mounts one instance when a where-live row or a
// version-card team badge is clicked — a deployment is the RECORD behind
// those gestures, so it opens as the wide DeploymentRecordPanel drawer,
// not a document tab. Everything is fetched
// from the registry through the deploy API — the deployment record, the
// immutable artifact (the readonly DESIGN render), this team's history, and
// the registry versions — then handed to the shared record panel. The
// run-log adapters are TEAM-scoped closures over client.log (the scope IS
// the kind: teamId addresses this team's deploy continuum); closing the
// drawer loses nothing durable — the continuum reconstructs on reopen.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShellConnection, getClient, ConnectionManager } from 'shell';
import { DeploymentRecordPanel, TeamDeploymentRecordPanel } from 'shared/components/deploy-panel';
import type { DeployHistoryRow, DeployScheduleRow, DeployVersionCard, DeploymentInfo } from 'shared/components/deploy-panel';
import { foldDeployRunState } from 'shared/modules/sidebar/taskFold';
import { isTeamLiveEvent } from 'shared/modules/project';
import type { TaskEventMessage } from 'shared/modules/project';
import type { Deployment, DeployHistoryEntry, DeployArtifact } from 'shell';
import { useDeployments } from '../hooks/useDeployments';

// Live-feed retention for the record's report cards (mirrors the dev host's
// chunky-trim policy: cap, then trim back to KEEP so sections re-feed once).
const LIVE_EVENTS_MAX = 4000;
const LIVE_EVENTS_KEEP = 3000;

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link DeploymentProvider}. */
interface IDeploymentProviderProps {
	/** The deployment's team (the environment identity). */
	teamId: string;
	/** The focused source; ABSENT = the TEAM record (team operations). */
	sourceId?: string;
	/** The deployed project id (registry key). */
	projectId: string;
	/** Dismiss the drawer. */
	onClose: () => void;
	/** Re-target the drawer at one source (team drawer's sources rows). */
	onOpenSource?: (sourceId: string) => void;
}

/**
 * Fetch-and-bind host for one team deployment's tab.
 *
 * Owns every server interaction (fetches, mutations, team-scoped log
 * adapters) and re-fetches after each mutation so the header/state chips
 * always reflect the server's truth, not an optimistic guess.
 */
const DeploymentProvider: React.FC<IDeploymentProviderProps> = ({ teamId, sourceId, projectId, onClose, onOpenSource }) => {
	const { client, isConnected } = useShellConnection();
	const { teams, teamName, refresh: refreshDeployments } = useDeployments();

	// --- Server state ---------------------------------------------------------

	const [deployment, setDeployment] = useState<Deployment | null>(null);
	const [pipeline, setPipeline] = useState<Record<string, unknown> | null>(null);
	const [historyRows, setHistoryRows] = useState<DeployHistoryEntry[]>([]);
	const [versionRows, setVersionRows] = useState<DeployArtifact[]>([]);
	const [servicesJson, setServicesJson] = useState<Record<string, unknown>>({});
	const [nextRun, setNextRun] = useState<{ at: number; sourceId: string; cron: string } | undefined>(undefined);
	const [nextRuns, setNextRuns] = useState<Record<string, number>>({});
	const [runningSources, setRunningSources] = useState<Record<string, boolean>>({});
	const [liveEvents, setLiveEvents] = useState<TaskEventMessage[]>([]);
	const [loadError, setLoadError] = useState('');

	// Synchronously-advanced mirror for the run-state fold: websocket events
	// can burst faster than a render, and the fold needs the CURRENT map.
	const runningSourcesRef = useRef(runningSources);
	useEffect(() => {
		runningSourcesRef.current = runningSources;
	}, [runningSources]);

	// Monotonic load counter: mutation re-fetches race the push-driven
	// re-fetch by design — a slower earlier run must not overwrite newer
	// rows, so only the newest fetchAll may commit each result.
	const fetchSeq = useRef(0);

	/** Fetch the deployment + registry state (initial load and post-mutation). */
	const fetchAll = useCallback(async (): Promise<void> => {
		if (!client || !isConnected || !projectId) return;
		const mine = ++fetchSeq.current;
		try {
			const dep = await client.deploy.get(projectId, teamId);
			if (mine !== fetchSeq.current) return;
			setDeployment(dep);
			setLoadError('');

			// The artifact only changes when the pointer moves — fetch per state.
			if (typeof dep.version === 'number') {
				const artifact = (await client.deploy.artifact(projectId, dep.version)) as unknown as Record<string, unknown>;
				if (mine !== fetchSeq.current) return;
				setPipeline(artifact);
			} else {
				// No published version to fetch — surface it instead of leaving
				// the drawer with an eternal loading body.
				setPipeline(null);
				setLoadError('This deployment has no published version.');
			}
			const [history, versions] = await Promise.all([client.deploy.history(projectId, { teamId }), client.deploy.versions(projectId)]);
			if (mine !== fetchSeq.current) return;
			setHistoryRows(history.rows ?? []);
			setVersionRows(versions.rows ?? []);

			// Next occurrence through THE single evaluator (never parse cron
			// client-side): the FOCUSED source's schedule, or — for the TEAM
			// record — the first armed schedule across every source.
			const armed = sourceId ? (dep.schedules?.[sourceId]?.cron && !dep.schedules[sourceId].paused ? ([sourceId, dep.schedules[sourceId]] as const) : undefined) : undefined;
			if (armed && dep.state === 'enabled') {
				const preview = await client.deploy.preview(armed[1].cron as string, 1);
				if (mine !== fetchSeq.current) return;
				const firstAt = preview.valid ? preview.next?.[0] : undefined;
				setNextRun(typeof firstAt === 'number' ? { at: firstAt, sourceId: armed[0], cron: armed[1].cron as string } : undefined);
			} else {
				setNextRun(undefined);
			}

			// TEAM record: every armed schedule's next occurrence (the status
			// grid's Next-run column) through the same single evaluator.
			if (!sourceId && dep.state === 'enabled') {
				const upcoming: Record<string, number> = {};
				for (const [sid, sched] of Object.entries(dep.schedules ?? {})) {
					if (!sched.cron || sched.paused) continue;
					try {
						const preview = await client.deploy.preview(sched.cron as string, 1);
						const firstAt = preview.valid ? preview.next?.[0] : undefined;
						if (typeof firstAt === 'number') upcoming[sid] = firstAt;
					} catch {
						// An unpreviewable cron just leaves the cell empty.
					}
					// A newer run superseded this one — stop the remaining previews.
					if (mine !== fetchSeq.current) return;
				}
				setNextRuns(upcoming);
			} else {
				setNextRuns({});
			}
			// Live-run state is EVENT-DRIVEN (see the monitor effect below):
			// the team-scoped 'task' subscription's catch-up snapshot seeds
			// runningSources and begin/end events flip it — no registry scan.
		} catch (err) {
			// Only the newest run may surface its failure.
			if (mine !== fetchSeq.current) return;
			setLoadError(err instanceof Error ? err.message : String(err));
		}
	}, [client, isConnected, projectId, teamId, sourceId]);

	// Initial load — record changes are pushed (apaevt_deploy invalidations
	// and team-scoped task events below), so there is no poll.
	useEffect(() => {
		void fetchAll();
	}, [fetchAll]);

	// PUSH wiring: the team-scoped 'task' subscription drives runningSources
	// (catch-up snapshot seeds it; begin/end flip it) and feeds the record's
	// live report cards; the org-scoped 'deploy' subscription invalidates
	// the record on any deployment mutation (re-fetch, never trust payload).
	useEffect(() => {
		if (!client || !isConnected || !projectId) return;
		client.addMonitor({ projectId, source: '*', teamId }, ['task']).catch((err) => console.error('[DeploymentProvider] task monitor failed:', err));
		client.addMonitor({ token: '*' }, ['deploy']).catch((err) => console.error('[DeploymentProvider] deploy monitor failed:', err));

		const unsub = ConnectionManager.getInstance().on('shell:event', ({ event }: { event: any }) => {
			if (event?.event === 'apaevt_task' && event.body) {
				const folded = foldDeployRunState(event.body, runningSourcesRef.current, teamId, projectId);
				if (folded) {
					runningSourcesRef.current = folded;
					setRunningSources(folded);
				}
			} else if (event?.event === 'apaevt_deploy' && event.body) {
				const b = event.body as { projectId?: string; teamId?: string; action?: string };
				// Publishes are org-wide (version picker); everything else is
				// this team's record.
				if (b.projectId === projectId && (b.teamId === teamId || b.action === 'publish')) void fetchAll();
			}

			// The record's live feed: this team's stamped deploy-run events.
			if (isTeamLiveEvent(event, projectId, teamId)) {
				setLiveEvents((prev) => {
					const next = [...prev, event as TaskEventMessage];
					return next.length > LIVE_EVENTS_MAX ? next.slice(next.length - LIVE_EVENTS_KEEP) : next;
				});
			}
		});

		return () => {
			unsub();
			client.removeMonitor({ projectId, source: '*', teamId }, ['task']).catch(() => {});
			client.removeMonitor({ token: '*' }, ['deploy']).catch(() => {});
		};
	}, [client, isConnected, projectId, teamId, fetchAll]);

	// Clear stale live state on reconnect (the resubscribe re-seeds it).
	useEffect(() => {
		if (isConnected) {
			setLiveEvents([]);
			runningSourcesRef.current = {};
			setRunningSources({});
		}
	}, [isConnected]);

	// Service catalog for the readonly canvas (same fetch as ProjectProvider).
	useEffect(() => {
		if (!client || !isConnected) return;
		(
			client as {
				getServices?: () => Promise<{ services?: Record<string, unknown> }>;
			}
		)
			.getServices?.()
			.then((res) => setServicesJson((res?.services ?? res ?? {}) as Record<string, unknown>))
			.catch(() => {});
	}, [client, isConnected]);

	// --- View models ----------------------------------------------------------

	const info: DeploymentInfo | null = useMemo(() => {
		if (!deployment) return null;
		return {
			pipelineName: deployment.pipelineName || projectId,
			version: deployment.version ?? 0,
			// A record without a state stamp is a live pointer — 'enabled' is
			// the only default inside the state vocabulary.
			state: (deployment.state ?? 'enabled') as DeploymentInfo['state'],
			deployedBy: deployment.updatedBy?.display || deployment.updatedBy?.userId || '',
			// The POINTER-MOVE stamp, not the last mutation time — a pause or
			// schedule edit bumps updatedAt but not deployedAt (same field the
			// where-live rows read; updatedAt covers pre-stamp records).
			deployedAt: deployment.deployedAt ?? deployment.updatedAt ?? 0,
		};
	}, [deployment, projectId]);

	// The focused source's display name from the artifact (id fallback).
	const sourceName: string = useMemo(() => {
		if (!sourceId) return '';
		const components = Array.isArray(pipeline?.components) ? (pipeline?.components as Array<{ id?: string; name?: string }>) : [];
		return components.find((c) => c.id === sourceId)?.name || sourceId;
	}, [pipeline, sourceId]);

	// Team record: one row per source (artifact sources ∪ schedule records).
	const scheduleRows: DeployScheduleRow[] = useMemo(() => {
		const components = Array.isArray(pipeline?.components) ? (pipeline?.components as Array<{ id?: string; name?: string; config?: { mode?: string } }>) : [];
		return components
			.filter((c) => c.config?.mode === 'Source' && c.id)
			.map((c) => {
				const sched = deployment?.schedules?.[c.id as string];
				return {
					sourceId: c.id as string,
					sourceName: c.name || (c.id as string),
					cron: (sched?.cron as string) ?? '',
					paused: sched?.paused === true,
					...(sched?.ttl ? { ttl: sched.ttl as number } : {}),
					...(sched?.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}),
				};
			});
	}, [pipeline, deployment]);

	// Registry versions for the team drawer's Deploy version… picker.
	const versions: DeployVersionCard[] = useMemo(
		() =>
			versionRows.map((v) => ({
				version: v.version ?? 0,
				sha256: v.sha256 ?? '',
				publishedAt: v.publishedAt ?? 0,
				publishedBy: v.publishedBy?.display || v.publishedBy?.userId || '',
				...(v.comment ? { comment: v.comment } : {}),
			})),
		[versionRows]
	);

	const history: DeployHistoryRow[] = useMemo(
		() =>
			historyRows.map((row) => ({
				seq: row.seq ?? 0,
				at: row.at ?? 0,
				action: (row.action ?? 'deploy') as DeployHistoryRow['action'],
				teamId: row.teamId ?? '',
				teamName: row.teamId ? teamName(row.teamId) : '',
				version: row.version ?? 0,
				actor: row.actor?.display || row.actor?.userId || '',
			})),
		[historyRows, teamName]
	);

	const canControl = teams.find((t) => t.id === teamId)?.canControl ?? false;

	// --- Team-scoped run-log adapters (the scope IS the kind) -----------------

	const openSession = useCallback(
		(sourceId: string) => {
			const c = getClient();
			if (!c) {
				// Inert stand-in when the shell has disconnected: satisfies the
				// session surface with no-ops (same shape ProjectProvider's
				// openEventStream returns before connect).
				return {
					seek: async () => {},
					getStatus: async () => null,
					play: async () => {},
					getTrace: async () => ({ events: [] }),
					pause: () => {},
					ingestLive: () => {},
					closeEventStream: () => {},
				};
			}
			return c.log.openEventStream({ projectId, source: sourceId, teamId });
		},
		[projectId, teamId]
	);

	const fetchTimeline = useCallback(
		async (sourceId: string) => {
			const c = getClient();
			if (!c) return { chapters: [], segments: [], horizonSeq: 0, completed: true };
			return c.log.chapters({ projectId, source: sourceId, teamId });
		},
		[projectId, teamId]
	);

	// --- Validation passthrough (readonly canvas still validates renders) ----

	const handleValidate = useCallback(async (pipelineToValidate: unknown): Promise<{ errors: unknown[]; warnings: unknown[] }> => {
		const c = getClient();
		if (!c) return { errors: [], warnings: [] };
		try {
			return await (
				c as {
					validate: (arg: { pipeline: unknown }) => Promise<{ errors: unknown[]; warnings: unknown[] }>;
				}
			).validate({ pipeline: pipelineToValidate });
		} catch {
			return { errors: [], warnings: [] };
		}
	}, []);

	// --- Mutations (re-fetch after each; the server is the truth) -------------

	/** Persist the focused source's execution settings (Save verb). */
	const handleSetSourceConfig = useCallback(
		async (traceLevel: 'none' | 'metadata' | 'summary' | 'full' | null, debugOut: boolean): Promise<void> => {
			if (!client || !sourceId) throw new Error('Not connected');
			await client.deploy.setSourceConfig(projectId, sourceId, teamId, { ...(traceLevel ? { traceLevel } : {}), debugOut });
			await fetchAll();
			refreshDeployments();
		},
		[client, projectId, sourceId, teamId, fetchAll, refreshDeployments]
	);

	/** Pause/resume the focused source's schedule (source-drawer verb). */
	const handleSetSchedulePaused = useCallback(
		async (paused: boolean): Promise<void> => {
			if (!client || !sourceId) throw new Error('Not connected');
			if (paused) await client.deploy.pauseSchedule(projectId, sourceId, teamId);
			else await client.deploy.resumeSchedule(projectId, sourceId, teamId);
			await fetchAll();
			refreshDeployments();
		},
		[client, projectId, sourceId, teamId, fetchAll, refreshDeployments]
	);

	/** Enable/disable this team deployment (team-drawer verb). */
	const handleSetDisabled = useCallback(
		async (disabled: boolean): Promise<void> => {
			if (!client) throw new Error('Not connected');
			if (disabled) await client.deploy.disable(projectId, teamId);
			else await client.deploy.enable(projectId, teamId);
			await fetchAll();
			refreshDeployments();
		},
		[client, projectId, teamId, fetchAll, refreshDeployments]
	);

	/** Point this team at a version (team-drawer verb). */
	const handleDeployVersion = useCallback(
		async (version: number): Promise<void> => {
			if (!client) throw new Error('Not connected');
			await client.deploy.deploy(projectId, version, teamId);
			await fetchAll();
			refreshDeployments();
		},
		[client, projectId, teamId, fetchAll, refreshDeployments]
	);

	/** Soft-remove this team deployment (team-drawer verb). */
	const handleRemove = useCallback(async (): Promise<void> => {
		if (!client) throw new Error('Not connected');
		await client.deploy.remove(projectId, teamId);
		refreshDeployments();
		// The deployment left every listing — close its drawer rather than
		// leaving a view of something that no longer exists.
		onClose();
	}, [client, projectId, teamId, refreshDeployments, onClose]);

	const handleRunSource = useCallback(
		async (sourceId: string): Promise<void> => {
			if (!client) throw new Error('Not connected');
			await client.deploy.run(projectId, sourceId, teamId);
			await fetchAll();
		},
		[client, projectId, teamId, fetchAll]
	);

	const handleStopSource = useCallback(
		async (sourceId: string): Promise<void> => {
			if (!client) throw new Error('Not connected');
			// Existing task machinery: resolve the live task, terminate it.
			// teamId scopes the lookup to the TEAM's deploy run — without it
			// the server would resolve the caller's own dev run.
			const token = await client.getTaskToken({ projectId, source: sourceId, teamId });
			if (token) await client.terminate(token);
			await fetchAll();
		},
		[client, projectId, teamId, fetchAll]
	);

	// --- Render ---------------------------------------------------------------

	// ONE drawer instance across loading -> loaded — the panel renders its
	// own state body until `data` exists, so the slide-in and width happen
	// exactly once (no default-width flash, no remount).
	const ready = Boolean(isConnected && !loadError && info && pipeline);
	const stateProps = !isConnected ? { loadError: 'Not connected to the server' } : loadError ? { loadError } : {};

	// TEAM record (no focused source): the team-operations drawer.
	if (!sourceId) {
		return (
			<TeamDeploymentRecordPanel
				open
				onClose={onClose}
				fallbackTitle={`${teamName(teamId)} / ${projectId}`}
				{...stateProps}
				{...(ready
					? {
							data: {
								teamName: teamName(teamId),
								deployment: info as NonNullable<typeof info>,
								versions,
								history,
								schedules: scheduleRows,
								nextRuns,
								runningSources,
								canControl,
								isConnected,
								fetchTimeline,
								...(onOpenSource ? { onOpenSource } : {}),
								onSetDisabled: handleSetDisabled,
								onDeployVersion: handleDeployVersion,
								...(canControl ? { onRemove: handleRemove } : {}),
							},
						}
					: {})}
			/>
		);
	}

	// SOURCE record: the focused (team, project, source) drawer.
	return (
		<DeploymentRecordPanel
			open
			onClose={onClose}
			fallbackTitle={`${teamName(teamId)} / ${projectId}`}
			{...stateProps}
			{...(ready
				? {
						data: {
							teamName: teamName(teamId),
							deployment: info as NonNullable<typeof info>,
							pipeline: pipeline as never,
							servicesJson: servicesJson as never,
							handleValidatePipeline: handleValidate as never,
							sourceId,
							sourceName,
							history,
							...(nextRun ? { nextRun } : {}),
							runningSources,
							canControl,
							isConnected,
							openSession,
							fetchTimeline,
							liveEvents,
							...(deployment?.schedules?.[sourceId] ? { sourcePaused: deployment.schedules[sourceId].paused === true } : {}),
							sourceConfig: { traceLevel: (deployment?.schedules?.[sourceId]?.traceLevel ?? null) as 'none' | 'metadata' | 'summary' | 'full' | null, debugOut: deployment?.schedules?.[sourceId]?.debugOut === true },
							onSetSourceConfig: handleSetSourceConfig,
							onSetSchedulePaused: handleSetSchedulePaused,
							onRunSource: handleRunSource,
							onStopSource: handleStopSource,
						},
					}
				: {})}
		/>
	);
};

export default DeploymentProvider;
