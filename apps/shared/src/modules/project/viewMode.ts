import type { ProjectViewMode } from './types';

/** Remember intent while asynchronous host capabilities load; rendering still clamps it. */
export function initialViewMode(mode: string | undefined, readonly: boolean): ProjectViewMode {
	return resolveViewMode(mode, readonly, true);
}

/** Restore old monitoring pages without leaving a host on an unavailable page. */
export function resolveViewMode(mode: string | undefined, readonly: boolean, hasEvaluations: boolean): ProjectViewMode {
	if (mode === 'design' || mode === 'development') return mode;
	if (mode === 'evaluations') return hasEvaluations && !readonly ? mode : 'design';
	if (mode === 'deploy') return readonly ? 'development' : mode;
	if (['status', 'tokens', 'flow', 'trace', 'errors'].includes(mode ?? '')) return 'development';
	return 'design';
}
