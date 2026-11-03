// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// HOST OPS — declarations for the host-environment vocabulary
// =============================================================================
//
// The `host.*` ops are capabilities only a framework HOST can provide (open
// the real browser, probe the server's Stripe key, persist prefs, read
// multi-connection state). DECLARATIONS AND SHARED GUARDS ONLY — the actual
// implementations live with each host: apps/rocket-ui/src/ops (cloud) and
// apps/vscode/src/ops (extension host). Not every host serves every op (a
// single-connection browser root has no env slots), but every op is
// declared here so realms address one vocabulary.
//
// Imports only the ext-host-safe busOps leaf: this file is compiled into
// webview bundles, the cloud realm, AND the extension host.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';

// =============================================================================
// PAYLOAD SHAPES
// =============================================================================

/** Why a host has no Stripe publishable key to offer. */
export type StripeKeyReason = 'no-connection' | 'probe-failed' | 'no-billing';

/** `host.stripeKey` result. */
export interface StripeKeyInfo {
	key: string | null;
	reason?: StripeKeyReason;
}

/** One connection slot's state for the Environment page (host-derived:
 *  a deploy slot's state never leaves the host process). */
export interface EnvSlotState {
	slot: 'development' | 'deployment';
	isConnected: boolean;
	isSaas: boolean;
	connectionMode: string | null;
	isOrgAdmin: boolean;
	isTeamAdmin: boolean;
	orgId?: string;
	teamId?: string;
}

/** `host.envSlots` result — also the `host.envSlotsChanged` broadcast payload. */
export interface EnvSlotsPayload {
	/** True when deployment shares the development target (one slot shown). */
	shared: boolean;
	slots: EnvSlotState[];
}

// =============================================================================
// THE VOCABULARY
// =============================================================================

/** What a dev-tool frame needs to mount its remote (`host.devtools.load`). */
export interface DevToolViewPayload {
	/** Whether the host currently holds a server connection. */
	connected: boolean;
	/** Engine base URL, no trailing slash ('' when disconnected). */
	engineHttpUrl: string;
	/** The tool to mount, or null when disconnected / not in the catalog. */
	app: { id: string; moduleId: string; name: string; registryVersion: number } | null;
}

/** The host-environment op map. */
export interface HostOpMap extends ShellOpMap {
	/** Opens a URL in the user's real browser (never inside the realm).
	 *  Every implementation MUST gate through {@link assertExternalUrl}. */
	'host.openExternal': ShellOpSpec<{ url: string }, void>;
	/** The Stripe publishable key for the host's server, or null + reason. */
	'host.stripeKey': ShellOpSpec<Record<string, never>, StripeKeyInfo>;
	/** Where Stripe sends the browser back from a portal/checkout session —
	 *  HOST POLICY (a webview realm's own origin is never a valid return
	 *  target). The shell serves a default (its own page URL — right for the
	 *  cloud root); hosts without a web origin (VS Code) register their own.
	 *  Callers pass the result into the SDK's billing methods. */
	'host.stripeReturnUrl': ShellOpSpec<Record<string, never>, { url: string }>;
	/** One pref write — fire-and-forget via emitOp to the WORKSPACE MANAGER,
	 *  which is the single writer. There is no matching read op: prefs are
	 *  MIRRORED on the retained `shell:prefs:<partition>` topics, so a realm
	 *  reads its own synchronous copy and never round-trips.
	 *
	 *  NOTE there is no `scope`. Partitions are the only axis — an app has ONE
	 *  bag, and cross-app state lives in the `shell` partition. */
	'shell.setPref': ShellOpSpec<{ partition: string; key: string; value: unknown }, void>;
	/** A realm DECLARES a partition it hosts, so the manager loads it (if it
	 *  has not already) and publishes its topic. Required because the retained
	 *  registry cannot tell the manager that someone subscribed, and an
	 *  unloaded partition has no snapshot to replay. Idempotent; always
	 *  publishes, even for an empty partition, so `ready` resolves. */
	'shell.prefs.attach': ShellOpSpec<{ partition: string }, void>;
	/** Setting-override write into the OWNING partition's `settings` section
	 *  (deltas only — an absent `value` resets the key to its default). The
	 *  caller resolves the owner from the settings registry; the manager
	 *  writes where it is told and republishes the partition's settings
	 *  topic (`shell:settings:<partition>`). */
	'shell.updateSetting': ShellOpSpec<{ partition: string; key: string; value?: string | number | boolean }, void>;
	/** The settings twin of `shell.prefs.attach`: declare a partition so its
	 *  settings topic gets its first publish (empty bag included). */
	'shell.settings.attach': ShellOpSpec<{ partition: string }, void>;
	/** Connection-slot state for the Environment page — served by
	 *  multi-connection hosts (dev/deploy). */
	'host.envSlots': ShellOpSpec<Record<string, never>, EnvSlotsPayload>;
	/** Slot-resolved env read for the Environment page: `connection` picks
	 *  the dev or deploy connection — HOST state (the deploy slot's client
	 *  never leaves the host process), which is why this is not a plain
	 *  `client.account.getEnv` on the realm client. Single-connection hosts
	 *  need no handler: their Environment surface reads the realm client. */
	'host.env.get': ShellOpSpec<{ scope: 'org' | 'team' | 'user'; scopeId?: string; connection?: 'dev' | 'deploy' }, Record<string, string>>;
	/** Slot-resolved env write — the counterpart of `host.env.get`. */
	'host.env.set': ShellOpSpec<{ scope: 'org' | 'team' | 'user'; env: Record<string, string>; scopeId?: string; connection?: 'dev' | 'deploy' }, void>;
	/** Opens a framework page by registry name, from ANY realm. The host's
	 *  page directory is the allowlist; an unknown name rejects. `popup`
	 *  asks for an overlay where the host has one (cloud); hosts without
	 *  window-modal surfaces (VS Code) open a page regardless. `args` ride
	 *  to the page's open hook (e.g. the Environment prefill keys). */
	'host.openPage': ShellOpSpec<{ page: string; popup?: boolean; args?: unknown[] }, void>;
	/** Closes a framework page by registry name — a page realm asking the
	 *  host to retire its own surface (e.g. Welcome after Save & Connect).
	 *  A page that is not open is a no-op, never an error. */
	'host.closePage': ShellOpSpec<{ page: string }, void>;
	/** Opens (or focuses) a tool's frame panel/document — the bus peer's
	 *  SUMMON: a sidebar event found no live frame (a sidebar post is a user
	 *  action by the peer contract). */
	'host.openToolPanel': ShellOpSpec<{ appId: string }, void>;
	/** Mounts a tool's SIDEBAR (controller) without selecting its tab — the
	 *  bus peer's reverse SUMMON: frame traffic arrived for a tool whose
	 *  controller is not mounted, and the frame reaches the engine only
	 *  through ops that mount serves. Lets a host mount tool sidebars lazily
	 *  (nothing downloads until a tab is picked or a frame asks) without
	 *  stranding a restored frame whose tab was never selected.
	 *
	 *  MOUNTED and SELECTED are distinct states: this one never changes the
	 *  strip selection, and the mount is display-hidden until chosen. */
	'host.mountToolSidebar': ShellOpSpec<{ appId: string }, void>;
	/** A tool frame's boot state, PULLED by the panel realm (its appId is
	 *  stamped into the served HTML). The host owns the catalog and the
	 *  connection, so it answers authoritatively — a late-attaching realm
	 *  must not have to re-derive this from mirror replay. */
	'host.devtools.load': ShellOpSpec<{ appId: string }, DevToolViewPayload>;
	/** The pinned (installed) dev tool ids — host-persisted strip state. */
	'host.devtools.installed': ShellOpSpec<Record<string, never>, { ids: string[] }>;
	/** Pins a tool to the strip. */
	'host.devtools.install': ShellOpSpec<{ appId: string }, void>;
	/** Unpins a tool AND retires its open frame panel. */
	'host.devtools.remove': ShellOpSpec<{ appId: string }, void>;
	/** PUSH — the pinned set changed (any surface). */
	'host.devtools.changed': ShellOpSpec<{ ids: string[] }, void>;
	/** Brings an OPEN window of the tool forward — never creates one (a mere
	 *  strip tab switch is not a summon; emitOp). */
	'host.devtools.reveal': ShellOpSpec<{ appId: string }, void>;
	/** Opens the tool's details page (README + Install/Remove; emitOp). */
	'host.devtools.readme': ShellOpSpec<{ appId: string }, void>;
	/** The Dev Tools RESET: re-fetch the app registry and reload every loaded
	 *  tool — stale frame panels AND the calling sidebar's own page (emitOp:
	 *  the caller's realm reboots mid-flight). */
	'host.devtools.refresh': ShellOpSpec<Record<string, never>, void>;
	/** Opens one of a tool's OWN documents (the DevToolProps.documents API —
	 *  e.g. one editor tab per database connection; emitOp). */
	'host.devtools.openDoc': ShellOpSpec<{ appId: string; docKey: string; title: string }, void>;
	/** Closes one of a tool's documents (emitOp). */
	'host.devtools.closeDoc': ShellOpSpec<{ appId: string; docKey: string }, void>;
	/** Opens an app's App Builder document (emitOp). */
	'host.app.open': ShellOpSpec<{ appId: string }, void>;
}

// =============================================================================
// SHARED GUARDS
// =============================================================================

/** The only URL schemes a host may open externally. */
export const EXTERNAL_URL_SCHEMES = ['https', 'http', 'mailto'] as const;

/**
 * Validates a realm-supplied external URL — the GENERIC half of every
 * `host.openExternal` implementation. A realm must never steer the host
 * into opening file:/vscode:/javascript:/custom-app URIs.
 *
 * @param url - The URL as received off the bus.
 * @returns The validated URL (for fluent use).
 * @throws When the URL is unparseable or its scheme is not allowlisted.
 */
export function assertExternalUrl(url: string): string {
	let scheme = '';
	try {
		scheme = new URL(url).protocol.replace(':', '').toLowerCase();
	} catch { /* unparseable — rejected below */ }
	if (!(EXTERNAL_URL_SCHEMES as readonly string[]).includes(scheme)) {
		throw new Error(`Blocked external URL scheme: ${scheme || '(unparseable)'}`);
	}
	return url;
}
