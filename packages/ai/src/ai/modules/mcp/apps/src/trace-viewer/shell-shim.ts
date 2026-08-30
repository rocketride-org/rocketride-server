/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Minimal stand-in for the 'shell' barrel: the trace component tree uses
 * exactly these symbols (verified 2026-08-12). Importing the real barrel
 * (shell/src/api.ts) would pull ~85 modules into the single-file bundle.
 */
/* eslint-disable no-restricted-imports -- this file IS the 'shell' specifier here (vite aliases bare 'shell' to it), so it must reach the sources directly */
export { commonStyles } from 'shell/src/themes/styles';
export { EmptyState } from 'shell/src/components/empty-state/EmptyState';
export { ToggleGroup } from 'shell/src/components/toggle-group/ToggleGroup';
export type { ITaskStatus } from 'shell/src/types/project';
