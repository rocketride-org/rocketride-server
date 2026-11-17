// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * CanvasPanel component — Pipeline canvas editor.
 *
 * ```tsx
 * import CanvasPanel from '@shared/tools/pipelines/canvas';
 * <CanvasPanel project={...} servicesJson={...} ... />
 * ```
 */

export { default } from './CanvasPanel';
export type { ICanvasPanelProps } from './CanvasPanel';
export * from './types';

// Published for consumers OUTSIDE the canvas (ProjectView, the rocket-ui
// providers): reaching into canvas/util directly would bypass this boundary.
export { Icon, registerServiceIcons } from './util/Icon';
export type { IconProps, ServiceIconsSource } from './util/Icon';
export { extractPipelineEnvVars } from './util/extractEnvVars';
