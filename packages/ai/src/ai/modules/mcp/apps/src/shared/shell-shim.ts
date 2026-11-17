/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Minimal stand-in for the 'shell' barrel. Importing the real barrel
 * (shell/src/api.ts) would pull about 85 modules into a single-file bundle.
 * It exports exactly what the reused trace and canvas files import from
 * 'shell'; tsc fails if one of them asks for a name that is missing here.
 */

// Trace viewer.
export { commonStyles } from 'shell/src/themes/styles';
export { EmptyState } from 'shell/src/components/empty-state/EmptyState';
export { ToggleGroup } from 'shell/src/components/toggle-group/ToggleGroup';

// Pipeline canvas: the builder's canvas types (canvas/types.ts) and graph code.
export { IServiceCapabilities, ITaskState, DEFAULT_TOOLCHAIN_STATE } from 'shell/src/types/project';
export type {
	IProject,
	IProjectComponent,
	IComponentUI,
	IControlConnection,
	IInputConnection,
	IPosition,
	IDimensions,
	IService,
	IServiceCatalog,
	INodeConfig,
	IValidateResponse,
	IComponentValidatePayload,
	IValidatePipelinePayload,
	IServiceSchema,
	IToolchainExport,
	IToolchainState,
	IForm,
	IFormData,
	ITaskStatus,
	IFlowData,
} from 'shell/src/types/project';
export type { PipelineComponent, PipelineInputConnection } from 'rocketride';

// Type-checker only. tsc follows the builder's real editor contexts, run
// button and config form, which the canvas build replaces with stand-ins
// (resolve.ts), so the bundle never imports these. `declare` emits no code:
// if a bundled file ever imports one at runtime, the build fails on the
// missing export instead of pulling in the shell.
export declare const useAppState: typeof import('shell/src/components/contexts/AppStateContext').useAppState;
export declare const Button: typeof import('shell/src/components/button/Button').Button;
export declare const BxPlay: typeof import('shell/src/components/BoxIcon').BxPlay;
export declare const BxStop: typeof import('shell/src/components/BoxIcon').BxStop;
export declare const BxRefresh: typeof import('shell/src/components/BoxIcon').BxRefresh;
