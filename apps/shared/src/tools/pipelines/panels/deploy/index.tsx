// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The DEPLOY panel — the third tab of the pipeline editor's strip.
 *
 * Composes the SHARED {@link DeployPanel} (`shared/panels/deploy`, which the
 * cloud's DeploymentProvider also mounts) with the pipeline-specific
 * adaptation that used to sit inline in ProjectView: the readonly guard, the
 * team-deployment row mapping, and the publish gating derived from document
 * state.
 *
 * Capabilities arrive as ONE object ({@link IPipelineDeploy}) rather than a
 * dozen loose props — the shape appdev's IAppBuilderHost already uses, and
 * what lets this panel exist as a file instead of a 22-prop forwarder.
 */

import React, { useMemo } from 'react';
import type { ComponentProps } from 'react';
import { commonStyles } from 'shell';
import { DeployPanel } from 'shared/panels/deploy/DeployPanel';
import type { DeploySnapshot } from 'shared/panels/deploy/DeployPanel';
import type { DeployTeamRef, TeamDeployment, TeamDeploymentRow } from 'shared/panels/deploy/types';
import type { SchedulePreviewResult } from 'shared/panels/deploy/DeploymentView';

// =============================================================================
// THE CAPABILITY
// =============================================================================

/**
 * Everything the Deploy tab needs from its host, in one object.
 *
 * PRESENCE enables the page: a host that cannot deploy omits it entirely and
 * the tab renders the not-available state. The three REQUIRED members are
 * what the old inline guard tested one by one
 * (`fetchDeployLifecycle && onDeployPublish && onDeployVersion`) — now the
 * type carries that instead of a runtime conjunction.
 */
export interface IPipelineDeploy {
	/** The deploy lifecycle for this pipeline (versions + history). The panel
	 *  owns fetching and refresh, like SourcePanel. */
	fetchLifecycle: () => Promise<DeploySnapshot>;
	/** Publish the SAVED pipeline as the next registry version. */
	publish: (comment: string, deployTo?: string) => Promise<void>;
	/** Point a team at a registry version (promotion and rollback alike). */
	deployVersion: (version: number, teamId: string) => Promise<void>;
	/** LIVE team deployments as RAW facts (team, pointer, state, schedule
	 *  records). Source names resolve HERE against the pipeline, never in the
	 *  host — the derivation exists once for both hosts. */
	teamDeployments?: TeamDeployment[];
	/** Teams visible to the caller, with resolved names + control rights. */
	teams?: DeployTeamRef[];
	/** Open a deployment record drawer (team-level without a sourceId). */
	openDeployment?: (teamId: string, sourceId?: string) => void;
	/** Toggle one team deployment's kill switch (where-live state dot). */
	setDisabled?: (teamId: string, disabled: boolean) => Promise<void>;
	/** Soft-remove one team's deployment from the where-live header. */
	remove?: (teamId: string) => Promise<void>;
	/** Set/clear one source's schedule on a team deployment (where-live pill). */
	setSchedule?: (teamId: string, sourceId: string, cron: string | null, ttl: number | null) => Promise<void>;
	/** Pause/resume ONE source's schedule, preserving cron/ttl. */
	setSchedulePaused?: (teamId: string, sourceId: string, paused: boolean) => Promise<void>;
	/** Cron preview via the server's single evaluator (schedule editor). */
	previewSchedule?: (cron: string, count: number) => Promise<SchedulePreviewResult>;
	/** Fetch one immutable artifact's pipeline JSON — makes the version cards
	 *  open a readonly-canvas record drawer. Typed with DeployPanel's own
	 *  artifact shape so drift surfaces at compile time, not via a cast. */
	fetchArtifact?: NonNullable<ComponentProps<typeof DeployPanel>['fetchArtifact']>;
	/** Save the document and resolve when it is on disk — the 'Save & publish'
	 *  path for a dirty document. */
	saveDocument?: () => Promise<void>;
}

/** The canvas context the record drawer needs to render an artifact readonly. */
export interface IDeployArtifactContext {
	servicesJson: ComponentProps<typeof DeployPanel>['servicesJson'];
	handleValidatePipeline: ComponentProps<typeof DeployPanel>['handleValidatePipeline'];
	isConnected: boolean;
	isSubscribed: boolean;
	serverHost: string;
	onOpenLink?: ComponentProps<typeof DeployPanel>['onOpenLink'];
}

/** Props for {@link DeployTab}. */
export interface IDeployTabProps {
	/** The host's deploy capability; absent = the tab is not available here. */
	deploy?: IPipelineDeploy;
	/** This pipeline's sources — resolves schedule records to source NAMES. */
	sources: { id: string; name: string }[];
	/** Rendered on the version strip. */
	pipelineName: string;
	/** A readonly host removes the tab and clamps the mode. */
	isReadonly: boolean;
	/** Document state drives publish gating (never-saved blocks; dirty saves). */
	isDirty: boolean;
	isNew: boolean;
	/** Only needed when `deploy.fetchArtifact` is present. */
	artifactContext: IDeployArtifactContext;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The Deploy tab's content.
 *
 * NOTE on mounting: TabPanel mounts EVERY panel and hides the inactive ones,
 * so a readonly host must not mount DeployPanel at all — its mount-time
 * refresh() would fetch a lifecycle the user can never open.
 *
 * @param props - See {@link IDeployTabProps}.
 */
export const DeployTab: React.FC<IDeployTabProps> = ({ deploy, sources, pipelineName, isReadonly, isDirty, isNew, artifactContext }) => {
	// Source lines = pipeline sources ∪ schedule records (a schedule on a
	// renamed/removed source still shows, id-named).
	const rows: TeamDeploymentRow[] = useMemo(() => {
		const names = new Map(sources.map((s) => [s.id, s.name]));
		return (deploy?.teamDeployments ?? []).map((dep) => {
			const sourceIds = [...new Set([...names.keys(), ...Object.keys(dep.schedules)])];
			return {
				teamId: dep.teamId,
				teamName: dep.teamName,
				version: dep.version,
				state: dep.state,
				deployedAt: dep.deployedAt,
				sources: sourceIds.map((sourceId) => {
					const sched = dep.schedules[sourceId];
					return {
						sourceId,
						sourceName: names.get(sourceId) ?? sourceId,
						cron: sched?.cron ?? '',
						paused: sched?.paused === true,
						...(sched?.ttl ? { ttl: sched.ttl } : {}),
						...(sched?.lastRunAt ? { lastRunAt: sched.lastRunAt } : {}),
						...(dep.runningSources?.[sourceId] ? { running: true } : {}),
					};
				}),
			};
		});
	}, [deploy?.teamDeployments, sources]);

	if (isReadonly || !deploy) {
		return <div style={commonStyles.empty}>Deployment lifecycle is not available in this host yet</div>;
	}

	const { servicesJson, handleValidatePipeline, isConnected, isSubscribed, serverHost, onOpenLink } = artifactContext;
	return (
		<DeployPanel
			fetchLifecycle={deploy.fetchLifecycle}
			deployments={rows}
			teams={deploy.teams ?? []}
			pipelineName={pipelineName}
			{...(deploy.setDisabled ? { onSetDisabled: deploy.setDisabled } : {})}
			{...(deploy.remove ? { onRemove: deploy.remove } : {})}
			{...(deploy.setSchedule ? { onSetSchedule: deploy.setSchedule } : {})}
			{...(deploy.setSchedulePaused ? { onSetSchedulePaused: deploy.setSchedulePaused } : {})}
			{...(deploy.fetchArtifact ? { fetchArtifact: deploy.fetchArtifact, servicesJson, handleValidatePipeline, isConnected, isSubscribed, serverHost, ...(onOpenLink ? { onOpenLink } : {}) } : {})}
			{...(deploy.previewSchedule ? { previewSchedule: deploy.previewSchedule } : {})}
			canPublish={!isDirty && !isNew}
			{...(isNew ? { publishDisabledReason: 'Save the pipeline first' } : {})}
			requiresSave={isDirty && !isNew}
			{...(deploy.saveDocument ? { onSaveDocument: deploy.saveDocument } : {})}
			onPublish={deploy.publish}
			onDeploy={deploy.deployVersion}
			{...(deploy.openDeployment ? { onOpenDeployment: deploy.openDeployment } : {})}
		/>
	);
};
