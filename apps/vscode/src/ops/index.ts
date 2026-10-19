// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OPS — this host's complete bus-op registration, in dependency order
// =============================================================================
//
// One call wires everything the extension host serves over the shell bus.
// ORDER MATTERS (specific-before-shared): host overrides first, then the
// shared generic table, which skips anything already registered.
// =============================================================================

import type * as vscode from 'vscode';
// Deep import on purpose — ext-host-safe .ts leaf (see busHost.ts).
import { registerClientOps } from 'shell/src/ops/clientOps';
import type { BusHost } from '../providers/toolhost/busHost';
import { registerVscodeClientOverrides } from './clientOverrides';
import { registerVscodeHostOps } from './hostOps';
import { registerVscodeSettingsOps } from './settingsOps';
import { registerVscodeAppDevOps } from './appdevOps';
import { registerVscodeAppBuilderOps } from './appBuilderOps';
import type { ISettingsOpsController } from './settingsOps';

/**
 * Registers every op this host serves:
 *
 * 1. The broker's monitor authority (BusHost — cross-realm refcount state).
 * 2. This host's `client.*` overrides (env family, slot-resolved).
 * 3. The SHARED `client.*` table against the primary connection's client,
 *    with this host's policy options.
 * 4. The `host.*` implementations (browser-open, Stripe probe, prefs,
 *    env slots, open/close page) + the env-slot change feed.
 * 5. The settings/cloud/engine family (Welcome + Settings pages).
 *
 * @returns The settings controller the extension wires to the Welcome and
 *          Settings FrameworkProvider lifecycle hooks.
 */
export function registerVscodeOps(busHost: BusHost, context: vscode.ExtensionContext): ISettingsOpsController {
	busHost.registerMonitorBroker();
	registerVscodeClientOverrides(busHost.rootBus, busHost.connectionManager);
	registerClientOps(busHost.rootBus, busHost.connectionManager, {
		// Stripe portal/checkout return target: the webview's own origin is
		// never valid, so the HOST decides — the public site.
		portalReturnUrl: () => 'https://rocketride.ai',
	});
	registerVscodeHostOps(busHost.rootBus, {
		context,
		connectionManager: busHost.connectionManager,
		broadcast: (op, params) => busHost.broadcastEmitOp(op, params),
	});
	registerVscodeAppDevOps(busHost.rootBus, {
		context,
		connectionManager: busHost.connectionManager,
		broadcast: (op, params) => busHost.broadcastEmitOp(op, params),
	});
	registerVscodeAppBuilderOps(busHost.rootBus, {
		context,
		connectionManager: busHost.connectionManager,
		retained: busHost.retained,
	});
	return registerVscodeSettingsOps(busHost.rootBus, {
		context,
		broadcast: (op, params) => busHost.broadcastEmitOp(op, params),
	});
}
