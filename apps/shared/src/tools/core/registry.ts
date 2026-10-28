// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// TOOLS/CORE — the builtin tool registry
// =============================================================================
//
// A TOOL IS AN APP, all the way down to its paperwork: a builtin (agent,
// apps, nodes, pipelines) registers the same PAIR every store tool has — an
// `AppManifestEntry` (the catalog row) and the descriptor surface it would
// MF-export (devToolSidebar as the controller, devToolFrame as the document
// view). The only difference is that there is nothing to go get: the
// components are COMPILED INTO the host bundle, so the manifest carries no
// `load` and the descriptor sits right here.
//
// The tier is decided by the registration route alone (this registry ⇒
// builtin, the MF catalog ⇒ store), never by anything a manifest claims, so
// a store app can never self-promote into host capabilities.
//
// ID SPELLINGS — one id, two spellings, both already in use everywhere:
//   - manifest.id:   `builtin.<tool>` — the PIN spelling (devToolPins), so a
//     builtin's catalog identity IS its toolbar-list entry, and it can never
//     collide with a store app id.
//   - descriptor.id: the bare `<tool>` — the chrome container id, strip tab
//     id, and the tool's channel key (what `containerIdOf` yields for a pin).
// =============================================================================

import type { AppDescriptor, AppManifestEntry } from 'shell';
import { registerSettings } from 'shell';
import { BUILTIN_PIN_PREFIX } from 'shell/src/workspace/devToolPins';
import { TOOL_SETTINGS_GROUP, TOOL_SETTINGS_OWNER } from '../toolSettings';

/** A builtin's manifest row: a real `AppManifestEntry` minus the loader —
 *  the one thing a builtin genuinely does not have (nothing to fetch). */
export type BuiltinManifest = Omit<AppManifestEntry, 'load'>;

/** A builtin's descriptor: the slice of `AppDescriptor` a dev tool serves.
 *  No `app`/`branding` — a tool mounts in a host workbench, it never boots
 *  as a full shell app. */
export type BuiltinToolDescriptor = Pick<AppDescriptor, 'id' | 'name' | 'icon' | 'devToolFrame' | 'devToolSidebar'>;

/** One builtin tool: the manifest row plus the in-bundle descriptor. */
export interface BuiltinTool {
	/** The catalog row (id `builtin.<tool>`, synthesised at registration). */
	manifest: BuiltinManifest;
	/** The descriptor surface (id = the bare tool id / channel key). */
	descriptor: BuiltinToolDescriptor;
}

/** What a registration supplies — manifest identity is synthesised from the
 *  descriptor id, so it cannot be declared (and cannot disagree). */
export interface BuiltinToolRegistration {
	manifest: Omit<BuiltinManifest, 'id' | 'moduleId'>;
	descriptor: BuiltinToolDescriptor;
}

const builtins: BuiltinTool[] = [];

/** The bare tool id of a builtin (its chrome/channel spelling). */
function toolIdOf(tool: BuiltinTool): string {
	return tool.descriptor.id;
}

/**
 * Registers a builtin tool. Called at host startup, before any sidebar
 * renders; registration order is the strip's default order (the user's
 * persisted tab order re-ranks it).
 *
 * The manifest's `id` is synthesised as `builtin.<tool>` (the pin spelling)
 * and `moduleId` by the standard underscore rule — a builtin cannot claim a
 * catalog identity other than its own.
 *
 * @param tool - The manifest row and descriptor surface.
 */
export function registerBuiltinTool(tool: BuiltinToolRegistration): void {
	if (builtins.some((t) => toolIdOf(t) === tool.descriptor.id)) return;
	const id = `${BUILTIN_PIN_PREFIX}${tool.descriptor.id}`;
	const manifest = { ...tool.manifest, id, moduleId: id.replace(/[^A-Za-z0-9_]/g, '_') };
	builtins.push({ manifest, descriptor: tool.descriptor });
	// Registering the tool IS registering its settings: a manifest that
	// declares `configuration` contributes a section (grouped under the
	// Rocket Builder nav parent). Builtins register for the host's lifetime —
	// their machinery is resident in the bundle (pipeline runs honor TTL,
	// autoCommit governs saves) even while the strip tab is disabled, so the
	// disposer is deliberately dropped.
	if (manifest.configuration) {
		registerSettings({
			appId: manifest.id,
			name: manifest.name,
			...(manifest.shells ? { shells: manifest.shells } : {}),
			group: TOOL_SETTINGS_GROUP,
			// Builtins store into the PRODUCT partition — no per-builtin files.
			storageAppId: TOOL_SETTINGS_OWNER,
			configuration: manifest.configuration,
		});
	}
}

/**
 * The registered builtin tools, in registration order.
 *
 * @returns The builtin tool list.
 */
export function getBuiltinTools(): readonly BuiltinTool[] {
	return builtins;
}

/**
 * The builtin registered under a tool id — accepts both spellings (the bare
 * container/channel id and the `builtin.<tool>` manifest id).
 *
 * @param appId - The tool id.
 * @returns The builtin, or undefined.
 */
export function getBuiltinTool(appId: string): BuiltinTool | undefined {
	return builtins.find((t) => toolIdOf(t) === appId || t.manifest.id === appId);
}

/**
 * Whether an id names a builtin tool.
 *
 * For hosts deciding whether a descriptor LOAD is needed at all — the
 * builtin's components come from this registry, so there is nothing to
 * fetch. Which component actually mounts is ToolMount's decision, never a
 * host's.
 *
 * @param appId - The tool id (either spelling).
 * @returns True when the id is registered here.
 */
export function isBuiltinTool(appId: string): boolean {
	return getBuiltinTool(appId) !== undefined;
}

/**
 * Whether a builtin serves a host, per its manifest `shells` declaration —
 * absent means every shell. The rocket workbench fronts the web editions
 * (saas/oss); the VS Code extension is its own edition.
 *
 * @param tool - The builtin.
 * @param host - The asking host.
 * @returns True when the tool should surface on that host.
 */
export function builtinServesHost(tool: BuiltinTool, host: 'rocket' | 'vscode'): boolean {
	const shells = tool.manifest.shells;
	if (!shells || shells.length === 0) return true;
	if (host === 'vscode') return shells.includes('vscode');
	return shells.includes('saas') || shells.includes('oss');
}
