// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy module — teams-as-environments deployment surfaces (mockup v5):
 * the file view's DEPLOY lifecycle page and the file-less deployment tab.
 */

export { DeployPanel } from './DeployPanel';
export type { IDeployPanelProps, DeploySnapshot } from './DeployPanel';
export { DeploymentView } from './DeploymentView';
export type { IDeploymentViewProps, DeploymentInfo, SchedulePreviewResult } from './DeploymentView';
export { DeploymentRecordPanel } from './DeploymentRecordPanel';
export { TeamDeploymentRecordPanel } from './TeamDeploymentRecordPanel';
export type { ITeamDeploymentRecordPanelProps, ITeamDeploymentRecordData } from './TeamDeploymentRecordPanel';
export type { IDeploymentRecordPanelProps, IDeploymentRecordData } from './DeploymentRecordPanel';
export { SchedulePanel, describeCron, describeTtl } from './SchedulePanel';
export type { ISchedulePanelProps } from './SchedulePanel';
export type { DeployTeamRef, DeployVersionCard, TeamDeployment, TeamDeploymentSchedule, TeamDeploymentRow, TeamDeploymentSource, DeployHistoryRow, DeployScheduleRow } from './types';
