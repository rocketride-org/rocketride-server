// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPE PICKER — public surface (plan 3.6, C.16c)
// =============================================================================

export { PipePicker, default } from './PipePicker';
export type { IPipePickerProps, IPipePickerClient } from './PipePicker';
export { looksLikeAddress, pipeLinkFromLocation, writePipeLinkToLocation } from './pipePickerLogic';
export type { IPipeChoice, IPipeLink, IPipeEntry, IInterfaceNode } from './pipePickerLogic';
