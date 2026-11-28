/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Stand-in for the builder's canvas hooks barrel (see resolve.ts). It keeps
 * the hooks the drawing path calls and leaves out auto-layout (and ELK),
 * panels and templates. Copy and paste do nothing in a read-only canvas.
 */
export { useFlowGraph } from './FlowGraphContext';
export { useFlowProject } from './FlowProjectContext';
export { useFlowPreferences } from './FlowPreferencesContext';
export { default as useNodeActionLabels, cmdOrCtrl, shortcutKeys } from '@app-shared/tools/pipelines/panels/design/canvas/hooks/useNodeActionLabels';

/** Read-only: copying nodes does nothing. */
export function useCopy(): (nodeIds?: readonly string[]) => void {
	return () => undefined;
}

/** Read-only: pasting nodes does nothing. */
export function usePaste(): () => void {
	return () => undefined;
}
