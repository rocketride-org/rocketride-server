// =============================================================================
// ShellApiConfigContext — forwards host API config to all remote apps
// =============================================================================
// The host (cloud) populates ShellConfig.apiConfig from its build-time env vars.
// Remote app components call useShellApiConfig() to read billing URLs, etc.
// No process.env usage in remotes.
// =============================================================================

import React, { createContext, useContext } from 'react';
import type { ShellApiConfig } from '../workspace/types';

const ShellApiConfigContext = createContext<ShellApiConfig>({});

export const ShellApiConfigProvider: React.FC<{
	config: ShellApiConfig;
	children: React.ReactNode;
}> = ({ config, children }) => (
	<ShellApiConfigContext.Provider value={config}>
		{children}
	</ShellApiConfigContext.Provider>
);

/** Access host-provided API config from any component under Shell. */
export function useShellApiConfig(): ShellApiConfig {
	return useContext(ShellApiConfigContext);
}
