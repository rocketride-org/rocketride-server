// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APPDEV OPS — declarations for the app-scaffold vocabulary
// =============================================================================
//
// The New App wizard's host surface: identity (who the developer is, where
// apps can land, which folders already exist) and the one-pass scaffold.
// DECLARATIONS ONLY — the VS Code host implements these over its workspace
// (apps/vscode/src/ops/appdevOps.ts); the cloud host scaffolds against the
// store VFS inside its own realm and serves none of them.
// =============================================================================

import type { ShellOpMap, ShellOpSpec } from 'shell/src/ops/busOps';
import type { NewAppIdentity } from '../tools/appdev/types';
import type { FrameOptions } from '../tools/appdev/templates';

/** The app-scaffold op map (the New App wizard page). */
export interface AppDevOpMap extends ShellOpMap {
	/** The live identity snapshot: developer id + provenance, workspace
	 *  availability, and existing app folders (collision validation). */
	'host.appdev.identity': ShellOpSpec<Record<string, never>, NewAppIdentity>;
	/**
	 * Scaffolds the app in ONE pass and opens its builder. The host resolves
	 * the developer id AT SCAFFOLD TIME (the wizard is modeless — a login
	 * between open and Create must change the app id). Resolution is the
	 * success signal; failures reject with the validation message.
	 */
	'host.appdev.scaffold': ShellOpSpec<{ appName: string; displayName: string; frame: FrameOptions }, void>;
	/** PUSH — the identity changed (connection/account events) while a
	 *  wizard may be open. */
	'host.appdev.identityChanged': ShellOpSpec<NewAppIdentity, void>;
}
