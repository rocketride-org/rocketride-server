// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Flow module — Public API for the pipeline canvas editor.
 *
 * The primary export is the `Flow` component, which is the single
 * entry point for host applications (VS Code, web app).
 *
 * ```tsx
 * import Flow from '@shared-ui/modules/flow';
 * <Flow project={...} servicesJson={...} ... />
 * ```
 */

export { default } from './Flow';
export type { IFlowProps } from './Flow';
export * from './types';
