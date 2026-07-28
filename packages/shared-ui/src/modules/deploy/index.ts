// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy module — teams-as-environments deployment surfaces (mockup v5):
 * the file view's DEPLOY lifecycle page and the file-less deployment tab.
 */

export { DeployPanel } from './components/DeployPanel';
export type { IDeployPanelProps, DeploySnapshot } from './components/DeployPanel';
export { DeploymentView } from './DeploymentView';
export type { IDeploymentViewProps, DeploymentInfo } from './DeploymentView';
export { SchedulePanel, describeCron } from './components/SchedulePanel';
export type { ISchedulePanelProps } from './components/SchedulePanel';
export type { DeployTeamRef, DeployVersionCard, TeamDeploymentRow, DeployHistoryRow, DeployScheduleRow } from './types';
