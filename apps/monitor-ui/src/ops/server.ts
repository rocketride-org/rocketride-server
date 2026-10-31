// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MONITOR OPS — SERVER side (the tool's sidebar CONTROLLER serves these)
// =============================================================================

import { createToolOpServer } from 'shell';
import type { ToolChannel } from 'shell';
import type { MonitorOps } from './types';

/** What serving needs from the controller mount. */
export interface IMonitorOpsServerDeps {
	/** Nudges the controller's ONE shared dashboard poller (useDashboardData);
	 *  read fresh per call so the newest poller closure is always the one
	 *  nudged (the mount keeps it in a ref). */
	refresh(): void;
}

/**
 * Serves the monitor's ops on the controller mount. The grids never arrive
 * here — they page on each frame's own realm client; what is served is the
 * COORDINATION of the one shared poller.
 *
 * @param channel - The mount's channel.
 * @param deps - The controller's shared-poller hook-ins.
 * @returns Dispose.
 */
export function serveMonitorOps(channel: ToolChannel, deps: IMonitorOpsServerDeps): () => void {
	const ops = createToolOpServer<MonitorOps>(channel);
	ops.serve('monitor.refresh', async () => {
		deps.refresh();
	});
	return () => ops.dispose();
}
