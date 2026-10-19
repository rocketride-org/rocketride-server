// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SETTINGS / CLOUD / ENGINE OPS — declarations for the host-configuration vocabulary
// =============================================================================
//
// The vocabulary the Welcome and Settings framework pages speak: extension
// settings (read/save/clear), staged cloud auth (sign-in is transactional —
// it commits only with the form it belongs to), engine lifecycle
// (install/start/stop + status + version catalogs), and the unauthenticated
// server probe. DECLARATIONS ONLY — the implementations live with the host
// that owns the capability (apps/vscode/src/ops/settingsOps.ts; the cloud
// host has no engine installs or staged credentials, so it serves none of
// these today).
//
// Request/push split: `host.*.…` names without a past-tense suffix are
// REQUESTS a realm sends to the host; the `…Changed` / `…progress` /
// `openArgs` names are PUSHES the host broadcasts to every realm
// (BusHost.broadcastEmitOp) — a page registers local handlers for those.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';

// =============================================================================
// SETTINGS PAYLOADS
// =============================================================================

/** Available connection modes for the dev/deploy targets. */
export type SettingsConnectionMode = 'cloud' | 'docker' | 'service' | 'onprem' | 'local';

/**
 * Per-group (development or deployment) connection configuration.
 * Null connectionMode means "use the other group's target" (shared mode).
 */
export interface ConnectionGroupSettings {
	/** Active connection mode, or null when sharing the other group's target. */
	connectionMode: SettingsConnectionMode | null;
	/** Server URL for onprem mode. */
	hostUrl: string;
	/** Cloud mode: connect to `cloudUrl` instead of the default cloud. */
	useCustomServer: boolean;
	/** Cloud mode: the custom server address (used when useCustomServer). */
	cloudUrl: string;
	/** Cloud mode: the default cloud server — the setting's package.json
	 *  default, HOST-ONLY knowledge (the page bakes no address). */
	defaultCloudUrl: string;
	/** Whether the secret store already has an API key for this group. */
	hasApiKey: boolean;
	/** User-entered API key (persisted to secret storage on save). */
	apiKey: string;
	/** Local engine settings (applies to local mode only). */
	local: {
		engineVersion: string;
	};
}

/**
 * The settings form's wire shape — what `host.settings.get` returns and
 * `host.settings.save` accepts. The save is TYPED against this full shape on
 * purpose: the page echoes the whole object back, and a silently missing
 * field used to reset that setting to its default — now it fails to compile.
 */
export interface SettingsData {
	development: ConnectionGroupSettings;
	deployment: ConnectionGroupSettings;
	/** Workspace-relative path where pipeline files are stored. */
	defaultPipelinePath: string;
	/** How pipelines behave after file changes. */
	pipelineRestartBehavior: 'auto' | 'manual' | 'prompt';
	/** Default idle-timeout (seconds) for runs without a per-pipeline override; 0 = none. */
	pipelineTtl: number;
	/** Default trace verbosity for runs without a per-pipeline override. */
	pipelineTraceLevel: 'none' | 'metadata' | 'summary' | 'full';
	/** Additional command-line arguments passed to each pipeline task via `.use`. */
	taskArguments: string;
	/** Enable full debug output for pipeline tasks. */
	pipelineDebugOutput: boolean;
	envVars?: Record<string, string>;
	/** Auto-install RocketRide docs for detected coding agents. */
	autoAgentIntegration: boolean;
	integrationCopilot: boolean;
	integrationClaudeCode: boolean;
	integrationCursor: boolean;
	integrationWindsurf: boolean;
	integrationClaudeMd: boolean;
	integrationAgentsMd: boolean;
}

/** `host.settings.get` result — also the `host.settings.changed` push payload. */
export interface SettingsPayload {
	settings: SettingsData;
	/** Whether the account's subscription covers the host's premium app. */
	isSubscribed: boolean;
}

/** Why the Settings page was opened — `host.settings.getOpenArgs` result and
 *  the `host.settings.openArgs` push (the env.prefill pull+push pattern:
 *  pull covers open-with-args racing the realm attach, push covers an
 *  already-open page). */
export interface SettingsOpenArgs {
	/** Settings section to activate (e.g. 'deployment'). */
	focus?: string;
	/** Auth-failure banner text, when opened because a connection was rejected. */
	authError?: string;
}

// =============================================================================
// CLOUD AUTH PAYLOADS
// =============================================================================

/** `host.cloud.status` result — also the `host.cloud.statusChanged` push.
 *  Settings surfaces are transactional: a sign-in/sign-out is STAGED
 *  (pending*) and commits only inside `host.settings.save`. */
export interface CloudAuthStatus {
	signedIn: boolean;
	userName: string;
	/** The server the session's token was minted against — subscribe gates
	 *  compare the form's target to it. */
	signedInUrl: string;
	/** Last sign-in attempt came back waitlisted (auth fine, access queued). */
	waitlisted: boolean;
	waitlistedName: string;
	pendingSignIn: boolean;
	pendingUserName: string;
	pendingUrl: string;
	pendingSignOut: boolean;
}

// =============================================================================
// ENGINE PAYLOADS
// =============================================================================

/** A GitHub release entry for the engine version dropdowns. */
export interface EngineVersionItem {
	tag_name: string;
	prerelease: boolean;
}

/** `host.engine.versions` result: the two version catalogs, host-cached. */
export interface EngineVersionsPayload {
	releases: EngineVersionItem[];
	dockerTags: string[];
}

/** One backend's install/runtime snapshot (service: installPath; docker:
 *  imageTag + the extra 'no-docker' state). Structural so webview-side
 *  ServiceStatus/DockerStatus narrow it without an ext-host import. */
export interface EngineStatusInfo {
	state: string;
	version: string | null;
	publishedAt: string | null;
	installPath?: string | null;
	imageTag?: string | null;
}

/** `host.engine.status` result — also the `host.engine.statusChanged` push
 *  (the host polls the OS/daemon while a settings-family page is open). */
export interface EngineStatusPayload {
	service: EngineStatusInfo;
	docker: EngineStatusInfo;
}

/** `host.engine.control` result (mirrors the ext-host IoControlResult). */
export interface EngineControlResult {
	success: boolean;
	error?: string;
	/** The verb needs a sudo password (macOS/Linux service lifecycle): the
	 *  panel shows its password field and re-sends the same command with
	 *  `params.sudoPassword`. */
	needsSudo?: boolean;
	data?: Record<string, unknown>;
}

/** `host.engine.progress` push — streamed during long controls (installs). */
export interface EngineProgress {
	mode: string;
	command: string;
	message: string;
}

// =============================================================================
// SERVER PROBE PAYLOAD
// =============================================================================

/** `host.server.probe` result. `unreachable` distinguishes "no server there"
 *  from "server answered but does not support the probe" (legacy/OSS). */
export interface ServerProbeResult {
	version: string;
	capabilities: string[];
	platform?: string;
	unreachable?: boolean;
}

// =============================================================================
// THE VOCABULARY
// =============================================================================

/** The host-configuration op map (Welcome + Settings pages). */
export interface SettingsHostOpMap extends ShellOpMap {
	// ── Settings ────────────────────────────────────────────────────────────
	/** The current settings form + subscription state. */
	'host.settings.get': ShellOpSpec<Record<string, never>, SettingsPayload>;
	/**
	 * Persists the form atomically and commits any STAGED cloud auth change
	 * with it. `connect: true` is the Welcome page's Save & Connect: the host
	 * additionally initializes connections and reconciles engines before
	 * resolving. Resolution IS the success signal; failures reject.
	 */
	'host.settings.save': ShellOpSpec<{ settings: SettingsData; connect?: boolean }, void>;
	/** Clears the development API key from secure storage. */
	'host.settings.clearCredentials': ShellOpSpec<Record<string, never>, { hasApiKey: boolean }>;
	/** PUSH — settings were saved (by any surface); payload is the fresh state. */
	'host.settings.changed': ShellOpSpec<SettingsPayload, void>;
	/** The open command's arguments (focus section / auth-error banner). */
	'host.settings.getOpenArgs': ShellOpSpec<Record<string, never>, SettingsOpenArgs>;
	/** PUSH — the open command fired again while the page is live. */
	'host.settings.openArgs': ShellOpSpec<SettingsOpenArgs, void>;

	// ── Cloud auth (staged) ─────────────────────────────────────────────────
	/** The current (incl. staged) cloud auth state. */
	'host.cloud.status': ShellOpSpec<Record<string, never>, CloudAuthStatus>;
	/**
	 * Starts the browser OAuth sign-in. Fire-and-forget by nature — the
	 * outcome arrives on `host.cloud.statusChanged` whenever the user
	 * completes (or abandons) the browser flow. `cloudUrl` carries the FORM's
	 * current effective server (unsaved edits included) so the code is
	 * exchanged against exactly the server on screen.
	 */
	'host.cloud.signIn': ShellOpSpec<{ cloudUrl?: string }, void>;
	/** Stages a sign-out (the stored session is deleted only on save). */
	'host.cloud.signOutStaged': ShellOpSpec<Record<string, never>, void>;
	/** Discards any staged sign-in/sign-out without touching the stored session. */
	'host.cloud.clearPending': ShellOpSpec<Record<string, never>, void>;
	/** PUSH — any cloud auth change (stored or staged). */
	'host.cloud.statusChanged': ShellOpSpec<CloudAuthStatus, void>;

	// ── Engine lifecycle ────────────────────────────────────────────────────
	/** Both version catalogs (GitHub releases + GHCR tags), host-cached. */
	'host.engine.versions': ShellOpSpec<Record<string, never>, EngineVersionsPayload>;
	/** Current service + docker backend status (one poll). */
	'host.engine.status': ShellOpSpec<Record<string, never>, EngineStatusPayload>;
	/** PUSH — the host's status poll observed the backends (every tick). */
	'host.engine.statusChanged': ShellOpSpec<EngineStatusPayload, void>;
	/** One engine lifecycle command (install/update/remove/start/stop/test),
	 *  routed to the mode's backend. The RESULT answers the caller directly —
	 *  no broadcast correlation. */
	'host.engine.control': ShellOpSpec<{ mode: SettingsConnectionMode; command: string; params?: Record<string, unknown> }, EngineControlResult>;
	/** PUSH — streamed progress during a long-running control. */
	'host.engine.progress': ShellOpSpec<EngineProgress, void>;

	// ── Server probe ────────────────────────────────────────────────────────
	/** Unauthenticated capability probe of a server URL. Answers the caller
	 *  directly — each panel awaits its own probe (no echo-routing). */
	'host.server.probe': ShellOpSpec<{ hostUrl: string }, ServerProbeResult>;
}
