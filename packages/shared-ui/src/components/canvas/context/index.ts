// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/** Barrel exports for flow context providers and hooks. */

export { FlowProvider } from './FlowProvider';
export type { IFlowProviderProps } from './FlowProvider';

export { FlowPreferencesProvider, useFlowPreferences } from './FlowPreferencesContext';
export type { IFlowPreferencesContext } from './FlowPreferencesContext';
export { NavigationMode, DEFAULT_PROJECT_LAYOUT, DEFAULT_CANVAS_PREFERENCES } from './FlowPreferencesContext';

export { FlowProjectProvider, useFlowProject } from './FlowProjectContext';
export type { IFlowProjectContext } from './FlowProjectContext';

export { FlowGraphProvider, useFlowGraph } from './FlowGraphContext';
export type { IFlowGraphContext } from './FlowGraphContext';
