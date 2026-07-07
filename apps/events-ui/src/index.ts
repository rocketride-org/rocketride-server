// =============================================================================
// EVENTS-UI — async boundary for Module Federation
// =============================================================================

import('./AppDescriptor').catch((err) => {
	console.error('[events-ui] Failed to load AppDescriptor', err);
});
