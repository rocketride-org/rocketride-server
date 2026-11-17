// =============================================================================
// ShellApiConfigContext — forwards host API config to all remote apps
// =============================================================================
// The host (cloud) populates ShellConfig.apiConfig from its build-time env vars.
// Remote app components call useShellApiConfig() to read billing URLs, etc.
// No process.env usage in remotes. The context never carries RR_APIKEY (no
// shell or app code reads it here, #1022). That keeps it off the documented
// app surface only: same-origin app code can still reach the session until
// PR2 moves third-party apps off-origin.
// =============================================================================

import React, { createContext, useContext, useMemo } from 'react';
import type { ShellApiConfig } from '../components/workspace/types';
import { bridgedApiConfig } from '../util/identity';

const ShellApiConfigContext = createContext<ShellApiConfig>({});

export const ShellApiConfigProvider: React.FC<{
	config: ShellApiConfig;
	children: React.ReactNode;
}> = ({ config, children }) => {
	const appConfig = useMemo(() => bridgedApiConfig(config), [config]);
	return <ShellApiConfigContext.Provider value={appConfig}>{children}</ShellApiConfigContext.Provider>;
};

/** Access host-provided API config from any component under Shell. */
export function useShellApiConfig(): ShellApiConfig {
	return useContext(ShellApiConfigContext);
}
